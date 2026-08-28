#!/usr/bin/env python3
"""Compact standalone location scores to one proposal per operation identity."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}


def location_score(
    frame: pd.DataFrame,
    weights: dict[str, float],
) -> pd.Series:
    typed = float(weights.get("typedLocation", 0.0))
    classifier = float(weights.get("locationClassifier", 0.0))
    rank_score = (
        frame["location_global_percentile"].fillna(0) * (1 - typed)
        + frame["location_typed_percentile"].fillna(0) * typed
    )
    classifier_score = (
        frame["location_global_classifier_percentile"].fillna(0)
        * (1 - typed)
        + frame["location_typed_classifier_percentile"].fillna(0) * typed
    )
    return rank_score * (1 - classifier) + classifier_score * classifier


def identity_top(
    frame: pd.DataFrame,
    weights: dict[str, float],
    score_mode: str = "frozen",
) -> pd.DataFrame:
    local = frame.loc[frame["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    if score_mode == "meta":
        local["identity_location_score"] = local[
            "location_meta_percentile"
        ].fillna(0)
    elif score_mode == "frozen":
        local["identity_location_score"] = location_score(local, weights)
    else:
        raise ValueError(f"unsupported score mode: {score_mode}")
    return (
        local.sort_values(
            ["identity_group", "identity_location_score"],
            ascending=[True, False],
        )
        .groupby("identity_group", sort=False)
        .head(1)
        .copy()
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--hierarchy-summary", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--score-mode", choices=("frozen", "meta"), default="frozen"
    )
    args = parser.parse_args()
    summary = json.loads(
        Path(args.hierarchy_summary).resolve().read_text(encoding="utf8")
    )
    scores = pd.read_pickle(Path(args.location_scores).resolve())
    top = identity_top(
        scores, summary.get("weights", {}), args.score_mode
    )
    compact_columns = [
        column for column in (
            "attempt_id", "cluster_id", "file_id", "family", "is_clean",
            "identity_group", "event_type", "shift_years", "candidate_source",
            "candidate_year", "candidate_has_response", "location_correct",
            "workflow_correct", "strict_correct", "identity_location_score",
        )
        if column in top
    ]
    compact = top[compact_columns].copy()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    compact.to_pickle(output)
    report = {
        "schemaVersion": 1,
        "selectionPolicy": f"same_identity_{args.score_mode}_location_score",
        "scoreMode": args.score_mode,
        "sourceRows": len(scores),
        "identityRows": len(compact),
        "attempts": int(compact["attempt_id"].nunique()),
        "weights": summary.get("weights", {}),
    }
    output.with_suffix(".summary.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"output": str(output), **report}))


if __name__ == "__main__":
    main()
