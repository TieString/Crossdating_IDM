// src/lib.rs
use tauri::Builder;

mod models;     // 数据结构模块
mod file_ops;   // 文件操作模块
mod commands;   // Tauri 命令模块

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![commands::greet, commands::list_files_and_directories, commands::write_out_next_to_rwl]) // 绑定命令
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

