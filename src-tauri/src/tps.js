/* Kimi Code 桌面封装 —— Token/秒（TPS）实时估算浮层
 *
 * 背景：`kimi web` 前端完全不显示吞吐（实测下载的 /assets/index-*.js 里
 * `TPS` / `TTFT` / `tok/s` 出现 0 次），而 WS 事件里其实什么都有：
 *   - event.assistant.delta / event.thinking.delta → payload.delta（增量文本）
 *   - event.turn.step.completed → payload.usage（{inputOther,output,inputCacheRead,
 *     inputCacheCreation}）+ payload.llmStreamDurationMs / llmFirstTokenLatencyMs 等
 * 服务端已在 TUI 里算过 `usage.output / (llmStreamDurationMs/1000)`，只是没给
 * Web 端。本脚本在页面构建前 hook WebSocket，自己把这块补上。
 *
 * 做法：
 *   1. 包装 WebSocket，只拦截 /api/v1/ws 上的下行帧（二进制 ArrayBuffer 或文本），
 *      原样转发给页面，绝不改写数据；
 *   2. 用「每 3 秒滚动窗口」算实时速率：同一时间区间内的估算 token ÷ 时长，
 *      首帧只作计时基准，完成事件到达后切换成真实 output ÷ llmStreamDurationMs；
 *   3. token 估算 = 字符启发式 × 自校准系数：每次 step 结束时拿真实 usage.output
 *      和本次原始估算量比一下，存进 localStorage；仍是启发式估算，不保证误差。
 *
 * 开关：Ctrl+Alt+T 显示/隐藏，拖拽移动位置，双击复位；位置和显隐都记在
 * localStorage。脚本只在能拿到 body 的 kimi 页面挂 DOM，其它页面静默。
 */
(function () {
  'use strict';

  if (window.__kimiTpsInstalled) return;
  window.__kimiTpsInstalled = true;

  // ---------------------------------------------------------------- 自诊断
  // 浮层不出现时最怕「全靠猜」。这里把关键事实（脚本是否执行、页面里有没有
  // #app、WS 有没有 hook 上、每帧的真实形态与解析结果）经 Tauri 事件转发给宿主，
  // 由 Rust 侧追加写入 %TEMP%\kimi-web-tauri-tps.log。DEBUG=false 即完全静音。
  var DEBUG = true;
  var dbgRing = [];
  var dbgCount = { attach: 0, frame: 0, parsed: 0, ev: 0, miss: 0, emit: 0, err: 0 };
  var dbgFlushTimer = null;

  function dbg(tag, data) {
    if (!DEBUG) return;
    try {
      var line = { tag: tag, t: Date.now(), d: data === undefined ? null : data };
      dbgRing.push(line);
      if (dbgRing.length > 160) dbgRing.shift();
      if (dbgFlushTimer) return;
      dbgFlushTimer = setTimeout(function () {
        dbgFlushTimer = null;
        var batch = dbgRing.slice();
        dbgRing.length = 0;
        try {
          if (window.__TAURI__ && window.__TAURI__.event) {
            dbgCount.emit++;
            window.__TAURI__.event.emit('kimi-tps-debug', { lines: batch, counts: dbgCount });
          }
        } catch (e) { /* 宿主不可用时静默 */ }
      }, 120);
    } catch (e) { /* 诊断本身绝不抛 */ }
  }

  // ---------------------------------------------------------------- 可调参数
  var CFG = {
    windowMs: 3000,       // 滚动窗口长度
    minSpanMs: 400,       // 窗口内至少积累这么久才显示速率（避免开局虚高）
    warmupTokens: 8,      // 至少这么多估算 token 才显示速率，之前只显示"已出 N tok"
    idleHideMs: 4000,     // 最后一次增量后多久不再显示实时速率
    finalLingerMs: 60000, // 定稿值停留时间：一次生成的真实结果不该转瞬即逝
    minFinalStreamMs: 200 // 太短的流不报 TPS（与 TUI 的 MIN_STREAM_MS_FOR_TPS 同义）
  };

  var LS = {
    pos: 'kimi.tps.pos',
    hidden: 'kimi.tps.hidden',
    cal: 'kimi.tps.cal.v2' // 旧公式保存的系数可能已饱和，重新学习
  };

  // ------------------------------------------------------------ token 估算器
  // 中文/日文/韩文按字计 1 个 token；每个 ASCII 字母、数字、下划线计 1/4；
  // 空白不计，其它非空白字符计 1。真实分词不可得，这里只求
  // 量级正确，再由 usage.output 做自校准。
  var RE_TOKEN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]|[A-Za-z0-9_]+|\S/gu;

  function estimateTokens(text) {
    if (!text) return 0;
    var m = text.match(RE_TOKEN);
    if (!m) return 0;
    var units = 0;
    for (var i = 0; i < m.length; i++) {
      var s = m[i];
      // 单个 ASCII 词/数字算 1/4 token，其余（CJK 单字、零散标点）算 1
      units += /^[A-Za-z0-9_]+$/.test(s) ? s.length / 4 : 1;
    }
    return units;
  }

  var cal = { text: 1, thinking: 1 };
  try {
    var saved = JSON.parse(localStorage.getItem(LS.cal) || 'null');
    if (saved && num(saved.text) !== null && num(saved.thinking) !== null) {
      cal.text = clampCal(saved.text);
      cal.thinking = clampCal(saved.thinking);
    }
  } catch (e) { /* 隐私模式等：用默认值 */ }

  // WebView2 (Chromium) 有 performance.now；老环境退回 Date.now
  var perfNow = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  function clampCal(v) { return Math.min(3, Math.max(0.34, v)); }
  function saveCal() {
    try { localStorage.setItem(LS.cal, JSON.stringify(cal)); } catch (e) {}
  }

  // ------------------------------------------------------------------ 统计态
  // 一条流 = 一次 LLM 调用（从 turn.step.started 到 turn.step.completed）
  function newStream() {
    return {
      t0: 0,               // 本步开始时刻（增量先到、没见到 step.started 时的兜底基准）
      ttft: null,          // 首次增量 - 提示词提交/本步开始
      firstDeltaAt: null,  // 首帧仅作速率基准，其 token 仍参与整步校准
      calibratable: false, // 仅观察到完整 step 开始时才允许校准
      byKind: {},          // kind -> 原始估算累计，用于结束时校准
      burst: []            // [{t, tok}] 滚动窗口
    };
  }

  var stream = null;
  var lastFinal = null;    // {tps, output, streamMs, ttft, t}
  var lastDeltaAt = 0;
  var promptT0 = null;     // 用户提交提示词的时刻
  var activeSessionId = null;
  var activeTurnId = null;
  var activeStepId = null;
  var completedSteps = Object.create(null);

  // 只统计当前订阅会话。切换时清空状态，后台会话不能改写前台用量或校准。
  function selectSession(id) {
    if (typeof id !== 'string' || !id || id === activeSessionId) return;
    activeSessionId = id;
    activeTurnId = null;
    activeStepId = null;
    completedSteps = Object.create(null);
    stream = null;
    lastFinal = null;
    lastDeltaAt = 0;
    promptT0 = null;
    currentTurnUsage = null;
    frameKinds = Object.create(null);
    scheduleRender();
  }

  function observeSubscription(data) {
    if (typeof data !== 'string') return;
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    var p = msg && msg.payload;
    if (!p) return;
    if (msg.type === 'subscribe_v2' && p.transcript && p.transcript.main === 'delta') {
      selectSession(p.session_id);
    } else if (msg.type === 'subscribe' && isArray(p.session_ids) && p.session_ids.length === 1) {
      selectSession(p.session_ids[0]);
    }
  }

  function onTurnStarted(id) {
    if (id !== undefined && id !== null && String(id) === activeTurnId) return;
    activeTurnId = id === undefined || id === null ? null : String(id);
    activeStepId = null;
    stream = null;
    lastFinal = null;
    currentTurnUsage = null;
    frameKinds = Object.create(null);
    promptT0 = perfNow();
    scheduleRender();
  }

  function kindOf(type, payload) {
    if (type === 'thinking.delta') return 'thinking';
    if (type === 'assistant.delta') {
      var k = payload && payload.kind;
      return k === 'thinking' || k === 'reasoning' ? 'thinking' : 'text';
    }
    return null;
  }

  function onDelta(kind, text) {
    var raw = estimateTokens(text);
    dbgCount.delta = (dbgCount.delta || 0) + 1;
    if (dbgCount.delta <= 8) {
      dbg('delta', {
        n: dbgCount.delta, kind: kind, chars: text ? text.length : 0,
        est: raw, tpsNow: windowRate() ? windowRate().tps : null
      });
    }
    if (raw <= 0) return;
    var now = perfNow();
    if (!stream) {
      stream = newStream();
      stream.t0 = promptT0 === null ? now : promptT0;
    }
    var s = stream;
    if (s.firstDeltaAt === null) s.firstDeltaAt = now;
    if (s.ttft === null) {
      // t0 可能是 0（合法时间戳），不能用 `||` 兜底
      var base = (s.t0 !== null && s.t0 !== undefined) ? s.t0 : now;
      s.ttft = Math.max(0, now - base);
    }
    var b = (s.byKind[kind] = s.byKind[kind] || { raw: 0, chars: 0 });
    b.raw += raw;
    b.chars += text.length;
    s.burst.push({ t: now, tok: raw * cal[kind] });
    lastDeltaAt = now;
    if (!display.hidden) scheduleRender();
  }

  function windowRate() {
    if (!stream) return null;
    var now = perfNow();
    if (stream.firstDeltaAt === null) return null;
    var start = Math.max(stream.firstDeltaAt, now - CFG.windowMs);
    var b = stream.burst;
    // 统计 (start, now]：首帧之前的时间未知，不把首帧算进分子。
    // 以 now 结束计时，网络停顿也会让实时速率下降。
    while (b.length && b[0].t <= start) b.shift();
    var span = now - start;
    if (span < CFG.minSpanMs) return null;
    var tok = 0;
    for (var i = 0; i < b.length; i++) tok += b[i].tok;
    if (tok < CFG.warmupTokens) return null;
    return { tps: tok / (span / 1000), tok: tok, span: span };
  }

  function onStepStarted(id, completeStart) {
    if (id !== undefined && id !== null) {
      id = String(id);
      if (completedSteps[id]) return;
      if (id === activeStepId && stream) return;
      activeStepId = id;
    }
    stream = newStream();
    stream.calibratable = completeStart !== false;
    stream.t0 = promptT0 === null ? perfNow() : promptT0;
    lastFinal = null;
    // 立刻重绘：用户按下回车到首个 token 之间可能等十几秒，这段必须看得见浮层
    if (!display.hidden) {
      scheduleRender();
      watchdog(1000);   // 期间没有增量事件，靠定时器把"已等待 Ns"刷新出来
    }
  }

  /// 最终 TTFT：优先用服务端自报的 llmFirstTokenLatencyMs（与 TUI 同源），
  /// 否则用「提示词提交 → 首个增量」的端到端观测值。
  function finalTtft(s, timing) {
    var server = num(timing && timing.llmFirstTokenLatencyMs);
    var client = s && s.ttft !== null ? s.ttft : null;
    if (server !== null && server > 0) {
      return { ms: server, src: '服务端', client: client };
    }
    if (client !== null) return { ms: client, src: '端到端', client: null };
    return null;
  }

  /// 用量对象有两种形态，都要认：
  ///   step.upsert.step.usage            → {inputOther, output, inputCacheRead, …}
  ///   meta.merge.agent.usage.total      → 同上（累计）
  ///   meta.merge.agent.usage.currentTurn→ 同上（只算本轮，仅用于用量展示）
  function usageOutput(u) {
    if (!u || typeof u !== 'object') return null;
    var v = u.output;
    if (typeof v !== 'number') v = u.output_tokens;
    return num(v) !== null && v > 0 ? v : null;
  }

  function onStepCompleted(step) {
    var id = step && step.stepId;
    if (id !== undefined && id !== null) {
      id = String(id);
      if (completedSteps[id] || (activeStepId !== null && id !== activeStepId)) return;
    }
    var usage = step && step.usage;
    // timing 既可能在 step.timing 里（transcript.ops 的 step.upsert），
    // 也可能直接平铺在事件载荷上（旧版 event.turn.step.completed）——两者都认。
    var timing = mergeTiming(step && step.timing, step);
    var out = usageOutput(usage);
    var ms = num(timing.llmStreamDurationMs);
    dbg('step.completed', {
      stepId: step && step.stepId,
      state: step && step.state,
      output: out,
      streamMs: ms,
      usageKeys: usage && typeof usage === 'object' ? Object.keys(usage) : null,
      timingKeys: timing && typeof timing === 'object' ? Object.keys(timing) : null,
      finalTps: (out !== null && ms) ? +(out / (ms / 1000)).toFixed(2) : null
    });
    var s = stream;
    stream = null;
    activeStepId = null;
    promptT0 = null;
    if (out === null || ms === null) return;
    if (id !== undefined && id !== null) completedSteps[id] = true;
    if (ms < CFG.minFinalStreamMs) {
      // 流太短：按 TUI 的做法不报 TPS（分母失真），只记下本步真实用量
      lastFinal = { tps: null, output: out, streamMs: ms, ttft: finalTtft(s, timing), t: perfNow() };
      if (!display.hidden) scheduleRender();
      return;
    }
    // 自校准：拿本步真实 output 与估算总量比，按推理/正文各自占比分摊修正
    var total = s ? totalRaw(s) : 0;
    if (s && s.calibratable && total > 0) {
      var ratio = out / total;                 // 本步整体「真实/估算」比
      for (var kind in s.byKind) {
        var b = s.byKind[kind];
        if (b.raw <= 40) continue;             // 样本太小不动系数
        var share = b.raw / total;             // 该类占本步比例
        var next = cal[kind] + (ratio - cal[kind]) * share;
        if (isFinite(next)) { cal[kind] = clampCal(next); saveCal(); }
      }
    }
    lastFinal = {
      tps: out / (ms / 1000),
      output: out,
      streamMs: ms,
      ttft: finalTtft(s, timing),
      decodeMs: num(timing.llmServerDecodeMs),
      buildMs: num(timing.llmRequestBuildMs),
      firstTokenMs: num(timing.llmServerFirstTokenMs),
      t: perfNow()
    };
    if (!display.hidden) scheduleRender();
  }

  function totalRaw(s) {
    var n = 0;
    for (var k in s.byKind) n += s.byKind[k].raw;
    return n || 0;
  }

  var TIMING_KEYS = [
    'llmFirstTokenLatencyMs', 'llmStreamDurationMs', 'llmRequestBuildMs',
    'llmServerFirstTokenMs', 'llmServerDecodeMs', 'llmClientConsumeMs', 'llmClientBlockedMs'
  ];

  /// 取一份 timing：优先 step.timing，缺失的字段从平铺载荷里兜。
  function mergeTiming(nested, flat) {
    var out = {};
    for (var i = 0; i < TIMING_KEYS.length; i++) {
      var k = TIMING_KEYS[i];
      var v = nested && typeof nested === 'object' ? nested[k] : undefined;
      if (typeof v !== 'number' && flat && typeof flat === 'object') v = flat[k];
      if (typeof v === 'number' && isFinite(v)) out[k] = v;
    }
    return out;
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  // -------------------------------------------------------------- WebSocket 钩子
  var NativeWS = window.WebSocket;
  if (typeof NativeWS === 'function' && !NativeWS.__kimiTpsPatched) {
    var Patched = function (url, protocols) {
      var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      try {
        if (String(url).indexOf('/api/v1/ws') >= 0) attach(ws);
      } catch (e) { /* 保底：hook 失败不影响页面 */ }
      return ws;
    };
    Patched.prototype = NativeWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
      try { Patched[k] = NativeWS[k]; } catch (e) {}
    });
    Patched.__kimiTpsPatched = true;
    try { window.WebSocket = Patched; } catch (e) {}
    dbg('ws.patched', { ok: window.WebSocket === Patched });
  } else {
    dbg('ws.patchSkipped', { hasWS: typeof NativeWS, already: !!(NativeWS && NativeWS.__kimiTpsPatched) });
  }

  function attach(ws) {
    dbgCount.attach++;
    dbg('ws.attach', { url: String(ws.url || ''), n: dbgCount.attach });
    // 上行帧同样要看：页面是靠 subscribe / transcript 计划按会话"点名"订阅的，
    // 没订阅的会话服务端根本不推 delta——这正是"看不到胶囊"的常见原因。
    try {
      var origSend = ws.send;
      if (typeof origSend === 'function' && !ws.__kimiTpsSendPatched) {
        ws.__kimiTpsSendPatched = true;
        ws.send = function (data) {
          var result = origSend.apply(this, arguments);
          try { observeSubscription(data); } catch (e) { /* 观测不能影响发送 */ }
          dbgCount.send = (dbgCount.send || 0) + 1;
          if (dbgCount.send <= 20) {
            dbg('ws.send', { n: dbgCount.send, head: describeFrame(data) });
          }
          return result;
        };
      }
    } catch (e) { /* 上行观测失败不影响功能 */ }
    ws.addEventListener('message', function (ev) {
      dbgCount.frame++;
      try {
        // 前 60 帧把真实形态记全：类型、长度、顶层键、payload 键、以及解析结果
        if (dbgCount.frame <= 60) {
          var d = ev.data;
          dbg('ws.frame', {
            n: dbgCount.frame,
            kind: typeof d === 'string' ? 'string' : tagOf(d),
            bytes: (typeof d === 'string') ? d.length : (d && d.byteLength) || (d && d.size) || null,
            head: describeFrame(d)
          });
        }
        handleFrame(ev.data);
      } catch (e) {
        dbgCount.err++;
        dbg('ws.frameError', { msg: String(e && e.message), stack: String(e && e.stack).slice(0, 400) });
      }
    });
  }

  /// 只窥探、不改写：尽量把一帧的前若干字节解出来，附顶层键与 payload 键。
  function describeFrame(d) {
    try {
      var text = null;
      if (typeof d === 'string') text = d;
      else if (isArrayBuffer(d)) text = decode(new Uint8Array(d));
      else return '(binary:' + tagOf(d) + ')';
      var head = text.slice(0, isTranscriptOps(text) ? 1200 : 300);
      var keys = null;
      var payloadKeys = null;
      var type = null;
      try {
        var j = JSON.parse(text);
        if (j && typeof j === 'object') {
          keys = Object.keys(j).slice(0, 12);
          type = typeof j.type === 'string' ? j.type : null;
          if (j.payload && typeof j.payload === 'object') payloadKeys = Object.keys(j.payload).slice(0, 14);
        }
      } catch (e) { /* 非完整 JSON：只留 head */ }
      return { type: type, keys: keys, payloadKeys: payloadKeys, head: head };
    } catch (e) { return '(describe failed: ' + String(e && e.message) + ')'; }
  }

  function handleFrame(data) {
    if (typeof data === 'string') return handleText(data);
    // 注意：不能只用 instanceof —— 跨 realm（iframe/沙箱）传来的帧会判定失败，
    // 所以先按 brand 判类型，再退回 tag 判定。
    if (isArrayBuffer(data)) return handleText(decode(new Uint8Array(data)));
    if (isBlob(data)) data.text().then(handleText).catch(function () {});
  }

  var toString = Object.prototype.toString;
  function tagOf(v) { return toString.call(v); }
  function isTranscriptOps(text) { return text.indexOf('transcript.ops') >= 0; }
  function isArrayBuffer(v) {
    return (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) ||
      tagOf(v) === '[object ArrayBuffer]' ||
      (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);
  }
  function isBlob(v) {
    return v && typeof v === 'object' && typeof v.text === 'function' && typeof v.size === 'number';
  }

  var decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;
  function decode(u8) {
    if (decoder) return decoder.decode(u8);
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  function handleText(text) {
    if (!text || text.charCodeAt(0) !== 123 /* '{' */) return;
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    dbgCount.parsed++;
    var type = msg.type;
    if (typeof type !== 'string') return;
    if (type.indexOf('event.') === 0) type = type.slice(6);
    dbgCount.ev++;
    // 前 80 个事件类型全记（漏掉哪个字段、有没有 delta 一眼就能看出来）
    if (dbgCount.ev <= 80) {
      dbg('event', {
        n: dbgCount.ev,
        type: type,
        payloadKeys: (msg.payload && typeof msg.payload === 'object') ? Object.keys(msg.payload).slice(0, 16) : null
      });
    }
    var p = msg.payload;
    var relevant = type === 'transcript.ops' || type === 'transcript.reset' ||
      type.indexOf('turn.') === 0 || type.indexOf('prompt.') === 0 ||
      type === 'assistant.delta' || type === 'thinking.delta';
    if (!relevant) return;
    if (p && ((p.agent_id && p.agent_id !== 'main') || (p.agentId && p.agentId !== 'main'))) return;
    // 无订阅消息时，以第一条有会话 ID 的统计事件作兼容入口。
    // 一旦选定会话，不接受缺少 ID 或来自其它会话的事件。
    if (activeSessionId === null) selectSession(msg.session_id);
    if (activeSessionId === null || msg.session_id !== activeSessionId) return;
    // 真实线格式：kimi web 的流式增量全走 transcript.ops（volatile 帧），
    // 里面的 append op 才是文本增量；权威用量在 step.upsert(completed) 的
    // step.usage / step.timing 上。assistant.delta/thinking.delta 只是服务端
    // 内部事件名，Web 端根本不会收到，这里保留兼容分支以防协议回退。
    if (type === 'transcript.ops' || type === 'transcript.reset') {
      applyTranscriptOps(msg, p);
      return;
    }
    switch (type) {
      case 'turn.started':
      case 'prompt.submitted':
        // 记下用户提交时刻，给「端到端 TTFT」用
        onTurnStarted(p && p.turnId);
        break;
      case 'turn.step.started':
        onStepStarted(p && p.stepId);
        break;
      case 'assistant.delta':
      case 'thinking.delta':
        onDelta(kindOf(type, p), deltaText(p));
        break;
      case 'turn.step.completed':
        onStepCompleted(p);
        break;
      case 'turn.ended':
      case 'turn.step.interrupted':
      case 'prompt.completed':
      case 'prompt.aborted':
        stream = null;
        promptT0 = null;
        scheduleRender();
        break;
      default:
        // server_hello / ping / ack / 工具事件等一律忽略
        break;
    }
  }

  /// transcript.ops 的载荷：{agent_id, ops:[{op:"append",target:{frameId,kind?},text,offset}, …]}
  /// 只认主 agent（子 agent 的流不计入 TPS，否则速率会被并行子任务放大）。
  function applyTranscriptOps(msg, p) {
    if (!p || typeof p !== 'object') return;
    if (p.agent_id && p.agent_id !== 'main') return;
    var ops = p.ops;
    if (!ops) return;
    if (!isArray(ops)) ops = [ops];
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (!op || typeof op !== 'object') continue;
      switch (op.op) {
        case 'append':
          if (!op.target || op.target.type !== 'frame') break;
          if (op.target.stepId && activeStepId && op.target.stepId !== activeStepId) break;
          onDelta(frameKind(op.target, op), typeof op.text === 'string' ? op.text : '');
          break;
        case 'frame.upsert':
          // 只带空串的"建帧"通知：记下 frameId→kind 的映射，增量靠 append
          rememberFrame(op.frame);
          break;
        case 'step.upsert':
          if (!op.step) break;
          if (op.step.state === 'completed') onStepCompleted(op.step);
          else if (op.step.state === 'running') {
            if (completedSteps[op.step.stepId]) break;
            var turnId = op.turnId || op.step.turnId;
            if (turnId && String(turnId) !== activeTurnId) onTurnStarted(turnId);
            onStepStarted(op.step.stepId);
          }
          break;
        case 'meta.merge':
          applyMetaMerge(op.meta);
          break;
        case 'prompt.upsert':
          // prompt 与 turn 通知可能连续到达，不能重复清掉同轮状态。
          if (op.prompt && op.prompt.status === 'running' && promptT0 === null && activeTurnId === null) onTurnStarted();
          break;
        case 'turn.upsert':
          if (op.turn && op.turn.state === 'running') onTurnStarted(op.turn.turnId);
          break;
        default:
          break;
      }
    }
  }

  var frameKinds = Object.create(null);
  function rememberFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (typeof frame.frameId === 'string' && typeof frame.kind === 'string') {
      frameKinds[frame.frameId] = frame.kind;
      // 订阅中途收到已有正文，之前的增量没有完整观测，不能用于学习系数。
      if (stream && totalRaw(stream) === 0 && typeof frame.text === 'string' && frame.text.length) stream.calibratable = false;
    }
  }

  /// append 的 target 只带 frameId，kind 得从 frame.upsert 或 frameId 规律推。
  /// 都不确定时按正文（text）算——宁可把推理算成正文，也不要漏掉增量。
  function frameKind(target, op) {
    var id = target && target.frameId;
    var kind = (id && frameKinds[id]) || (typeof op.kind === 'string' ? op.kind : null);
    if (!kind && target && typeof target.kind === 'string') kind = target.kind;
    return kind === 'thinking' ? 'thinking' : 'text';
  }

  /// agent.phase 的 kind=streaming 带 stream:"thinking"|"assistant"，是权威的
  /// 流阶段信号；agent.usage.currentTurn.output 仅用于本轮用量展示。
  function applyMetaMerge(meta) {
    if (!meta || typeof meta !== 'object') return;
    var agent = meta.agent;
    if (!agent || typeof agent !== 'object') return;
    var phase = agent.phase;
    if (phase && typeof phase === 'object') {
      if (phase.kind === 'streaming' && !stream) {
        onStepStarted(null, false);
        dbgCount.phaseStream = (dbgCount.phaseStream || 0) + 1;
        if (dbgCount.phaseStream <= 4) dbg('phase.streaming', { stream: phase.stream, turnId: phase.turnId, step: phase.step });
      } else if (phase.kind === 'ended') {
        stream = null;
        scheduleRender();
      }
    }
    if (agent.usage && agent.usage.currentTurn) {
      currentTurnUsage = agent.usage.currentTurn;
      if (dbgCount.usageMeta === undefined) dbgCount.usageMeta = 0;
      if (dbgCount.usageMeta++ < 4) dbg('meta.usage', agent.usage.currentTurn);
    }
  }

  var currentTurnUsage = null;

  function isArray(v) { return tagOf(v) === '[object Array]'; }

  function deltaText(p) {
    if (!p) return '';
    var d = p.delta;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object') {
      if (typeof d.text === 'string') return d.text;
      if (typeof d.thinking === 'string') return d.thinking;
    }
    if (typeof p.text === 'string') return p.text;
    return '';
  }

  // ------------------------------------------------------------------- 渲染
  var display = { hidden: false, el: null, value: null, sub: null, dot: null };
  try { display.hidden = localStorage.getItem(LS.hidden) === '1'; } catch (e) {}

  function fmtTps(v) { return v >= 100 ? String(Math.round(v)) : v.toFixed(1); }
  function fmtMs(v) { return v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms'; }

  function ensureEl() {
    if (display.el && display.el.isConnected) return display.el;
    if (!document.body) { dbg('el.noBody', { readyState: document.readyState }); return null; }
    var box = document.createElement('div');
    box.id = '__kimi_tps__';
    box.style.cssText = [
      'position:fixed', 'z-index:2147483646', 'right:14px', 'bottom:14px',
      'display:none', 'align-items:baseline', 'gap:8px',
      'padding:5px 10px', 'border-radius:999px',
      'font:12px/1.35 ui-monospace,Consolas,"Microsoft YaHei",monospace',
      'background:rgba(22,26,36,.88)', 'color:#e6e8ee',
      'border:1px solid rgba(255,255,255,.10)',
      'box-shadow:0 6px 18px rgba(0,0,0,.35)',
      'cursor:default', 'user-select:none', 'pointer-events:auto'
    ].join(';');

    var dot = document.createElement('span');
    dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#3d6bff;display:inline-block;flex:0 0 auto';

    var val = document.createElement('span');
    val.style.cssText = 'font-weight:600;letter-spacing:.02em';

    var sub = document.createElement('span');
    sub.style.cssText = 'color:#9aa1ad;font-size:11px';

    box.appendChild(dot);
    box.appendChild(val);
    box.appendChild(sub);
    document.body.appendChild(box);
    applyPos(box);
    var rect = box.getBoundingClientRect();
    dbg('el.created', {
      appEl: !!document.getElementById('app'),
      childCount: document.body.childElementCount,
      bodyTag: document.body.tagName,
      rect: { l: Math.round(rect.left), t: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      innerW: window.innerWidth, innerH: window.innerHeight
    });

    // 双击复位，拖拽移动
    box.addEventListener('dblclick', function () {
      try { localStorage.removeItem(LS.pos); } catch (e) {}
      box.style.left = '';
      box.style.top = '';
      box.style.right = '14px';
      box.style.bottom = '14px';
    });
    box.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      var r = box.getBoundingClientRect();
      var offX = ev.clientX - r.left;
      var offY = ev.clientY - r.top;
      function move(e2) {
        var x = Math.max(0, Math.min(window.innerWidth - r.width, e2.clientX - offX));
        var y = Math.max(0, Math.min(window.innerHeight - r.height, e2.clientY - offY));
        box.style.left = x + 'px';
        box.style.top = y + 'px';
        box.style.right = 'auto';
        box.style.bottom = 'auto';
      }
      function up() {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        try {
          localStorage.setItem(LS.pos, JSON.stringify({ left: box.style.left, top: box.style.top }));
        } catch (e) {}
      }
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      ev.preventDefault();
    });

    display.el = box;
    display.value = val;
    display.sub = sub;
    display.dot = dot;
    return box;
  }

  function applyPos(box) {
    try {
      var p = JSON.parse(localStorage.getItem(LS.pos) || 'null');
      if (p && p.left && p.top) {
        box.style.left = p.left;
        box.style.top = p.top;
        box.style.right = 'auto';
        box.style.bottom = 'auto';
      }
    } catch (e) {}
  }

  var rafPending = false;
  /// 有界的渲染轨迹（只读排障用；只在 DEBUG 下写入，最多 40 条）
  var dbgTrace = [];
  function scheduleRender() {
    // 注意：这里刻意不写诊断日志——render 是最热的路径，而 dbg 会在 flush 时
    // 再排一个定时器，二者叠加会互相喂饭（测试环境里能放大成泵循环）。
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; render(); });
  }

  function render(force) {
    var box = ensureEl();
    // 热路径只累加计数，不打日志（dbg 会排定时器，二者叠加会互相喂饭）
    dbgCount.render = (dbgCount.render || 0) + 1;
    if (!box) return;
    if (display.hidden) { box.style.display = 'none'; return; }

    var now = perfNow();
    var live = windowRate();
    var text = null;
    var sub = '';
    var color = '#3d6bff';
    var pulse = false;

    // 优先级：实时速率 > 定稿值 > 生成中（含"已出 N tok"）。定稿值只在没有
    // 新的流时才盖住"生成中"，否则连续多步会把刚出的数字顶掉。
    if (live && now - lastDeltaAt < CFG.idleHideMs) {
      text = '≈ ' + fmtTps(live.tps) + ' tok/s';
      sub = '实时估算 · ' + Math.round(live.tok) + ' tok';
      if (stream && stream.ttft !== null) sub += ' · 首 token ' + fmtMs(stream.ttft);
      pulse = true;
    } else if (lastFinal && now - lastFinal.t < CFG.finalLingerMs && !stream) {
      if (lastFinal.tps === null) {
        // 流太短不报速率，但把真实用量亮出来
        text = lastFinal.output + ' tok';
        sub = '流太短(' + fmtMs(lastFinal.streamMs) + ')，不报 TPS';
      } else {
        text = fmtTps(lastFinal.tps) + ' tok/s';
        sub = lastFinal.output + ' tok / ' + fmtMs(lastFinal.streamMs);
        if (lastFinal.ttft) sub += ' · TTFT ' + fmtMs(lastFinal.ttft.ms) + '(' + lastFinal.ttft.src + ')';
        if (lastFinal.decodeMs) sub += ' · 服务端解码 ' + fmtMs(lastFinal.decodeMs);
      }
      color = '#4ad07a';
    } else if (stream) {
      // 生成中：TTFT 可能十几秒，这段等待期也必须看得见浮层
      var outSoFar = usageOutput(currentTurnUsage);
      // 注意：t0 可能是 0（页面刚加载时 performance.now() 就是 0），不能用 `||`
      // 兜底，否则 0 会被当成"没值"，等待时长恒为 0。
      var waited = stream.ttft !== null ? stream.ttft
        : now - (stream.t0 !== null && stream.t0 !== undefined ? stream.t0 : now);
      text = live ? '≈ ' + fmtTps(live.tps) + ' tok/s' : '生成中…';
      sub = '首 token ' + fmtMs(waited);
      if (DEBUG && dbgTrace.length < 40) {
        dbgTrace.push({ now: now, t0: stream.t0, ttft: stream.ttft, waited: waited, sub: sub });
      }
      if (outSoFar) sub += ' · 本轮已出 ' + outSoFar + ' tok';
      // 只有速率在活（真有增量）时才做脉冲动画；纯等待交给 watchdog 每秒刷新，
      // 否则会一直自调度空转刷帧。
      if (live) pulse = true;
      else watchdog(250);
    } else if (force) {
      // 强制显示（排障用）：没有数据也把胶囊亮出来，证明脚本确实挂上了
      text = 'TPS 就绪';
      sub = '等待生成 · Ctrl+Alt+T 隐藏';
      color = '#9aa1ad';
    } else {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'inline-flex';
    display.value.textContent = text;
    display.sub.textContent = sub;
    display.dot.style.background = color;
    display.dot.style.opacity = pulse ? String(0.45 + 0.55 * Math.abs(Math.sin(now / 420))) : '1';

    // 脉冲动画只在真有增量流动时自调度；流卡住（比如等 TTFT 十几秒）时
    // 由 watchdog 定时唤醒，避免空转刷帧。
    if (pulse) {
      // 只有真有增量在流动时才逐帧自调度（脉冲动画）；等 TTFT 时交给 watchdog
      if (now - lastDeltaAt < CFG.idleHideMs) scheduleRender();
      else watchdog(1000);
    }
  }

  var watchdogTimer = null;
  function watchdog(ms) {
    if (watchdogTimer !== null) return;
    watchdogTimer = setTimeout(function () {
      watchdogTimer = null;
      scheduleRender();
    }, ms);
  }

  document.addEventListener('keydown', function (ev) {
    if (ev.ctrlKey && ev.altKey && (ev.key === 't' || ev.key === 'T')) {
      display.hidden = !display.hidden;
      try { localStorage.setItem(LS.hidden, display.hidden ? '1' : '0'); } catch (e) {}
      if (display.el) display.el.style.display = display.hidden ? 'none' : 'inline-flex';
      if (!display.hidden) scheduleRender();
      ev.preventDefault();
    }
  }, true);

  // 调试入口：数字不对时可在控制台看当前校准系数
  window.__kimiTps = {
    config: CFG,
    calibration: cal,
    debug: dbgCount,
    dump: function () { return dbgRing; },
    renderTrace: function () { return dbgTrace.slice(); },
    resetCalibration: function () { cal.text = 1; cal.thinking = 1; saveCal(); },
    estimate: estimateTokens,
    /// show() 强制亮出浮层（不等 token 事件），用来区分「脚本没跑」和「没数据」
    show: function () {
      display.hidden = false;
      try { localStorage.setItem(LS.hidden, '0'); } catch (e) {}
      render(true);
      dbg('show', snapshot());
      return snapshot();
    },
    /// snapshot() 返回浮层的实际几何与文本，供外部核对是否真的可见
    snapshot: snapshot,
    state: function () {
      return { stream: stream, final: lastFinal, window: windowRate() };
    }
  };

  function snapshot() {
    var box = display.el;
    if (!box) return { exists: false };
    var r = box.getBoundingClientRect();
    var cs = window.getComputedStyle(box);
    return {
      exists: true,
      inlineDisplay: box.style.display,
      computedDisplay: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      zIndex: cs.zIndex,
      text: display.value ? display.value.textContent : null,
      sub: display.sub ? display.sub.textContent : null,
      rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.left < window.innerWidth
    };
  }

  function boot(reason) {
    dbg('boot', {
      reason: reason,
      readyState: document.readyState,
      // 关键判据：若这里已经有 /api/v1/ws 资源记录，说明页面的 socket 在本脚本
      // 执行前就建好了——那 hook 就漏了，得改成在 WS 原型上挂钩子。
      wsResourceSeen: (function () {
        try {
          var rs = performance.getEntriesByType('resource') || [];
          for (var i = 0; i < rs.length; i++) {
            if (String(rs[i].name).indexOf('/api/v1/ws') >= 0) return rs[i].name;
          }
        } catch (e) {}
        return null;
      })(),
      wsPatched: !!(window.WebSocket && window.WebSocket.__kimiTpsPatched),
      hasTauri: !!(window.__TAURI__ && window.__TAURI__.event),
      hasApp: !!document.getElementById('app'),
      bodyReady: !!document.body,
      href: String((typeof location !== 'undefined' && location && location.href) || '').replace(/#.*$/, '#<token>')
    });
    scheduleRender();
    dbg('boot.rendered', snapshot());
    // 心跳：每 15 秒报一次浮层的真实几何与计数。排障时"胶囊到底在不在屏幕
    // 上"不该靠推断——这条能让外部直接看到 w/h 是否非 0、文本是什么。
    if (DEBUG) {
      setInterval(function () {
        dbg('heartbeat', {
          snap: snapshot(),
          counts: dbgCount,
          href: String((typeof location !== 'undefined' && location && location.href) || '').replace(/#.*$/, ''),
          stream: !!stream,
          hasFinal: !!lastFinal
        });
      }, 15000);
    }
  }

  // 页面是 SPA，DOM 就绪后 body 一直在
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot('DOMContentLoaded'); });
  } else {
    boot('immediate:' + document.readyState);
  }
})();
