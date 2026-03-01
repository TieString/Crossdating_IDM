// src/commands.rs
use tauri::command;
use crate::file_ops::list_files_and_directories_recursive;
use crate::models::FileOrDir;
use std::fs;
use std::path::Path;

#[command]
/// Tauri命令: 列出指定目录的文件和子目录
pub fn list_files_and_directories(dir_path: &str) -> Result<FileOrDir, String> {
    list_files_and_directories_recursive(dir_path)
        .map_err(|e| e.to_string()) // 转换为String错误类型
}

#[command]
/// Tauri命令: 打招呼
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[command]
/// Write OUT content next to the source RWL file and return the saved path.
pub fn write_out_next_to_rwl(source_rwl_path: &str, out_text: &str) -> Result<String, String> {
    let src = Path::new(source_rwl_path);
    let parent = src
        .parent()
        .ok_or_else(|| format!("invalid source path, no parent: {}", source_rwl_path))?;

    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("invalid source path, no file stem: {}", source_rwl_path))?;

    let out_path = parent.join(format!("{}.OUT", stem));
    fs::write(&out_path, out_text)
        .map_err(|e| format!("failed to write OUT file {}: {}", out_path.display(), e))?;

    Ok(out_path.to_string_lossy().into_owned())
}
