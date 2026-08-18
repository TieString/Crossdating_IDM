use tauri::Builder;

mod bayesian_dating_mcmc;
mod commands;
mod file_ops;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::list_files_and_directories,
            commands::write_out_next_to_rwl,
            commands::prepare_tree_ring_scan_image,
            bayesian_dating_mcmc::bayesian_date_series_mcmc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
