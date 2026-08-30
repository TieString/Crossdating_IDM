use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritativeDiagnosisRequest {
    pub rwl_text: String,
    pub out_text: String,
    pub target_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritativeDiagnosisResult {
    pub schema_version: u32,
    pub model_version: String,
    pub authority: String,
    pub status: String,
    pub event_type: String,
    pub shift_years: i32,
    pub start_year: Option<i32>,
    pub end_year: Option<i32>,
    pub top_year: Option<i32>,
    pub identity_group: Option<String>,
    pub refusal_reason: Option<String>,
}

fn repository_root() -> Result<PathBuf, String> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "cannot resolve repository root".to_string())
}

fn unique_work_dir() -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "crossdating-authoritative-{}-{timestamp}",
        std::process::id(),
    ));
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

fn run_authoritative(
    request: AuthoritativeDiagnosisRequest,
) -> Result<AuthoritativeDiagnosisResult, String> {
    if request.target_id.trim().is_empty() {
        return Err("targetId is required".to_string());
    }
    if request.out_text.trim().is_empty() {
        return Err("authoritative diagnosis requires a fresh COFECHA report".to_string());
    }
    let root = repository_root()?;
    let work_dir = unique_work_dir()?;
    let rwl_path = work_dir.join("current.rwl");
    let out_path = work_dir.join("VERYCOF.OUT");
    let input_path = work_dir.join("input.json");
    fs::write(&rwl_path, request.rwl_text).map_err(|error| error.to_string())?;
    fs::write(&out_path, request.out_text).map_err(|error| error.to_string())?;
    let input = serde_json::json!({
        "rwlPath": rwl_path,
        "outPath": out_path,
        "targetId": request.target_id,
    });
    fs::write(
        &input_path,
        serde_json::to_vec_pretty(&input).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    let python = std::env::var("CROSSDATING_PYTHON").unwrap_or_else(|_| "python".to_string());
    let mut command = Command::new(python);
    command
        .current_dir(&root)
        .arg(root.join("scripts").join("authoritative-unified-runtime.py"))
        .arg("--input")
        .arg(&input_path)
        .arg("--work-dir")
        .arg(work_dir.join("runtime"));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let result_line = stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix("AUTHORITATIVE_RESULT "));
    let parsed = result_line
        .ok_or_else(|| format!(
            "authoritative model returned no result (status={}): {}{}",
            output.status,
            stdout,
            stderr,
        ))
        .and_then(|payload| {
            serde_json::from_str::<AuthoritativeDiagnosisResult>(payload)
                .map_err(|error| error.to_string())
        });
    let _ = fs::remove_dir_all(&work_dir);
    parsed
}

#[tauri::command]
pub async fn run_authoritative_unified_diagnosis(
    request: AuthoritativeDiagnosisRequest,
) -> Result<AuthoritativeDiagnosisResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_authoritative(request))
        .await
        .map_err(|error| error.to_string())?
}
