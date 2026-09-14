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
