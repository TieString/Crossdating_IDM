// src/commands.rs
use tauri::command;
use crate::file_ops::list_files_and_directories_recursive;
use crate::models::FileOrDir;

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
