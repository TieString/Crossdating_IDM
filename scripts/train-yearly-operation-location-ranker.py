#!/usr/bin/env python3
"""Rank full yearly counterfactual rows for one file-OOF selected operation identity."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


PROFILE_FIELDS = (
    "rawCorrelation",
    "differenceCorrelation",
    "combinedCorrelation",
    "samplePairs",
    "differencePairs",
    "sideOlderAdvantage",
    "sideNewerAdvantage",
    "sideMinimumAdvantage",
    "sideStepScore",
    "correctedSideSupport",
    "localSideOlderAdvantage11",
    "localSideNewerAdvantage11",
    "localSideStepScore11",
    "localSideOlderAdvantage21",
    "localSideNewerAdvantage21",
    "localSideStepScore21",
    "localSideOlderAdvantage31",
    "localSideNewerAdvantage31",
    "localSideStepScore31",
    "olderSamplePairs",
    "newerSamplePairs",
    "olderDifferencePairs",
    "newerDifferencePairs",
    "rawGain",
    "differenceGain",
    "combinedGain",
)
RANK_FIELDS = (
    "rawGain",
    "differenceGain",
    "combinedGain",
    "sideMinimumAdvantage",
    "sideStepScore",
    "correctedSideSupport",
    "localSideStepScore11",
    "localSideStepScore21",
    "localSideStepScore31",
)


def model(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=500,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=45,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.0,
        reg_lambda=3.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    extracted = json.loads(Path(args.rows).read_text(encoding="utf8"))["rows"]
    steps = json.loads((Path(args.run_dir).resolve() / "steps.json").read_text(
        encoding="utf8"
    ))
    truth_by_attempt = {
        f"evaluation:{step['caseIndex']}:{step['step']}": step
        for step in steps
    }
    operation_top = pd.read_csv(Path(args.operation_top).resolve())
    operation_by_attempt = operation_top.set_index("attempt_id")
    records = []
    for attempt in extracted:
        scored = attempt.get("scored")
        truth = truth_by_attempt.get(attempt["attemptId"])
        if not scored or not scored.get("rows") or not truth:
            continue
        truth_year = truth.get("diagnosedTruthYear") or truth.get("acceptedTruthYear")
        if truth_year is None:
            continue
        selected_operation = operation_by_attempt.loc[attempt["attemptId"]]
        years = [row["year"] for row in scored["rows"]]
        minimum_year = min(years)
        maximum_year = max(years)
        span = max(1, maximum_year - minimum_year)
        for row in scored["rows"]:
            record = {
                "attempt_id": attempt["attemptId"],
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
                "distance_from_side_best": abs(row["year"] - scored["sideStepBestYear"]),
                "baseline_lag": scored["baselineLag"],
                "window_correct": int(abs(row["year"] - truth_year) <= 6),
                "top_exact": int(row["year"] == truth_year),
                "truth_year": truth_year,
            }
            record.update({field: row[field] for field in PROFILE_FIELDS})
            records.append(record)
    table = pd.DataFrame(records)
    for field in RANK_FIELDS:
        table[f"{field}_percentile"] = table.groupby("attempt_id")[field].rank(
            method="average",
            pct=True,
            ascending=True,
        )
        table[f"{field}_deficit"] = (
            table.groupby("attempt_id")[field].transform("max") - table[field]
        )
    forbidden = {
        "attempt_id",
        "file_id",
        "family",
        "operation_correct",
        "strict_operation_correct",
        "product_correct",
        "window_correct",
        "top_exact",
        "truth_year",
        "year",
    }
    feature_columns = [column for column in table.columns if column not in forbidden]
    values = pd.get_dummies(
        table[feature_columns],
        columns=["event_type"],
        dtype=float,
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(float)
    feature_names = list(values.columns)
    files = np.array(sorted(table["file_id"].unique()))
    predictions = np.full(len(table), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)),
        groups=files,
    )):
        held_files = set(files[test_file_indices])
        train = np.flatnonzero(~table["file_id"].isin(held_files).to_numpy())
        test = np.flatnonzero(table["file_id"].isin(held_files).to_numpy())
        ordered = table.iloc[train].sort_values("attempt_id").index.to_numpy(dtype=int)
        groups = table.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
        estimator = model(26000 + fold)
        estimator.fit(
            values.loc[ordered],
            table.loc[ordered, "window_correct"],
            group=groups,
        )
        predictions[test] = estimator.predict(values.iloc[test])
    if np.isnan(predictions).any():
        raise RuntimeError("missing yearly location OOF predictions")
    table["location_score"] = predictions
    top = table.sort_values(
        ["attempt_id", "location_score"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()
    failures = top[top["product_correct"].eq(0)]
    operation_correct = failures[failures["operation_correct"].eq(1)]
    end_to_end = operation_correct[operation_correct["window_correct"].eq(1)]
    summary = {
        "schemaVersion": 1,
        "attempts": int(table["attempt_id"].nunique()),
        "yearRows": len(table),
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
        "topExactAmongEndToEnd": int(end_to_end["top_exact"].sum()),
        "byFamily": {
            family: {
                "productFailures": len(failures[failures["family"] == family]),
                "operationTopCorrect": len(operation_correct[
                    operation_correct["family"] == family
                ]),
                "endToEndTopCorrect": len(end_to_end[end_to_end["family"] == family]),
            }
            for family in ("A", "B", "C", "D")
        },
    }
    top.to_csv(output_dir / "yearly-location-top.csv", index=False)
    table[[
        "attempt_id",
        "file_id",
        "family",
        "event_type",
        "shift_years",
        "operation_probability",
        "operation_correct",
        "product_correct",
        "year",
        "window_correct",
        "top_exact",
        "location_score",
    ]].to_csv(output_dir / "yearly-location-scores.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
