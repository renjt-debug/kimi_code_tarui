//! Windows 标题栏颜色跟随页面背景（移植自 py 版 apply_native_titlebar_color）：
//! Win11 用 DWMWA_CAPTION_COLOR / DWMWA_TEXT_COLOR / DWMWA_BORDER_COLOR，
//! Win10 退回 DWMWA_USE_IMMERSIVE_DARK_MODE（只能选深/浅）。

#[cfg(windows)]
const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
#[cfg(windows)]
const DWMWA_BORDER_COLOR: u32 = 34;
#[cfg(windows)]
const DWMWA_CAPTION_COLOR: u32 = 35;
#[cfg(windows)]
const DWMWA_TEXT_COLOR: u32 = 36;

pub fn apply(hwnd: isize, background: &str, foreground: &str) {
    #[cfg(windows)]
    {
        let dark = if relative_luminance(background) < 128 { 1 } else { 0 };
        set_dword(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, dark);
        set_dword(hwnd, DWMWA_CAPTION_COLOR, hex_to_colorref(background));
        set_dword(hwnd, DWMWA_TEXT_COLOR, hex_to_colorref(foreground));
        set_dword(hwnd, DWMWA_BORDER_COLOR, hex_to_colorref(background));
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, background, foreground);
    }
}

#[cfg(windows)]
fn set_dword(hwnd: isize, attr: u32, value: u32) {
    use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
    unsafe {
        DwmSetWindowAttribute(
            hwnd as *mut core::ffi::c_void,
            attr,
            &value as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

fn parse_hex(color: &str) -> Option<(u8, u8, u8)> {
    let c = color.trim_start_matches('#');
    if c.len() != 6 {
        return None;
    }
    let red = u8::from_str_radix(&c[0..2], 16).ok()?;
    let green = u8::from_str_radix(&c[2..4], 16).ok()?;
    let blue = u8::from_str_radix(&c[4..6], 16).ok()?;
    Some((red, green, blue))
}

/// '#rrggbb' → Windows COLORREF（0x00bbggrr）
fn hex_to_colorref(color: &str) -> u32 {
    match parse_hex(color) {
        Some((r, g, b)) => (b as u32) << 16 | (g as u32) << 8 | r as u32,
        None => 0,
    }
}

/// 粗略亮度（0-255），用于 Win10 深浅回退。
fn relative_luminance(color: &str) -> i32 {
    match parse_hex(color) {
        Some((r, g, b)) => (299 * r as i32 + 587 * g as i32 + 114 * b as i32) / 1000,
        None => 255,
    }
}
