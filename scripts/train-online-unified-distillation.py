#!/usr/bin/env python3
"""Fit and export the frozen TypeScript online student for unified diagnosis."""

from __future__ import annotations

import argparse
import gc
import gzip
import json
from collections import defaultdict
from pathlib import Path
from collections.abc import Iterable
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


META_COLUMNS = {
    "attempt_id",
    "file_id",
    "package_id",
    "location_group",
    "event_type",
    "shift_years",
    "start_year",
    "end_year",
    "top_year",
    "width",
    "label",
}

SPARSE_LOCATION_PREFIXES = (
    "nearest_note_",
    "exact_window_note_",
    "overlap_window_note_",
)


def load_operation_rows(
    paths: Iterable[Path],
) -> tuple[pd.DataFrame, dict[str, dict[str, Any]]]:
    operation_rows: list[dict[str, Any]] = []
    attempts: dict[str, dict[str, Any]] = {}
    for path in paths:
        with gzip.open(path, "rt", encoding="utf8") as handle:
            for line in handle:
                payload = json.loads(line)
                attempt_id = str(payload["attemptId"])
                if attempt_id in attempts:
                    raise ValueError(f"duplicate attempt id across inputs: {attempt_id}")
                file_id = str(payload["fileId"])
                attempts[attempt_id] = {
                    "file_id": file_id,
                    "teacher_status": payload.get("teacherStatus", "truth_labeled"),
                    "label_mode": payload.get("labelMode", "teacher"),
                    "family": payload.get("family", "unknown"),
                    "target_year": payload.get("targetYear"),
                    "target_identity": payload["targetIdentity"],
                    "has_location_rows": bool(payload["locationRows"]),
                    "workflow_oracle": bool(payload.get("workflowOracle", True)),
                }
                for row in payload["operationRows"]:
                    operation_rows.append({
                        "attempt_id": attempt_id,
                        "file_id": file_id,
                        "package_id": row["packageId"],
                        "event_type": row["eventType"],
                        "shift_years": int(row["shiftYears"]),
                        "label": int(row["label"]),
                        **row["features"],
                    })
    return pd.DataFrame.from_records(operation_rows), attempts


def load_location_rows(
    paths: Iterable[Path],
    attempts: dict[str, dict[str, Any]],
    predicted_groups: dict[str, str],
) -> pd.DataFrame:
    location_rows: list[dict[str, Any]] = []
    for path in paths:
        with gzip.open(path, "rt", encoding="utf8") as handle:
            for line in handle:
                payload = json.loads(line)
                attempt_id = str(payload["attemptId"])
                file_id = str(payload["fileId"])
                metadata = attempts[attempt_id]
                target = metadata["target_identity"]
                exact_group = (
                    f"{attempt_id}|{target['eventType']}|{target['shiftYears']}"
                )
                equivalent_group = next((
                    str(row.get("locationGroup", attempt_id))
                    for row in payload["locationRows"]
                    if int(row["label"]) > 0
                    and str(row.get("eventType", "")) == "partialMove"
                ), None)
                allowed_groups = {
                    exact_group,
                    predicted_groups.get(attempt_id, ""),
                    equivalent_group or "",
                }
                for row in payload["locationRows"]:
                    location_group = str(row.get("locationGroup", attempt_id))
                    if location_group not in allowed_groups:
                        continue
                    stable_features = {
                        key: value
                        for key, value in row["features"].items()
                        if not key.startswith(SPARSE_LOCATION_PREFIXES)
                    }
                    location_rows.append({
                        "attempt_id": attempt_id,
                        "file_id": file_id,
                        "package_id": row["packageId"],
                        "location_group": location_group,
                        "event_type": row.get("eventType", ""),
                        "shift_years": int(row.get("shiftYears", 0)),
                        "start_year": int(row["startYear"]),
                        "end_year": int(row["endYear"]),
                        "top_year": int(row["topYear"]),
                        "width": int(row["width"]),
                        "label": int(row["label"]),
                        **stable_features,
                    })
    return pd.DataFrame.from_records(location_rows)


def feature_names(frame: pd.DataFrame) -> list[str]:
    return sorted(column for column in frame.columns if column not in META_COLUMNS)


def compact_feature_storage(frame: pd.DataFrame, features: list[str]) -> None:
    frame.replace([np.inf, -np.inf], np.nan, inplace=True)
    frame[features] = frame[features].fillna(0.0).astype(np.float32)


def prepare_grouped(
    frame: pd.DataFrame,
    group_column: str = "attempt_id",
) -> tuple[pd.DataFrame, np.ndarray]:
    ordered = frame.sort_values(
        [group_column, "package_id"], kind="stable",
    ).reset_index(drop=True)
    groups = ordered.groupby(group_column, sort=False).size().to_numpy(dtype=np.int32)
    return ordered, groups


def make_ranker(seed: int, estimators: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        ndcg_at=[1, 3, 5],
        lambdarank_truncation_level=10,
        n_estimators=estimators,
        learning_rate=0.04,
        num_leaves=31,
        max_depth=-1,
        min_child_samples=24,
        subsample=0.9,
        colsample_bytree=0.85,
        reg_alpha=0.08,
        reg_lambda=0.2,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def predict_group_top(frame: pd.DataFrame, scores: np.ndarray) -> pd.DataFrame:
    predicted = frame[[column for column in META_COLUMNS if column in frame.columns]].copy()
    predicted["score"] = scores
    return predicted.sort_values(
        ["attempt_id", "score", "package_id"],
        ascending=[True, False, True],
        kind="stable",
    ).groupby("attempt_id", sort=False).head(1)


def predict_location_top(frame: pd.DataFrame, scores: np.ndarray) -> pd.DataFrame:
    predicted = frame[[column for column in META_COLUMNS if column in frame.columns]].copy()
    predicted["score"] = scores
    return predicted.sort_values(
        ["location_group", "score", "package_id"],
        ascending=[True, False, True],
        kind="stable",
    ).groupby("location_group", sort=False).head(1)


def fit_oof(
    frame: pd.DataFrame,
    features: list[str],
    seed: int,
    estimators: int,
    group_column: str = "attempt_id",
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    predictions = np.full(len(frame), np.nan, dtype=np.float64)
    fold_reports: list[dict[str, Any]] = []
    files = frame[["file_id"]].drop_duplicates().sort_values("file_id")
    splits = min(5, len(files))
    splitter = GroupKFold(n_splits=splits)
    row_index = np.arange(len(frame))
    for fold, (train_files_index, test_files_index) in enumerate(
        splitter.split(files, groups=files["file_id"]),
        start=1,
    ):
        train_files = set(files.iloc[train_files_index]["file_id"])
        test_files = set(files.iloc[test_files_index]["file_id"])
        train = frame[frame["file_id"].isin(train_files)]
        test_mask = frame["file_id"].isin(test_files).to_numpy()
        test = frame.loc[test_mask]
        train_ordered, train_groups = prepare_grouped(train, group_column)
        model = make_ranker(seed + fold, estimators)
        model.fit(
            train_ordered[features].fillna(0.0),
            train_ordered["label"],
            group=train_groups,
        )
        fold_scores = model.predict(test[features].fillna(0.0))
        predictions[row_index[test_mask]] = fold_scores
        top = predict_group_top(test, fold_scores) \
            if group_column == "attempt_id" \
            else predict_location_top(test, fold_scores)
        fold_reports.append({
            "fold": fold,
            "trainFiles": len(train_files),
            "testFiles": len(test_files),
            "attempts": int(top[group_column].nunique()),
            "top1": float(top["label"].mean()),
        })
    if np.isnan(predictions).any():
        raise RuntimeError("OOF prediction coverage is incomplete")
    return predictions, fold_reports


def fit_final(
    frame: pd.DataFrame,
    features: list[str],
    seed: int,
    estimators: int,
    group_column: str = "attempt_id",
) -> lgb.Booster:
    ordered, groups = prepare_grouped(frame, group_column)
    model = make_ranker(seed, estimators)
    model.fit(
        ordered[features].fillna(0.0),
        ordered["label"],
        group=groups,
    )
    return model.booster_


def selected_by_attempt(frame: pd.DataFrame, scores: np.ndarray) -> dict[str, dict[str, Any]]:
    top = predict_group_top(frame, scores)
    return {
        str(row.attempt_id): row._asdict()
        for row in top.itertuples(index=False)
    }


def selected_by_location_group(
    frame: pd.DataFrame,
    scores: np.ndarray,
) -> dict[str, dict[str, Any]]:
    top = predict_location_top(frame, scores)
    return {
        str(row.location_group): row._asdict()
        for row in top.itertuples(index=False)
    }


def model_payload(booster: lgb.Booster, features: list[str]) -> dict[str, Any]:
    dump = booster.dump_model()
    return {
        "featureNames": features,
        "averageOutput": bool(dump.get("average_output", False)),
        "objective": dump.get("objective", "lambdarank"),
        "treeInfo": dump["tree_info"],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--model-output", required=True)
    parser.add_argument("--report-output", required=True)
    parser.add_argument("--predictions-output")
    parser.add_argument("--seed", type=int, default=20260831)
    args = parser.parse_args()

    input_paths = [Path(value) for value in args.input]
    operation, attempts = load_operation_rows(input_paths)
    operation_features = feature_names(operation)
    compact_feature_storage(operation, operation_features)
    operation_rows_count = len(operation)
    operation_feature_count = len(operation_features)
    operation_package_oracle = float(
        operation.groupby("attempt_id")["label"].max().mean()
    )

    operation_oof, operation_folds = fit_oof(
        operation,
        operation_features,
        args.seed,
        260,
    )
    operation_top = selected_by_attempt(operation, operation_oof)
    operation_booster = fit_final(
        operation,
        operation_features,
        args.seed,
        260,
    )
    predicted_location_groups = {
        attempt_id: f"{attempt_id}|{row['event_type']}|{row['shift_years']}"
        for attempt_id, row in operation_top.items()
        if row["event_type"] not in {"noEvent", "wholeSeriesMove"}
    }
    del operation, operation_oof
    gc.collect()
    location = load_location_rows(
        input_paths,
        attempts,
        predicted_location_groups,
    )
    location_features = feature_names(location)
    compact_feature_storage(location, location_features)
    location_rows_count = len(location)
    location_feature_count = len(location_features)
    location_package_oracle = float(
        location.groupby("location_group")["label"].max().mean()
    )
    location_valid_groups = set(
        location.groupby("location_group")["label"].max()
        .loc[lambda values: values > 0].index
    )
    location_train = location[
        location["location_group"].isin(location_valid_groups)
    ].copy()
    location_oof, location_folds = fit_oof(
        location_train,
        location_features,
        args.seed + 100,
        320,
        "location_group",
    )

    location_top = selected_by_location_group(location_train, location_oof)
    combined_correct = 0
    operation_correct = 0
    local_attempts = 0
    location_correct = 0
    per_file: dict[str, list[int]] = defaultdict(list)
    per_family: dict[str, list[int]] = defaultdict(list)
    prediction_rows: list[dict[str, Any]] = []
    for attempt_id, metadata in attempts.items():
        operation_prediction = operation_top[attempt_id]
        operation_hit = bool(operation_prediction["label"])
        operation_correct += int(operation_hit)
        predicted_type = str(operation_prediction["event_type"])
        predicted_shift = int(operation_prediction["shift_years"])
        is_local = predicted_type not in {"noEvent", "wholeSeriesMove"}
        local_hit = True
        if is_local:
            local_attempts += 1
            location_group = f"{attempt_id}|{predicted_type}|{predicted_shift}"
            local_hit = bool(location_top.get(location_group, {}).get("label", 0))
            location_correct += int(local_hit)
        success = operation_hit and local_hit
        combined_correct += int(success)
        per_file[metadata["file_id"]].append(int(success))
        per_family[metadata["family"]].append(int(success))
        prediction_rows.append({
            "attempt_id": attempt_id,
            "file_id": metadata["file_id"],
            "family": metadata["family"],
            "target_event_type": metadata["target_identity"]["eventType"],
            "target_shift_years": metadata["target_identity"]["shiftYears"],
            "predicted_event_type": predicted_type,
            "predicted_shift_years": predicted_shift,
            "operation_correct": int(operation_hit),
            "location_correct": int(local_hit),
            "combined_correct": int(success),
            "workflow_oracle": int(metadata["workflow_oracle"]),
        })

    location_booster = fit_final(
        location_train,
        location_features,
        args.seed + 100,
        320,
        "location_group",
    )
    model = {
        "schemaVersion": 1,
        "modelVersion": "online-unified-workflow-v3",
        "teacherModelVersion": "workflow-truth",
        "truthBlindRuntime": True,
        "operation": model_payload(operation_booster, operation_features),
        "location": model_payload(location_booster, location_features),
    }
    model_path = Path(args.model_output)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.write_text(json.dumps(model, separators=(",", ":")), encoding="utf8")

    attempt_count = len(attempts)
    report = {
        "schemaVersion": 1,
        "modelVersion": model["modelVersion"],
        "teacherModelVersion": model["teacherModelVersion"],
        "attempts": attempt_count,
        "files": len(per_file),
        "operationRows": operation_rows_count,
        "locationRows": location_rows_count,
        "locationTrainRows": len(location_train),
        "operationFeatures": operation_feature_count,
        "locationFeatures": location_feature_count,
        "operationPackageOracle": operation_package_oracle,
        "workflowPackageOracle": float(np.mean([
            int(metadata["workflow_oracle"]) for metadata in attempts.values()
        ])),
        "locationPackageOracle": location_package_oracle,
        "fileOofOperationTop1": operation_correct / max(1, attempt_count),
        "fileOofLocationTop1GivenPackage": location_correct / max(1, local_attempts),
        "fileOofCombinedTeacherFidelity": combined_correct / max(1, attempt_count),
        "fileMacroCombinedTeacherFidelity": float(np.mean([
            np.mean(values) for values in per_file.values()
        ])),
        "byFamily": {
            family: {
                "correct": int(sum(values)),
                "attempts": len(values),
                "accuracy": float(np.mean(values)),
            }
            for family, values in sorted(per_family.items())
        },
        "operationFolds": operation_folds,
        "locationFolds": location_folds,
    }
    report_path = Path(args.report_output)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    if args.predictions_output:
        predictions_path = Path(args.predictions_output)
        predictions_path.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame.from_records(prediction_rows).to_csv(predictions_path, index=False)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
