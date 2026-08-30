#!/usr/bin/env python3
"""Run the frozen unified v12 model as the sole diagnosis authority."""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_DIR = REPO_ROOT / "scripts"
DEFAULT_MODEL_DIR = (
    REPO_ROOT / "models" / "authoritative" / "applied-residual-unified-v12"
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load runtime module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


SHADOW = load_module(
    "authoritative_runtime_shadow",
    SCRIPT_DIR / "applied_residual_unified_shadow.py",
)
UPSTREAM = load_module(
    "authoritative_runtime_upstream",
    SCRIPT_DIR / "authoritative_unified_upstream.py",
)
BASE = load_module(
    "authoritative_runtime_base",
    SCRIPT_DIR / "predict-frozen-standalone-model.py",
)
SHORTLIST = load_module(
    "authoritative_runtime_operation_shortlist",
    SCRIPT_DIR / "prepare-applied-residual-operation-shortlist.py",
)
LOCATION_SHORTLIST = load_module(
    "authoritative_runtime_location_shortlist",
    SCRIPT_DIR / "prepare-selected-identity-location-shortlist.py",
)


def run(command: list[str], *, cwd: Path = REPO_ROOT) -> None:
    completed = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        tail = "\n".join(completed.stdout.splitlines()[-80:])
        raise RuntimeError(
            f"authoritative runtime command failed ({completed.returncode}): "
            f"{' '.join(command)}\n{tail}"
        )


def vite_node() -> Path:
    executable = REPO_ROOT / "node_modules" / ".bin" / "vite-node.cmd"
    if not executable.exists():
        raise FileNotFoundError(f"vite-node runtime is unavailable: {executable}")
    return executable


def write_worker_manifest(
    output_dir: Path,
    *,
    run_dir: Path,
    identities_path: Path,
    part_path: Path,
) -> Path:
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps({
            "schemaVersion": 1,
            "runDir": str(run_dir),
            "identitiesPath": str(identities_path),
            "topK": 8,
            "selection": "authoritative-runtime-single-attempt",
            "parts": [str(part_path)],
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    return manifest_path


def extract_residual(
    *,
    run_dir: Path,
    proposals: Path,
    output_dir: Path,
    include_per_reference: bool,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        str(vite_node()),
        str(SCRIPT_DIR / "extract-applied-residual-evidence.ts"),
        f"--run-dir={run_dir}",
        f"--proposals={proposals}",
        f"--output-dir={output_dir}",
        "--workers=1",
        "--worker-index=0",
    ]
    if not include_per_reference:
        command.append("--skip-per-reference")
    run(command)


def score_operation_head(
    model_pack: dict[str, Any],
    operation_rows: pd.DataFrame,
) -> pd.DataFrame:
    values = SHADOW.align_features(
        SHADOW.operation_features(operation_rows),
        list(model_pack["operationFeatures"]),
    )
    scores = SHADOW.score_pair_tournament(
        operation_rows,
        values,
        model_pack["operationModel"],
        group="attempt_id",
        seed_score="selection_oof_score",
        shortlist_size=int(model_pack["operationShortlistSize"]),
    )
    return SHADOW.OPERATION.select_top(
        operation_rows,
        pd.Series(scores, index=operation_rows.index),
    ).copy()


def make_location_proposals(rows: pd.DataFrame, output: Path) -> None:
    proposal_columns = [
        "proposal_id", "attempt_id", "file_id", "family", "event_type",
        "shift_years", "year", "listwise_score", "pairwise_score",
    ]
    rows[proposal_columns].to_csv(output, index=False)


def run_authoritative(
    *,
    input_path: Path,
    work_dir: Path,
    model_dir: Path,
) -> dict[str, Any]:
    work_dir.mkdir(parents=True, exist_ok=True)
    run_dir = work_dir / "attempt"
    run([
        str(vite_node()),
        str(SCRIPT_DIR / "create-authoritative-runtime-attempt.ts"),
        f"--input={input_path}",
        f"--run-dir={run_dir}",
    ])

    runtime_dir = model_dir / "frozen-runtime-v34"
    runtime_manifest = model_dir / "frozen-runtime-v34-manifest.json"
    initial_dir = work_dir / "initial"
    run([
        sys.executable,
        str(SCRIPT_DIR / "predict-frozen-operation-identities.py"),
        "--target-run-dir", str(run_dir),
        "--model-dir", str(model_dir / "initial-operation-model"),
        "--runtime-dir", str(runtime_dir),
        "--runtime-manifest", str(runtime_manifest),
        "--output-dir", str(initial_dir),
        "--run-tag", "evaluation",
    ])

    full_year_dir = work_dir / "full-year"
    full_year_dir.mkdir(parents=True, exist_ok=True)
    part_path = full_year_dir / "part-0.ndjson"
    run([
        str(vite_node()),
        str(SCRIPT_DIR / "extract-operation-identity-rows.ts"),
        f"--run-dir={run_dir}",
        f"--operation-identities={initial_dir / 'operation-identities.csv'}",
        f"--output-dir={full_year_dir}",
        "--top-k=8",
        "--workers=1",
        "--worker-index=0",
    ])
    rows_manifest = write_worker_manifest(
        full_year_dir,
        run_dir=run_dir,
        identities_path=initial_dir / "operation-identities.csv",
        part_path=part_path,
    )

    row_cache = work_dir / "row-cache"
    run([
        sys.executable,
        str(SCRIPT_DIR / "prepare-enriched-row-cache.py"),
        "--rows-manifest", str(rows_manifest),
        "--run-dir", str(run_dir),
        "--operation-identities", str(initial_dir / "operation-identities.csv"),
        "--output-dir", str(row_cache),
        "--stride", "5",
    ])
    enriched_dir = work_dir / "enriched"
    run([
        sys.executable,
        str(SCRIPT_DIR / "predict-frozen-enriched-evidence-heads.py"),
        "--row-cache", str(row_cache),
        "--ranker-model-dir",
        str(runtime_dir / "calibration-enriched-hierarchical-fit-v2"),
        "--classifier-model-dir",
        str(runtime_dir / "calibration-enriched-location-classifier-fit-v2"),
        "--output-dir", str(enriched_dir),
    ])

    packages = work_dir / "packages.pkl"
    run([
        sys.executable,
        str(SCRIPT_DIR / "prepare-standalone-unified-package-table.py"),
        "--dataset-id", "authoritative-runtime",
        "--run-dir", str(run_dir),
        "--enriched-rows", str(row_cache / "rows.pkl"),
        "--hierarchical-scores",
        str(enriched_dir / "target-enriched-location-scores.pkl"),
        "--classifier-scores",
        str(enriched_dir / "target-location-classifier-scores.pkl"),
        "--operation-identities",
        str(enriched_dir / "target-enriched-operation-identities.csv"),
        "--output", str(packages),
        "--modes-per-score", "2",
        "--minimum-mode-distance", "7",
        "--enable-evidence-projection",
        "--enable-physical-posterior",
        "--enable-frontier-competition",
        "--enable-local-year-shape",
        "--enable-whole-projection",
    ])

    base_dir = work_dir / "base"
    base_dir.mkdir(parents=True, exist_ok=True)
    locations, operations, _, _ = BASE.score_base(
        packages,
        runtime_dir / "calibration-standalone-whole-modes8-fit-v38",
        base_dir,
    )
    bottom_dir = work_dir / "bottom"
    run([
        sys.executable,
        str(SCRIPT_DIR / "generate-immutable-operation-bottom-evidence.py"),
        "--row-cache", str(row_cache / "rows.pkl"),
        "--operation-scores", str(base_dir / "target-operation-scores.pkl"),
        "--output-dir", str(bottom_dir),
        "--feature-set", "core",
    ])

    operation_upstream = joblib.load(model_dir / "operation-upstream.joblib")
    operation_scores = UPSTREAM.score_operation_stack_pack(
        operation_upstream,
        operations,
        pd.read_pickle(bottom_dir / "operation-bottom-evidence.pkl"),
    )
    operation_shortlist_dir = work_dir / "operation-shortlist"
    operation_shortlist_dir.mkdir(parents=True, exist_ok=True)
    operation_proposals = SHORTLIST.choose_operation_shortlist(
        operation_scores[[
            "identity_group",
            "meta_oof_score",
            "pair_oof_score",
            "selection_oof_score",
        ]],
        locations,
        operation_scores,
        4,
    )
    operation_proposal_path = operation_shortlist_dir / "proposals.csv"
    operation_proposals.to_csv(operation_proposal_path, index=False)

    operation_residual_dir = operation_shortlist_dir / "residual"
    extract_residual(
        run_dir=run_dir,
        proposals=operation_proposal_path,
        output_dir=operation_residual_dir,
        include_per_reference=True,
    )
    operation_rows = SHADOW.read_operation_rows(
        operation_proposal_path,
        operation_residual_dir,
    ).reset_index(drop=True)
    model_pack = joblib.load(model_dir / "model.joblib")
    operation_top = score_operation_head(model_pack, operation_rows)
    selected_operation_path = work_dir / "selected-operation.csv"
    operation_top.to_csv(selected_operation_path, index=False)

    selected_type = str(operation_top.iloc[0]["event_type"])
    location_rows = pd.DataFrame(columns=["attempt_id", "identity_group"])
    if selected_type in SHADOW.LOCAL_EVENT_TYPES:
        selected_identity = str(operation_top.iloc[0]["identity_group"])
        identity_locations = locations[
            locations["identity_group"].eq(selected_identity)
        ].copy()
        location_shortlist = LOCATION_SHORTLIST.build_shortlist(
            identity_locations,
            operation_top,
            top_per_view=6,
        ).reset_index(drop=True)
        location_dir = work_dir / "location-shortlist"
        location_dir.mkdir(parents=True, exist_ok=True)
        location_path = location_dir / "location-scores.pkl"
        location_shortlist.to_pickle(location_path)
        location_proposals = location_dir / "proposals.csv"
        make_location_proposals(location_shortlist, location_proposals)
        location_residual_dir = location_dir / "residual"
        extract_residual(
            run_dir=run_dir,
            proposals=location_proposals,
            output_dir=location_residual_dir,
            include_per_reference=True,
        )
        residual_rows = SHADOW.LOCATION.read_residual_frame(
            location_residual_dir
        )
        location_rows = UPSTREAM.score_location_anchor_pack(
            joblib.load(model_dir / "location-anchor.joblib"),
            location_shortlist,
            residual_rows,
        )

    result = SHADOW.score_model_pack(
        model_pack,
        operation_rows,
        location_rows,
    ).iloc[0].to_dict()
    normalized = {
        "schemaVersion": 1,
        "modelVersion": SHADOW.MODEL_VERSION,
        "authority": "authoritative",
        "status": str(result["status"]),
        "eventType": str(result["event_type"]),
        "shiftYears": int(result["shift_years"]),
        "startYear": (
            int(result["start_year"])
            if pd.notna(result["start_year"]) else None
        ),
        "endYear": (
            int(result["end_year"])
            if pd.notna(result["end_year"]) else None
        ),
        "topYear": (
            int(result["top_year"])
            if pd.notna(result["top_year"]) else None
        ),
        "identityGroup": str(result["identity_group"]),
        "refusalReason": (
            str(result["refusal_reason"])
            if pd.notna(result["refusal_reason"]) else None
        ),
    }
    (work_dir / "result.json").write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    return normalized


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    args = parser.parse_args()
    try:
        result = run_authoritative(
            input_path=Path(args.input).resolve(),
            work_dir=Path(args.work_dir).resolve(),
            model_dir=Path(args.model_dir).resolve(),
        )
    except Exception as error:
        result = {
            "schemaVersion": 1,
            "modelVersion": SHADOW.MODEL_VERSION,
            "authority": "authoritative",
            "status": "error",
            "eventType": "noEvent",
            "shiftYears": 0,
            "startYear": None,
            "endYear": None,
            "topYear": None,
            "identityGroup": None,
            "refusalReason": f"{error}\n{traceback.format_exc()}",
        }
    print("AUTHORITATIVE_RESULT " + json.dumps(result, ensure_ascii=False))
    if result["status"] == "error":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
