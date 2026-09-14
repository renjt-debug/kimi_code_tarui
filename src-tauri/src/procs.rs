//! 进程治理：枚举进程、结束进程树、GUI↔kimi 状态文件、启动前清理残留。
//! 结构与 dsh-web-tauri 的 procs.rs 相同，只清理两类进程：
//! 1. 状态文件记录的、且 GUI 已不存在的 kimi 子进程；
//! 2. 父进程已不存在（孤儿）的 `kimi ... web ...` 进程。
//! 父进程仍然存活的 kimi（例如终端里手动启动的）不会被误杀。

use std::collections::HashSet;
use std::path::PathBuf;

/// 隐藏窗口标志 CREATE_NO_WINDOW，避免闪出控制台。
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub name: String,
    pub cmd: String,
}

/// GUI↔kimi 状态文件（独立于 dsh 版的 dsh-gui-state.json）。
fn state_path() -> PathBuf {
    std::env::temp_dir().join("kimi-gui-state.json")
}

pub fn write_state(gui_pid: u32, kimi_pid: u32) {
    let payload = serde_json::json!({
        "guiPid": gui_pid,
        "kimiPid": kimi_pid,
        "updatedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let path = state_path();
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, payload.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

pub fn read_state() -> Option<(u32, u32)> {
    let data = std::fs::read_to_string(state_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    Some((
        v.get("guiPid")?.as_u64()? as u32,
        v.get("kimiPid")?.as_u64()? as u32,
    ))
}

pub fn remove_state() {
    let _ = std::fs::remove_file(state_path());
}

/// 匹配 `kimi.exe web ...` 形式的命令行：进程名含 kimi，
/// 且除可执行路径外的参数里有独立的 `web` token。
pub fn looks_like_kimi_web(p: &ProcInfo) -> bool {
    if !p.name.contains("kimi") {
        return false;
    }
    p.cmd
        .split_whitespace()
        .skip(1)
        .any(|t| t.eq_ignore_ascii_case("web"))
}

/// 枚举本机进程（pid/ppid/name/cmd）；失败返回空列表。
/// Windows 下经 PowerShell Get-CimInstance。
pub fn list_processes() -> Vec<ProcInfo> {
    #[cfg(windows)]
    {
        use std::process::Command;
        let script = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | \
                      Select-Object ProcessId,ParentProcessId,Name,CommandLine | \
                      ConvertTo-Json -Compress";
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(NO_WINDOW);
        }
        let Ok(out) = cmd.output() else {
            return vec![];
        };
        if !out.status.success() || out.stdout.is_empty() {
            return vec![];
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(text.trim()) else {
            return vec![];
        };
        let items = match parsed {
            serde_json::Value::Array(a) => a,
            v => vec![v],
        };
        items
            .into_iter()
            .filter_map(|it| {
                let pid = it.get("ProcessId")?.as_i64()?;
                let ppid = it.get("ParentProcessId").and_then(|v| v.as_i64()).unwrap_or(0);
                if pid <= 0 {
                    return None;
                }
                Some(ProcInfo {
                    pid: pid as u32,
                    ppid: ppid.max(0) as u32,
                    name: it
                        .get("Name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_lowercase(),
                    cmd: it
                        .get("CommandLine")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

/// 结束进程树（Windows：taskkill /T /F），返回 taskkill 是否成功。
pub fn kill_tree(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use std::process::Command;
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(NO_WINDOW);
        }
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

/// 启动前清理上次异常退出遗留的 kimi web 进程，返回清理结果说明。
pub fn cleanup_stale_instances() -> Vec<String> {
    let mut cleaned: Vec<String> = vec![];
    let procs = list_processes();
    if procs.is_empty() {
        return cleaned;
    }
    let alive: HashSet<u32> = procs.iter().map(|p| p.pid).collect();
    let me = std::process::id();

    if let Some((gui_pid, kimi_pid)) = read_state() {
        if gui_pid > 0 && gui_pid != me && !alive.contains(&gui_pid) && kimi_pid > 0 {
            if let Some(p) = procs.iter().find(|p| p.pid == kimi_pid) {
                if looks_like_kimi_web(p) && kill_tree(kimi_pid) {
                    cleaned.push(format!("残留进程 {kimi_pid}"));
                }
            }
        }
        remove_state();
    }

    for p in &procs {
        if p.pid == me || alive.contains(&p.ppid) {
            continue;
        }
        if looks_like_kimi_web(p) && kill_tree(p.pid) {
            cleaned.push(format!("孤儿进程 {}", p.pid));
        }
    }
    cleaned
}

/// 识别"端口已被占用"类启动失败。
pub fn looks_busy(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    detail.contains("EADDRINUSE")
        || lower.contains("address already in use")
        || detail.contains("端口已占用")
        || detail.contains("端口被占用")
        || lower.contains("already owned by process")
        || lower.contains("eacces")
}

/// 从失败输出中提取占用者 pid（形如 `process <pid>` / `process: <pid>`）。
pub fn extract_owner_pid(detail: &str) -> Option<u32> {
    let lower = detail.to_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("process") {
        let after = &lower[from + pos + 7..];
        let trimmed = after.trim_start_matches([':', ' ', '\t']);
        if trimmed.len() < after.len() {
            let digits: String = trimmed
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(pid) = digits.parse::<u32>() {
                return Some(pid);
            }
        }
        from += pos + 7;
    }
    None
}
