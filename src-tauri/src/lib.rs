//! Kimi Code 桌面封装（Tauri 版）。结构与 dsh-web-tauri 相同，负责三件事：
//! 1. 定位本机 kimi.exe（~/.kimi-code/bin/kimi.exe），以隐藏窗口拉起
//!    `kimi web --port <N> --no-open`（默认 0 = 自动选空闲端口）；
//! 2. 从输出横幅解析 `Local: http://127.0.0.1:<port>/#token=<令牌>`，加载进窗口；
//! 3. 生命周期绑定：关窗停服务、Job Object 崩溃兜底、启动前清理残留、
//!    端口占用自动清理重试、单实例、标题栏颜色跟随页面；
//! 4. 桌面通知：WebView2 宿主默认不授浏览器通知权限，用初始化脚本把页面
//!    的 Notification API 打补丁——页面内弹吐司并把内容转发给宿主，窗口
//!    失焦时闪任务栏 + Windows 系统 toast（kimi 自带"失焦才通知"逻辑）；
//! 5. 吞吐浮层：kimi web 前端不显示 token/秒，用初始化脚本 hook 页面的
//!    WebSocket（/api/v1/ws），从 delta 事件流里估算实时 TPS，并用
//!    turn.step.completed 的真实 usage 做定稿与自校准（详见 src/tps.js）。

mod dwm;
mod finder;
mod host;
mod notify;
mod procs;
mod settings;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Listener, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// 默认标题栏配色（与加载页一致：深色）
const DEFAULT_BG: &str = "#0b0d12";
const DEFAULT_FG: &str = "#e6e8ee";

/// 加载页与 dist/index.html 同一份内容（document.write 重绘用）
const LOADING_HTML: &str = include_str!("../../dist/index.html");

/// 注入 kimi 页面的取色脚本：读 body 背景/文字色并回传。
const COLOR_SCRIPT: &str = r#"
(function () {
    function toHex(input) {
        var m = /^rgba?\(([^)]*)\)$/i.exec(input);
        if (!m) return null;
        var parts = m[1].split(',').map(function (v) { return parseFloat(v.trim()); });
        if (parts.length < 3) return null;
        var a = parts.length > 3 ? parts[3] : 1;
        if (a === 0) return null;
        function clamp(v) {
            return Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0');
        }
        return '#' + clamp(parts[0]) + clamp(parts[1]) + clamp(parts[2]);
    }
    try {
        var bg = toHex(getComputedStyle(document.body).backgroundColor);
        var fg = toHex(getComputedStyle(document.body).color);
        if (window.__TAURI__ && window.__TAURI__.event) {
            window.__TAURI__.event.emit('kimi-page-colors', { bg: bg, fg: fg });
        }
    } catch (e) { /* 页面受限时保持默认标题栏 */ }
})();
"#;

/// Notification API 补丁（初始化脚本，先于页面脚本在每个页面执行）：
/// 宿主 WebView2 默认拒授通知权限，这里把 Notification 替换成自有实现——
/// permission 恒为 granted，构造时在页面内弹吐司并把内容经事件转发给宿主。
const NOTIFY_POLYFILL: &str = r#"
(function () {
  if (typeof window.Notification === 'undefined' || window.__kimiNotifyPatched) return;
  window.__kimiNotifyPatched = true;
  function emit(title, body) {
    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('kimi-desktop-notify', { title: String(title || ''), body: String(body || '') });
      }
    } catch (e) {}
  }
  function toastUi(title, body) {
    try {
      var card = document.createElement('div');
      card.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:320px;'
        + 'padding:12px 14px;border-radius:10px;background:#161a24;color:#e6e8ee;'
        + 'font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.45);cursor:pointer;opacity:0;transition:opacity .2s;';
      var t = document.createElement('div');
      t.style.cssText = 'font-weight:600;margin-bottom:2px;';
      t.textContent = String(title || '');
      var b = document.createElement('div');
      b.style.cssText = 'color:#9aa1ad;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;';
      b.textContent = String(body || '');
      card.appendChild(t);
      card.appendChild(b);
      card.onclick = function () {
        try { window.focus(); } catch (e) {}
        if (card.parentNode) card.parentNode.removeChild(card);
      };
      (document.body || document.documentElement).appendChild(card);
      requestAnimationFrame(function () { card.style.opacity = '1'; });
      setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 6000);
      return card;
    } catch (e) { return null; }
  }
  function Polyfill(title, options) {
    options = options || {};
    this.title = String(title || '');
    this.body = String(options.body || '');
    this.tag = options.tag || '';
    this._card = toastUi(this.title, this.body);
    emit(this.title, this.body);
  }
  Polyfill.prototype.close = function () {
    if (this._card && this._card.parentNode) this._card.parentNode.removeChild(this._card);
  };
  Polyfill.prototype.addEventListener = function () {};
  Polyfill.prototype.removeEventListener = function () {};
  Polyfill.prototype.dispatchEvent = function () { return false; };
  Object.defineProperty(Polyfill, 'permission', {
    configurable: true,
    get: function () { return 'granted'; }
  });
  Polyfill.requestPermission = function (cb) {
    var r = 'granted';
    if (typeof cb === 'function') cb(r);
    return Promise.resolve(r);
  };
  Polyfill.maxActions = 0;
  window.Notification = Polyfill;
})();
"#;

/// Token/秒 实时浮层（初始化脚本，先于页面脚本执行）：hook WebSocket 统计
/// delta 流估算实时 TPS，并用 turn.step.completed 的真实 usage 定稿 + 自校准。
/// Ctrl+Alt+T 显隐、拖拽移动、双击复位。实现见 src/tps.js。
const TPS_SCRIPT: &str = include_str!("tps.js");

/// 注入页面的全部初始化脚本（按顺序拼接后交给 initialization_script）。
/// `include_str!` 自带变更追踪，改 tps.js / 通知补丁后 cargo 会自动重编。
fn init_scripts() -> String {
    format!("{NOTIFY_POLYFILL}\n{TPS_SCRIPT}")
}

#[derive(Default)]
struct GuiState {
    host: Mutex<Option<host::HostHandle>>,
    /// 首次失败后是否已自动清理重试过
    auto_recovered: AtomicBool,
    /// 自动重试已排队，忽略后续重复失败信号
    retry_pending: AtomicBool,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kimi Code")
                .inner_size(1280.0, 840.0)
                .resizable(true)
                .center()
                .initialization_script(init_scripts())
                .on_page_load(|w, payload| on_page_load(w, payload))
                .build()?;
            apply_default_titlebar(&window);

            app.manage(GuiState::default());

            // 错误页"清理遗留并自动端口重试"按钮
            let retry_app = app.handle().clone();
            app.listen("kimi-gui-retry", move |_| {
                settings::write_port(0);
                start_host(&retry_app, false);
            });

            // kimi 页面取色回传 → 标题栏同色
            let color_app = app.handle().clone();
            app.listen("kimi-page-colors", move |event| {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    return;
                };
                let bg = v["bg"].as_str().unwrap_or(DEFAULT_BG);
                let fg = v["fg"].as_str().unwrap_or(DEFAULT_FG);
                if let Some(w) = color_app.get_webview_window("main") {
                    if let Ok(h) = w.hwnd() {
                        dwm::apply(h.0 as isize, bg, fg);
                    }
                }
            });

            // 桌面通知：页面补丁转发的 Notification 内容 → 失焦时闪任务栏 + 系统 toast
            let notify_app = app.handle().clone();
            app.listen("kimi-desktop-notify", move |event| {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
                    return;
                };
                let title = v["title"].as_str().unwrap_or("Kimi Code");
                let body = v["body"].as_str().unwrap_or("");
                if let Some(w) = notify_app.get_webview_window("main") {
                    // 聚焦时页面内吐司已足够，系统级提醒只在失焦时打扰
                    if !w.is_focused().unwrap_or(true) {
                        if let Ok(h) = w.hwnd() {
                            notify::attention(h.0 as isize, title, body);
                        }
                    }
                }
            });

            // TPS 浮层的自诊断：页面把「脚本是否执行 / 有没有 hook 到 WS / 每帧真实
            // 形态与解析结果」批量发上来，这里追加写入 %TEMP%\kimi-web-tauri-tps.log。
            // 浮层不出现时先看这个文件，别猜。
            // 启动即清空，保证日志只对应当前这一次运行。
            if let Some(path) = tps_log_path() {
                let _ = std::fs::write(&path, b"# kimi-web-tauri TPS diagnostics\n");
            }
            app.listen("kimi-tps-debug", move |event| {
                let Some(path) = tps_log_path() else { return };
                let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                else {
                    return;
                };
                use std::io::Write;
                let payload = event.payload();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                    let counts = v.get("counts").cloned().unwrap_or(serde_json::Value::Null);
                    let lines = v
                        .get("lines")
                        .and_then(|l| l.as_array())
                        .cloned()
                        .unwrap_or_default();
                    for line in lines {
                        let _ = writeln!(f, "{line}");
                    }
                    if !counts.is_null() {
                        let _ = writeln!(f, "{{\"tag\":\"counts\",\"d\":{counts}}}");
                    }
                }
            });

            // 延后到事件循环起来后再拉起宿主，避免启动前清理阻塞首帧
            let boot_app = app.handle().clone();
            std::thread::spawn(move || start_host(&boot_app, false));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                stop_host(app);
            }
        });
}

fn on_page_load(w: WebviewWindow, payload: PageLoadPayload) {
    if !matches!(payload.event(), PageLoadEvent::Finished) {
        return;
    }
    let url = payload.url();
    let is_kimi = matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if is_kimi {
        // kimi 页面加载完成后注入取色脚本（经 kimi-remote capability 回传事件）
        let _ = w.eval(COLOR_SCRIPT);
    } else {
        apply_default_titlebar(&w);
    }
}

fn apply_default_titlebar(w: &WebviewWindow) {
    if let Ok(h) = w.hwnd() {
        dwm::apply(h.0 as isize, DEFAULT_BG, DEFAULT_FG);
    }
}

/// TPS 自诊断日志路径（%TEMP%\kimi-web-tauri-tps.log）。
fn tps_log_path() -> Option<std::path::PathBuf> {
    std::env::temp_dir().into_os_string().into_string().ok().map(|t| {
        std::path::Path::new(&t).join("kimi-web-tauri-tps.log")
    })
}

fn start_host(app: &tauri::AppHandle, auto: bool) {
    let state = app.state::<GuiState>();
    if !auto {
        let cleaned = procs::cleanup_stale_instances();
        if !cleaned.is_empty() {
            set_status(app, &format!("已清理上次遗留的 kimi 进程：{}", cleaned.join("、")));
        }
        state.auto_recovered.store(false, Ordering::SeqCst);
    }
    stop_host(app);
    state.retry_pending.store(false, Ordering::SeqCst);
    set_status(app, "正在启动 kimi web…");
    show_loading(app);

    let cfg = settings::load();
    let kimi_exe = match cfg.bin_override.filter(|p| p.is_file()).or_else(finder::find_kimi) {
        Some(p) => p,
        None => {
            show_startup_error(
                app,
                "找不到 Kimi Code CLI（kimi.exe）。\n\n请先安装：kimi 官方安装器（默认装到 \
                 %USERPROFILE%\\.kimi-code\\bin\\kimi.exe）\n\
                 或通过环境变量 KIMI_GUI_BIN 指定 kimi.exe 路径\n\
                 （或在注册表 HKCU\\Software\\MoonshotAI\\Kimi Web GUI\\kimi\\binPath 中设置）。",
            );
            return;
        }
    };

    let Some((handle, events)) = host::spawn_and_monitor(&kimi_exe, cfg.port, &cfg.workspace) else {
        show_startup_error(app, "无法启动 kimi.exe，请确认其可正常运行。");
        return;
    };
    procs::write_state(std::process::id(), handle.pid);
    *state.host.lock().unwrap() = Some(handle);

    let monitor_app = app.clone();
    std::thread::spawn(move || {
        while let Ok(ev) = events.recv() {
            match ev {
                host::HostEvent::Url(url) => {
                    set_status(&monitor_app, "运行中");
                    if let Some(w) = monitor_app.get_webview_window("main") {
                        if let Ok(u) = url.parse() {
                            let _ = w.navigate(u);
                        }
                    }
                }
                host::HostEvent::Failed(detail) => handle_failure(&monitor_app, &detail),
                host::HostEvent::Exited(code) => {
                    set_status(&monitor_app, &format!("服务进程已意外退出（代码 {code}）"));
                    show_error(&monitor_app, "kimi web 服务意外退出。\n请关闭窗口后重新打开。");
                }
            }
        }
    });
}

fn stop_host(app: &tauri::AppHandle) {
    if let Some(handle) = app.state::<GuiState>().host.lock().unwrap().take() {
        handle.stop();
    }
    procs::remove_state();
}

/// 启动失败处理：先自动清理重试一次。
fn handle_failure(app: &tauri::AppHandle, detail: &str) {
    set_status(app, "启动失败");
    let state = app.state::<GuiState>();
    if state.retry_pending.load(Ordering::SeqCst) {
        return;
    }
    if !state.auto_recovered.swap(true, Ordering::SeqCst) && try_auto_recovery(app, detail) {
        return;
    }
    show_error(app, detail);
}

/// 端口被上次遗留进程占用时，清理后改用自动端口重试一次。
fn try_auto_recovery(app: &tauri::AppHandle, detail: &str) -> bool {
    let mut cleaned = procs::cleanup_stale_instances();
    if let Some(owner_pid) = procs::extract_owner_pid(detail) {
        let procs = procs::list_processes();
        let alive: std::collections::HashSet<u32> = procs.iter().map(|p| p.pid).collect();
        if let Some(p) = procs.iter().find(|p| p.pid == owner_pid) {
            if procs::looks_like_kimi_web(p) && !alive.contains(&p.ppid) && procs::kill_tree(owner_pid) {
                cleaned.push(format!("占用进程 {owner_pid}"));
            }
        }
    }
    let busy = procs::looks_busy(detail);
    if busy || !cleaned.is_empty() {
        if busy {
            settings::write_port(0);
        }
        let summary = if cleaned.is_empty() {
            "无残留".to_string()
        } else {
            cleaned.join("、")
        };
        set_status(
            app,
            &format!("检测到上次遗留的后台服务，已清理（{summary}），正在自动重试…"),
        );
        app.state::<GuiState>()
            .retry_pending
            .store(true, Ordering::SeqCst);
        let retry_app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            start_host(&retry_app, true);
        });
        true
    } else {
        false
    }
}

fn show_startup_error(app: &tauri::AppHandle, detail: &str) {
    set_status(app, "启动失败");
    show_error(app, detail);
}

/// 在当前页面（本地或 kimi 远程页均可）上重绘加载页 / 错误页。
fn eval_html(app: &tauri::AppHandle, html: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let payload = serde_json::to_string(html).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(&format!("document.open();document.write({payload});document.close();"));
    }
}

fn show_loading(app: &tauri::AppHandle) {
    eval_html(app, LOADING_HTML);
}

fn show_error(app: &tauri::AppHandle, detail: &str) {
    eval_html(app, &error_html(detail));
}

/// 更新加载页状态行；页面没有状态元素时静默跳过。
fn set_status(app: &tauri::AppHandle, text: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let payload = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(&format!(
            "(function(){{var e=document.getElementById('status');\
             if(e)e.textContent={payload};\
             window.__kimiStatus__=function(t){{var x=document.getElementById('status');\
             if(x)x.textContent=t||'';}};}})();"
        ));
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// 启动失败页（深色，配 Kimi 风格加载页）。
fn error_html(detail: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Kimi Code</title><style>
  html, body {{ height: 100%; margin: 0; display: grid; place-items: center;
               background: #0b0d12; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }}
  .box {{ max-width: 720px; padding: 24px; }}
  h1 {{ color: #ff7a7a; font-size: 16px; }}
  p {{ color: #9aa1ad; font-size: 13px; }}
  pre {{ white-space: pre-wrap; word-break: break-all; color: #9aa1ad; font-size: 12px;
        font-family: Consolas, "Microsoft YaHei", monospace;
        background: #141821; border: 1px solid #232836; padding: 12px; border-radius: 6px; }}
  #retry {{ margin-top: 16px; padding: 8px 18px; border: 0; border-radius: 6px; cursor: pointer;
           background: #3d6bff; color: #fff; font-size: 13px; }}
  #retry:disabled {{ background: #35508f; cursor: default; }}
</style></head><body><div class="box">
  <h1>Kimi Code 启动失败</h1>
  <p>程序默认会自动选择空闲端口；也可点击下方按钮清理上次遗留的后台进程后重试。</p>
  <pre>{}</pre>
  <button id="retry">清理遗留并自动端口重试</button>
</div>
<script>
  document.getElementById('retry').onclick = function () {{
    this.disabled = true;
    this.textContent = '正在清理并重试…';
    try {{
      window.__TAURI__.event.emit('kimi-gui-retry');
    }} catch (e) {{
      this.textContent = '无法通知主程序，请关闭窗口后重新打开';
    }}
  }};
</script>
</body></html>"#,
        escape_html(detail)
    )
}
