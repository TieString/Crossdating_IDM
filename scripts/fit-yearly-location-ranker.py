#!/usr/bin/env python3
"""Fit the yearly location ranker on development rows and predict a separate target set."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
YEARLY = load_module(
    "yearly_location_ranker",
    ROOT / "train-yearly-operation-location-ranker.py",
)


def build_table(rows_path: Path, run_dir: Path, operation_top_path: Path, prefix: str) -> pd.DataFrame:
    extracted = json.loads(rows_path.read_text(encoding="utf8"))["rows"]
    steps = json.loads((run_dir / "steps.json").read_text(encoding="utf8"))
    truth_by_attempt = {
        f"evaluation:{step['caseIndex']}:{step['step']}": step
        for step in steps
    }
    operation_top = pd.read_csv(operation_top_path).set_index("attempt_id")
    records = []
    for attempt in extracted:
        scored = attempt.get("scored")
        truth = truth_by_attempt.get(attempt["attemptId"])
        if not scored or not scored.get("rows") or not truth:
            continue
        truth_year = truth.get("diagnosedTruthYear") or truth.get("acceptedTruthYear")
        if truth_year is None or attempt["attemptId"] not in operation_top.index:
            continue
        selected_operation = operation_top.loc[attempt["attemptId"]]
        years = [row["year"] for row in scored["rows"]]
        minimum_year = min(years)
        maximum_year = max(years)
        span = max(1, maximum_year - minimum_year)
        for row in scored["rows"]:
            record = {
                "attempt_id": f"{prefix}:{attempt['attemptId']}",
                "source_attempt_id": attempt["attemptId"],
                "file_id": attempt["fileId"],
                "family": attempt["family"],
                "event_type": attempt["eventType"],
                "shift_years": attempt["shiftYears"],
                "shift_abs": abs(attempt["shiftYears"]),
                "operation_probability": attempt["operationProbability"],
                "operation_correct": int(selected_operation["operation_correct"]),
                "strict_operation_correct": int(
                    selected_operation["strict_operation_correct"]
                ),
                "product_correct": int(selected_operation["product_correct"]),
                "year": row["year"],
                "year_fraction": (row["year"] - minimum_year) / span,
                "distance_from_operation_best": abs(row["year"] - scored["bestYear"]),
                "distance_from_side_best": abs(
                    row["year"] - scored["sideStepBestYear"]
                ),
                "baseline_lag": scored["baselineLag"],
                "window_correct": int(abs(row["year"] - truth_year) <= 6),
                "top_exact": int(row["year"] == truth_year),
                "truth_year": truth_year,
            }
            record.update({field: row[field] for field in YEARLY.PROFILE_FIELDS})
            records.append(record)
    table = pd.DataFrame(records)
    for field in YEARLY.RANK_FIELDS:
        table[f"{field}_percentile"] = table.groupby("attempt_id")[field].rank(
            method="average", pct=True, ascending=True,
        )
        table[f"{field}_deficit"] = (
            table.groupby("attempt_id")[field].transform("max") - table[field]
        )
    return table


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-rows", required=True)
    parser.add_argument("--development-run-dir", required=True)
    parser.add_argument("--development-operation-top", required=True)
    parser.add_argument("--target-rows", required=True)
    parser.add_argument("--target-run-dir", required=True)
    parser.add_argument("--target-operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--model-scope",
        choices=("global", "event_type"),
        default="global",
    )
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development = build_table(
        Path(args.development_rows).resolve(),
        Path(args.development_run_dir).resolve(),
        Path(args.development_operation_top).resolve(),
        "development",
    )
    target = build_table(
        Path(args.target_rows).resolve(),
        Path(args.target_run_dir).resolve(),
        Path(args.target_operation_top).resolve(),
        "target",
    )
    combined = pd.concat([development, target], ignore_index=True)
    forbidden = {
        "attempt_id", "source_attempt_id", "file_id", "family",
        "operation_correct", "strict_operation_correct", "product_correct",
        "window_correct", "top_exact", "truth_year", "year",
    }
    feature_columns = [column for column in combined.columns if column not in forbidden]
    values = pd.get_dummies(
        combined[feature_columns],
        columns=["event_type"],
        dtype=float,
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(float)
    feature_names = list(values.columns)
    development_count = len(development)
    target = target.copy()
    target["location_score"] = np.nan
    model_strings = {}
    scopes = (
        sorted(development["event_type"].unique())
        if args.model_scope == "event_type"
        else ["global"]
    )
    for model_index, scope in enumerate(scopes):
        development_mask = (
            development["event_type"].eq(scope).to_numpy()
            if scope != "global"
            else np.ones(len(development), dtype=bool)
        )
        target_mask = (
            target["event_type"].eq(scope).to_numpy()
            if scope != "global"
            else np.ones(len(target), dtype=bool)
        )
        development_rows = np.flatnonzero(development_mask)
        ordered = development.iloc[development_rows].sort_values(
            "attempt_id"
        ).index.to_numpy(dtype=int)
        groups = development.loc[ordered].groupby(
            "attempt_id", sort=False
        ).size().to_numpy()
        estimator = YEARLY.model(30000 + model_index)
        estimator.fit(
            values.iloc[ordered],
            development.loc[ordered, "window_correct"],
            group=groups,
        )
        target_rows = np.flatnonzero(target_mask)
        target.loc[target_rows, "location_score"] = estimator.predict(
            values.iloc[development_count + target_rows]
        )
        model_strings[scope] = estimator.booster_.model_to_string()
    if target["location_score"].isna().any():
        raise RuntimeError("missing target location scores")
    top = target.sort_values(
        ["attempt_id", "location_score"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()
    operation_top = pd.read_csv(Path(args.target_operation_top).resolve())
    whole = operation_top[
        (operation_top["family"] != "Clean")
        & operation_top["event_type"].eq("wholeSeriesMove")
    ].copy()
    whole["source_attempt_id"] = whole["attempt_id"]
    whole["window_correct"] = 1
    whole["top_exact"] = 0
    whole["location_score"] = np.inf
    whole["year"] = np.nan
    whole["truth_year"] = np.nan
    for column in top.columns:
        if column not in whole.columns:
            whole[column] = np.nan
    top = pd.concat([top, whole[top.columns]], ignore_index=True)
    failures = top[top["product_correct"].eq(0)]
    operation_correct = failures[failures["operation_correct"].eq(1)]
    end_to_end = operation_correct[operation_correct["window_correct"].eq(1)]
    summary = {
        "schemaVersion": 1,
        "developmentAttempts": int(development["attempt_id"].nunique()),
        "developmentYearRows": len(development),
        "targetAttempts": int(top["source_attempt_id"].nunique()),
        "targetYearRows": len(target),
        "features": len(feature_names),
        "productFailures": len(failures),
        "operationTopCorrect": len(operation_correct),
        "endToEndTopCorrect": len(end_to_end),
        "endToEndRateAmongOperationCorrect": (
            len(end_to_end) / len(operation_correct) if len(operation_correct) else None
        ),
        "strictEndToEndTopCorrect": int((
            operation_correct["strict_operation_correct"].eq(1)
            & operation_correct["window_correct"].eq(1)
        ).sum()),
    }
    top.to_csv(output_dir / "target-yearly-location-top.csv", index=False)
    target.to_csv(output_dir / "target-yearly-location-scores.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    for scope, model_string in model_strings.items():
        (output_dir / f"location-model-{scope}.txt").write_text(
            model_string, encoding="utf8"
        )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
