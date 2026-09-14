//! kimi web 宿主进程管理：拉起子进程、Job Object 绑定、输出解析与生命周期监控。
//! 结构与 dsh-web-tauri 的 host.rs 相同，差异点：
//! - kimi 是独立 exe（无需 node），命令为 `kimi web --port <N> --no-open`；
//!   省略 --host 即只绑 127.0.0.1；--no-open 阻止自动打开浏览器。
//! - URL 从启动横幅的 `Local:    http://127.0.0.1:<port>/#token=<令牌>` 解析，
//!   token 已包含在 URL 里，直接整体加载即可通过鉴权。

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB：
/// 不闪控制台；允许脱离父 Job 以便绑到本进程自己的 Job 上。
#[cfg(windows)]
const CHILD_FLAGS: u32 = 0x0800_0000 | 0x0100_0000;

/// kimi web 未在限时内输出地址则判定启动失败。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
/// 输出缓冲上限，防止长期运行无限增长（排障只看尾部）。
const BUFFER_CAP: usize = 64 * 1024;

pub enum HostEvent {
    /// 输出中解析到 `Local: http://.../#token=...`
    Url(String),
    /// 启动失败（超时 / 进程未就绪即退出，附带输出尾部）
    Failed(String),
    /// 已就绪后宿主进程意外退出
    Exited(i32),
}

pub struct HostHandle {
    child: Arc<Mutex<Child>>,
    pub pid: u32,
    _job: Option<JobObject>,
}

impl HostHandle {
    pub fn stop(&self) {
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// 拉起 `kimi web --port <port> --no-open` 并启动监控线程，
/// 返回宿主句柄与事件接收端。port=0 时由 kimi 自动选端口。
pub fn spawn_and_monitor(
    kimi_exe: &Path,
    port: u16,
    workspace: &Path,
) -> Option<(HostHandle, Receiver<HostEvent>)> {
    let mut cmd = Command::new(kimi_exe);
    cmd.arg("web")
        .arg("--port")
        .arg(port.to_string())
        // kimi web 默认会用系统浏览器打开页面，桌面封装里只需内嵌加载
        .arg("--no-open")
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CHILD_FLAGS);
    }
    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let job = JobObject::create();
    if let Some(job) = &job {
        job.assign(pid);
    }

    let buffer = Arc::new(Mutex::new(String::new()));
    let (line_tx, line_rx) = std::sync::mpsc::channel::<String>();
    if let Some(stream) = stdout {
        spawn_line_reader(stream, line_tx.clone(), Arc::clone(&buffer));
    }
    if let Some(stream) = stderr {
        spawn_line_reader(stream, line_tx.clone(), Arc::clone(&buffer));
    }
    drop(line_tx);

    let (event_tx, event_rx) = std::sync::mpsc::channel::<HostEvent>();
    let child = Arc::new(Mutex::new(child));
    let monitor_child = Arc::clone(&child);
    let monitor_buffer = Arc::clone(&buffer);
    std::thread::spawn(move || {
        let start = Instant::now();
        let mut url_seen = false;
        loop {
            let exit_code = monitor_child
                .lock()
                .unwrap()
                .try_wait()
                .ok()
                .flatten()
                .map(|s| s.code().unwrap_or(-1));
            if let Some(code) = exit_code {
                let tail = tail_text(&monitor_buffer.lock().unwrap(), 2000);
                if url_seen {
                    let _ = event_tx.send(HostEvent::Exited(code));
                } else {
                    let detail = if tail.is_empty() {
                        format!("进程退出码 {code}")
                    } else {
                        tail
                    };
                    let _ = event_tx.send(HostEvent::Failed(detail));
                }
                break;
            }

            while line_rx.try_recv().is_ok() {
                if !url_seen {
                    let url = extract_kimi_url(&monitor_buffer.lock().unwrap());
                    if let Some(u) = url {
                        url_seen = true;
                        let _ = event_tx.send(HostEvent::Url(u));
                    }
                }
            }

            if !url_seen && start.elapsed() > STARTUP_TIMEOUT {
                let mut c = monitor_child.lock().unwrap();
                let _ = c.kill();
                let _ = c.wait();
                drop(c);
                let _ = event_tx.send(HostEvent::Failed(
                    "启动超时：kimi web 未在限时内输出地址。".into(),
                ));
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    });

    Some((
        HostHandle {
            child,
            pid,
            _job: job,
        },
        event_rx,
    ))
}

/// 逐行读取子进程输出：计入共享缓冲（限长）并转发给监控线程。
fn spawn_line_reader<S: std::io::Read + Send + 'static>(
    stream: S,
    tx: std::sync::mpsc::Sender<String>,
    buf: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            {
                let mut b = buf.lock().unwrap();
                b.push_str(&line);
                b.push('\n');
                if b.len() > BUFFER_CAP {
                    let mut cut = b.len() - BUFFER_CAP / 2;
                    while !b.is_char_boundary(cut) {
                        cut += 1;
                    }
                    b.drain(..cut);
                }
            }
            let _ = tx.send(line);
        }
    });
}

/// 从累积输出中解析 `Local:    http://127.0.0.1:<port>/#token=<令牌>`。
/// 横幅里 Network: 行只有 --host 时才会出现，这里只认 Local:。
fn extract_kimi_url(buffer: &str) -> Option<String> {
    const MARK: &str = "Local:";
    let idx = buffer.find(MARK)?;
    let rest = &buffer[idx + MARK.len()..];
    let http_at = rest.find("http")?;
    let url: String = rest[http_at..]
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url)
    } else {
        None
    }
}

fn tail_text(s: &str, max_chars: usize) -> String {
    let total = s.chars().count();
    if total <= max_chars {
        return s.trim().to_string();
    }
    s.chars().skip(total - max_chars).collect::<String>().trim().to_string()
}

/// Windows Job Object（KILL_ON_JOB_CLOSE）：GUI 崩溃或被任务管理器结束时，
/// 操作系统在本进程 Job 句柄关闭时自动结束 kimi 子进程，避免后台残留。
#[cfg(windows)]
struct JobObject(*mut core::ffi::c_void);

#[cfg(windows)]
// 句柄本身可跨线程使用，仅是裸指针不受 Send 约束
unsafe impl Send for JobObject {}

#[cfg(windows)]
impl JobObject {
    fn create() -> Option<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of_val(&info) as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Self(handle))
        }
    }

    fn assign(&self, pid: u32) -> bool {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        unsafe {
            let process = OpenProcess(
                PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if process.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(self.0, process);
            CloseHandle(process);
            ok != 0
        }
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

#[cfg(not(windows))]
struct JobObject;

#[cfg(not(windows))]
impl JobObject {
    fn create() -> Option<Self> {
        None
    }
}
