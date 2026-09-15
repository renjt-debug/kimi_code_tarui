//! 桌面提醒：窗口失焦时任务完成通知——闪任务栏 + Windows 系统 toast。
//! 通知源是 kimi 页面经初始化脚本补丁转发的 `kimi-desktop-notify` 事件。

/// 触发一次"需要注意"提醒（任务栏闪烁 + 系统 toast）。
#[cfg(windows)]
pub fn attention(hwnd: isize, title: &str, body: &str) {
    flash_taskbar(hwnd);
    spawn_toast(title.to_string(), body.to_string());
}

#[cfg(not(windows))]
pub fn attention(_hwnd: isize, _title: &str, _body: &str) {}

/// 闪烁任务栏按钮直到窗口重新获得焦点。
#[cfg(windows)]
fn flash_taskbar(hwnd: isize) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_ALL, FLASHW_TIMERNOFG,
    };
    let mut info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: hwnd as *mut core::ffi::c_void,
        dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
        uCount: 0,
        dwTimeout: 0,
    };
    unsafe { FlashWindowEx(&mut info) };
}

/// 非打包桌面应用没有自己的 AppUserModelID，借用 PowerShell 的
///（开始菜单有其快捷方式，AUMID 可解析），否则系统 toast 不显示。
#[cfg(windows)]
const TOAST_AUMID: &str = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";

/// WinRT 调用需要线程初始化 COM，放独立线程里做，别堵主线程。
#[cfg(windows)]
fn spawn_toast(title: String, body: String) {
    std::thread::spawn(move || {
        use windows::core::HSTRING;
        use windows::Data::Xml::Dom::XmlDocument;
        use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
        let _ = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            )
        };
        let xml = format!(
            "<toast><visual><binding template=\"ToastText02\"><text id=\"1\">{}</text><text id=\"2\">{}</text></binding></visual></toast>",
            xml_escape(&title),
            xml_escape(&body)
        );
        let shown = (|| -> windows::core::Result<()> {
            let doc = XmlDocument::new()?;
            doc.LoadXml(&HSTRING::from(&xml))?;
            let toast = ToastNotification::CreateToastNotification(&doc)?;
            let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
                TOAST_AUMID,
            ))?;
            notifier.Show(&toast)?;
            Ok(())
        })();
        log_result(&title, &body, &shown);
    });
}

/// 简易记录，便于排查"没收到通知"类问题。
#[cfg(windows)]
fn log_result(title: &str, body: &str, shown: &windows::core::Result<()>) {
    let line = format!(
        "[{}] title={:?} body={:?} toast={:?}\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        title,
        body,
        shown.as_ref().err().map(|e| e.to_string()),
    );
    let path = std::env::temp_dir().join("kimi-web-tauri-notify.log");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}
