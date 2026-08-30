#!/usr/bin/env python3
"""Freeze and score the truth-blind applied-residual unified shadow heads."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


PAIR = load_module(
    "applied_residual_shadow_pair",
    SCRIPT_DIR / "immutable_two_stage_adjudicator.py",
)
OPERATION = load_module(
    "applied_residual_shadow_operation",
    SCRIPT_DIR / "audit-applied-residual-operation-oof.py",
)
LOCATION = load_module(
    "applied_residual_shadow_location",
    SCRIPT_DIR / "audit-applied-residual-location-oof.py",
)

MODEL_VERSION = "applied-residual-unified-v12"
LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
FORBIDDEN_FEATURE_SUBSTRINGS = (
    "truth",
    "file_id",
    "series_id",
    "target_id",
    "attempt_id",
    "candidate_year",
)


def sha256(path: Path) -> str:
    """Hash a file or a directory tree without depending on absolute paths."""

    digest = hashlib.sha256()
    paths = [path] if path.is_file() else sorted(
        candidate for candidate in path.rglob("*") if candidate.is_file()
    )
    if not paths:
        raise FileNotFoundError(f"cannot hash missing or empty path: {path}")
    for candidate in paths:
        relative = candidate.name if path.is_file() else candidate.relative_to(path).as_posix()
        digest.update(relative.encode("utf8"))
        digest.update(b"\0")
        with candidate.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                digest.update(block)
    return digest.hexdigest()


def assert_truth_blind_features(feature_names: list[str]) -> None:
    forbidden = sorted({
        name
        for name in feature_names
        if (
            any(token in name.lower() for token in FORBIDDEN_FEATURE_SUBSTRINGS)
            or "correct" in re.split(r"[^a-z0-9]+", name.lower())
            or "family" in re.split(r"[^a-z0-9]+", name.lower())
        )
    })
    if forbidden:
        raise RuntimeError(
            "unified shadow admitted evaluation-only features: "
            + ", ".join(forbidden[:20])
        )


def proposal_id(frame: pd.DataFrame) -> pd.Series:
    if "proposal_id" in frame:
        return frame["proposal_id"].astype(str)
    return (
        frame["attempt_id"].astype(str)
        + "|" + frame["event_type"].astype(str)
        + "|" + frame["shift_years"].astype(int).astype(str)
        + "|" + frame["year"].astype(int).astype(str)
    )


def read_operation_rows(
    proposals_path: Path,
    residual_path: Path,
    identity_metadata_path: Path | None = None,
) -> pd.DataFrame:
    proposals = pd.read_csv(proposals_path)
    proposals["proposal_id"] = proposal_id(proposals)
    residual = OPERATION.read_residual_frame(residual_path)
    residual_columns = [
        column for column in residual
        if column == "proposal_id" or column.startswith("residual_")
    ]
    rows = proposals.merge(
        residual[residual_columns],
        on="proposal_id",
        how="inner",
        validate="one_to_one",
    )
    if identity_metadata_path is not None:
        metadata = pd.read_pickle(identity_metadata_path)
        labels = metadata[[
            "identity_group",
            "identity_operation_correct",
            "identity_workflow_oracle",
        ]].drop_duplicates("identity_group")
        rows = rows.merge(
            labels,
            on="identity_group",
            how="left",
            validate="many_to_one",
        )
        if rows["identity_workflow_oracle"].isna().any():
            raise RuntimeError("operation shortlist misses identity labels")
    return rows


def operation_features(rows: pd.DataFrame) -> pd.DataFrame:
    return OPERATION.residual_operation_features(rows)


def read_location_rows(
    location_scores_path: Path,
    residual_path: Path,
) -> pd.DataFrame:
    location = pd.read_pickle(location_scores_path)
    location["proposal_id"] = proposal_id(location)
    residual = LOCATION.read_residual_frame(residual_path)
    residual_columns = [
        column for column in residual
        if column == "proposal_id" or column.startswith("residual_")
    ]
    return location.merge(
        residual[residual_columns],
        on="proposal_id",
        how="inner",
        validate="one_to_one",
    )


def location_features(rows: pd.DataFrame) -> pd.DataFrame:
    return LOCATION.residual_features(
        rows,
        excluded_prefixes=("residual_perReference_",),
        include_physical_modes=True,
        include_typed_physical_modes=True,
        include_anchor_oof_evidence=True,
        include_compact_per_reference_location=True,
    )


def align_features(
    values: pd.DataFrame,
    feature_names: list[str],
) -> pd.DataFrame:
    assert_truth_blind_features(feature_names)
    missing = sorted(set(feature_names).difference(values.columns))
    required_missing = [
        name for name in missing
        if not name.startswith("event_type__") and "__for_" not in name
    ]
    if required_missing:
        raise RuntimeError(
            "unified shadow runtime evidence is incomplete; missing features: "
            + ", ".join(required_missing[:20])
        )
    return values.reindex(columns=feature_names, fill_value=0).astype(np.float32)


def fit_pair_model(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    *,
    label: str,
    group: str,
    seed_score: str,
    maximum_positives: int,
    maximum_negatives: int,
    seed: int,
):
    pair_values, pair_labels = PAIR.build_pair_training(
        frame.reset_index(drop=True),
        values.reset_index(drop=True),
        label=label,
        group=group,
        seed_score=frame.reset_index(drop=True)[seed_score],
        maximum_positives=maximum_positives,
        maximum_negatives=maximum_negatives,
    )
    estimator = PAIR.pair_classifier(seed)
    estimator.fit(pair_values, pair_labels)
    return estimator, int(len(pair_labels))


def fit_model_pack(
    *,
    operation_proposals: Path,
    operation_residual: Path,
    identity_metadata: Path,
    operation_top: Path,
    location_scores: Path,
    location_residual: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    operation_rows = read_operation_rows(
        operation_proposals,
        operation_residual,
        identity_metadata,
    ).reset_index(drop=True)
    operation_values = operation_features(operation_rows)
    operation_names = list(operation_values.columns)
    assert_truth_blind_features(operation_names)
    operation_model, operation_pairs = fit_pair_model(
        operation_rows,
        operation_values,
        label="identity_workflow_oracle",
        group="attempt_id",
        seed_score="selection_oof_score",
        maximum_positives=1,
        maximum_negatives=3,
        seed=850012,
    )

    location_rows = read_location_rows(
        location_scores,
        location_residual,
    ).reset_index(drop=True)
    selected_operation = LOCATION.normalize_operation_top(
        pd.read_csv(operation_top)
    ).set_index("attempt_id")["operation_correct"]
    location_rows["selected_operation_correct"] = location_rows[
        "attempt_id"
    ].map(selected_operation).fillna(0).astype(np.int8)
    location_train = location_rows[
        location_rows["selected_operation_correct"].eq(1)
    ].reset_index(drop=True)
    location_values = location_features(location_train)
    location_names = list(location_values.columns)
    assert_truth_blind_features(location_names)
    location_model, location_pairs = fit_pair_model(
        location_train,
        location_values,
        label="window_correct",
        group="attempt_id",
        seed_score="pairwise_score",
        maximum_positives=3,
        maximum_negatives=12,
        seed=850013,
    )

    pack = {
        "schemaVersion": 1,
        "modelVersion": MODEL_VERSION,
        "operationModel": operation_model,
        "operationFeatures": operation_names,
        "operationShortlistSize": 4,
        "locationModel": location_model,
        "locationFeatures": location_names,
        "locationShortlistSize": 16,
        "locationOptions": {
            "excludedPrefixes": ["residual_perReference_"],
            "typedPhysicalModes": True,
            "anchorOofEvidence": True,
            "compactPerReferenceLocation": True,
        },
    }
    summary = {
        "schemaVersion": 1,
        "modelVersion": MODEL_VERSION,
        "truthBlind": True,
        "operationIdentityImmutable": True,
        "sameIdentityLocationImmutable": True,
        "operationRows": int(len(operation_rows)),
        "operationFeatures": len(operation_names),
        "operationPairRows": operation_pairs,
        "locationRows": int(len(location_train)),
        "locationFeatures": len(location_names),
        "locationPairRows": location_pairs,
    }
    return pack, summary


def score_pair_tournament(
    frame: pd.DataFrame,
    values: pd.DataFrame,
    model,
    *,
    group: str,
    seed_score: str,
    shortlist_size: int,
) -> np.ndarray:
    return PAIR.pair_tournament_scores(
        frame.reset_index(drop=True),
        values.reset_index(drop=True),
        model,
        group=group,
        shortlist_score=frame.reset_index(drop=True)[seed_score],
        shortlist_size=shortlist_size,
    )


def selected_window(row: pd.Series) -> tuple[int, int]:
    parsed_width = pd.to_numeric(
        row.get("runtime_window_width"), errors="coerce"
    )
    width = int(parsed_width) if pd.notna(parsed_width) else 0
    if width not in {5, 7, 9, 13}:
        width = 13
    year = int(row["year"])
    older = (width - 1) // 2
    return year - older, year + (width - older - 1)


def score_model_pack(
    pack: dict[str, Any],
    operation_rows: pd.DataFrame,
    location_rows: pd.DataFrame,
) -> pd.DataFrame:
    if pack.get("modelVersion") != MODEL_VERSION:
        raise RuntimeError("unified shadow model version mismatch")
    operation_values = align_features(
        operation_features(operation_rows),
        list(pack["operationFeatures"]),
    )
    operation_scores = score_pair_tournament(
        operation_rows,
        operation_values,
        pack["operationModel"],
        group="attempt_id",
        seed_score="selection_oof_score",
        shortlist_size=int(pack["operationShortlistSize"]),
    )
    operation_top = OPERATION.select_top(
        operation_rows,
        pd.Series(operation_scores, index=operation_rows.index),
    ).copy()
    identity_by_attempt = operation_top.set_index("attempt_id")[
        "identity_group"
    ]
    selected_locations = location_rows[
        location_rows["identity_group"].eq(
            location_rows["attempt_id"].map(identity_by_attempt)
        )
    ].copy()
    local_attempts = operation_top[
        operation_top["event_type"].isin(LOCAL_EVENT_TYPES)
    ]["attempt_id"]
    selected_locations = selected_locations[
        selected_locations["attempt_id"].isin(local_attempts)
    ].reset_index(drop=True)

    location_top = pd.DataFrame()
    if not selected_locations.empty:
        location_values = align_features(
            location_features(selected_locations),
            list(pack["locationFeatures"]),
        )
        location_scores = score_pair_tournament(
            selected_locations,
            location_values,
            pack["locationModel"],
            group="attempt_id",
            seed_score="pairwise_score",
            shortlist_size=int(pack["locationShortlistSize"]),
        )
        location_top = LOCATION.select_top(
            selected_locations,
            pd.Series(location_scores, index=selected_locations.index),
        ).copy()
    location_by_attempt = (
        location_top.set_index("attempt_id")
        if not location_top.empty else pd.DataFrame()
    )

    rows: list[dict[str, Any]] = []
    for _, operation in operation_top.iterrows():
        attempt_id = str(operation["attempt_id"])
        event_type = str(operation["event_type"])
        location = (
            location_by_attempt.loc[attempt_id]
            if not location_by_attempt.empty
            and attempt_id in location_by_attempt.index
            else None
        )
        start_year = end_year = top_year = None
        refusal_reason = None
        if location is not None:
            top_year = int(location["year"])
            start_year, end_year = selected_window(location)
        elif event_type in LOCAL_EVENT_TYPES:
            refusal_reason = "same_identity_location_unavailable"
        elif event_type == "noEvent":
            refusal_reason = "model_refused"
        rows.append({
            "attempt_id": attempt_id,
            "status": "refused" if refusal_reason else "selected",
            "event_type": event_type,
            "shift_years": int(operation["shift_years"]),
            "start_year": start_year,
            "end_year": end_year,
            "top_year": top_year,
            "identity_group": str(operation["identity_group"]),
            "refusal_reason": refusal_reason,
        })
    return pd.DataFrame(rows)


def write_manifest(
    output: Path,
    model_path: Path,
    summary: dict[str, Any],
    inputs: dict[str, Path],
) -> dict[str, Any]:
    manifest = {
        **summary,
        "modelFile": model_path.name,
        "modelSha256": sha256(model_path),
        "inputSha256": {name: sha256(path) for name, path in inputs.items()},
        "runtimeContract": {
            "operationInputs": [
                "immutable Top4 identities",
                "base selection/meta/pair scores",
                "post-correction residual evidence",
            ],
            "locationInputs": [
                "selected operation identity only",
                "immutable location candidates",
                "base listwise/pairwise and anchor scores",
                "post-correction per-reference residual evidence",
            ],
            "output": "one immutable operation/shift/window package",
        },
    }
    output.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    return manifest
