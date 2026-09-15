# Kimi Code 桌面版（Tauri 封装）

把 `kimi web`（Kimi Code CLI 的本地 Web 界面）封装成独立桌面应用。
框架复用自 dsh-web-tauri（DeepSeek Harness 桌面封装），按 kimi 的差异适配。

## 与 dsh 版的差异点

| dsh-web-tauri | kimi-web-tauri |
|---|---|
| 找 node.exe + dsh bin.js | 直接找 `~/.kimi-code/bin/kimi.exe`（独立 exe） |
| `dsh web --host 127.0.0.1 --port <N> --no-open` | `kimi web --port <N> --no-open`（省略 --host 即绑 127.0.0.1） |
| 解析 `dsh web: http://...` | 解析启动横幅 `Local: http://.../#token=<令牌>`（token 在 URL 里，加载即通过鉴权） |
| 注册表 `HKCU\Software\DeepSeek\...` | 注册表 `HKCU\Software\MoonshotAI\Kimi Web GUI`（server/port=0 自动选端口、server/workspace、kimi/binPath） |
| 状态文件 `%TEMP%\dsh-gui-state.json` | 状态文件 `%TEMP%\kimi-gui-state.json` |
| 残留清理匹配 `node ...bin.js web` | 残留清理匹配 `kimi ... web` |
| 浅色加载页 | 深色加载页（Kimi 风格） |

其余逻辑完全一致：Job Object 崩溃兜底、启动前清理残留、端口占用自动清理重试、
单实例、标题栏颜色跟随页面、错误页内嵌重试按钮。

## 桌面通知（失焦提醒）

WebView2 宿主默认不授浏览器通知权限，本封装用**初始化脚本把页面的
Notification API 打补丁**接通：`Notification.permission` 恒为 granted，
`new Notification(...)` 时在页面内弹吐司并把内容转发给宿主——窗口**失焦**时
闪任务栏 + Windows 系统 toast（kimi 自带"失焦才通知"逻辑，聚焦时只有页面内
吐司）。通知调用记录在 `%TEMP%\kimi-web-tauri-notify.log` 便于排障。

已知取舍：非打包桌面应用没有自己的 AppUserModelID，系统 toast 借用
PowerShell 的 AUMID 显示，通知归属会写成 Windows PowerShell（仅观感问题）。

## Token/秒（TPS）实时浮层

kimi web 前端**不显示吞吐**（实测其 `/assets/index-*.js` 里 `TPS`、`TTFT`、
`tok/s`、`streamDuration` 出现次数均为 0；服务端其实把数据都发过来了，只有
TUI 里用了）。本封装用第二段初始化脚本（[src/tps.js](src-tauri/src/tps.js)）
在页面构建前 hook `/api/v1/ws` 的 WebSocket，把这块补上。

**真实线格式**（从运行中的 v0.42.0 抓包确认，别照直觉猜）：页面**收不到**
`assistant.delta` / `thinking.delta`（那是服务端内部事件名），流式增量全走
`transcript.ops` 帧——`payload.agent_id === "main"` 且 `payload.ops[]` 里：

```json
{"op":"frame.upsert","frame":{"kind":"thinking|text","frameId":"t2.1.f1","text":""}}
{"op":"append","target":{"type":"frame","frameId":"t2.1.f1"},"offset":0,"text":"增量文本"}
{"op":"step.upsert","step":{"stepId":"t2.1","state":"completed",
  "usage":{"inputOther":160,"output":22,"inputCacheRead":20224,"inputCacheCreation":0},
  "timing":{"llmFirstTokenLatencyMs":22390,"llmStreamDurationMs":823,
            "llmServerDecodeMs":822,"llmServerFirstTokenMs":22384,"llmClientBlockedMs":27}}}
{"op":"meta.merge","meta":{"agent":{"phase":{"kind":"streaming","stream":"thinking"}}}}
{"op":"meta.merge","meta":{"agent":{"usage":{"currentTurn":{"output":22}}}}}
```

（子 agent 的 ops 通过 `agent_id` 区分，不计入。只统计当前订阅会话的
`session_id`；页面切换会话时清空统计状态，旧会话的迟到事件不会修改当前结果。）

- **实时估算**：`append` op 的 `text` 逐条计入 3 秒**滚动窗口**。首帧只作计时
  基准，**它自己的 token 不进分子**（首帧之前是首 token 等待，不属于生成阶段）；
  窗口取闭区间 `[max(首帧时刻, 当前时刻−3s), 当前时刻]`，仅累计这个区间内的增量，
  再除以相同时长——分子分母必须覆盖同一段时间。停顿会降低实时速率。
  首帧 token 仍计入整步校准。`append` 的
  target 只带 `frameId`，靠 `frame.upsert` 记下的 `frameId→kind` 映射区分
  推理/正文。token 数用字符启发式估算：CJK 每字 1，ASCII 字母、数字和下划线
  每字符 1/4，其它非空白字符 1，空白不计；ASCII 整词和拆帧后的估算量一致。
- **自校准**：`step.upsert.completed` 带回真实 `step.usage.output`，脚本拿它和
  本步原始估算量比一下，按各类原始估算量的占比，将「推理 / 正文」系数向这个
  比值更新。相同样本会收敛，不再重复乘上修正比例。仅完整观测的步骤参与校准，
  结果存进 `localStorage['kimi.tps.cal.v2']`；旧公式的系数不再沿用。
- **权威定稿**：同一条 op 还带 `step.timing.*`，于是能显示和 TUI 同口径的真实
  TPS（`usage.output ÷ llmStreamDurationMs`）、TTFT（优先用服务端自报的
  `llmFirstTokenLatencyMs`，标注 `(服务端)`；没有时退回「提示词提交 → 首个增量」
  的 `(端到端)`）以及服务端解码耗时。生成阶段太短（<200ms）时不报速率，只亮出
  真实用量——与 TUI 的 `MIN_STREAM_MS_FOR_TPS` 同义；这类步的 token 也不计入
  整轮累计（分子分母同进同出）。
- **两个口径**（与 ZCode 皮肤管理器的实时 TPS 胶囊一致，同一套规则）：
  - **模型生成速度** = 本次调用真实 `output` ÷ **生成阶段时长**。分母排除这次
    调用的首 token 等待，但保留同一次生成内部的停顿；不含工具执行时间。
    服务端给了 `llmStreamDurationMs` 就以它为准（TUI 也直接拿它当分母，说明该
    字段本身就是生成阶段时长，再减一次 TTFT 会重复扣除、把速率抬高）；服务端
    没给时才退回「客户端首帧 → 末帧」的观测跨度。两者都走 `generationMs()`，
    实时副行与定稿分母用的是同一个函数，口径必然一致。
  - **计时铁律**：没有工具事件就**绝不**因"一段时间没收到增量"而扣时——那段
    可能是模型/网络的真实停顿，扣掉会让速率虚高，而界面已无告警可察。未知空档
    一律留在分母里（速率偏低但可解释）。本实现本来就没有超时切段，这条写下来
    是防止以后有人"顺手优化"回去。
- **显示时机**（吃过亏，别改回去）：`step.upsert(running)` 一出现就亮浮层并显示
  「生成中… / 等待首 token Ns」——TTFT 实测能到 17 秒，这段等待期不显示用户就
  等于看不到；定稿值停留 60 秒（蓝=实时估算，绿=定稿）。等首 token 期间没有增量
  事件驱动重绘，靠 watchdog 每秒刷新一次，不做逐帧空转。
- **常驻**（`CFG.persistent`，与 ZCode 侧胶囊一致）：浮层**不自动隐藏**，任何时候
  都摆在那里。过了 60 秒新鲜期不消失，只在副行标注「上一轮」；常驻下仍保留低频
  重绘（1.5s 一次），否则「上一轮」标记再也不会更新；唯一隐藏途径是
  **Ctrl+Alt+T**。
- **副行只有三项**：整轮输出、生成时间、TTFT（静置超 60s 追加「上一轮」）。
  原来副行上的"实时估算 · N tok""本轮已出 N tok""服务端解码""来源(服务端/端到端)"
  都已去掉，与 ZCode 侧同一版面。
- **悬停提示已取消**：`title` 恒为空，鼠标移上去不弹任何框（与 ZCode 侧一致），
  所以任何说明性文案都不要往界面上加。
- **自检**：[src/tps.test.cjs](src-tauri/src/tps.test.cjs) 用 `vm` 造了假浏览器 +
  假 WebSocket（定时器与 rAF 两条独立队列，如实模拟"一帧一回调"），其中第 7 组
  把上面这些真实帧逐字回放并断言浮层文本：
  另有重复校准、分帧一致性、窗口边界、停顿、会话切换、新轮用量重置，
  以及第 11/12 节的口径对齐与常驻回归（共 125 条断言）。
  `node src-tauri/src/tps.test.cjs`（离线可跑，不需要 kimi/网络；
  扩展名是 `.cjs`——根 `package.json` 声明了 `"type": "module"`）。

交互：**Ctrl+Alt+T** 显隐，**拖拽**移动，**双击**复位（位置/显隐都记在
`localStorage`）。控制台可用 `__kimiTps.state()` / `__kimiTps.calibration`
查看当前窗口与校准系数，`__kimiTps.resetCalibration()` 归零重学。

注意：实时值仍是启发式估算，不能保证与实际分词结果相差几个百分点。
`usage.output` 是本步输出的合计，不能单独确定推理和正文各自的真实 token 数；
语言、内容和输出类型变化都可能使校准失准。精确用量应以服务端定稿为准。
可在控制台改 `__kimiTps.config.windowMs`（窗口越长越稳，但变化响应越慢）。

### 浮层不出现怎么查

脚本内置一条自诊断通道（`DEBUG = true`，见 `tps.js` 顶部）：把「初始化脚本是否
执行、页面里 DOM 长什么样、WebSocket 有没有 hook 上、**每帧的真实形态**（类型、
顶层键、payload 键、前 220 字节）与解析结果、以及各计数」经 Tauri 事件
`kimi-tps-debug` 交给宿主，宿主追加写入 **`%TEMP%\kimi-web-tauri-tps.log`**
（每次启动清空）。对照着看：

| 日志现象 | 说明 |
|---|---|
| 没有 `boot` 行 | 初始化脚本压根没进页面（`initialization_script` 那条路的问题） |
| `boot` 里 `hasApp:false` / `bodyReady:false` | DOM 还没起来，属正常早期状态 |
| `boot` 里 `wsPatched:false` | `window.WebSocket` 没被改掉，hook 失效 |
| `boot` 里 `wsResourceSeen` 非 null | 页面的 socket 在本脚本执行**之前**就建好了，hook 漏了 |
| `boot` 之后完全没有 `ws.attach` | 页面这版前端没走 `/api/v1/ws`（协议变了） |
| `ws.attach` 有、`ws.frame` 只有 `ping`/`ack` | 页面没订阅那个会话，服务端不会推它的流（换个会话发消息再看） |
| `ws.frame` 里 `type` 不是 `transcript.ops` | 线格式变了，照 `head` 字段改 `applyTranscriptOps` |
| `delta` 一直不出现但 `ws.frame` 有 `transcript.ops` | op 名/字段变了，看 `head` 里的 `ops[].op` |
| `step.completed` 的 `output` 为 null | `usage` 字段名变了，看日志里的 `usageKeys` |
| 心跳里 `snap.exists:true` 但 `computedDisplay:"none"` | 空闲态，正常；发消息时再看 |
| 心跳里 `rect.w` 为 0 / `inViewport:false` | 浮层被页面 CSS 影响了（或不在视口内） |

`heartbeat` 每 15 秒记一次浮层的**真实几何与文本**——"胶囊到底在不在屏幕上"
不必靠推断，直接看 `snap.text` / `snap.sub` / `snap.rect` 即可（本次排障就是靠它
发现"数字全对但显示成 none"的）。

控制台还留了这些入口：`__kimiTps.show()` 在没有任何 token 事件时也强制亮出胶囊
（显示「TPS 就绪」），用来区分「脚本没跑」和「跑了但没数据」；`__kimiTps.snapshot()`
返回浮层的实际 `display/visibility/opacity/zIndex/rect`；`__kimiTps.dump()` 给出
最近 160 条本机诊断；`__kimiTps.renderTrace()` 给出最近 40 次渲染的
`now / t0 / 计算出的等待时长`。参考完成后把 `tps.js` 顶部的 `DEBUG` 改 `false`
即可完全静音（诊断本身绝不在渲染热路径上打日志——那会与 dbg 的自排定时器互相喂饭）。

环境变量 `KIMI_GUI_BIN` 可覆盖 kimi.exe 路径。

## 构建

本机无 MSVC 链接器，工程通过 `rust-toolchain.toml` 固定 `stable-x86_64-pc-windows-gnu`
（MinGW 工具链），`.cargo/config.toml` 附加 `--exclude-all-symbols`
（规避 windows-gnu 下 cdylib 导出符号数超过 PE 65535 上限的链接错误）。
在装有 VS Build Tools 的机器上构建时删除这两个文件即可回到 msvc。

```bash
# 依赖：node + pnpm（装 @tauri-apps/cli）、rustup(gnu)、MinGW gcc
pnpm install
pnpm build        # NSIS 安装包（tauri build）

# 或仅调试构建（无需 node/pnpm，前端是静态 dist/）
cd src-tauri && cargo build --bin kimi-web-tauri
./target/debug/kimi-web-tauri.exe
```

## 部署

release 版前端资源已内嵌进 exe，但 **gnu 构建的 exe 动态依赖 `WebView2Loader.dll`**，
部署时必须和 exe 放同一目录（MSVC/CI 构建则静态并入、单文件即可）：

```
D:\software\kimi-web-tauri\
├─ kimi-web-tauri.exe      # target/release 下构建产物
└─ WebView2Loader.dll     # target/release 下随构建产出的同名文件
```

## CI

- **冒烟**（[ci.yml](.github/workflows/ci.yml)）：每次 push 到 main / PR，windows runner
  上做调试构建并确认产物存在，坏改动第一时间暴露。
- **发布**（[release.yml](.github/workflows/release.yml)）：推送 `v*` 标签触发，
  MSVC 构建出 NSIS 安装包 + 独立 exe，产出**草稿 release**
  （到仓库 Releases 页面手动点发布），正文自带双 exe 下载说明。

```bash
git tag v0.1.0 && git push origin v0.1.0   # 触发 release 构建
```
