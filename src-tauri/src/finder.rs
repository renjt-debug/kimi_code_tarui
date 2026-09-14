//! 定位 Kimi Code CLI（kimi.exe，独立可执行文件，无需 node）。
//! 候选顺序：环境变量 KIMI_GUI_BIN → 官方默认安装位置 ~/.kimi-code/bin/kimi.exe → PATH。

use std::path::PathBuf;

/// `KIMI_GUI_BIN` 环境变量指定的 kimi.exe 覆盖路径。
fn env_file(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

pub fn find_kimi() -> Option<PathBuf> {
    if let Some(p) = env_file("KIMI_GUI_BIN") {
        return Some(p);
    }
    // 官方默认安装位置（kimi-code 安装器）
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(home)
            .join(".kimi-code")
            .join("bin")
            .join("kimi.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    for name in ["kimi.exe", "kimi"] {
        if let Some(p) = which(name) {
            return Some(p);
        }
    }
    None
}
