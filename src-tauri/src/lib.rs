use tauri::{Builder, Manager};

mod bayesian_dating_mcmc;
mod commands;
mod current_event_ranker;
mod file_ops;
mod models;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(current_event_ranker::CurrentEventSidecar::start(
                &app.handle(),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::list_files_and_directories,
            commands::write_out_next_to_rwl,
            bayesian_dating_mcmc::bayesian_date_series_mcmc,
            current_event_ranker::list_current_event_models,
            current_event_ranker::rank_current_event_v1,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
