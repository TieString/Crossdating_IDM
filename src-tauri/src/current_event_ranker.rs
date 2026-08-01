//! Switchable long-lived JSONL bridges for trusted diagnostic-only models.
//!
//! Python owns RWL parsing, candidate generation, the 251-feature contract,
//! LambdaRank/range scoring and reliability gating. Rust owns the trusted
//! model catalog, one-active-process lifecycle and response-contract checks.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};
#[cfg(not(debug_assertions))]
use tauri::Manager;
use tauri::{AppHandle, State};

pub const PROTOCOL_VERSION: &str = "crossdating.current-event.v1";
const EXPECTED_FEATURE_VARIANT: &str = "deployable_no_missing_count";
const EXPECTED_FEATURE_COUNT: u64 = 251;
const EXPECTED_CANDIDATE_POOL: &str = "selected_top500";
const EXPECTED_RANGE_RELIABILITY_FEATURE_COUNT: u64 = 109;
const EXPECTED_RANGE_RELIABILITY_THRESHOLD: f64 = 0.338_531_781_981_448_95;
const EXPECTED_RRF_RELIABILITY_THRESHOLD: f64 = 0.669_796_459_711_970_9;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
pub const DEFAULT_MODEL_ID: &str = "current-event-range-v1.0.0";
const ADAPTIVE_RANGE_MODEL_ID: &str = "current-event-adaptive-range-v1";
const RRF_MODEL_ID: &str = "current-event-missing-rrf-v1";
const RRF_ROUTE_VERSION: &str = "missing-current-event-rrf0-range3-v1";

#[cfg(debug_assertions)]
const DEFAULT_DEV_PYTHON: &str = r"D:\Programming\Python\Python310\python.exe";
#[cfg(debug_assertions)]
const DEFAULT_DEV_SIDECAR_SCRIPT: &str =
    r"D:\Code\Crossdating_py_rankdiag_tauri_deploy\scripts\current_event_ranker_sidecar.py";
#[cfg(debug_assertions)]
const ADAPTIVE_RANGE_DEV_SIDECAR_SCRIPT: &str =
    r"D:\Code\Crossdating_py_eventrange_gate\scripts\current_event_ranker_sidecar.py";
#[cfg(debug_assertions)]
const RRF_DEV_SIDECAR_SCRIPT: &str =
    r"D:\Code\Crossdating_py_false_ring\scripts\current_event_rrf_sidecar.py";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SuggestionContract {
    LegacyPerSuggestionRange,
    SingleEventRange,
    RrfPerSuggestionRange,
}

#[derive(Clone, Debug)]
struct ModelDefinition {
    id: &'static str,
    display_name: &'static str,
    description: &'static str,
    bundle_version: &'static str,
    deployment_version: Option<&'static str>,
    route_version: Option<&'static str>,
    operation_scope: &'static [&'static str],
    resource_name: &'static str,
    #[cfg(not(debug_assertions))]
    release_executable: &'static str,
    #[cfg(debug_assertions)]
    debug_sidecar_script: &'static str,
    #[cfg(debug_assertions)]
    debug_bundle_env: &'static str,
    #[cfg(debug_assertions)]
    debug_script_env: &'static str,
    range_feature_count: Option<u64>,
    range_reliability_feature_count: Option<u64>,
    suggestion_contract: SuggestionContract,
    adaptive_event_range: bool,
    existing_zero_policy: &'static str,
    top_k: u8,
    range_radius: u8,
    max_confirmations: usize,
    manual_only: bool,
    is_default: bool,
}

impl ModelDefinition {
    fn descriptor(&self) -> CurrentEventModelDescriptor {
        CurrentEventModelDescriptor {
            id: self.id.to_owned(),
            display_name: self.display_name.to_owned(),
            description: self.description.to_owned(),
            bundle_version: self.bundle_version.to_owned(),
            deployment_version: self.deployment_version.map(str::to_owned),
            route_version: self.route_version.map(str::to_owned),
            operation_scope: self
                .operation_scope
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            year_feature_count: EXPECTED_FEATURE_COUNT,
            range_feature_count: self.range_feature_count,
            range_reliability_feature_count: self.range_reliability_feature_count,
            single_event_range: self.suggestion_contract == SuggestionContract::SingleEventRange,
            adaptive_event_range: self.adaptive_event_range,
            existing_zero_policy: self.existing_zero_policy.to_owned(),
            top_k: self.top_k,
            range_radius: self.range_radius,
            max_confirmations: self.max_confirmations,
            manual_only: self.manual_only,
            diagnostic_only: true,
            automatic_writeback: false,
            is_default: self.is_default,
        }
    }
}

fn model_definitions() -> Vec<ModelDefinition> {
    vec![
        ModelDefinition {
            id: DEFAULT_MODEL_ID,
            display_name: "年份 Top5 V1.0（原模型）",
            description: "原始年份排序模型；每条建议保留候选年附近的兼容检查范围。",
            bundle_version: "current-event-range-v1.0.0",
            deployment_version: None,
            route_version: None,
            operation_scope: &["insert_missing"],
            resource_name: "current-event-range-v1.0.0",
            #[cfg(not(debug_assertions))]
            release_executable: "current-event-ranker-sidecar.exe",
            #[cfg(debug_assertions)]
            debug_sidecar_script: DEFAULT_DEV_SIDECAR_SCRIPT,
            #[cfg(debug_assertions)]
            debug_bundle_env: "CURRENT_EVENT_BUNDLE",
            #[cfg(debug_assertions)]
            debug_script_env: "CURRENT_EVENT_SIDECAR_SCRIPT",
            range_feature_count: None,
            range_reliability_feature_count: None,
            suggestion_contract: SuggestionContract::LegacyPerSuggestionRange,
            adaptive_event_range: false,
            existing_zero_policy: "preserve",
            top_k: 5,
            range_radius: 1,
            max_confirmations: 6,
            manual_only: false,
            is_default: true,
        },
        ModelDefinition {
            id: ADAPTIVE_RANGE_MODEL_ID,
            display_name: "当前缺轮事件：双门控自适应范围 V1.3",
            description:
                "范围门与年份门独立判断：优先定位唯一事件范围；年份证据通过时再显示精确年份 Top5。",
            bundle_version: "current-event-adaptive-range-gate-v1.3.0",
            deployment_version: None,
            route_version: None,
            operation_scope: &["insert_missing"],
            resource_name: "current-event-adaptive-range-v1",
            #[cfg(not(debug_assertions))]
            release_executable: "current-event-adaptive-range-sidecar.exe",
            #[cfg(debug_assertions)]
            debug_sidecar_script: ADAPTIVE_RANGE_DEV_SIDECAR_SCRIPT,
            #[cfg(debug_assertions)]
            debug_bundle_env: "CURRENT_EVENT_ADAPTIVE_RANGE_BUNDLE",
            #[cfg(debug_assertions)]
            debug_script_env: "CURRENT_EVENT_ADAPTIVE_RANGE_SIDECAR_SCRIPT",
            range_feature_count: Some(70),
            range_reliability_feature_count: Some(EXPECTED_RANGE_RELIABILITY_FEATURE_COUNT),
            suggestion_contract: SuggestionContract::SingleEventRange,
            adaptive_event_range: true,
            existing_zero_policy: "preserve",
            top_k: 5,
            range_radius: 1,
            max_confirmations: 6,
            manual_only: false,
            is_default: false,
        },
        ModelDefinition {
            id: RRF_MODEL_ID,
            display_name: "缺轮逐轮建议：双基准 RRF V1",
            description:
                "仅用于专家主动调用的缺轮逐轮路线；融合 latest-path 与无归一化候选，并由冻结 selector 决定建议或拒答。",
            bundle_version: "current-event-range-v1.0.0",
            deployment_version: Some("current-event-rrf-deployment-candidate-v1"),
            route_version: Some(RRF_ROUTE_VERSION),
            operation_scope: &["insert_missing"],
            resource_name: RRF_MODEL_ID,
            #[cfg(not(debug_assertions))]
            release_executable: "current-event-rrf-sidecar.exe",
            #[cfg(debug_assertions)]
            debug_sidecar_script: RRF_DEV_SIDECAR_SCRIPT,
            #[cfg(debug_assertions)]
            debug_bundle_env: "CURRENT_EVENT_RRF_BUNDLE",
            #[cfg(debug_assertions)]
            debug_script_env: "CURRENT_EVENT_RRF_SIDECAR_SCRIPT",
            range_feature_count: None,
            range_reliability_feature_count: None,
            suggestion_contract: SuggestionContract::RrfPerSuggestionRange,
            adaptive_event_range: false,
            existing_zero_policy: "remove",
            top_k: 5,
            range_radius: 3,
            max_confirmations: 6,
            manual_only: true,
            is_default: false,
        },
    ]
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentEventModelDescriptor {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub bundle_version: String,
    pub deployment_version: Option<String>,
    pub route_version: Option<String>,
    pub operation_scope: Vec<String>,
    pub year_feature_count: u64,
    pub range_feature_count: Option<u64>,
    pub range_reliability_feature_count: Option<u64>,
    pub single_event_range: bool,
    pub adaptive_event_range: bool,
    pub existing_zero_policy: String,
    pub top_k: u8,
    pub range_radius: u8,
    pub max_confirmations: usize,
    pub manual_only: bool,
    pub diagnostic_only: bool,
    pub automatic_writeback: bool,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentEventModelCatalog {
    pub default_model_id: String,
    pub models: Vec<CurrentEventModelDescriptor>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmedInsertion {
    pub year: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankCurrentEventParams {
    pub rwl_path: String,
    pub target_series_id: String,
    #[serde(default = "default_zero_policy")]
    pub existing_zero_policy: String,
    #[serde(default)]
    pub confirmed_insertions: Vec<ConfirmedInsertion>,
    #[serde(default = "default_top_k")]
    pub top_k: u8,
    #[serde(default = "default_range_radius")]
    pub range_radius: u8,
}

fn default_zero_policy() -> String {
    "preserve".to_owned()
}

fn default_top_k() -> u8 {
    5
}

fn default_range_radius() -> u8 {
    1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentEventRequest {
    pub protocol_version: String,
    pub request_id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<RankCurrentEventParams>,
}

impl CurrentEventRequest {
    fn validate(&self, model: &CurrentEventModelDescriptor) -> Result<(), SidecarCommandError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                format!(
                    "protocolVersion must be {PROTOCOL_VERSION}, got {}",
                    self.protocol_version
                ),
                false,
            ));
        }
        if self.request_id.is_empty() || self.request_id.len() > 128 {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                "requestId must contain 1..128 characters",
                false,
            ));
        }
        if self.method != "rank_current_event" {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                "the Tauri command only accepts method=rank_current_event",
                false,
            ));
        }
        let params = self.params.as_ref().ok_or_else(|| {
            SidecarCommandError::new(
                "INVALID_REQUEST",
                "rank_current_event requires params",
                false,
            )
        })?;
        if params.rwl_path.trim().is_empty() || params.target_series_id.trim().is_empty() {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                "rwlPath and targetSeriesId are required",
                false,
            ));
        }
        if params.existing_zero_policy != model.existing_zero_policy {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                format!(
                    "model {} requires existingZeroPolicy={}",
                    model.id, model.existing_zero_policy
                ),
                false,
            ));
        }
        if params.confirmed_insertions.len() > model.max_confirmations {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                format!(
                    "model {} supports at most {} confirmed insertions",
                    model.id, model.max_confirmations
                ),
                false,
            ));
        }
        if params
            .confirmed_insertions
            .iter()
            .any(|item| !(-12_000..=3_000).contains(&item.year))
        {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                "confirmed insertion year is outside -12000..3000",
                false,
            ));
        }
        let confirmed_years: Vec<i32> = params
            .confirmed_insertions
            .iter()
            .map(|item| item.year)
            .collect();
        let unique_years: HashSet<i32> = confirmed_years.iter().copied().collect();
        if unique_years.len() != confirmed_years.len()
            || !confirmed_years.windows(2).all(|pair| pair[0] > pair[1])
        {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                "confirmedInsertions must be unique and ordered newest to oldest",
                false,
            ));
        }
        if params.top_k != model.top_k || params.range_radius != model.range_radius {
            return Err(SidecarCommandError::new(
                "INVALID_REQUEST",
                format!(
                    "model {} requires topK={} and rangeRadius={}",
                    model.id, model.top_k, model.range_radius
                ),
                false,
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarProtocolError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub details: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentEventResponse {
    pub protocol_version: String,
    pub request_id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SidecarProtocolError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankResultContract {
    status: String,
    message: String,
    route_version: Option<String>,
    operation_scope: Option<Value>,
    event_range: Option<EventRangeContract>,
    suggestions: Vec<RankSuggestionContract>,
    reliability: Option<ReliabilityContract>,
    year_reliability: Option<ReliabilityContract>,
    range_reliability: Option<ReliabilityContract>,
    automatic_writeback: Option<bool>,
    diagnostic_only: Option<bool>,
    state: Option<Value>,
    score_semantics: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReliabilityContract {
    accepted: bool,
    score: f64,
    threshold: f64,
    semantics: Option<String>,
    independent_from_year_gate: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventRangeContract {
    start_year: i32,
    end_year: i32,
    center_year: i32,
    width: u64,
    scope: String,
    localizer_score: f64,
    learned_score: Option<f64>,
    interval_softmax_mass: Option<f64>,
    base_center_rank: u64,
    candidate_center_count: u64,
    score_semantics: String,
    adaptive: Option<bool>,
    shrunk: Option<bool>,
    window_policy: Option<String>,
    max_envelope_start: Option<i32>,
    max_envelope_end: Option<i32>,
    evidence_peak: Option<f64>,
    evidence_mass: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RankSuggestionContract {
    rank: u64,
    center_year: i32,
    range_start: i32,
    range_end: i32,
    ranking_score: f64,
    base_rank: Option<u64>,
    range_promoted: Option<bool>,
    score_semantics: Option<String>,
    evidence: Option<RrfEvidenceContract>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RrfEvidenceContract {
    path_rank: Option<u64>,
    none_rank: Option<u64>,
    inferred_latest_path_base: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarCommandError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub details: Value,
}

impl SidecarCommandError {
    fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            details: json!({}),
        }
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
}

#[derive(Clone, Debug)]
struct SidecarLaunch {
    program: PathBuf,
    args: Vec<String>,
    current_dir: Option<PathBuf>,
    bundle_dir: PathBuf,
    model: ModelDefinition,
}

impl SidecarLaunch {
    fn resolve(_app: &AppHandle, model: ModelDefinition) -> Result<Self, SidecarCommandError> {
        #[cfg(debug_assertions)]
        {
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let bundle_dir = std::env::var_os(model.debug_bundle_env)
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    manifest_dir
                        .join("resources")
                        .join("current_event_ranker")
                        .join("models")
                        .join(model.resource_name)
                        .join("bundle")
                });
            let program = std::env::var_os("CURRENT_EVENT_PYTHON")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_DEV_PYTHON));
            let script = std::env::var_os(model.debug_script_env)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(model.debug_sidecar_script));
            validate_launch_path(&program, "development Python")?;
            validate_launch_path(&script, "development sidecar script")?;
            validate_bundle_dir(&bundle_dir)?;
            return Ok(Self {
                program,
                args: vec![
                    "-u".to_owned(),
                    script.to_string_lossy().into_owned(),
                    "--bundle".to_owned(),
                    bundle_dir.to_string_lossy().into_owned(),
                ],
                current_dir: script
                    .parent()
                    .and_then(Path::parent)
                    .map(Path::to_path_buf),
                bundle_dir,
                model,
            });
        }

        #[cfg(not(debug_assertions))]
        {
            let resource_dir = _app.path().resource_dir().map_err(|error| {
                SidecarCommandError::new(
                    "RESOURCE_DIR_UNAVAILABLE",
                    format!("could not resolve Tauri resourceDir: {error}"),
                    false,
                )
            })?;
            let bundle_dir = resource_dir
                .join("current_event_ranker")
                .join("models")
                .join(model.resource_name)
                .join("bundle");
            validate_bundle_dir(&bundle_dir)?;

            let executable_dir = std::env::current_exe()
                .map_err(|error| {
                    SidecarCommandError::new(
                        "SIDECAR_NOT_FOUND",
                        format!("could not resolve application executable: {error}"),
                        false,
                    )
                })?
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| {
                    SidecarCommandError::new(
                        "SIDECAR_NOT_FOUND",
                        "application executable has no parent directory",
                        false,
                    )
                })?;
            let program = executable_dir.join(model.release_executable);
            validate_launch_path(&program, "bundled current-event sidecar")?;
            Ok(Self {
                program,
                args: vec![
                    "--bundle".to_owned(),
                    bundle_dir.to_string_lossy().into_owned(),
                ],
                current_dir: Some(executable_dir),
                bundle_dir,
                model,
            })
        }
    }
}

fn validate_launch_path(path: &Path, label: &str) -> Result<(), SidecarCommandError> {
    if path.is_file() {
        Ok(())
    } else {
        Err(SidecarCommandError::new(
            "SIDECAR_NOT_FOUND",
            format!("{label} does not exist: {}", path.display()),
            false,
        ))
    }
}

fn validate_bundle_dir(path: &Path) -> Result<(), SidecarCommandError> {
    if path.is_dir() && path.join("bundle_manifest.json").is_file() {
        Ok(())
    } else {
        Err(SidecarCommandError::new(
            "BUNDLE_NOT_FOUND",
            format!(
                "current-event bundle is incomplete or missing: {}",
                path.display()
            ),
            false,
        ))
    }
}

struct SidecarProcess {
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Receiver<Result<String, String>>,
}

impl SidecarProcess {
    fn spawn(launch: &SidecarLaunch) -> Result<Self, SidecarCommandError> {
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONDONTWRITEBYTECODE", "1");
        if let Some(current_dir) = &launch.current_dir {
            command.current_dir(current_dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| {
            SidecarCommandError::new(
                "SIDECAR_START_FAILED",
                format!(
                    "could not start current-event sidecar {}: {error}",
                    launch.program.display()
                ),
                true,
            )
            .with_details(json!({"bundleDir": launch.bundle_dir}))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            SidecarCommandError::new(
                "SIDECAR_START_FAILED",
                "current-event sidecar stdin pipe is unavailable",
                true,
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            SidecarCommandError::new(
                "SIDECAR_START_FAILED",
                "current-event sidecar stdout pipe is unavailable",
                true,
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            SidecarCommandError::new(
                "SIDECAR_START_FAILED",
                "current-event sidecar stderr pipe is unavailable",
                true,
            )
        })?;

        let (stdout_tx, stdout_lines) = mpsc::channel();
        thread::Builder::new()
            .name("current-event-sidecar-stdout".to_owned())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let next = line.map_err(|error| error.to_string());
                    if stdout_tx.send(next).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| {
                SidecarCommandError::new(
                    "SIDECAR_START_FAILED",
                    format!("could not start sidecar stdout reader: {error}"),
                    true,
                )
            })?;

        thread::Builder::new()
            .name("current-event-sidecar-stderr".to_owned())
            .spawn(move || {
                for line in BufReader::new(stderr).lines() {
                    match line {
                        Ok(message) if !message.trim().is_empty() => {
                            eprintln!("[current-event sidecar] {message}");
                        }
                        Ok(_) => {}
                        Err(error) => {
                            eprintln!("[current-event sidecar] stderr read failed: {error}");
                            break;
                        }
                    }
                }
            })
            .map_err(|error| {
                SidecarCommandError::new(
                    "SIDECAR_START_FAILED",
                    format!("could not start sidecar stderr reader: {error}"),
                    true,
                )
            })?;

        Ok(Self {
            child,
            stdin,
            stdout_lines,
        })
    }

    fn call(
        &mut self,
        request: &CurrentEventRequest,
        timeout: Duration,
        model: &ModelDefinition,
    ) -> Result<CurrentEventResponse, SidecarCommandError> {
        if let Some(status) = self.child.try_wait().map_err(|error| {
            SidecarCommandError::new(
                "SIDECAR_IO_FAILED",
                format!("could not inspect sidecar status: {error}"),
                true,
            )
        })? {
            return Err(SidecarCommandError::new(
                "SIDECAR_EXITED",
                format!("current-event sidecar exited with {status}"),
                true,
            ));
        }
        let serialized = serde_json::to_string(request).map_err(|error| {
            SidecarCommandError::new(
                "REQUEST_SERIALIZATION_FAILED",
                format!("could not serialize current-event request: {error}"),
                false,
            )
        })?;
        writeln!(self.stdin, "{serialized}")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| {
                SidecarCommandError::new(
                    "SIDECAR_IO_FAILED",
                    format!("could not write current-event request: {error}"),
                    true,
                )
            })?;

        let response_line = match self.stdout_lines.recv_timeout(timeout) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => {
                return Err(SidecarCommandError::new(
                    "SIDECAR_IO_FAILED",
                    format!("could not read current-event response: {error}"),
                    true,
                ))
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(SidecarCommandError::new(
                    "SIDECAR_TIMEOUT",
                    format!(
                        "current-event request exceeded {} seconds",
                        timeout.as_secs()
                    ),
                    true,
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(SidecarCommandError::new(
                    "SIDECAR_EXITED",
                    "current-event sidecar closed stdout without a response",
                    true,
                ))
            }
        };
        let response: CurrentEventResponse =
            serde_json::from_str(response_line.trim()).map_err(|error| {
                SidecarCommandError::new(
                    "INVALID_SIDECAR_RESPONSE",
                    format!("sidecar emitted invalid JSON: {error}"),
                    true,
                )
                .with_details(json!({"line": response_line.chars().take(500).collect::<String>()}))
            })?;
        validate_response(request, &response, model)?;
        Ok(response)
    }

    fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for SidecarProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn validate_response(
    request: &CurrentEventRequest,
    response: &CurrentEventResponse,
    model: &ModelDefinition,
) -> Result<(), SidecarCommandError> {
    if response.protocol_version != PROTOCOL_VERSION {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "sidecar response protocolVersion does not match",
            true,
        ));
    }
    if response.request_id.as_deref() != Some(request.request_id.as_str()) {
        return Err(SidecarCommandError::new(
            "REQUEST_ID_MISMATCH",
            "sidecar response requestId does not match the request",
            true,
        )
        .with_details(json!({
            "expected": request.request_id,
            "received": response.request_id,
        })));
    }
    if response.ok && response.result.is_none() {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "successful sidecar response is missing result",
            true,
        ));
    }
    if !response.ok && response.error.is_none() {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "failed sidecar response is missing error",
            true,
        ));
    }
    if response.ok && request.method == "rank_current_event" {
        validate_rank_result(request, response, model)?;
    }
    Ok(())
}

fn validate_rank_result(
    request: &CurrentEventRequest,
    response: &CurrentEventResponse,
    model: &ModelDefinition,
) -> Result<(), SidecarCommandError> {
    let params = request.params.as_ref().ok_or_else(|| {
        SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "rank response cannot be validated without request params",
            true,
        )
    })?;
    let result: RankResultContract =
        serde_json::from_value(response.result.clone().ok_or_else(|| {
            SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                "rank response is missing result",
                true,
            )
        })?)
        .map_err(|error| {
            SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                format!("rank result does not match the protocol schema: {error}"),
                true,
            )
        })?;

    if result.message.trim().is_empty()
        || result.automatic_writeback == Some(true)
        || result.diagnostic_only == Some(false)
    {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "rank result must remain diagnostic-only and must not enable automatic writeback",
            true,
        ));
    }
    match result.status.as_str() {
        "advice" if result.suggestions.is_empty() => {
            return Err(SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                "advice result must contain at least one suggestion",
                true,
            ));
        }
        "evidence_insufficient" if !result.suggestions.is_empty() => {
            return Err(SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                "evidence_insufficient result must not contain suggestions",
                true,
            ));
        }
        "range_advice" if !result.suggestions.is_empty() => {
            return Err(SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                "range_advice result must not contain exact-year suggestions",
                true,
            ));
        }
        "range_advice" if model.range_reliability_feature_count.is_none() => {
            return Err(SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                "range_advice is only valid for a model with an independent range gate",
                true,
            ));
        }
        "advice" | "range_advice" | "evidence_insufficient" => {}
        _ => {
            return Err(SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                format!("unexpected rank result status: {}", result.status),
                true,
            ));
        }
    }
    if result.suggestions.len() > params.top_k as usize {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "rank result contains more suggestions than requested",
            true,
        ));
    }

    if model.range_reliability_feature_count.is_some() {
        validate_dual_gate_result(&result)?;
    }
    if model.suggestion_contract == SuggestionContract::RrfPerSuggestionRange {
        validate_rrf_result(&result)?;
    }

    match model.suggestion_contract {
        SuggestionContract::LegacyPerSuggestionRange
        | SuggestionContract::RrfPerSuggestionRange
            if result.event_range.is_some() =>
        {
            return Err(SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                "per-suggestion-range model must not emit a single eventRange",
                true,
            ));
        }
        SuggestionContract::SingleEventRange => {
            if matches!(result.status.as_str(), "advice" | "range_advice") {
                let event_range = result.event_range.as_ref().ok_or_else(|| {
                    SidecarCommandError::new(
                        "INVALID_SIDECAR_RESPONSE",
                        "single-range advice must include exactly one eventRange",
                        true,
                    )
                })?;
                let computed_width =
                    i64::from(event_range.end_year) - i64::from(event_range.start_year) + 1;
                let bounded_scores = event_range
                    .learned_score
                    .map_or(true, |value| value.is_finite())
                    && event_range
                        .interval_softmax_mass
                        .map_or(true, |value| value.is_finite());
                let adaptive_contract = if model.adaptive_event_range {
                    match (
                        event_range.shrunk,
                        event_range.max_envelope_start,
                        event_range.max_envelope_end,
                        event_range.evidence_peak,
                        event_range.evidence_mass,
                    ) {
                        (Some(shrunk), Some(max_start), Some(max_end), Some(peak), Some(mass)) => {
                            let max_width = i64::from(max_end) - i64::from(max_start) + 1;
                            event_range.adaptive == Some(true)
                                && event_range.window_policy.as_deref() == Some("local_score_mass")
                                && max_start <= event_range.start_year
                                && event_range.end_year <= max_end
                                && max_start <= event_range.center_year
                                && event_range.center_year <= max_end
                                && (1..=15).contains(&max_width)
                                && shrunk == (computed_width < max_width)
                                && peak.is_finite()
                                && (0.0..=1.0).contains(&peak)
                                && mass.is_finite()
                                && (0.0..=1.0).contains(&mass)
                        }
                        _ => false,
                    }
                } else {
                    true
                };
                let valid_range = event_range.start_year <= event_range.center_year
                    && event_range.center_year <= event_range.end_year
                    && computed_width == event_range.width as i64
                    && (1..=15).contains(&event_range.width)
                    && event_range.scope == "newest_unresolved_event"
                    && event_range.localizer_score.is_finite()
                    && bounded_scores
                    && event_range.base_center_rank >= 1
                    && event_range.base_center_rank <= event_range.candidate_center_count
                    && event_range.candidate_center_count <= 120
                    && !event_range.score_semantics.trim().is_empty()
                    && adaptive_contract;
                if !valid_range {
                    return Err(SidecarCommandError::new(
                        "INVALID_SIDECAR_RESPONSE",
                        "single eventRange violates the bounded adaptive-range contract",
                        true,
                    ));
                }
            } else if result.event_range.is_some() {
                return Err(SidecarCommandError::new(
                    "INVALID_SIDECAR_RESPONSE",
                    "evidence_insufficient must not expose an eventRange",
                    true,
                ));
            }
        }
        SuggestionContract::LegacyPerSuggestionRange
        | SuggestionContract::RrfPerSuggestionRange => {}
    }

    let mut previous_score = f64::INFINITY;
    for (index, suggestion) in result.suggestions.iter().enumerate() {
        let expected_rank = (index + 1) as u64;
        let valid_for_model = match model.suggestion_contract {
            SuggestionContract::LegacyPerSuggestionRange => {
                let center_year = i64::from(suggestion.center_year);
                let range_start = i64::from(suggestion.range_start);
                let range_end = i64::from(suggestion.range_end);
                let range_radius = i64::from(params.range_radius);
                suggestion.range_start <= suggestion.center_year
                    && suggestion.center_year <= suggestion.range_end
                    && center_year - range_start <= range_radius
                    && range_end - center_year <= range_radius
                    && suggestion.ranking_score <= previous_score
            }
            SuggestionContract::RrfPerSuggestionRange => {
                let center_year = i64::from(suggestion.center_year);
                let range_start = i64::from(suggestion.range_start);
                let range_end = i64::from(suggestion.range_end);
                let range_radius = i64::from(params.range_radius);
                let evidence = suggestion.evidence.as_ref();
                let expected_score = evidence.map(|item| {
                    item.path_rank.map_or(0.0, |rank| 1.0 / rank as f64)
                        + item.none_rank.map_or(0.0, |rank| 1.0 / rank as f64)
                });
                suggestion.range_start <= suggestion.center_year
                    && suggestion.center_year <= suggestion.range_end
                    && center_year - range_start <= range_radius
                    && range_end - center_year <= range_radius
                    && suggestion.ranking_score <= previous_score
                    && suggestion
                        .score_semantics
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
                    && evidence.is_some_and(|item| {
                        (item.path_rank.is_some() || item.none_rank.is_some())
                            && item.path_rank.is_none_or(|rank| rank >= 1)
                            && item.none_rank.is_none_or(|rank| rank >= 1)
                            && item
                                .inferred_latest_path_base
                                .is_some_and(|offset| (-30..=30).contains(&offset))
                    })
                    && expected_score
                        .is_some_and(|score| (score - suggestion.ranking_score).abs() <= 1e-12)
            }
            SuggestionContract::SingleEventRange => result
                .event_range
                .as_ref()
                .map(|event_range| {
                    suggestion.range_start == event_range.start_year
                        && suggestion.range_end == event_range.end_year
                        && suggestion.base_rank.is_some_and(|rank| rank >= 1)
                        && suggestion.range_promoted.is_some()
                })
                .unwrap_or(false),
        };
        if suggestion.rank != expected_rank
            || !suggestion.ranking_score.is_finite()
            || !valid_for_model
        {
            return Err(SidecarCommandError::new(
                "INVALID_SIDECAR_RESPONSE",
                "rank suggestions do not match the selected model contract or server rank order",
                true,
            )
            .with_details(json!({
                "index": index,
                "suggestion": response.result.as_ref().and_then(|value| {
                    value.get("suggestions").and_then(|items| items.get(index))
                }),
            })));
        }
        previous_score = suggestion.ranking_score;
    }
    Ok(())
}

fn validate_rrf_result(result: &RankResultContract) -> Result<(), SidecarCommandError> {
    let operation_scope_is_insert_missing = match result.operation_scope.as_ref() {
        Some(Value::String(value)) => value == "insert_missing",
        Some(Value::Array(values)) => {
            values.len() == 1 && values[0].as_str() == Some("insert_missing")
        }
        _ => false,
    };
    let reliability = result.reliability.as_ref();
    let reliability_is_valid = reliability.is_some_and(|value| {
        value.score.is_finite()
            && (0.0..=1.0).contains(&value.score)
            && value.threshold.is_finite()
            && (value.threshold - EXPECTED_RRF_RELIABILITY_THRESHOLD).abs() <= 1e-15
            && value.accepted == (result.status == "advice")
            && value
                .semantics
                .as_deref()
                .is_some_and(|semantics| !semantics.trim().is_empty())
    });
    let state_uses_remove = result
        .state
        .as_ref()
        .and_then(|value| value.get("existingZeroPolicy"))
        .and_then(Value::as_str)
        == Some("remove");
    let score_semantics_present =
        result
            .score_semantics
            .as_ref()
            .is_some_and(|value| match value {
                Value::String(text) => !text.trim().is_empty(),
                Value::Object(fields) => !fields.is_empty(),
                _ => false,
            });
    if result.route_version.as_deref() != Some(RRF_ROUTE_VERSION)
        || !operation_scope_is_insert_missing
        || result.diagnostic_only != Some(true)
        || result.automatic_writeback != Some(false)
        || !reliability_is_valid
        || !state_uses_remove
        || !score_semantics_present
        || result.event_range.is_some()
        || result.range_reliability.is_some()
        || result.year_reliability.is_some()
    {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "RRF result violates the frozen insert_missing route, selector, or remove-zero contract",
            true,
        ));
    }
    Ok(())
}

fn validate_dual_gate_result(result: &RankResultContract) -> Result<(), SidecarCommandError> {
    let range = result.range_reliability.as_ref();
    let year = result.year_reliability.as_ref();
    let year_alias = result.reliability.as_ref();
    let contracts_present = range.is_some() && year.is_some() && year_alias.is_some();
    if !contracts_present {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "dual-gate result must include rangeReliability, yearReliability and the reliability alias",
            true,
        ));
    }
    let range = range.expect("range reliability presence was checked");
    let year = year.expect("year reliability presence was checked");
    let year_alias = year_alias.expect("year reliability alias presence was checked");
    let valid_contract = |value: &ReliabilityContract| {
        value.score.is_finite()
            && value.threshold.is_finite()
            && value
                .semantics
                .as_deref()
                .is_some_and(|semantics| !semantics.trim().is_empty())
    };
    let alias_matches_year = year_alias.accepted == year.accepted
        && year_alias.score == year.score
        && year_alias.threshold == year.threshold
        && year_alias.semantics == year.semantics;
    let range_contract_matches = valid_contract(range)
        && range.independent_from_year_gate == Some(true)
        && (range.threshold - EXPECTED_RANGE_RELIABILITY_THRESHOLD).abs() <= 1e-15;
    let status_matches_gates = match result.status.as_str() {
        "advice" => range.accepted && year.accepted,
        "range_advice" => range.accepted && !year.accepted,
        "evidence_insufficient" => !range.accepted,
        _ => false,
    };
    if !range_contract_matches
        || !valid_contract(year)
        || !valid_contract(year_alias)
        || !alias_matches_year
        || !status_matches_gates
    {
        return Err(SidecarCommandError::new(
            "INVALID_SIDECAR_RESPONSE",
            "dual-gate reliability fields do not match the selected model or result status",
            true,
        ));
    }
    Ok(())
}

enum WorkerMessage {
    Call {
        model_id: String,
        request: CurrentEventRequest,
        deadline: Instant,
        reply: Sender<Result<CurrentEventResponse, SidecarCommandError>>,
    },
    Stop,
}

pub struct CurrentEventSidecar {
    sender: Sender<WorkerMessage>,
    models: Vec<CurrentEventModelDescriptor>,
}

impl CurrentEventSidecar {
    pub fn start(app: &AppHandle) -> Self {
        let definitions = model_definitions();
        let models = definitions
            .iter()
            .map(ModelDefinition::descriptor)
            .collect();
        let launches = definitions
            .into_iter()
            .map(|definition| {
                let id = definition.id.to_owned();
                (id, SidecarLaunch::resolve(app, definition))
            })
            .collect();
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("current-event-sidecar-worker".to_owned())
            .spawn(move || worker_loop(receiver, launches))
            .expect("could not start current-event sidecar worker");
        Self { sender, models }
    }

    fn catalog(&self) -> CurrentEventModelCatalog {
        CurrentEventModelCatalog {
            default_model_id: DEFAULT_MODEL_ID.to_owned(),
            models: self.models.clone(),
        }
    }

    async fn call(
        &self,
        model_id: Option<String>,
        request: CurrentEventRequest,
    ) -> Result<CurrentEventResponse, SidecarCommandError> {
        let model_id = model_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL_ID.to_owned());
        let model = self
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| {
                SidecarCommandError::new(
                    "MODEL_NOT_FOUND",
                    format!("unknown current-event model: {model_id}"),
                    false,
                )
            })?;
        request.validate(model)?;
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let sender = self.sender.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let (reply, response) = mpsc::channel();
            sender
                .send(WorkerMessage::Call {
                    model_id,
                    request,
                    deadline,
                    reply,
                })
                .map_err(|_| {
                    SidecarCommandError::new(
                        "SIDECAR_WORKER_STOPPED",
                        "current-event sidecar worker is not available",
                        true,
                    )
                })?;
            match response.recv_timeout(remaining_timeout(deadline, REQUEST_TIMEOUT)?) {
                Ok(result) => result,
                Err(RecvTimeoutError::Timeout) => Err(SidecarCommandError::new(
                    "SIDECAR_TIMEOUT",
                    format!(
                        "current-event request exceeded the total {} second deadline",
                        REQUEST_TIMEOUT.as_secs()
                    ),
                    true,
                )),
                Err(RecvTimeoutError::Disconnected) => Err(SidecarCommandError::new(
                    "SIDECAR_WORKER_STOPPED",
                    "current-event sidecar worker stopped before responding",
                    true,
                )),
            }
        })
        .await
        .map_err(|error| {
            SidecarCommandError::new(
                "SIDECAR_WORKER_FAILED",
                format!("current-event sidecar worker task failed: {error}"),
                true,
            )
        })?
    }
}

impl Drop for CurrentEventSidecar {
    fn drop(&mut self) {
        let _ = self.sender.send(WorkerMessage::Stop);
    }
}

fn worker_loop(
    receiver: Receiver<WorkerMessage>,
    launches: HashMap<String, Result<SidecarLaunch, SidecarCommandError>>,
) {
    let mut process: Option<SidecarProcess> = None;
    let mut active_model_id: Option<String> = None;

    while let Ok(message) = receiver.recv() {
        match message {
            WorkerMessage::Call {
                model_id,
                request,
                deadline,
                reply,
            } => {
                if active_model_id.as_deref() != Some(model_id.as_str()) {
                    process.take();
                    active_model_id = Some(model_id.clone());
                }
                let result = match launches.get(&model_id) {
                    Some(Ok(launch)) => {
                        call_with_restart(launch, &mut process, &request, deadline, REQUEST_TIMEOUT)
                    }
                    Some(Err(error)) => Err(error.clone()),
                    None => Err(SidecarCommandError::new(
                        "MODEL_NOT_FOUND",
                        format!("unknown current-event model: {model_id}"),
                        false,
                    )),
                };
                let _ = reply.send(result);
            }
            WorkerMessage::Stop => {
                process.take();
                break;
            }
        }
    }
}

fn call_with_restart(
    launch: &SidecarLaunch,
    process: &mut Option<SidecarProcess>,
    request: &CurrentEventRequest,
    deadline: Instant,
    timeout: Duration,
) -> Result<CurrentEventResponse, SidecarCommandError> {
    let mut last_error = None;
    for _attempt in 0..2 {
        ensure_deadline(deadline, timeout)?;
        if process.is_none() {
            match SidecarProcess::spawn(launch).and_then(|mut next| {
                perform_handshake(&mut next, launch, deadline, timeout)?;
                Ok(next)
            }) {
                Ok(next) => *process = Some(next),
                Err(error) if error.retryable => {
                    last_error = Some(error);
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        let result = process
            .as_mut()
            .expect("sidecar process was initialized")
            .call(
                request,
                remaining_timeout(deadline, timeout)?,
                &launch.model,
            );
        match result {
            Ok(response) => return Ok(response),
            Err(error) if error.retryable => {
                last_error = Some(error);
                process.take();
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        SidecarCommandError::new(
            "SIDECAR_UNAVAILABLE",
            "current-event sidecar is unavailable after restart",
            true,
        )
    }))
}

fn ensure_deadline(deadline: Instant, timeout: Duration) -> Result<(), SidecarCommandError> {
    remaining_timeout(deadline, timeout).map(|_| ())
}

fn remaining_timeout(
    deadline: Instant,
    timeout: Duration,
) -> Result<Duration, SidecarCommandError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| {
            SidecarCommandError::new(
                "SIDECAR_TIMEOUT",
                format!(
                    "current-event request exceeded the total {} second deadline",
                    timeout.as_secs()
                ),
                true,
            )
        })
}

fn perform_handshake(
    process: &mut SidecarProcess,
    launch: &SidecarLaunch,
    deadline: Instant,
    timeout: Duration,
) -> Result<(), SidecarCommandError> {
    let health = protocol_request("health", "startup-health");
    let health_response = process.call(
        &health,
        remaining_timeout(deadline, timeout)?,
        &launch.model,
    )?;
    if !health_response.ok {
        return Err(SidecarCommandError::new(
            "SIDECAR_HANDSHAKE_FAILED",
            "current-event sidecar health check failed",
            true,
        )
        .with_details(json!({"response": health_response})));
    }
    let health_bundle_version = health_response
        .result
        .as_ref()
        .and_then(|value| value.get("bundleVersion"))
        .and_then(Value::as_str);
    if health_bundle_version != Some(launch.model.bundle_version) {
        return Err(SidecarCommandError::new(
            "SIDECAR_HANDSHAKE_FAILED",
            "current-event sidecar health bundleVersion does not match the selected model",
            false,
        )
        .with_details(json!({
            "expectedBundleVersion": launch.model.bundle_version,
            "healthBundleVersion": health_bundle_version,
        })));
    }

    let describe = protocol_request("describe", "startup-describe");
    let describe_response = process.call(
        &describe,
        remaining_timeout(deadline, timeout)?,
        &launch.model,
    )?;
    let result = describe_response.result.ok_or_else(|| {
        SidecarCommandError::new(
            "SIDECAR_HANDSHAKE_FAILED",
            "current-event sidecar describe response is missing result",
            true,
        )
    })?;
    let checks = [
        (
            result.get("bundleVersion").and_then(Value::as_str)
                == Some(launch.model.bundle_version),
            "bundleVersion",
        ),
        (
            result.get("featureVariant").and_then(Value::as_str) == Some(EXPECTED_FEATURE_VARIANT),
            "featureVariant",
        ),
        (
            result.get("featureCount").and_then(Value::as_u64) == Some(EXPECTED_FEATURE_COUNT),
            "featureCount",
        ),
        (
            result.get("candidatePool").and_then(Value::as_str) == Some(EXPECTED_CANDIDATE_POOL),
            "candidatePool",
        ),
        (
            result.get("topK").and_then(Value::as_u64) == Some(launch.model.top_k.into()),
            "topK",
        ),
        (
            result.get("diagnosticOnly").and_then(Value::as_bool) == Some(true),
            "diagnosticOnly",
        ),
        (
            result.get("automaticWriteback").and_then(Value::as_bool) == Some(false),
            "automaticWriteback",
        ),
        (
            match launch.model.route_version {
                Some(route_version) => {
                    let scope = result.get("operationScope");
                    result.get("routeVersion").and_then(Value::as_str) == Some(route_version)
                        && result.get("rangeRadius").and_then(Value::as_u64)
                            == Some(launch.model.range_radius.into())
                        && result.get("recommendedTopK").and_then(Value::as_u64)
                            == Some(launch.model.top_k.into())
                        && result.get("recommendedRangeRadius").and_then(Value::as_u64)
                            == Some(launch.model.range_radius.into())
                        && result
                            .get("defaultExistingZeroPolicy")
                            .and_then(Value::as_str)
                            == Some(launch.model.existing_zero_policy)
                        && result.get("fusion").and_then(Value::as_str)
                            == Some("path_rank_reciprocal_plus_none_rank_reciprocal")
                        && scope.and_then(Value::as_array).is_some_and(|values| {
                            values.len() == 1 && values[0].as_str() == Some("insert_missing")
                        })
                }
                None => true,
            },
            "routePolicy",
        ),
        (
            match launch.model.range_feature_count {
                Some(feature_count) => {
                    let event_range = result.get("eventRange");
                    let base_contract = event_range
                        .and_then(|value| value.get("count"))
                        .and_then(Value::as_u64)
                        == Some(1)
                        && event_range
                            .and_then(|value| value.get("maxWidth"))
                            .and_then(Value::as_u64)
                            == Some(15)
                        && event_range
                            .and_then(|value| value.get("featureCount"))
                            .and_then(Value::as_u64)
                            == Some(feature_count);
                    let range_gate_contract = match launch.model.range_reliability_feature_count {
                        Some(reliability_feature_count) => {
                            let gate = event_range.and_then(|value| value.get("reliabilityGate"));
                            gate.and_then(|value| value.get("independentFromYearGate"))
                                .and_then(Value::as_bool)
                                == Some(true)
                                && gate
                                    .and_then(|value| value.get("featureCount"))
                                    .and_then(Value::as_u64)
                                    == Some(reliability_feature_count)
                                && gate
                                    .and_then(|value| value.get("threshold"))
                                    .and_then(Value::as_f64)
                                    .is_some_and(|threshold| {
                                        (threshold - EXPECTED_RANGE_RELIABILITY_THRESHOLD).abs()
                                            <= 1e-15
                                    })
                        }
                        None => event_range
                            .and_then(|value| value.get("reliabilityGate"))
                            .is_none(),
                    };
                    base_contract
                        && range_gate_contract
                        && (!launch.model.adaptive_event_range
                            || (event_range
                                .and_then(|value| value.get("adaptive"))
                                .and_then(Value::as_bool)
                                == Some(true)
                                && event_range
                                    .and_then(|value| value.get("maxRadius"))
                                    .and_then(Value::as_u64)
                                    == Some(7)
                                && event_range
                                    .and_then(|value| value.get("maxCenters"))
                                    .and_then(Value::as_u64)
                                    == Some(120)
                                && event_range
                                    .and_then(|value| value.get("adaptivePolicy"))
                                    .is_some_and(Value::is_object)))
                }
                None => result.get("eventRange").is_none(),
            },
            "eventRange",
        ),
    ];
    let failed: Vec<&str> = checks
        .into_iter()
        .filter_map(|(passed, name)| (!passed).then_some(name))
        .collect();
    if !failed.is_empty() {
        return Err(SidecarCommandError::new(
            "SIDECAR_HANDSHAKE_FAILED",
            "current-event sidecar describe contract does not match this application",
            false,
        )
        .with_details(json!({"failedChecks": failed, "describe": result})));
    }
    Ok(())
}

fn protocol_request(method: &str, request_id: &str) -> CurrentEventRequest {
    CurrentEventRequest {
        protocol_version: PROTOCOL_VERSION.to_owned(),
        request_id: request_id.to_owned(),
        method: method.to_owned(),
        params: None,
    }
}

#[tauri::command]
/// Rank a single selected series without changing the RWL or the default
/// automatic-crossdating candidate ordering.
pub async fn rank_current_event_v1(
    state: State<'_, CurrentEventSidecar>,
    model_id: Option<String>,
    request: CurrentEventRequest,
) -> Result<CurrentEventResponse, SidecarCommandError> {
    state.inner().call(model_id, request).await
}

#[tauri::command]
/// Return the trusted model bundles packaged with this application.
pub fn list_current_event_models(
    state: State<'_, CurrentEventSidecar>,
) -> CurrentEventModelCatalog {
    state.inner().catalog()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_model() -> ModelDefinition {
        model_definitions()
            .into_iter()
            .find(|model| model.id == DEFAULT_MODEL_ID)
            .unwrap()
    }

    fn adaptive_range_model() -> ModelDefinition {
        model_definitions()
            .into_iter()
            .find(|model| model.id == ADAPTIVE_RANGE_MODEL_ID)
            .unwrap()
    }

    fn rrf_model() -> ModelDefinition {
        model_definitions()
            .into_iter()
            .find(|model| model.id == RRF_MODEL_ID)
            .unwrap()
    }

    fn valid_request() -> CurrentEventRequest {
        CurrentEventRequest {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: "rank-test-1".to_owned(),
            method: "rank_current_event".to_owned(),
            params: Some(RankCurrentEventParams {
                rwl_path: r"D:\data\sample.rwl".to_owned(),
                target_series_id: "ABC01A".to_owned(),
                existing_zero_policy: "preserve".to_owned(),
                confirmed_insertions: vec![ConfirmedInsertion { year: 1900 }],
                top_k: 5,
                range_radius: 1,
            }),
        }
    }

    fn rrf_request() -> CurrentEventRequest {
        CurrentEventRequest {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: "rank-test-1".to_owned(),
            method: "rank_current_event".to_owned(),
            params: Some(RankCurrentEventParams {
                rwl_path: r"D:\data\sample.rwl".to_owned(),
                target_series_id: "ABC01A".to_owned(),
                existing_zero_policy: "remove".to_owned(),
                confirmed_insertions: vec![
                    ConfirmedInsertion { year: 1900 },
                    ConfirmedInsertion { year: 1880 },
                ],
                top_k: 5,
                range_radius: 3,
            }),
        }
    }

    fn range_only_response(year_accepted: bool) -> CurrentEventResponse {
        CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("rank-test-1".to_owned()),
            ok: true,
            result: Some(json!({
                "status": "range_advice",
                "message": "范围可供重点检查，但精确年份证据不足",
                "diagnosticOnly": true,
                "automaticWriteback": false,
                "rangeReliability": {
                    "accepted": true,
                    "score": 0.8,
                    "threshold": EXPECTED_RANGE_RELIABILITY_THRESHOLD,
                    "semantics": "relative range reliability score, not probability",
                    "independentFromYearGate": true
                },
                "yearReliability": {
                    "accepted": year_accepted,
                    "score": 0.5,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "reliability": {
                    "accepted": year_accepted,
                    "score": 0.5,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "eventRange": {
                    "startYear": 1880,
                    "endYear": 1894,
                    "centerYear": 1887,
                    "width": 15,
                    "scope": "newest_unresolved_event",
                    "localizerScore": 2.4,
                    "baseCenterRank": 4,
                    "candidateCenterCount": 120,
                    "scoreSemantics": "relative range score, not probability",
                    "adaptive": true,
                    "shrunk": false,
                    "windowPolicy": "local_score_mass",
                    "maxEnvelopeStart": 1880,
                    "maxEnvelopeEnd": 1894,
                    "evidencePeak": 0.2,
                    "evidenceMass": 0.8
                },
                "suggestions": []
            })),
            error: None,
        }
    }

    #[test]
    fn request_serializes_to_the_frozen_camel_case_protocol() {
        let value = serde_json::to_value(valid_request()).unwrap();
        assert_eq!(value["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(value["method"], "rank_current_event");
        assert_eq!(value["params"]["confirmedInsertions"][0]["year"], 1900);
        assert!(value["params"].get("zero_count").is_none());
        assert!(value["params"].get("remaining_event_count").is_none());
    }

    #[test]
    fn trusted_catalog_keeps_legacy_default_and_upgrades_the_stable_adaptive_slot() {
        let models = model_definitions();
        assert_eq!(models.len(), 3);
        assert!(models
            .iter()
            .any(|model| model.id == DEFAULT_MODEL_ID && model.is_default));
        let adaptive = models
            .iter()
            .find(|model| model.id == ADAPTIVE_RANGE_MODEL_ID)
            .unwrap();
        assert_eq!(
            adaptive.bundle_version,
            "current-event-adaptive-range-gate-v1.3.0"
        );
        assert_eq!(adaptive.range_feature_count, Some(70));
        assert_eq!(adaptive.range_reliability_feature_count, Some(109));
        assert!(adaptive.adaptive_event_range);
        assert_eq!(
            adaptive.suggestion_contract,
            SuggestionContract::SingleEventRange
        );
        assert!(!models
            .iter()
            .any(|model| model.id == "current-event-single-range-v1.1.0"));
        let rrf = models
            .iter()
            .find(|model| model.id == RRF_MODEL_ID)
            .unwrap();
        assert_eq!(rrf.bundle_version, "current-event-range-v1.0.0");
        assert_eq!(
            rrf.deployment_version,
            Some("current-event-rrf-deployment-candidate-v1")
        );
        assert_eq!(rrf.route_version, Some(RRF_ROUTE_VERSION));
        assert_eq!(rrf.existing_zero_policy, "remove");
        assert_eq!(rrf.range_radius, 3);
        assert!(rrf.manual_only);
        assert_eq!(
            rrf.suggestion_contract,
            SuggestionContract::RrfPerSuggestionRange
        );
    }

    #[test]
    fn desktop_validation_enforces_each_models_frozen_request_policy() {
        let mut request = valid_request();
        request.params.as_mut().unwrap().existing_zero_policy = "remove".to_owned();
        assert_eq!(
            request
                .validate(&legacy_model().descriptor())
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );

        let mut request = valid_request();
        request.params.as_mut().unwrap().confirmed_insertions =
            (0..7).map(|year| ConfirmedInsertion { year }).collect();
        assert_eq!(
            request
                .validate(&legacy_model().descriptor())
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );

        rrf_request().validate(&rrf_model().descriptor()).unwrap();
        let mut wrong_rrf_request = rrf_request();
        wrong_rrf_request
            .params
            .as_mut()
            .unwrap()
            .existing_zero_policy = "preserve".to_owned();
        assert_eq!(
            wrong_rrf_request
                .validate(&rrf_model().descriptor())
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );
        let mut unordered = rrf_request();
        unordered
            .params
            .as_mut()
            .unwrap()
            .confirmed_insertions
            .reverse();
        assert_eq!(
            unordered
                .validate(&rrf_model().descriptor())
                .unwrap_err()
                .code,
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn response_validation_rejects_request_id_mismatch() {
        let response = CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("different-request".to_owned()),
            ok: true,
            result: Some(json!({"status": "advice"})),
            error: None,
        };
        assert_eq!(
            validate_response(&valid_request(), &response, &legacy_model())
                .unwrap_err()
                .code,
            "REQUEST_ID_MISMATCH"
        );
    }

    #[test]
    fn evidence_insufficient_is_a_valid_success_response() {
        let response = CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("rank-test-1".to_owned()),
            ok: true,
            result: Some(json!({
                "status": "evidence_insufficient",
                "message": "insufficient evidence",
                "suggestions": [],
                "automaticWriteback": false
            })),
            error: None,
        };
        validate_response(&valid_request(), &response, &legacy_model()).unwrap();
    }

    #[test]
    fn dual_gate_range_advice_exposes_one_range_without_exact_years() {
        validate_response(
            &valid_request(),
            &range_only_response(false),
            &adaptive_range_model(),
        )
        .unwrap();
    }

    #[test]
    fn dual_gate_status_must_match_independent_gate_decisions() {
        assert_eq!(
            validate_response(
                &valid_request(),
                &range_only_response(true),
                &adaptive_range_model(),
            )
            .unwrap_err()
            .code,
            "INVALID_SIDECAR_RESPONSE"
        );
    }

    #[test]
    fn rank_result_rejects_scores_that_are_not_descending() {
        let response = CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("rank-test-1".to_owned()),
            ok: true,
            result: Some(json!({
                "status": "advice",
                "message": "review these years",
                "automaticWriteback": false,
                "suggestions": [
                    {
                        "rank": 1,
                        "centerYear": 1900,
                        "rangeStart": 1899,
                        "rangeEnd": 1901,
                        "rankingScore": 0.1
                    },
                    {
                        "rank": 2,
                        "centerYear": 1880,
                        "rangeStart": 1879,
                        "rangeEnd": 1881,
                        "rankingScore": 0.2
                    }
                ]
            })),
            error: None,
        };
        assert_eq!(
            validate_response(&valid_request(), &response, &legacy_model())
                .unwrap_err()
                .code,
            "INVALID_SIDECAR_RESPONSE"
        );
    }

    #[test]
    fn rrf_response_requires_route_selector_evidence_and_reciprocal_rank_score() {
        let response = CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("rank-test-1".to_owned()),
            ok: true,
            result: Some(json!({
                "status": "advice",
                "message": "请由专家复核以下缺轮中心年",
                "routeVersion": RRF_ROUTE_VERSION,
                "operationScope": "insert_missing",
                "diagnosticOnly": true,
                "automaticWriteback": false,
                "scoreSemantics": "RRF score is not probability",
                "reliability": {
                    "accepted": true,
                    "score": 0.9,
                    "threshold": EXPECTED_RRF_RELIABILITY_THRESHOLD,
                    "semantics": "round-level reliability, not candidate probability"
                },
                "state": {
                    "existingZeroPolicy": "remove"
                },
                "suggestions": [
                    {
                        "rank": 1,
                        "centerYear": 1900,
                        "rangeStart": 1897,
                        "rangeEnd": 1903,
                        "rankingScore": 1.5,
                        "scoreSemantics": "reciprocal rank fusion, not probability",
                        "evidence": {
                            "pathRank": 1,
                            "noneRank": 2,
                            "inferredLatestPathBase": 0
                        }
                    },
                    {
                        "rank": 2,
                        "centerYear": 1880,
                        "rangeStart": 1877,
                        "rangeEnd": 1883,
                        "rankingScore": 0.8333333333333333,
                        "scoreSemantics": "reciprocal rank fusion, not probability",
                        "evidence": {
                            "pathRank": 2,
                            "noneRank": 3,
                            "inferredLatestPathBase": -2
                        }
                    }
                ]
            })),
            error: None,
        };
        validate_response(&rrf_request(), &response, &rrf_model()).unwrap();

        let mut wrong_route = response;
        wrong_route.result.as_mut().unwrap()["routeVersion"] = json!("wrong-route");
        assert_eq!(
            validate_response(&rrf_request(), &wrong_route, &rrf_model())
                .unwrap_err()
                .code,
            "INVALID_SIDECAR_RESPONSE"
        );
    }

    #[test]
    fn single_range_preserves_server_rank_even_when_scores_are_not_descending() {
        let response = CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("rank-test-1".to_owned()),
            ok: true,
            result: Some(json!({
                "status": "advice",
                "message": "review the range then exact years",
                "diagnosticOnly": true,
                "automaticWriteback": false,
                "rangeReliability": {
                    "accepted": true,
                    "score": 0.8,
                    "threshold": EXPECTED_RANGE_RELIABILITY_THRESHOLD,
                    "semantics": "relative range reliability score, not probability",
                    "independentFromYearGate": true
                },
                "yearReliability": {
                    "accepted": true,
                    "score": 0.9,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "reliability": {
                    "accepted": true,
                    "score": 0.9,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "eventRange": {
                    "startYear": 1880,
                    "endYear": 1894,
                    "centerYear": 1887,
                    "width": 15,
                    "scope": "newest_unresolved_event",
                    "localizerScore": 2.4,
                    "baseCenterRank": 4,
                    "candidateCenterCount": 120,
                    "scoreSemantics": "relative range score, not probability",
                    "adaptive": true,
                    "shrunk": false,
                    "windowPolicy": "local_score_mass",
                    "maxEnvelopeStart": 1880,
                    "maxEnvelopeEnd": 1894,
                    "evidencePeak": 0.2,
                    "evidenceMass": 0.8
                },
                "suggestions": [
                    {
                        "rank": 1,
                        "centerYear": 1892,
                        "rangeStart": 1880,
                        "rangeEnd": 1894,
                        "rankingScore": 0.1,
                        "baseRank": 8,
                        "rangePromoted": true
                    },
                    {
                        "rank": 2,
                        "centerYear": 1879,
                        "rangeStart": 1880,
                        "rangeEnd": 1894,
                        "rankingScore": 0.2,
                        "baseRank": 1,
                        "rangePromoted": false
                    }
                ]
            })),
            error: None,
        };
        validate_response(&valid_request(), &response, &adaptive_range_model()).unwrap();
    }

    #[test]
    fn adaptive_range_rejects_the_superseded_static_v11_shape() {
        let response = CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("rank-test-1".to_owned()),
            ok: true,
            result: Some(json!({
                "status": "advice",
                "message": "static range without adaptive evidence",
                "diagnosticOnly": true,
                "automaticWriteback": false,
                "rangeReliability": {
                    "accepted": true,
                    "score": 0.8,
                    "threshold": EXPECTED_RANGE_RELIABILITY_THRESHOLD,
                    "semantics": "relative range reliability score, not probability",
                    "independentFromYearGate": true
                },
                "yearReliability": {
                    "accepted": true,
                    "score": 0.9,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "reliability": {
                    "accepted": true,
                    "score": 0.9,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "eventRange": {
                    "startYear": 1880,
                    "endYear": 1894,
                    "centerYear": 1887,
                    "width": 15,
                    "scope": "newest_unresolved_event",
                    "localizerScore": 2.4,
                    "baseCenterRank": 4,
                    "candidateCenterCount": 120,
                    "scoreSemantics": "relative range score, not probability"
                },
                "suggestions": [{
                    "rank": 1,
                    "centerYear": 1892,
                    "rangeStart": 1880,
                    "rangeEnd": 1894,
                    "rankingScore": 0.1,
                    "baseRank": 8,
                    "rangePromoted": true
                }]
            })),
            error: None,
        };
        assert_eq!(
            validate_response(&valid_request(), &response, &adaptive_range_model())
                .unwrap_err()
                .code,
            "INVALID_SIDECAR_RESPONSE"
        );
    }

    #[test]
    fn single_range_rejects_a_range_wider_than_fifteen_years() {
        let response = CurrentEventResponse {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            request_id: Some("rank-test-1".to_owned()),
            ok: true,
            result: Some(json!({
                "status": "advice",
                "message": "invalid wide range",
                "automaticWriteback": false,
                "rangeReliability": {
                    "accepted": true,
                    "score": 0.8,
                    "threshold": EXPECTED_RANGE_RELIABILITY_THRESHOLD,
                    "semantics": "relative range reliability score, not probability",
                    "independentFromYearGate": true
                },
                "yearReliability": {
                    "accepted": true,
                    "score": 0.9,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "reliability": {
                    "accepted": true,
                    "score": 0.9,
                    "threshold": 0.67,
                    "semantics": "relative year reliability score, not probability"
                },
                "eventRange": {
                    "startYear": 1880,
                    "endYear": 1895,
                    "centerYear": 1887,
                    "width": 16,
                    "scope": "newest_unresolved_event",
                    "localizerScore": 2.4,
                    "baseCenterRank": 4,
                    "candidateCenterCount": 120,
                    "scoreSemantics": "relative range score, not probability",
                    "adaptive": true,
                    "shrunk": false,
                    "windowPolicy": "local_score_mass",
                    "maxEnvelopeStart": 1880,
                    "maxEnvelopeEnd": 1895,
                    "evidencePeak": 0.2,
                    "evidenceMass": 0.8
                },
                "suggestions": [{
                    "rank": 1,
                    "centerYear": 1892,
                    "rangeStart": 1880,
                    "rangeEnd": 1895,
                    "rankingScore": 0.1,
                    "baseRank": 8,
                    "rangePromoted": true
                }]
            })),
            error: None,
        };
        assert_eq!(
            validate_response(&valid_request(), &response, &adaptive_range_model())
                .unwrap_err()
                .code,
            "INVALID_SIDECAR_RESPONSE"
        );
    }

    #[test]
    fn expired_total_deadline_is_reported_as_timeout() {
        let deadline = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .unwrap();
        assert_eq!(
            remaining_timeout(deadline, REQUEST_TIMEOUT)
                .unwrap_err()
                .code,
            "SIDECAR_TIMEOUT"
        );
    }
}
