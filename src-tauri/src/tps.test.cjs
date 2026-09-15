/* TPS 注入脚本的离屏验收：用 vm 造一个假浏览器 + 假 WebSocket，
 * 按真实 kimi web 线格式喂事件帧，断言浮层文本与校准系数。
 *   node src-tauri/src/tps.test.cjs     （与 tps.js 同目录即可）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'tps.js'), 'utf8');

let clock = 0;
/// onBeforeRun(ctx)：脚本执行前的钩子，用来预置 __TAURI__ 之类的东西
/// （自诊断测试必须抢在脚本跑之前挂上事件通道）。
function makeSandbox(onBeforeRun) {
  // 真实环境里定时器与 rAF 是两条独立队列：这里照搬，才能如实反映行为——
  // rAF 一帧一跑、setTimeout 只在显式 drain 时跑完（诊断 flush 就是靠它）。
  const timers = [];
  const frames = [];
  function drain() {
    // 先给 rAF 一点帧预算，再把定时器队列跑干（各自都有硬上限）
    let guard = 0;
    while (timers.length && guard++ < 5000) timers.shift()();
    let f = 0;
    while (frames.length && f++ < 240) frames.shift()();
  }
  function fakeEl(tag) {
    const el = {
      tagName: tag, children: [], style: {}, textContent: '', isConnected: true,
      title: '',
      attrs: {},
      appendChild(c) { this.children.push(c); return c; },
      addEventListener() {}, removeEventListener() {},
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'title') this.title = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 24 }; }
    };
    el.style = new Proxy({ cssText: '' }, {
      set(t, k, v) { t[k] = v; if (k === 'cssText') t.cssText = v; return true; }
    });
    return el;
  }
  const store = new Map();
  const body = fakeEl('body');
  const doc = {
    readyState: 'complete',
    body,
    documentElement: fakeEl('html'),
    createElement: fakeEl,
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {}
  };
  const sandbox = {
    console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    // rAF 模拟"每帧一次"：一帧只跑一个回调，且总量受限（等价真实浏览器的帧率上限）
    requestAnimationFrame: (fn) => {
      if (frames.length < 8) frames.push(fn);
      return frames.length;
    },
    // 心跳定时器测试里不跑（否则 drain 永不停）
    setInterval: () => 0,
    clearInterval: () => {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    TextDecoder,
    TextEncoder: class { encode(s) { return new Uint8Array(Buffer.from(s, 'utf8')); } },
    Blob: class Blob {},
    // 只回读内联样式 + 少量默认值，够 snapshot() 断言用
    getComputedStyle: (el) => new Proxy({}, {
      get: (_t, k) => {
        const inline = (el.style && el.style[k]) || '';
        if (inline) return inline;
        if (k === 'visibility') return 'visible';
        if (k === 'opacity') return '1';
        if (k === 'display') return 'block';
        return '';
      }
    }),
    // 让 boot() 里的「页面是否已建过 WS」探测有东西可探
    performance: {
      now: () => clock,
      getEntriesByType: () => (sandbox.__wsResources || [])
    },
    document: doc,
    __store: store,
    drain,
    queues: () => ({ timers: timers.length, frames: frames.length })
  };
  sandbox.window = sandbox;
  sandbox.WebSocket = makeFakeWS(sandbox);
  vm.createContext(sandbox);
  if (typeof onBeforeRun === 'function') onBeforeRun(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: 'tps.js' });
  drain();
  return sandbox;
}

const sockets = [];
function makeFakeWS(sandbox) {
  class FakeWS {
    constructor(url) {
      this.url = String(url);
      this.listeners = {};
      this.readyState = 1;
      sockets.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    send(data) { this.sent = this.sent || []; this.sent.push(data); }
    close() {}
    emit(obj, asBinary) {
      const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const frame = asBinary
        ? (() => { const b = new TextEncoder().encode(data); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })()
        : data;
      for (const fn of this.listeners.message || []) fn({ data: frame });
      sandbox.drain();   // 帧送达后立刻把渲染与诊断批次跑完，便于断言
    }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  return FakeWS;
}

const snap = (sb) => {
  const box = sb.document.body.children.find((c) => c.id === '__kimi_tps__');
  if (!box) return { hidden: true };
  return {
    hidden: box.style.display === 'none',
    value: box.children[1].textContent,
    sub: box.children[2].textContent,
    title: box.title || box.attrs.title || ''
  };
};

function ev(type, payload) {
  return { type: 'event.' + type, seq: 1, session_id: 's1', payload };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 收集脚本经 Tauri 事件通道发上来的自诊断批次（用于断言「黑匣子」可读）
function collectDebug(sb) {
  const batches = [];
  sb.__TAURI__ = { event: { emit: (name, payload) => batches.push({ name, payload }) } };
  return {
    batches,
    lines() { return batches.flatMap((b) => (b.payload && b.payload.lines) || []); },
    tags() { return this.lines().map((l) => l.tag); }
  };
}
/// 直接构造一个「自带诊断收集」的沙箱：加载顺序与真实初始化脚本一致
function makeDebugSandbox() {
  const box = { batches: [] };
  const sb = makeSandbox((ctx) => {
    ctx.__TAURI__ = { event: { emit: (name, payload) => box.batches.push({ name, payload }) } };
  });
  return Object.assign(box, {
    sb,
    lines() { return box.batches.flatMap((b) => (b.payload && b.payload.lines) || []); },
    tags() { return this.lines().map((l) => l.tag); }
  });
}

// ---------------------------------------------------------------- 1. 估算器
{
  const sb = makeSandbox();
  const est = sb.window.__kimiTps.estimate;
  check('CJK 每字 1 token', est('你好世界') === 4, 'got ' + est('你好世界'));
  check('拉丁词按 /4', Math.abs(est('hello world') - 2.5) < 1e-9, 'got ' + est('hello world'));
  check('空串为 0', est('') === 0);
  check('数字与下划线归入词', est('foo_bar123') === 2.5, 'got ' + est('foo_bar123'));
}

// ---------------------------------------------------------------- 2. 实时窗口
{
  sockets.length = 0;
  clock = 0;
  const sb = makeSandbox();
  const ws = new sb.window.WebSocket('http://127.0.0.1:1/api/v1/ws?client_id=abc');
  check('只 hook /api/v1/ws', sockets.length === 1 && /\/api\/v1\/ws/.test(ws.url));

  ws.emit({ type: 'server_hello', payload: {} });
  ws.emit(ev('turn.step.started', { agentId: 'main', turnId: 1, step: 1 }));
  // 每 200ms 到达 20 个汉字。首帧只定基准（它的 token 不进分子），
  // 因此后四帧 = 80tok / 800ms。
  for (let i = 0; i < 5; i++) {
    if (i) clock += 200;
    ws.emit(ev('assistant.delta', { agentId: 'main', turnId: 1, delta: '一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾'.slice(0, 20) }));
  }
  const live = snap(sb);
  const st = sb.window.__kimiTps.state();
  check('实时值已显示', !live.hidden && /tok\/s/.test(live.value), JSON.stringify(live));
  check('实时值的分子分母使用同一区间', !!st.window && Math.abs(st.window.tps - 100) < 0.5,
    'window=' + JSON.stringify(st.window) + ' (期望 80tok/0.8s=100)');
  // 该校验只针对「首帧是否进了分子」：5 帧各 20 个估 token，前 4 帧之后的
  // 窗口应只含后 4 帧（80 个原始单位 × 当前系数），而不是 100 × 系数。
  // 系数会经 localStorage 在用例间继承，所以按系数推算期望值。
  const calText = sb.window.__kimiTps.calibration.text;
  check('首帧 token 只作基准、不进实时分子',
    !!st.window && Math.abs(st.window.tok - 80 * calText) < 1e-6 && st.window.tok < 100 * calText,
    'tok=' + (st.window && st.window.tok) + ' cal=' + calText + ' (期望 ' + (80 * calText) + '，含首帧会是 ' + (100 * calText) + ')');
  check('实时值带 ≈ 前缀', live.value.indexOf('≈') === 0, live.value);
  check('实时副行给生成时间', /^生成 [\d.]+(ms|s)$/.test(live.sub), live.sub);
}

// ------------------------------------------------------------ 3. 定稿与自校准
{
  sockets.length = 0;
  clock = 0;
  const sb = makeSandbox();
  const ws = new sb.window.WebSocket('ws://127.0.0.1:1/api/v1/ws?client_id=abc');

  // 第 1 步：估算 100 tok，真实 output 60 → 系数 0.6
  ws.emit(ev('turn.started', {}));
  ws.emit(ev('turn.step.started', {}));
  for (let i = 0; i < 5; i++) {
    ws.emit(ev('assistant.delta', { delta: '一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾'.slice(0, 20) }));
    clock += 200;
  }
  ws.emit(ev('turn.step.completed', {
    usage: { inputOther: 1000, output: 60, inputCacheRead: 0, inputCacheCreation: 0 },
    llmStreamDurationMs: 1500, llmFirstTokenLatencyMs: 320, llmServerDecodeMs: 1180
  }));
  const fin = snap(sb);
  check('定稿显示权威 TPS', Math.abs(parseFloat(fin.value) - 40) < 0.05, fin.value);
  check('定稿副行 = 整轮输出/生成时间/TTFT 三项',
    /^整轮输出 60 tok · 生成 1\.18s · TTFT 320ms$/.test(fin.sub), fin.sub);
  check('TTFT 用服务端自报值（320ms 而不是端到端的 1000ms）', /TTFT 320ms/.test(fin.sub), fin.sub);
  check('生成时间用服务端解码时间 1.18s（不是流式总时长 1.50s）',
    /生成 1\.18s/.test(fin.sub), fin.sub);
  const cal1 = sb.window.__kimiTps.calibration.text;
  check('自校准下调系数到 0.6', Math.abs(cal1 - 0.6) < 1e-6, 'cal=' + cal1);
  check('校准已落盘', /"text":0\.6/.test(sb.__store.get('kimi.tps.cal.v2')), sb.__store.get('kimi.tps.cal.v2'));

  // 第 2 步：同样文本，校准后扣掉首帧的区间速率应为 80*0.6/0.8 = 60
  ws.emit(ev('turn.step.started', {}));
  for (let i = 0; i < 5; i++) {
    if (i) clock += 200;
    ws.emit(ev('assistant.delta', { delta: '一二三四五六七八九十壹贰叁肆伍陆柒捌玖拾'.slice(0, 20) }));
  }
  const st2 = sb.window.__kimiTps.state();
  check('校准后实时值随之缩小', !!st2.window && Math.abs(st2.window.tps - 60) < 0.5, 'window=' + JSON.stringify(st2.window));
}

// -------------------------------------------------------- 4. 思考流 / 多帧形态
{
  sockets.length = 0;
  clock = 0;
  const sb = makeSandbox();
  const ws = new sb.window.WebSocket('ws://127.0.0.1:1/api/v1/ws?client_id=abc');
  ws.emit(ev('turn.step.started', {}));
  ws.emit(ev('thinking.delta', { delta: '一二三四五六七八九十' }));
  clock += 300;
  ws.emit(ev('assistant.delta', { delta: { text: '更多正文内容' } }));
  clock += 300;
  ws.emit(ev('assistant.delta', { delta: '第三帧撑开窗口跨度' }));
  clock += 300;
  const st = sb.window.__kimiTps.state();
  check('thinking.delta 计入窗口', !!st.window && st.window.tok > 0, JSON.stringify(st.window));
  check('对象形态 delta.text 兼容', st.stream.byKind.text.raw === 15, JSON.stringify(st.stream.byKind));
  check('thinking 与 text 分开累计', st.stream.byKind.thinking.raw === 10, JSON.stringify(st.stream.byKind));

  // 二进制帧（kimi 前端 binaryType=arraybuffer 的实际形态）也要能解析
  const before = st.window.tok;
  ws.emit(ev('assistant.delta', { delta: '二进制帧也要算' }), true);
  clock += 100;
  const st2 = sb.window.__kimiTps.state();
  check('ArrayBuffer 帧兼容', !!st2.window && st2.window.tok > before, before + ' → ' + (st2.window && st2.window.tok));
}

// ------------------------------------------------------------ 5. 稳健性
{
  sockets.length = 0;
  clock = 0;
  const sb = makeSandbox();
  const ws = new sb.window.WebSocket('ws://127.0.0.1:1/api/v1/ws?client_id=abc');
  for (const bad of ['', 'not json', '{', '[]', '{"type":123}', '{"type":"event.ping"}',
    '{"type":"event.assistant.delta"}', '{"type":"event.turn.step.completed","payload":{}}',
    '{"type":"event.turn.step.completed","payload":{"usage":{},"llmStreamDurationMs":10}}']) {
    let threw = false;
    try { ws.listeners.message[0]({ data: bad }); } catch (e) { threw = true; }
    if (threw) check('坏帧不抛异常: ' + JSON.stringify(bad).slice(0, 40), false);
  }
  check('脏数据全部安全吞掉', true);
  check('未 hook 的其它 socket 不受影响',
    new sb.window.WebSocket('ws://127.0.0.1:2/other').listeners.message === undefined);

  // 短流不报 TPS（与 TUI MIN_STREAM_MS_FOR_TPS 同义），但用量仍要亮出来
  const sb2 = makeSandbox();
  const ws2 = new sb2.window.WebSocket('ws://127.0.0.1:1/api/v1/ws?client_id=abc');
  ws2.emit(ev('turn.step.started', {}));
  ws2.emit(ev('assistant.delta', { delta: '一二三' }));
  ws2.emit(ev('turn.step.completed', { usage: { output: 3 }, llmStreamDurationMs: 120 }));
  const shortView = snap(sb2);
  check('过短的流不报 TPS', !shortView.hidden && !/tok\/s/.test(shortView.value), JSON.stringify(shortView));
  check('过短的流仍显示真实用量', /3 tok/.test(shortView.value), JSON.stringify(shortView));
}

// ------------------------------------------------- 6. 自诊断通道（排障用黑匣子）
{
  sockets.length = 0;
  clock = 0;
  const dbg = makeDebugSandbox();         // __TAURI__ 在脚本执行前就挂好
  const sb = dbg.sb;

  check('boot 事件被上报', dbg.tags().indexOf('boot') >= 0, dbg.tags().join(','));
  const boot = dbg.lines().find((l) => l.tag === 'boot');
  check('boot 带 DOM/hook 事实', !!boot && boot.d.bodyReady === true && boot.d.hasApp === false,
    JSON.stringify(boot && boot.d));
  check('boot 记录 WS 是否已在页面建过', !!boot && 'wsResourceSeen' in boot.d, JSON.stringify(boot && boot.d.wsResourceSeen));
  check('boot 记录初始化脚本是否真的改了 WebSocket', !!boot && boot.d.wsPatched === true, String(boot && boot.d.wsPatched));

  const ws = new sb.window.WebSocket('ws://127.0.0.1:1/api/v1/ws?client_id=abc');
  ws.emit({ type: 'server_hello', payload: { hi: 1 } });
  ws.emit(ev('turn.step.started', {}));
  ws.emit(ev('assistant.delta', { delta: '一二三四五' }));
  clock += 500;
  ws.emit(ev('turn.step.completed', {
    usage: { inputOther: 10, output: 8, inputCacheRead: 0, inputCacheCreation: 0 },
    llmStreamDurationMs: 800, llmFirstTokenLatencyMs: 100
  }));

  const tags = dbg.tags();
  check('WS attach 被记录', tags.indexOf('ws.attach') >= 0, tags.join(','));
  check('帧形态被记录（含类型与载荷键）', tags.indexOf('ws.frame') >= 0, tags.join(','));
  const frame = dbg.lines().find((l) => l.tag === 'ws.frame' && l.d && l.d.head && l.d.head.type);
  check('帧记录带解析出的类型与前缀', !!frame && frame.d.head.type === 'server_hello' && typeof frame.d.head.head === 'string',
    JSON.stringify(frame && frame.d.head));
  check('事件类型被记录', tags.indexOf('event') >= 0, tags.join(','));
  check('delta 与 step.completed 被记录',
    tags.indexOf('delta') >= 0 && tags.indexOf('step.completed') >= 0, tags.join(','));
  const sc = dbg.lines().find((l) => l.tag === 'step.completed');
  check('step.completed 记录真实 output/streamMs', !!sc && sc.d.output === 8 && sc.d.streamMs === 800,
    JSON.stringify(sc && sc.d));

  // show()/snapshot()：用来区分「脚本没跑」和「没数据」
  const shown = sb.window.__kimiTps.show();
  check('show() 能强制亮出浮层', shown.exists && shown.computedDisplay === 'inline-flex',
    JSON.stringify({ exists: shown.exists, display: shown.computedDisplay }));
  check('snapshot() 报告几何与可见性', typeof shown.rect.w === 'number' && 'inViewport' in shown,
    JSON.stringify(shown));
  // 计数从「上报的 payload」判定：宿主读到的就是这个，比跨 realm 读对象可靠
  const counts = dbg.batches.map((b) => b.payload && b.payload.counts).filter(Boolean).pop() || {};
  check('诊断计数随帧递增（attach/frame/parsed/ev）',
    counts.attach >= 1 && counts.frame >= 4 && counts.parsed >= 3 && counts.ev >= 3,
    JSON.stringify(counts));
  check('自诊断走的是 Tauri 事件通道', dbg.batches.every((b) => b.name === 'kimi-tps-debug'),
    JSON.stringify(Array.from(new Set(dbg.batches.map((b) => b.name)))));

  // 上行帧（subscribe / transcript 计划）也要能被观测到，且不破坏原 send 行为
  ws.send(JSON.stringify({ type: 'subscribe', payload: { session_ids: ['s1'] } }));
  sb.drain();
  const sendLine = dbg.lines().find((l) => l.tag === 'ws.send');
  check('上行帧被记录', !!sendLine && sendLine.d.head.type === 'subscribe',
    JSON.stringify(sendLine && sendLine.d.head));
  check('包装 send 不丢数据', Array.isArray(ws.sent) && ws.sent.length === 1,
    JSON.stringify(ws.sent));
}

// ------------------- 7. 真实线格式：transcript.ops（从实机抓包逐字回放）
// 这些帧是从运行中的 kimi web（v0.42.0）抓到后原样抄下来的：页面收不到
// assistant.delta，增量全在 transcript.ops 的 append op 里。
{
  sockets.length = 0;
  clock = 0;
  const dbg = makeDebugSandbox();   // 顺便确认这一路也有诊断输出
  const sb = dbg.sb;                // 事件与断言必须落在同一个沙箱上
  const ws = new sb.window.WebSocket('ws://127.0.0.1:1/api/v1/ws?client_id=web_x');

  const opsFrame = (ops, seq) => ({
    type: 'transcript.ops', seq, epoch: 'ep_x', volatile: true,
    session_id: 'session_x', timestamp: new Date().toISOString(),
    payload: { type: 'transcript.ops', agent_id: 'main', ops, seq: 1 }
  });

  // 1) 用户提交（服务端会在 prompt.upsert(status=running) 时开始计时）
  ws.emit(opsFrame([{ op: 'turn.upsert', turn: { kind: 'turn', turnId: 't2', state: 'running', prompt: '回复OK', startedAt: 'x' } },
    { op: 'meta.merge', meta: { activity: 'turn' } }], 27));
  ws.emit(opsFrame([{ op: 'step.upsert', turnId: 't2', step: { kind: 'step', stepId: 't2.1', turnId: 't2', ordinal: 1, state: 'running' } }], 31));

  // 1b) TTFT 可能长达十几秒：这段"等首 token"的窗口里浮层也必须可见，
  //     否则用户根本来不及看到（实机就是这样漏掉的）。
  //     （不推进时钟——先验证"生成中"这一态本身）
  const waiting0 = snap(sb);
  check('等待首 token 时 stream 已激活', !!sb.window.__kimiTps.state().stream,
    JSON.stringify(sb.window.__kimiTps.state().stream));
  check('等待首 token 时浮层已可见', !waiting0.hidden, JSON.stringify(waiting0));
  check('等待期文案为"生成中"', waiting0.value === '生成中…', JSON.stringify(waiting0));

  // 等 TTFT 期间没有任何增量事件，靠 watchdog 定期刷新"已等待 Ns"。
  // 注意此刻 t0 恰好是 0（页面刚加载时 performance.now() 就是 0）——这正是当初把
  // 兜底写成 `t0 || now` 的 falsy 陷阱、导致等待时长恒为 0 的那个场景。
  clock += 3000;
  sb.drain();
  const waiting = snap(sb);
  check('等待期显示已等待时长（t0=0 不能退化成 0ms）', /首 token 3\.00s/.test(waiting.sub),
    waiting.sub);

  // 本轮用量（meta.merge.agent.usage.currentTurn）也要反映出来
  ws.emit(opsFrame([{ op: 'meta.merge', meta: { agent: { usage: { total: { output: 232 }, currentTurn: { inputOther: 160, output: 12 } } } } }], 32));
  const waiting2 = snap(sb);
  check('等待期副行只给首 token 等待', /^等待首 token /.test(waiting2.sub), waiting2.sub);

  // 2) 推理帧 + 正文帧，各 4 次 append（每次 5 个汉字），间隔 200ms
  ws.emit(opsFrame([
    { op: 'frame.upsert', turnId: 't2', stepId: 't2.1', frame: { kind: 'thinking', frameId: 't2.1.f1', text: '' } },
    { op: 'append', target: { type: 'frame', turnId: 't2', stepId: 't2.1', frameId: 't2.1.f1' }, offset: 0, text: '用户要求回复' }
  ], 32));
  ws.emit(opsFrame([{ op: 'meta.merge', meta: { agent: { phase: { kind: 'streaming', turnId: 2, step: 1, stream: 'thinking' } } } }], 32));
  clock += 200;
  ws.emit(opsFrame([
    { op: 'frame.upsert', turnId: 't2', stepId: 't2.1', frame: { kind: 'text', frameId: 't2.1.f2', role: 'assistant', text: '' } },
    { op: 'append', target: { type: 'frame', turnId: 't2', stepId: 't2.1', frameId: 't2.1.f2' }, offset: 0, text: '好的明白了' }
  ], 32));
  ws.emit(opsFrame([{ op: 'meta.merge', meta: { agent: { phase: { kind: 'streaming', turnId: 2, step: 1, stream: 'assistant' } } } }], 32));
  clock += 200;
  ws.emit(opsFrame([{ op: 'append', target: { type: 'frame', frameId: 't2.1.f2' }, offset: 5, text: '我这就处理' }], 32));
  clock += 200;
  ws.emit(opsFrame([{ op: 'append', target: { type: 'frame', frameId: 't2.1.f1' }, offset: 6, text: '继续推理中' }], 32));
  clock += 200;

  const live = sb.window.__kimiTps.state();
  check('append op 被算成增量', !!live.window && live.window.tok > 0, JSON.stringify(live.window));
  check('frame.upsert 建的帧能按 kind 归类',
    live.stream && live.stream.byKind.thinking && live.stream.byKind.thinking.raw === 11,
    JSON.stringify(live.stream && live.stream.byKind));
  check('append 只给 frameId 也能归类（靠 frame.upsert 记的映射）',
    live.stream && live.stream.byKind.text && live.stream.byKind.text.raw === 10,
    JSON.stringify(live.stream && live.stream.byKind));
  const liveView = snap(sb);
  check('实时胶囊已亮起', !liveView.hidden && /^≈ /.test(liveView.value), JSON.stringify(liveView));

  // 3) 本轮用量（meta.merge.agent.usage.currentTurn）→ 生成中副行
  ws.emit(opsFrame([{ op: 'meta.merge', meta: { agent: { usage: { total: { output: 232 }, currentTurn: { inputOther: 160, output: 22 } } } } }], 32));

  // 4) 定稿：step.upsert(completed) 带 usage + timing（真实字段）
  ws.emit(opsFrame([
    { op: 'frame.upsert', turnId: 't2', stepId: 't2.1', frame: { kind: 'text', frameId: 't2.1.f2', role: 'assistant', text: 'OK' } },
    {
      op: 'step.upsert', turnId: 't2',
      step: {
        kind: 'step', stepId: 't2.1', turnId: 't2', ordinal: 1, state: 'completed',
        startedAt: '2026-09-15T03:04:39.074Z', endedAt: '2026-09-15T03:05:02.301Z',
        usage: { inputOther: 160, output: 22, inputCacheRead: 20224, inputCacheCreation: 0 },
        finishReason: 'end_turn',
        timing: {
          llmFirstTokenLatencyMs: 22390, llmStreamDurationMs: 823, llmRequestBuildMs: 6,
          llmServerFirstTokenMs: 22384, llmServerDecodeMs: 822, llmClientConsumeMs: 1, llmClientBlockedMs: 27
        }
      }
    }
  ], 32));

  const fin = snap(sb);
  check('真实 payload 算出权威 TPS（22tok/0.823s≈26.7）', /^26\.7 tok\/s$/.test(fin.value), JSON.stringify(fin));
  check('定稿副行 = 整轮输出/生成时间/TTFT',
    /^整轮输出 22 tok · 生成 822ms · TTFT 22\.39s$/.test(fin.sub), fin.sub);
  check('生成时间取服务端解码时间 822ms（不是流式总时长 823ms）',
    /生成 822ms/.test(fin.sub), fin.sub);

  // 5) 子 agent 的流不计入（否则并行子任务会把速率放大）
  ws.emit(opsFrame([{ op: 'step.upsert', turnId: 't3', step: { kind: 'step', stepId: 't3.1', state: 'running' } }], 40));
  const beforeSub = sb.window.__kimiTps.state();
  const beforeRaw = beforeSub.stream && beforeSub.stream.byKind.text ? beforeSub.stream.byKind.text.raw : 0;
  const beforeChars = beforeSub.stream && beforeSub.stream.byKind.text ? beforeSub.stream.byKind.text.chars : 0;
  const subFrame = {
    type: 'transcript.ops', seq: 42, volatile: true, session_id: 'session_x',
    payload: { type: 'transcript.ops', agent_id: 'sub_1', ops: [{ op: 'append', target: { type: 'frame', frameId: 'sub.f1' }, offset: 0, text: '子代理在干活六字' }] }
  };
  ws.emit(subFrame);
  const afterSub = sb.window.__kimiTps.state();
  const afterRaw = afterSub.stream && afterSub.stream.byKind.text ? afterSub.stream.byKind.text.raw : 0;
  const afterChars = afterSub.stream && afterSub.stream.byKind.text ? afterSub.stream.byKind.text.chars : 0;
  check('子 agent 的 ops 被忽略（主 agent 计数不变）',
    afterRaw === beforeRaw && afterChars === beforeChars,
    `raw ${beforeRaw}→${afterRaw}, chars ${beforeChars}→${afterChars}`);

  // 6) 畸形 ops 不炸
  for (const bad of [
    { type: 'transcript.ops' },
    { type: 'transcript.ops', payload: null },
    { type: 'transcript.ops', payload: { ops: null } },
    { type: 'transcript.ops', payload: { ops: [null, 5, {}, { op: 'append' }] } },
    { type: 'transcript.ops', payload: { agent_id: 'main', ops: { op: 'append', text: '单对象也要认', target: {} } } },
    { type: 'transcript.ops', payload: { agent_id: 'main', ops: [{ op: 'step.upsert' }] } },
    { type: 'transcript.ops', payload: { agent_id: 'main', ops: [{ op: 'meta.merge' }] } },
    { type: 'transcript.ops', payload: { agent_id: 'main', ops: [{ op: 'frame.upsert', frame: {} }] } }
  ]) {
    let threw = false;
    try { ws.emit(bad); } catch (e) { threw = true; }
    if (threw) check('畸形 transcript.ops 不抛异常: ' + JSON.stringify(bad).slice(0, 60), false);
  }
  check('畸形 transcript.ops 全部安全吞掉', true);
}

// --------------------------------------------------- 8. 统计边界回归
function makeReplay() {
  clock = 0;
  const sb = makeSandbox();
  let ws = new sb.WebSocket('ws://localhost/api/v1/ws');
  let seq = 0;
  const r = {
    sb, ws,
    send(ops, session = 'a') {
      ws.emit({ type: 'transcript.ops', session_id: session, seq: ++seq,
        payload: { agent_id: 'main', ops } });
    },
    select(session) {
      ws.send(JSON.stringify({ type: 'subscribe_v2', payload: {
        session_id: session, transcript: { main: 'delta' }
      } }));
      sb.drain();
    },
    /// fresh()：彻底重置统计状态——直接换一个干净的沙箱。
    /// 只切会话 id 不可靠：实现里 id === activeSessionId 时直接 return，
    /// 同会话再次进入不会重置流，上一块的首帧基准会漏进来。
    fresh() {
      clock = 0;
      const nsb = makeSandbox();
      r.sb = nsb;
      r.ws = ws = new nsb.WebSocket('ws://localhost/api/v1/ws');
      seq = 0;
      return r;
    }
  };
  return r;
}
const running = (id = 't1.1', turnId) => ({ op: 'step.upsert', turnId,
  step: { stepId: id, state: 'running' } });
const append = (text, offset = 0, frameId = 'f1', stepId) => ({ op: 'append',
  target: { type: 'frame', frameId, stepId }, offset, text });
const completed = (id = 't1.1', output = 60) => ({ op: 'step.upsert',
  step: { stepId: id, state: 'completed', usage: { output },
    timing: { llmStreamDurationMs: 1000 } } });
const rawTotal = (sb) => Object.values(sb.__kimiTps.state().stream?.byKind || {})
  .reduce((n, b) => n + b.raw, 0);
const near = (a, b) => Math.abs(a - b) < 1e-9;

{
  const r = makeReplay();
  const values = [];
  for (let i = 0; i < 6; i++) {
    const id = `t${i}.1`;
    r.send([running(id), append('一'.repeat(100))]);
    clock += 1000;
    r.send([completed(id)]);
    values.push(r.sb.__kimiTps.calibration.text);
  }
  check('重复同一纯正文样本，系数稳定在真实/原始比值', values.every(v => near(v, 0.6)), JSON.stringify(values));
  r.send([completed('t5.1')]);
  check('完成事件重放不重复校准', near(r.sb.__kimiTps.calibration.text, 0.6));
  const restored = makeSandbox(sb => sb.localStorage.setItem('kimi.tps.cal.v2', r.sb.__store.get('kimi.tps.cal.v2')));
  check('新版校准系数重载后保留', near(restored.__kimiTps.calibration.text, 0.6));
  const legacy = makeSandbox(sb => sb.localStorage.setItem('kimi.tps.cal', '{"text":0.34,"thinking":3}'));
  check('旧公式保存的饱和系数不再沿用', legacy.__kimiTps.calibration.text === 1 && legacy.__kimiTps.calibration.thinking === 1);
}

{
  const r = makeReplay();
  for (let i = 0; i < 30; i++) {
    const id = `mixed.${i}`;
    r.send([running(id),
      { op: 'frame.upsert', frame: { frameId: 'think', kind: 'thinking', text: '' } },
      append('一'.repeat(100)), append('二'.repeat(100), 0, 'think')]);
    clock += 1000;
    r.send([completed(id, 120)]);
  }
  check('相同混合样本的两路系数均收敛且不触底',
    near(r.sb.__kimiTps.calibration.text, 0.6) && near(r.sb.__kimiTps.calibration.thinking, 0.6),
    JSON.stringify(r.sb.__kimiTps.calibration));
}

{
  const r = makeReplay();
  r.send([running()]);
  clock = 10000; // 长 TTFT 不应混入生成速率
  r.send([append('一'.repeat(50))]);
  check('单个首帧不能凭空产生速率', r.sb.__kimiTps.state().window === null);
  clock += 500;
  r.send([append('一'.repeat(50), 50)]);
  clock += 500;
  r.send([append('一'.repeat(50), 100)]);
  check('扣掉首帧后每 500ms 出 50token → 100tok/s',
    near(r.sb.__kimiTps.state().window.tps, 100), JSON.stringify(r.sb.__kimiTps.state().window));
  check('首帧 50tok 不进实时分子（窗口只含后两帧）',
    r.sb.__kimiTps.state().window.tok === 100, JSON.stringify(r.sb.__kimiTps.state().window));
  clock += 1000;
  r.sb.drain();
  check('停顿一秒后速率降为 50tok/s', near(r.sb.__kimiTps.state().window.tps, 50),
    JSON.stringify(r.sb.__kimiTps.state().window));
  check('停顿后的浮层同步更新', /≈ 50\.0 tok\/s/.test(snap(r.sb).value), JSON.stringify(snap(r.sb)));
  clock += 4000;
  r.sb.drain();
  check('所有样本过期后不保留旧速率', r.sb.__kimiTps.state().window === null && !/tok\/s/.test(snap(r.sb).value));
}

{
  const r = makeReplay();
  r.send([running()]);
  for (let i = 0; i <= 20; i++) {
    clock = i * 500;
    r.send([append('一'.repeat(50), i * 50)]);
  }
  const w = r.sb.__kimiTps.state().window;
  // 窗口是闭区间 [now-3000, now]：3000ms 内每 500ms 一帧共 7 帧（含左端点），
  // 首帧 t=0 已被滑出窗口，其 firstTok 标记不影响计数。
  check('满窗口按闭区间计数（7 帧 × 50）', w.span === 3000 && w.tok === 350 && near(w.tps, 350 / 3),
    JSON.stringify(w));
}

{
  const r = makeReplay();
  const estimate = r.sb.__kimiTps.estimate;
  check('单字符ASCII与整词估算可加和', near(estimate('abcd'), [...'abcd'].reduce((n, c) => n + estimate(c), 0)));
  for (const text of ['hello world_123', '中英hello混排9，测试!', 'a b\nc\t12_']) {
    const expected = estimate(text);
    check('所有切分点保持估算量：' + JSON.stringify(text),
      Array.from({ length: text.length + 1 }, (_, i) => i)
        .every(i => near(estimate(text.slice(0, i)) + estimate(text.slice(i)), expected)));
  }
  const whole = makeReplay(), split = makeReplay();
  whole.send([running(), append('abcd'.repeat(100))]);
  split.send([running()]);
  for (let i = 0; i < 400; i++) split.send([append('abcd'[i % 4], i)]);
  check('分帧前后经事件处理的累计量一致', near(rawTotal(whole.sb), rawTotal(split.sb)));
  whole.send([completed()]); split.send([completed()]);
  check('分帧前后学习到的系数一致', near(whole.sb.__kimiTps.calibration.text, split.sb.__kimiTps.calibration.text));
}

{
  const r = makeReplay();
  r.select('a');
  r.send([running(), append('一'.repeat(100))]);
  const before = JSON.stringify(r.sb.__kimiTps.state());
  r.send([running(), append('二'.repeat(100)), completed()], 'b');
  check('其它会话的开始、增量和完成不改写当前流', JSON.stringify(r.sb.__kimiTps.state()) === before);
  check('后台会话不能修改校准', r.sb.__kimiTps.calibration.text === 1);
  r.send([running()]);
  check('同一步running重放保留已有计数', rawTotal(r.sb) === 100);
  r.send([append('三'.repeat(100), 0, 'late', 'old.step'), completed('old.step')]);
  check('其它step的增量与完成不污染当前step', rawTotal(r.sb) === 100 && r.sb.__kimiTps.state().final === null);
  r.send([completed()]);
  check('当前会话完成时按自己的完整样本校准', near(r.sb.__kimiTps.calibration.text, 0.6));
  r.select('b');
  check('切换会话清除旧定稿及旧流', r.sb.__kimiTps.state().final === null && r.sb.__kimiTps.state().stream === null);
  r.send([running(), append('二'.repeat(100))], 'b');
  r.send([completed()], 'a');
  check('切换后的迟到旧会话事件被忽略', rawTotal(r.sb) === 100);
  r.select('b');
  check('重订阅同一会话不清空计数', rawTotal(r.sb) === 100);
  r.send([completed('t1.1', 80)], 'b');
  check('不同会话相同步骤ID可正常完成', r.sb.__kimiTps.state().final.output === 80);
  r.send([{ op: 'meta.merge', meta: { agent: { phase: { kind: 'streaming', turnId: 1, step: 2 } } } },
    append('二'.repeat(100)), completed('t1.2', 80)], 'b');
  check('只有phase开始信号的下一步仍可定稿', r.sb.__kimiTps.state().final.output === 80 && r.sb.__kimiTps.state().stream === null);
  check('phase兜底开始的步骤不用于校准', near(r.sb.__kimiTps.calibration.text, 0.8));
  r.select('c');
  r.send([append('一'.repeat(100)), completed()], 'c');
  check('未观察到step开始的残缺流不参与校准', near(r.sb.__kimiTps.calibration.text, 0.8));
  r.send([running('t2.1'), { op: 'step.upsert', step: { stepId: 't2.1', state: 'completed' } },
    completed('t2.1', 42)], 'c');
  check('缺少用量的完成通知不阻止后续完整定稿', r.sb.__kimiTps.state().final.output === 42);
}

{
  const r = makeReplay();
  r.send([{ op: 'turn.upsert', turn: { turnId: 't1', state: 'running' } }, running(),
    { op: 'meta.merge', meta: { agent: { usage: { currentTurn: { output: 300 } } } } }, completed('t1.1', 300)]);
  r.send([{ op: 'turn.upsert', turn: { turnId: 't2', state: 'running' } }, running('t2.1', 't2')]);
  check('新轮开始不再显示上一轮300token', !/本轮已出/.test(snap(r.sb).sub), snap(r.sb).sub);
  r.send([{ op: 'meta.merge', meta: { agent: { usage: { currentTurn: { output: 12 } } } } }]);
  r.sb.drain();
  check('新轮收到用量后记下正确数值', r.sb.__kimiTps.state().currentTurnUsage.output === 12,
    JSON.stringify(r.sb.__kimiTps.state().currentTurnUsage));
  r.send([{ op: 'turn.upsert', turn: { turnId: 't2', state: 'running' } }]);
  check('同轮running更新不清除当前用量', r.sb.__kimiTps.state().currentTurnUsage.output === 12);
  r.send([completed('t2.1'), running('t2.2', 't2')]);
  check('同轮进入下一步保留本轮累计用量', r.sb.__kimiTps.state().currentTurnUsage.output === 12);
  r.ws.send(JSON.stringify({ type: 'subscribe', payload: { session_ids: ['new'] } }));
  r.send([running()], 'new');
  check('旧版单会话订阅也清除旧用量', !/本轮已出/.test(snap(r.sb).sub));
}

// ------------------------------------------- 11. 与 ZCode 胶囊对齐的口径回归
// 逐条对应从 ZCode 侧同步过来的修正：首帧只作基准、零时长生成段不参与测速、
// 生成阶段过短不报 TPS、整轮完成效率按整轮墙钟算、悬停公式两个口径各用各自分子。
{
  // 【1】首帧只作时间基准：它前面的首 token 等待不属于生成阶段，
  //      因此它的 token 不进实时窗口分子，也不进定稿分子。
  const r = makeReplay();
  r.fresh();
  clock = 5000;                      // 首 token 等待 5s（服务端 TTFT）
  r.send([running()]);
  r.send([append('一'.repeat(100))]);
  const afterFirst = r.sb.__kimiTps.state().window;
  check('[1] 只有首帧时没有速率（首帧不产生分子）', afterFirst === null, JSON.stringify(afterFirst));
  clock += 1000;
  r.send([append('二'.repeat(100), 100)]);
  const live1 = r.sb.__kimiTps.state().window;
  check('[1] 实时分子只含首帧之后的 100 tok', !!live1 && live1.tok === 100,
    JSON.stringify(live1) + ' (首帧 100 估 token 被排除)');
  check('[1] 实时速率 = 100tok / 1.0s', !!live1 && near(live1.tps, 100), JSON.stringify(live1));
  r.send([completed('t1.1', 300)]);
  const fin1 = r.sb.__kimiTps.state().final;
  check('[1] 定稿分子不减首帧（用真实 output）', fin1 && fin1.output === 300, JSON.stringify(fin1));
  check('[1] 定稿分母用服务端生成时长（1000ms → 300tok/s）',
    fin1 && fin1.genMs === 1000 && near(fin1.tps, 300), JSON.stringify({ genMs: fin1 && fin1.genMs, tps: fin1 && fin1.tps }));
}

{
  // 【2】服务端没给生成时长时，用「客户端首帧→末帧」兜底；零时长则不报速率。
  const r = makeReplay();
  r.fresh();
  clock = 3000;
  r.send([running()]);
  r.send([append('一'.repeat(100))]);
  clock += 800;
  r.send([append('二'.repeat(100), 100)]);
  // 完成事件里完全没有 timing 字段 → genMs 只能靠客户端跨度 800ms
  r.send([{ op: 'step.upsert', step: { stepId: 't1.1', state: 'completed', usage: { output: 120 } } }]);
  const fin = r.sb.__kimiTps.state().final;
  check('[2] 服务端缺生成时长时用客户端跨度兜底', fin && fin.genMs === 800,
    JSON.stringify({ genMs: fin && fin.genMs, streamMs: fin && fin.streamMs }));
  check('[2] 兜底后仍给出速率 = 120tok / 0.8s', fin && near(fin.tps, 150),
    JSON.stringify({ tps: fin && fin.tps }));

  // 零时长生成段：所有增量同一时刻到达 → 分母为 0，绝不能报出巨大速率。
  // 这里必须 fresh()：同会话再次进入不会重置流，会继承上一块的首帧基准。
  const z = makeReplay();
  z.fresh();
  clock = 0;                         // 所有增量都落在同一时刻 → 生成段时长 0
  z.send([running()]);
  z.send([append('一'.repeat(100))]);
  z.send([append('二'.repeat(100), 100)]);
  // 注意不能用 completed() 辅助：它自带的 llmStreamDurationMs:1000 会走
  // 「服务端给了时长」的分支，测不到客户端零跨度。这里显式给不带 timing 的完成事件。
  z.send([{ op: 'step.upsert', step: { stepId: 't1.1', state: 'completed', usage: { output: 500 } } }]);
  const zf = z.sb.__kimiTps.state().final;
  check('[2] 零时长生成段不报速率（分母为 0 会算出无穷大）',
    zf && zf.genMs === 0 && zf.tps === null,
    JSON.stringify({ genMs: zf && zf.genMs, tps: zf && zf.tps }));
  check('[2] 零时长片段仍如实显示真实用量',
    zf && zf.output === 500 && /^整轮输出 500 tok/.test(snap(z.sb).sub), JSON.stringify(snap(z.sb)));
  check('[2] 生成时间无从计算时该项不显示（不编 0s）',
    !/生成 /.test(snap(z.sb).sub), JSON.stringify(snap(z.sb).sub));
  check('[2] 整轮累计不收零时长片段的 token（分子分母同进同出）',
    z.sb.__kimiTps.state().turn.tok === 0, JSON.stringify(z.sb.__kimiTps.state().turn));
}

{
  // 【3】生成阶段过短不报 TPS，但真实用量照旧展示；且不参与自校准。
  const r = makeReplay();
  r.fresh();
  clock = 0;
  r.send([running()]);
  r.send([append('一'.repeat(50))]);
  clock += 100;
  r.send([append('二'.repeat(50), 50)]);
  // 同样不能用 completed()：它带 llmStreamDurationMs:1000，会走服务端分支。
  r.send([{ op: 'step.upsert', step: { stepId: 't1.1', state: 'completed', usage: { output: 42 } } }]);
  const fin = r.sb.__kimiTps.state().final;
  check('[3] 生成阶段 100ms < minGenMs 时不报 TPS', fin && fin.tps === null && fin.genMs === 100,
    JSON.stringify({ genMs: fin && fin.genMs, tps: fin && fin.tps }));
  check('[3] 副行给出 100ms 生成时间与真实用量',
    /^整轮输出 42 tok · 生成 100ms/.test(snap(r.sb).sub), snap(r.sb).sub);
  check('[3] 短流不污染自校准系数', near(r.sb.__kimiTps.calibration.text, 1),
    'cal=' + r.sb.__kimiTps.calibration.text);

  // 服务端给了生成时长时以服务端为准：即使客户端只观测到 100ms，
  // 也不能用观测跨度把速率抬高（服务端才是权威口径）。
  const s2 = makeReplay();
  s2.fresh();
  clock = 0;
  s2.send([running('t9.1')]);
  s2.send([append('一'.repeat(50), 0, 'f9', 't9.1')]);
  clock += 100;
  s2.send([append('二'.repeat(50), 50, 'f9', 't9.1')]);
  s2.send([{ op: 'step.upsert', step: { stepId: 't9.1', state: 'completed',
    usage: { output: 300 }, timing: { llmStreamDurationMs: 3000 } } }]);
  const fin9 = s2.sb.__kimiTps.state().final;
  check('[3] 服务端给了时长就以服务端为准（300tok/3.0s=100，不用客户端的 0.1s）',
    fin9 && fin9.genMs === 3000 && near(fin9.tps, 100),
    JSON.stringify({ genMs: fin9 && fin9.genMs, tps: fin9 && fin9.tps }));
}

{
  // 【4】整轮完成效率：分母是整轮墙钟（含首 token 等待与工具执行），
  //      分子是整轮各步真实 output 之和，因此必然低于模型生成速度。
  const r = makeReplay();
  r.fresh();
  clock = 2000;                       // 首 token 等待
  r.send([{ op: 'turn.upsert', turn: { turnId: 't1', state: 'running' } }, running()]);
  r.send([append('一'.repeat(100))]);
  clock += 1000;
  r.send([append('二'.repeat(100), 100)]);
  r.send([completed('t1.1', 200)]);   // 第 1 步：200 tok / 1.0s 生成 = 200 tok/s
  clock += 10000;                     // 工具执行 10s（不产生 token）
  r.send([running('t1.2'), append('三'.repeat(100), 0, 'f2')]);
  clock += 1000;
  r.send([append('四'.repeat(100), 100, 'f2')]);
  r.send([completed('t1.2', 200)]);   // 第 2 步：同样 200 tok / 1.0s
  const st = r.sb.__kimiTps.state();
  check('[4] 整轮墙钟含工具执行（12s）', st.turn.wallMs === 12000, JSON.stringify(st.turn));
  check('[4] 整轮分子 = 两步真实 output 之和', st.turn.tok === 400, JSON.stringify(st.turn));
  const v4 = snap(r.sb);
  // 副行给的是"最后一次调用"的真实 output（本步 200）；整轮累计见上面的 state().turn.tok
  check('[4] 副行给本步真实 output 200 tok',
    /^整轮输出 200 tok/.test(v4.sub), JSON.stringify(v4.sub));
  check('[4] 悬停已取消（与 ZCode 侧一致）', v4.title === '', JSON.stringify(v4.title));
  check('[4] 整轮效率必不高于模型生成速度',
    (st.turn.tok / (st.turn.wallMs / 1000)) < st.final.tps,
    JSON.stringify({ wall: st.turn.tok / (st.turn.wallMs / 1000), gen: st.final.tps }));
}

{
  // 【5】悬停公式的两个口径各用各自分子：主值用本次调用的真实 output ÷ 生成时间。
  const r = makeReplay();
  r.fresh();
  clock = 2000;
  r.send([{ op: 'turn.upsert', turn: { turnId: 't1', state: 'running' } }, running()]);
  clock += 2000;                     // 首 token 等待 2s（整轮墙钟要含这段）
  r.send([append('一'.repeat(100))]);
  clock += 1000;                     // 生成阶段 1s
  r.send([append('二'.repeat(100), 100)]);
  r.send([completed('t1.1', 600)]);
  const v5 = snap(r.sb);
  check('[5] 副行 = 整轮输出/生成时间/TTFT 三项',
    /^整轮输出 600 tok · 生成 1\.00s · TTFT 2\.00s$/.test(v5.sub), JSON.stringify(v5.sub));
  check('[5] 悬停已取消', v5.title === '', JSON.stringify(v5.title));
}

// ------------------------------------------------- 12. 常驻与悬停回归
// 浮层不自动隐藏（与 ZCode 侧胶囊的 persistent 一致）；过了新鲜期标注"上一轮"；
// 悬停在任何阶段都有内容——常驻浮层悬停为空会让人以为脚本没工作。
{
  // 【1】刚启动、还没有任何数据：浮层照样在，且悬停有说明
  const r = makeReplay();
  r.fresh();
  const s0 = snap(r.sb);
  check('[常驻1] 无数据时浮层也可见', !s0.hidden && /TPS 就绪/.test(s0.value), JSON.stringify(s0));
  check('[常驻1] 无数据时也不弹悬停框', s0.title === '', JSON.stringify(s0.title));

  // 【2】定稿后长时间静置：不隐藏，并在过新鲜期后出现"上一轮"
  clock = 1000;
  r.send([{ op: 'turn.upsert', turn: { turnId: 't1', state: 'running' } }, running()]);
  clock += 2000;
  r.send([append('一'.repeat(100))]);
  clock += 1000;
  r.send([append('二'.repeat(100), 100)]);
  r.send([completed('t1.1', 600)]);
  const settled = snap(r.sb);
  check('[常驻2] 定稿后显示速率', /600 tok\/s/.test(settled.value) && !settled.hidden, JSON.stringify(settled));
  check('[常驻2] 新鲜期内不标"上一轮"', !/上一轮/.test(settled.sub), settled.sub);

  clock += 70000;                       // 超过 finalLingerMs(60s)
  r.sb.drain();
  const old1 = snap(r.sb);
  check('[常驻2] 静置 70s 后浮层仍在', !old1.hidden, JSON.stringify(old1));
  check('[常驻2] 过新鲜期标注"上一轮"', /上一轮/.test(old1.sub), old1.sub);
  check('[常驻2] 静置后悬停仍不弹框', old1.title === '', JSON.stringify(old1.title));
  check('[常驻2] 静置后副行给出三项且标注上一轮',
    /^整轮输出 600 tok · 生成 1\.00s · TTFT 2\.00s · 上一轮$/.test(old1.sub), JSON.stringify(old1.sub));

  clock += 600000;                      // 再静置 10 分钟
  r.sb.drain();
  const old2 = snap(r.sb);
  check('[常驻2] 静置 10 分钟后依然常驻', !old2.hidden && /600 tok\/s/.test(old2.value), JSON.stringify(old2));
  check('[常驻2] 静置 10 分钟后副行仍是同一份数据（不被闲置时间稀释）',
    /^整轮输出 600 tok · 生成 1\.00s · TTFT 2\.00s · 上一轮$/.test(old2.sub), JSON.stringify(old2.sub));

  // 【3】等待首 token 期间也要有悬停说明（此时还没有任何速率）
  clock += 1000;
  r.send([{ op: 'turn.upsert', turn: { turnId: 't2', state: 'running' } }, running('t2.1')]);
  const waiting = snap(r.sb);
  check('[常驻3] 等首 token 时不隐藏', !waiting.hidden && /生成中/.test(waiting.value), JSON.stringify(waiting));
  check('[常驻3] 等首 token 时副行给等待时长、且不弹悬停框',
    /^等待首 token /.test(waiting.sub) && waiting.title === '', JSON.stringify(waiting));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
