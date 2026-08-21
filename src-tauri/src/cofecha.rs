use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CofechaProcessOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn validate_executable_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("COFECHA 可执行文件必须使用绝对路径".to_string());
    }
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
    {
        return Err("请选择 Windows EXE 格式的 COFECHA 可执行文件".to_string());
    }

    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("无法访问 COFECHA 可执行文件 {}: {}", path.display(), error))?;
    if !canonical.is_file() {
        return Err(format!("COFECHA 路径不是文件: {}", canonical.display()));
    }
    Ok(canonical)
}

fn validate_runtime_input_name(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed != value
        || !trimmed.is_ascii()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\n')
        || trimmed.contains('\r')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err("COFECHA 临时输入文件名无效".to_string());
    }
    Ok(trimmed)
}

fn execute_cofecha(
    executable_path: PathBuf,
    work_dir: PathBuf,
    runtime_input_name: String,
) -> Result<CofechaProcessOutput, String> {
    let executable_path = validate_executable_path(&executable_path)?;
    let runtime_input_name = validate_runtime_input_name(&runtime_input_name)?;
    fs::create_dir_all(&work_dir)
        .map_err(|error| format!("无法创建 COFECHA 工作目录 {}: {}", work_dir.display(), error))?;

    let mut command = Command::new(&executable_path);
    command
        .current_dir(&work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动 COFECHA 可执行文件 {}: {}",
            executable_path.display(),
            error
        )
    })?;
    let prompt = format!("very\n{}\n\n\n\n\n\n", runtime_input_name);
    child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 COFECHA 标准输入".to_string())?
        .write_all(prompt.as_bytes())
        .map_err(|error| format!("无法向 COFECHA 写入运行参数: {}", error))?;

    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 COFECHA 完成时出错: {}", error))?;
    Ok(CofechaProcessOutput {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

#[tauri::command]
pub async fn run_external_cofecha(
    app: AppHandle,
    executable_path: String,
    runtime_input_name: String,
) -> Result<CofechaProcessOutput, String> {
    let work_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {}", error))?
        .join("cofecha-work");
    let executable_path = PathBuf::from(executable_path);

    tauri::async_runtime::spawn_blocking(move || {
        execute_cofecha(executable_path, work_dir, runtime_input_name)
    })
    .await
    .map_err(|error| format!("COFECHA 执行任务异常结束: {}", error))?
}

#[cfg(test)]
mod tests {
    use super::{validate_executable_path, validate_runtime_input_name};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn accepts_a_safe_ascii_runtime_input_name() {
        assert_eq!(validate_runtime_input_name("sample.rwl").unwrap(), "sample.rwl");
    }

    #[test]
    fn rejects_unsafe_runtime_input_names() {
        assert!(validate_runtime_input_name("..\\sample.rwl").is_err());
        assert!(validate_runtime_input_name("样本.rwl").is_err());
        assert!(validate_runtime_input_name("sample.rwl\nnext").is_err());
    }

    #[test]
    fn accepts_only_an_existing_absolute_exe_file() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "crossdating-cofecha-path-{}-{}",
            std::process::id(),
            suffix
        ));
        fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("COFECHA.EXE");
        fs::write(&executable, []).unwrap();

        assert_eq!(
            validate_executable_path(&executable).unwrap(),
            fs::canonicalize(&executable).unwrap()
        );
        assert!(validate_executable_path(&directory.join("COFECHA.txt")).is_err());
        assert!(validate_executable_path(Path::new("COFECHA.EXE")).is_err());

        fs::remove_dir_all(directory).unwrap();
    }
}
