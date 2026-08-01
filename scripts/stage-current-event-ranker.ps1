param(
    [string]$ResearchRepo = "D:\Code\Crossdating_py_eventrange_gate",
    [string]$SourceBundle = "",
    [string]$SourceScript = "",
    [string]$BuildScript = "",
    [string]$ModelId = "current-event-adaptive-range-v1",
    [string]$BundleVersion = "current-event-adaptive-range-gate-v1.3.0",
    [string]$SupersededModelId = "current-event-single-range-v1.1.0",
    [string]$ExpectedManifestSha256 = "09f3e4c37d7a4bc06586eca0012678788afd0c786701cd03821b2b4ca2077a78",
    [string]$Python = "D:\Programming\Python\Python310\python.exe",
    [switch]$BuildExecutable,
    [switch]$ReuseBuiltExecutable
)

$ErrorActionPreference = "Stop"
if ($ReuseBuiltExecutable -and -not $BuildExecutable) {
    throw "-ReuseBuiltExecutable requires -BuildExecutable"
}
$TauriRepo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ResearchRepo = (Resolve-Path -LiteralPath $ResearchRepo).Path
if (-not $SourceBundle) {
    $SourceBundle = Join-Path $ResearchRepo "artifacts\exports\current_event_adaptive_range_gate_tauri_bundle_v1_20260718\bundle"
}
if (-not $SourceScript) {
    $SourceScript = Join-Path $ResearchRepo "scripts\current_event_ranker_sidecar.py"
}
if (-not $BuildScript) {
    $BuildScript = Join-Path $ResearchRepo "scripts\build_current_event_sidecar.ps1"
}

$ResourceRoot = Join-Path $TauriRepo "src-tauri\resources\current_event_ranker"
$ModelsRoot = Join-Path $ResourceRoot "models"
$ResourceModelRoot = Join-Path $ModelsRoot $ModelId
$ResourceBundle = Join-Path $ResourceModelRoot "bundle"
$SupersededModelRoot = Join-Path $ModelsRoot $SupersededModelId
$SidecarTarget = Join-Path $TauriRepo "src-tauri\bin\current-event-adaptive-range-sidecar-x86_64-pc-windows-msvc.exe"
$SupersededSidecarTarget = Join-Path $TauriRepo "src-tauri\bin\current-event-single-range-sidecar-x86_64-pc-windows-msvc.exe"
$SmokeScript = Join-Path $TauriRepo "tools\smoke_current_event_sidecar.py"
$BundleVerifier = Join-Path $TauriRepo "tools\verify_current_event_bundle.py"
$BuildEnvironmentVerifier = Join-Path $TauriRepo "tools\check_current_event_build_environment.py"
$SourceYearBundleVerifier = Join-Path $ResearchRepo "scripts\verify_current_event_tauri_bundle.py"
$SourceBundleVerifier = Join-Path $ResearchRepo "scripts\verify_current_event_single_range_bundle.py"
$NodeValidator = Join-Path $TauriRepo "scripts\validate-current-event-integration.mjs"
$StageParent = Join-Path $TauriRepo "target-codex-check\current-event-model-stage"
$StageModelRoot = Join-Path $StageParent $ModelId
$StageBundle = Join-Path $StageModelRoot "bundle"
$BuildRoot = Join-Path $TauriRepo "target-codex-check\current-event-adaptive-range-sidecar"

function Assert-ExactChildPath([string]$Path, [string]$Root, [string]$Label) {
    $FullPath = [System.IO.Path]::GetFullPath($Path)
    $FullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    if (-not $FullPath.StartsWith($FullRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing $Label outside trusted root: $FullPath"
    }
}

function Get-Sha256Hex([string]$Path) {
    $Stream = [System.IO.File]::OpenRead($Path)
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Bytes = $Hasher.ComputeHash($Stream)
        return ([System.BitConverter]::ToString($Bytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $Hasher.Dispose()
        $Stream.Dispose()
    }
}

foreach ($RequiredFile in @(
    $SourceScript,
    $BuildScript,
    $SmokeScript,
    $BundleVerifier,
    $BuildEnvironmentVerifier,
    $SourceYearBundleVerifier,
    $SourceBundleVerifier,
    $NodeValidator,
    $Python
)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
        throw "Required file not found: $RequiredFile"
    }
}
if (-not (Test-Path -LiteralPath $SourceBundle -PathType Container)) {
    throw "Current-event bundle not found: $SourceBundle"
}

$SourceManifestPath = Join-Path $SourceBundle "bundle_manifest.json"
$Manifest = Get-Content -LiteralPath $SourceManifestPath -Raw | ConvertFrom-Json
if ($Manifest.bundle_version -ne $BundleVersion) {
    throw "Unexpected bundle_version: expected=$BundleVersion actual=$($Manifest.bundle_version)"
}
if ((Get-Sha256Hex $SourceManifestPath) -ne $ExpectedManifestSha256.ToLowerInvariant()) {
    throw "Source bundle manifest SHA-256 does not match the trusted adaptive-range upgrade"
}
if ($Manifest.protocol_version -ne "crossdating.current-event.v1") {
    throw "Unsupported current-event protocol: $($Manifest.protocol_version)"
}
if ($Manifest.diagnostic_only -ne $true -or $Manifest.automatic_writeback -ne $false) {
    throw "Bundle must remain diagnostic-only with automatic writeback disabled"
}

$ExpectedBundleFiles = @("bundle_manifest.json") + @(
    $Manifest.files.PSObject.Properties | ForEach-Object { [string]$_.Value.path }
)
if ($ExpectedBundleFiles.Count -ne 36) {
    throw "Adaptive-range gate bundle must contain exactly 36 files, got $($ExpectedBundleFiles.Count)"
}
if ($ExpectedBundleFiles | Where-Object { [System.IO.Path]::GetFileName($_) -ne $_ }) {
    throw "Current-event bundle must remain a flat file set"
}
$ActualSourceFiles = @(
    Get-ChildItem -LiteralPath $SourceBundle -File | ForEach-Object { $_.Name }
)
$SourceFileDiff = @(
    Compare-Object `
        -ReferenceObject @($ExpectedBundleFiles | Sort-Object) `
        -DifferenceObject @($ActualSourceFiles | Sort-Object)
)
if ($SourceFileDiff.Count -gt 0) {
    throw "Source bundle contains missing or manifest-external files: $($SourceFileDiff | Out-String)"
}

Assert-ExactChildPath $StageParent $TauriRepo "staging"
Assert-ExactChildPath $BuildRoot $TauriRepo "sidecar build"
Assert-ExactChildPath $ResourceModelRoot $ModelsRoot "resource replacement"
Assert-ExactChildPath $SupersededModelRoot $ModelsRoot "superseded resource removal"
if (Test-Path -LiteralPath $StageParent) {
    Remove-Item -LiteralPath $StageParent -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $StageBundle | Out-Null
foreach ($FileName in $ExpectedBundleFiles) {
    Copy-Item -LiteralPath (Join-Path $SourceBundle $FileName) -Destination (Join-Path $StageBundle $FileName)
}
Copy-Item -LiteralPath $SourceScript -Destination (Join-Path $StageModelRoot "current_event_ranker_sidecar.py")

foreach ($Record in $Manifest.files.PSObject.Properties) {
    $FilePath = Join-Path $StageBundle $Record.Value.path
    if ((Get-Item -LiteralPath $FilePath).Length -ne [long]$Record.Value.bytes) {
        throw "Byte count mismatch after staging: $FilePath"
    }
    if ((Get-Sha256Hex $FilePath) -ne [string]$Record.Value.sha256) {
        throw "Hash mismatch after staging: $FilePath"
    }
}

$PreviousNoBytecode = $env:PYTHONDONTWRITEBYTECODE
$PreviousUtf8 = $env:PYTHONUTF8
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:PYTHONUTF8 = "1"
try {
    & $Python $BundleVerifier --bundle $StageBundle
    if ($LASTEXITCODE -ne 0) {
        throw "Current-event year/range joblib and reference validation failed"
    }
    & $Python $SourceYearBundleVerifier --bundle $StageBundle
    if ($LASTEXITCODE -ne 0) {
        throw "Current-event source year verifier failed"
    }
    & $Python $SourceBundleVerifier --bundle $StageBundle --raw-parity
    if ($LASTEXITCODE -ne 0) {
            throw "Current-event source verifier, dual-gate reference or raw RWL parity failed"
    }

    $BuiltExecutable = $null
    if ($BuildExecutable) {
        & $Python $BuildEnvironmentVerifier --bundle $StageBundle
        if ($LASTEXITCODE -ne 0) {
            throw "Current-event sidecar build environment does not match the frozen versions"
        }
        $BuiltExecutable = Join-Path $BuildRoot "current-event-ranker-sidecar.exe"
        if (-not $ReuseBuiltExecutable) {
            if (Test-Path -LiteralPath $BuildRoot) {
                Remove-Item -LiteralPath $BuildRoot -Recurse -Force
            }
            $ResearchUri = [System.Uri]::new($ResearchRepo.TrimEnd("\") + "\")
            $BuildUri = [System.Uri]::new($BuildRoot)
            $RelativeBuildRoot = [System.Uri]::UnescapeDataString(
                $ResearchUri.MakeRelativeUri($BuildUri).ToString()
            ).Replace("/", "\")
            & powershell -NoProfile -ExecutionPolicy Bypass -File $BuildScript `
                -Python $Python `
                -OutputDir $RelativeBuildRoot
            if ($LASTEXITCODE -ne 0) {
                throw "Provided sidecar build script failed with exit code $LASTEXITCODE"
            }
        }
        if (-not (Test-Path -LiteralPath $BuiltExecutable -PathType Leaf)) {
            throw "Provided build script did not create $BuiltExecutable"
        }
        & $Python $SmokeScript --executable $BuiltExecutable --bundle $StageBundle
        if ($LASTEXITCODE -ne 0) {
            throw "Built adaptive-range gate sidecar failed JSONL smoke tests"
        }
    } elseif (-not (Test-Path -LiteralPath $SidecarTarget -PathType Leaf)) {
        throw "Bundled adaptive-range sidecar is missing; rerun with -BuildExecutable"
    }

    New-Item -ItemType Directory -Force -Path $ModelsRoot | Out-Null
    $BackupModelRoot = Join-Path $StageParent "$ModelId.backup"
    if (Test-Path -LiteralPath $BackupModelRoot) {
        Remove-Item -LiteralPath $BackupModelRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $ResourceModelRoot) {
        Move-Item -LiteralPath $ResourceModelRoot -Destination $BackupModelRoot
    }
    $BackupSupersededModelRoot = Join-Path $StageParent "$SupersededModelId.backup"
    if (Test-Path -LiteralPath $BackupSupersededModelRoot) {
        Remove-Item -LiteralPath $BackupSupersededModelRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $SupersededModelRoot) {
        Move-Item -LiteralPath $SupersededModelRoot -Destination $BackupSupersededModelRoot
    }
    $BackupExecutable = Join-Path $StageParent "current-event-adaptive-range-sidecar.backup.exe"
    if ($BuiltExecutable -and (Test-Path -LiteralPath $SidecarTarget -PathType Leaf)) {
        Copy-Item -LiteralPath $SidecarTarget -Destination $BackupExecutable
    }
    $BackupSupersededExecutable = Join-Path $StageParent "current-event-single-range-sidecar.backup.exe"
    if (Test-Path -LiteralPath $SupersededSidecarTarget -PathType Leaf) {
        Move-Item -LiteralPath $SupersededSidecarTarget -Destination $BackupSupersededExecutable
    }
    try {
        Move-Item -LiteralPath $StageModelRoot -Destination $ResourceModelRoot
        if ($BuiltExecutable) {
            Copy-Item -LiteralPath $BuiltExecutable -Destination $SidecarTarget -Force
        }
        & $Python $BundleVerifier --bundle $ResourceBundle
        if ($LASTEXITCODE -ne 0) {
            throw "Copied Tauri bundle failed year/range verification"
        }
        & $Python $SourceYearBundleVerifier --bundle $ResourceBundle
        if ($LASTEXITCODE -ne 0) {
            throw "Copied Tauri bundle failed source year verification"
        }
        & $Python $SourceBundleVerifier --bundle $ResourceBundle --raw-parity
        if ($LASTEXITCODE -ne 0) {
            throw "Copied Tauri bundle failed source adaptive-range gate verification"
        }
        & node $NodeValidator
        if ($LASTEXITCODE -ne 0) {
            throw "Current-event multi-model resource validation failed"
        }
        if (Test-Path -LiteralPath $BackupModelRoot) {
            Remove-Item -LiteralPath $BackupModelRoot -Recurse -Force
        }
        if (Test-Path -LiteralPath $BackupSupersededModelRoot) {
            Remove-Item -LiteralPath $BackupSupersededModelRoot -Recurse -Force
        }
        if (Test-Path -LiteralPath $BackupExecutable) {
            Remove-Item -LiteralPath $BackupExecutable -Force
        }
        if (Test-Path -LiteralPath $BackupSupersededExecutable) {
            Remove-Item -LiteralPath $BackupSupersededExecutable -Force
        }
    } catch {
        if (Test-Path -LiteralPath $ResourceModelRoot) {
            Remove-Item -LiteralPath $ResourceModelRoot -Recurse -Force
        }
        if ($BuiltExecutable -and (Test-Path -LiteralPath $SidecarTarget -PathType Leaf)) {
            Remove-Item -LiteralPath $SidecarTarget -Force
        }
        if (Test-Path -LiteralPath $BackupModelRoot) {
            Move-Item -LiteralPath $BackupModelRoot -Destination $ResourceModelRoot
        }
        if (Test-Path -LiteralPath $BackupSupersededModelRoot) {
            Move-Item -LiteralPath $BackupSupersededModelRoot -Destination $SupersededModelRoot
        }
        if (Test-Path -LiteralPath $BackupExecutable) {
            Copy-Item -LiteralPath $BackupExecutable -Destination $SidecarTarget -Force
        }
        if (Test-Path -LiteralPath $BackupSupersededExecutable) {
            Move-Item -LiteralPath $BackupSupersededExecutable -Destination $SupersededSidecarTarget
        }
        throw
    }
} finally {
    $env:PYTHONDONTWRITEBYTECODE = $PreviousNoBytecode
    $env:PYTHONUTF8 = $PreviousUtf8
}

if (Test-Path -LiteralPath $StageParent) {
    Remove-Item -LiteralPath $StageParent -Recurse -Force
}
Write-Output "Added and verified current-event model at $ResourceBundle"
if ($BuildExecutable) {
    Write-Output "Built Tauri adaptive-range sidecar at $SidecarTarget"
}
