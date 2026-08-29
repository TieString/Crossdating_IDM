#!/usr/bin/env python3
"""Read-only stratified audit for immutable two-stage shadow predictions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def short_attempt(value: object) -> str:
    text = str(value)
    marker = text.find("evaluation:")
    return text[marker:] if marker >= 0 else text


def cluster_lower(frame: pd.DataFrame, seed: int, repetitions: int) -> float:
    files = np.asarray(sorted(frame["file_id"].astype(str).unique()))
    grouped = {
        file_id: frame.loc[
            frame["file_id"].astype(str).eq(file_id), "final_correct"
        ].to_numpy(dtype=float)
        for file_id in files
    }
    rng = np.random.default_rng(seed)
    samples = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        selected = rng.choice(files, size=len(files), replace=True)
        samples[index] = np.concatenate([grouped[file_id] for file_id in selected]).mean()
    return float(np.quantile(samples, 0.05, method="lower"))


def classify_failure(row: pd.Series) -> str:
    if int(row["final_correct"]) == 1:
        return "correct"
    if int(row["candidate_oracle"]) == 0:
        return "candidate_oracle_miss"
    if bool(row.get("same_frozen_frontier_error", False)):
        return "frontier_selection"
    if int(row["candidate_has_response"]) == 0 or row["event_type"] == "noEvent":
        return "refusal"
    if int(row["operation_correct"]) == 0:
        return "operation_or_shift"
    if row["event_type"] in {"missingRing", "falseRing", "partialMove"}:
        return "window_location"
    return "package_projection_or_other"


def summarize_group(group: pd.DataFrame, seed: int, repetitions: int) -> dict:
    failures = group[group["final_correct"].eq(0)]
    oracle_hit_failures = failures[failures["candidate_oracle"].eq(1)]
    return {
        "files": int(group["file_id"].nunique()),
        "events": len(group),
        "workflowCorrect": int(group["final_correct"].sum()),
        "workflowAccuracy": float(group["final_correct"].mean()),
        "oneSided95FileClusterLower": cluster_lower(group, seed, repetitions),
        "candidateOracleHits": int(group["candidate_oracle"].sum()),
        "candidateOracleAccuracy": float(group["candidate_oracle"].mean()),
        "rankingLosses": len(oracle_hit_failures),
        "candidateOracleMiss": int(failures["candidate_oracle"].eq(0).sum()),
        "operationOrShift": int(failures["failure_category"].eq("operation_or_shift").sum()),
        "windowLocation": int(failures["failure_category"].eq("window_location").sum()),
        "frontierSelection": int(failures["failure_category"].eq("frontier_selection").sum()),
        "refusal": int(failures["failure_category"].eq("refusal").sum()),
        "projectionOrOther": int(
            failures["failure_category"].eq("package_projection_or_other").sum()
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--predictions", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--frontier-errors")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    prediction = pd.read_csv(args.predictions)
    metadata = pd.read_csv(args.metadata)
    prediction["attempt_key"] = prediction["attempt_id"].map(short_attempt)
    metadata["attempt_key"] = metadata["attempt_id"].map(short_attempt)
    if prediction["attempt_key"].duplicated().any():
        raise RuntimeError("prediction attempts are not unique")
    if metadata["attempt_key"].duplicated().any():
        raise RuntimeError("metadata attempts are not unique")
    metadata_columns = [
        "attempt_key",
        "target_id",
        "truth_type",
        "truth_year",
        "truth_shift_years",
        "series_years",
        "event_count",
        "position_band",
        "file_correlation",
        "target_master_correlation",
        "file_correlation_bin",
        "target_correlation_bin",
        "length_bin",
        "reference_depth_bin",
        "candidate_oracle",
        "event_type",
        "shift_years",
        "selected_candidate_year",
        "final_correct",
    ]
    old = metadata[metadata_columns].rename(columns={
        "event_type": "old_event_type",
        "shift_years": "old_shift_years",
        "selected_candidate_year": "old_candidate_year",
        "final_correct": "old_final_correct",
    })
    joined = prediction.merge(old, on="attempt_key", how="left", validate="one_to_one")
    event = joined[joined["family"].ne("Clean")].copy()
    if event["candidate_oracle"].isna().any():
        raise RuntimeError("external metadata did not cover every event prediction")
    event["candidate_oracle"] = event["candidate_oracle"].astype(np.int8)

    frontier_attempts: set[str] = set()
    if args.frontier_errors:
        frontier = pd.read_csv(args.frontier_errors)
        frontier_attempts = set(frontier["attempt_id"].map(short_attempt))
    unchanged_package = (
        event["event_type"].eq(event["old_event_type"])
        & event["shift_years"].eq(event["old_shift_years"])
        & pd.to_numeric(event["selected_candidate_year"], errors="coerce").fillna(-1e9).eq(
            pd.to_numeric(event["old_candidate_year"], errors="coerce").fillna(-1e9)
        )
    )
    event["same_frozen_frontier_error"] = (
        event["attempt_key"].isin(frontier_attempts) & unchanged_package
    )
    event["failure_category"] = event.apply(classify_failure, axis=1)
    event["correct_to_wrong"] = (
        event["old_final_correct"].eq(1) & event["final_correct"].eq(0)
    )
    event["wrong_to_correct"] = (
        event["old_final_correct"].eq(0) & event["final_correct"].eq(1)
    )

    overall = summarize_group(event, 99101, args.bootstrap_repetitions)
    overall.update({
        "oldWorkflowCorrect": int(event["old_final_correct"].sum()),
        "correctToWrong": int(event["correct_to_wrong"].sum()),
        "wrongToCorrect": int(event["wrong_to_correct"].sum()),
        "correctRetention": float(
            event.loc[event["old_final_correct"].eq(1), "final_correct"].mean()
        ),
        "failureCategories": event.loc[
            event["final_correct"].eq(0), "failure_category"
        ].value_counts().to_dict(),
    })
    dimensions = {
        "family": "family",
        "fileCorrelation": "file_correlation_bin",
        "targetCorrelation": "target_correlation_bin",
        "length": "length_bin",
        "position": "position_band",
        "eventCount": "event_count",
        "referenceDepth": "reference_depth_bin",
    }
    rows: list[dict] = []
    stratified: dict[str, dict[str, dict]] = {}
    for dimension_index, (dimension, column) in enumerate(dimensions.items()):
        stratified[dimension] = {}
        for level, group in event.groupby(column, dropna=False, sort=True):
            label = str(level)
            result = summarize_group(
                group,
                99200 + dimension_index * 100 + len(rows),
                args.bootstrap_repetitions,
            )
            stratified[dimension][label] = result
            rows.append({"dimension": dimension, "level": label, **result})

    event.to_csv(output_dir / "cases.csv", index=False)
    pd.DataFrame(rows).to_csv(output_dir / "stratified.csv", index=False)
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "trainingCalls": 0,
        "overall": overall,
        "stratified": stratified,
    }
    (output_dir / "analysis.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
