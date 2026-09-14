//! Kimi Web GUI 设置读取，注册表位置：
//! `HKCU\Software\MoonshotAI\Kimi Web GUI`
//! - `server\port`      DWORD，0 = 由 kimi 自动选择空闲端口（默认）
//! - `server\workspace` SZ，kimi web 的工作目录（默认用户主目录，
//!   会显示在网页标题 "<workspace dir> | Kimi Code" 中）
//! - `kimi\binPath`     SZ，手动指定 kimi.exe
//!
//! 环境变量 `KIMI_GUI_BIN` 优先级最高（在 finder 模块内处理）。

use std::path::PathBuf;

/// 注册表键名（相对 HKCU）
const REG_ROOT: &str = "Software\\MoonshotAI\\Kimi Web GUI";

#[derive(Debug, Clone)]
pub struct Settings {
    pub port: u16,
    pub workspace: PathBuf,
    pub bin_override: Option<PathBuf>,
}

pub fn load() -> Settings {
    let port = reg_u32(&format!("{REG_ROOT}\\server"), "port")
        .map(|v| v.clamp(0, 65535) as u16)
        .unwrap_or(0);
    let workspace = reg_string(&format!("{REG_ROOT}\\server"), "workspace")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(default_workspace);
    let bin_override = reg_string(&format!("{REG_ROOT}\\kimi"), "binPath")
        .map(PathBuf::from)
        .filter(|p| p.is_file());
    Settings {
        port,
        workspace,
        bin_override,
    }
}

/// 端口占用自动恢复后回写 port=0（自动选端口）。
pub fn write_port(port: u32) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
            REG_DWORD, REG_OPTION_NON_VOLATILE,
        };
        let sub = wide(&format!("{REG_ROOT}\\server"));
        let name = wide("port");
        let mut hkey: HKEY = std::ptr::null_mut();
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                sub.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut hkey,
                std::ptr::null_mut(),
            )
        };
        if rc == 0 {
            let data = port.to_le_bytes();
            unsafe {
                RegSetValueExW(
                    hkey,
                    name.as_ptr(),
                    0,
                    REG_DWORD,
                    data.as_ptr(),
                    data.len() as u32,
                );
                RegCloseKey(hkey);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = port;
    }
}

fn default_workspace() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

const REG_SZ: u32 = 1;
const REG_DWORD: u32 = 4;

/// 读注册表值（任意类型），返回 (类型, 原始字节)；不存在返回 None。
#[cfg(windows)]
fn reg_get_raw(subkey: &str, value: &str) -> Option<(u32, Vec<u8>)> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_ANY};
    let sub = wide(subkey);
    let name = wide(value);
    let mut buf = vec![0u8; 256];
    loop {
        let mut ty: u32 = 0;
        let mut size: u32 = buf.len() as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                sub.as_ptr(),
                name.as_ptr(),
                RRF_RT_ANY,
                &mut ty,
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match rc {
            0 => {
                buf.truncate(size as usize);
                return Some((ty, buf));
            }
            234 => buf.resize(size as usize + 8, 0), // ERROR_MORE_DATA
            _ => return None,
        }
    }
}

#[cfg(windows)]
fn reg_u32(subkey: &str, value: &str) -> Option<u32> {
    let (ty, data) = reg_get_raw(subkey, value)?;
    match ty {
        REG_DWORD => {
            if data.len() >= 4 {
                Some(u32::from_le_bytes([data[0], data[1], data[2], data[3]]))
            } else {
                None
            }
        }
        REG_SZ => utf16_bytes_to_string(&data).and_then(|s| s.trim().parse().ok()),
        _ => None,
    }
}

#[cfg(windows)]
fn reg_string(subkey: &str, value: &str) -> Option<String> {
    let (ty, data) = reg_get_raw(subkey, value)?;
    match ty {
        REG_SZ => utf16_bytes_to_string(&data),
        _ => None,
    }
}

#[cfg(windows)]
fn utf16_bytes_to_string(bytes: &[u8]) -> Option<String> {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = String::from_utf16_lossy(&units);
    let s = s.trim_end_matches('\0').trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

#[cfg(not(windows))]
fn reg_u32(_subkey: &str, _value: &str) -> Option<u32> {
    None
}

#[cfg(not(windows))]
fn reg_string(_subkey: &str, _value: &str) -> Option<String> {
    None
}
