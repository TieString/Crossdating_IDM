#!/usr/bin/env python3
"""Fit and export the frozen TypeScript online student for unified diagnosis."""

from __future__ import annotations

import argparse
import gzip
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


META_COLUMNS = {
    "attempt_id",
    "file_id",
    "package_id",
    "event_type",
    "shift_years",
    "start_year",
    "end_year",
    "top_year",
    "width",
    "label",
}


def load_rows(path: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, dict[str, Any]]]:
    operation_rows: list[dict[str, Any]] = []
    location_rows: list[dict[str, Any]] = []
    attempts: dict[str, dict[str, Any]] = {}
    with gzip.open(path, "rt", encoding="utf8") as handle:
        for line in handle:
            payload = json.loads(line)
            attempt_id = str(payload["attemptId"])
            file_id = str(payload["fileId"])
            attempts[attempt_id] = {
                "file_id": file_id,
                "teacher_status": payload["teacherStatus"],
                "label_mode": payload.get("labelMode", "teacher"),
                "family": payload.get("family", "unknown"),
                "target_year": payload.get("targetYear"),
                "target_identity": payload["targetIdentity"],
                "has_location_rows": bool(payload["locationRows"]),
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
            for row in payload["locationRows"]:
                location_rows.append({
                    "attempt_id": attempt_id,
                    "file_id": file_id,
                    "package_id": row["packageId"],
                    "start_year": int(row["startYear"]),
                    "end_year": int(row["endYear"]),
                    "top_year": int(row["topYear"]),
                    "width": int(row["width"]),
                    "label": int(row["label"]),
                    **row["features"],
                })
    return (
        pd.DataFrame.from_records(operation_rows),
        pd.DataFrame.from_records(location_rows),
        attempts,
    )


def feature_names(frame: pd.DataFrame) -> list[str]:
    return sorted(column for column in frame.columns if column not in META_COLUMNS)


def prepare_grouped(frame: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    ordered = frame.sort_values(["attempt_id", "package_id"], kind="stable").reset_index(drop=True)
    groups = ordered.groupby("attempt_id", sort=False).size().to_numpy(dtype=np.int32)
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


def fit_oof(
    frame: pd.DataFrame,
    features: list[str],
    seed: int,
    estimators: int,
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
        train_ordered, train_groups = prepare_grouped(train)
        model = make_ranker(seed + fold, estimators)
        model.fit(
            train_ordered[features].fillna(0.0),
            train_ordered["label"],
            group=train_groups,
        )
        fold_scores = model.predict(test[features].fillna(0.0))
        predictions[row_index[test_mask]] = fold_scores
        top = predict_group_top(test, fold_scores)
        fold_reports.append({
            "fold": fold,
            "trainFiles": len(train_files),
            "testFiles": len(test_files),
            "attempts": int(top["attempt_id"].nunique()),
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
) -> lgb.Booster:
    ordered, groups = prepare_grouped(frame)
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
    parser.add_argument("--input", required=True)
    parser.add_argument("--model-output", required=True)
    parser.add_argument("--report-output", required=True)
    parser.add_argument("--seed", type=int, default=20260831)
    args = parser.parse_args()

    operation, location, attempts = load_rows(Path(args.input))
    operation_features = feature_names(operation)
    location_features = feature_names(location)
    operation = operation.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    location = location.replace([np.inf, -np.inf], np.nan).fillna(0.0)

    operation_oof, operation_folds = fit_oof(
        operation,
        operation_features,
        args.seed,
        260,
    )
    location_valid_attempts = set(
        location.groupby("attempt_id")["label"].max().loc[lambda values: values > 0].index
    )
    location_train = location[location["attempt_id"].isin(location_valid_attempts)].copy()
    location_oof, location_folds = fit_oof(
        location_train,
        location_features,
        args.seed + 100,
        320,
    )

    operation_top = selected_by_attempt(operation, operation_oof)
    location_top = selected_by_attempt(location_train, location_oof)
    combined_correct = 0
    operation_correct = 0
    local_attempts = 0
    location_correct = 0
    per_file: dict[str, list[int]] = defaultdict(list)
    per_family: dict[str, list[int]] = defaultdict(list)
    for attempt_id, metadata in attempts.items():
        operation_prediction = operation_top[attempt_id]
        operation_hit = bool(operation_prediction["label"])
        operation_correct += int(operation_hit)
        identity = metadata["target_identity"]
        is_local = identity["eventType"] not in {"noEvent", "wholeSeriesMove"}
        local_hit = True
        if is_local:
            local_attempts += 1
            local_hit = bool(location_top.get(attempt_id, {}).get("label", 0))
            location_correct += int(local_hit)
        success = operation_hit and local_hit
        combined_correct += int(success)
        per_file[metadata["file_id"]].append(int(success))
        per_family[metadata["family"]].append(int(success))

    operation_booster = fit_final(
        operation,
        operation_features,
        args.seed,
        260,
    )
    location_booster = fit_final(
        location_train,
        location_features,
        args.seed + 100,
        320,
    )
    model = {
        "schemaVersion": 1,
        "modelVersion": "online-unified-package-v2",
        "teacherModelVersion": "applied-residual-unified-v12",
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
        "operationRows": len(operation),
        "locationRows": len(location),
        "locationTrainRows": len(location_train),
        "operationFeatures": len(operation_features),
        "locationFeatures": len(location_features),
        "operationPackageOracle": float(
            operation.groupby("attempt_id")["label"].max().mean()
        ),
        "locationPackageOracle": len(location_valid_attempts) / max(1, local_attempts),
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
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
