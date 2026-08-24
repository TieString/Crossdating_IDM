#!/usr/bin/env python3
"""Freeze unit-window classifier and partial-transition ranker into one proposal."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ranker-top", required=True)
    parser.add_argument("--classifier-top", required=True)
    parser.add_argument("--attempts", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    ranker = pd.read_csv(Path(args.ranker_top).resolve()).set_index("attempt_id")
    classifier = pd.read_csv(Path(args.classifier_top).resolve()).set_index(
        "attempt_id"
    )
    attempts_path = Path(args.attempts).resolve()
    attempts = (
        pd.read_pickle(attempts_path)
        if attempts_path.suffix.lower() == ".pkl"
        else pd.read_csv(attempts_path)
    ).set_index("attempt_id")
    attempt_ids = ranker.index.union(classifier.index)
    ranker = ranker.reindex(attempt_ids)
    classifier = classifier.reindex(attempt_ids)
    use_ranker = classifier["event_type"].eq("partialMove")
    columns = ranker.columns.union(classifier.columns)
    ranker = ranker.reindex(columns=columns)
    classifier = classifier.reindex(columns=columns)
    selected = classifier.copy()
    selected.loc[use_ranker, :] = ranker.loc[use_ranker, :]
    selected["location_head"] = "unit_window_classifier"
    selected.loc[use_ranker, "location_head"] = "partial_transition_ranker"
    selected.index.name = "attempt_id"
    selected = selected.reset_index()

    event_attempts = attempts[attempts["family"] != "Clean"]
    event = event_attempts.merge(
        selected[[
            "attempt_id", "event_type", "shift_years", "year",
            "window_correct", "strict_correct", "location_head",
        ]],
        on="attempt_id",
        how="left",
    )
    failures = event[event["product_correct"].eq(0)]
    corrections = int(failures["window_correct"].sum())
    union = int((
        event["product_correct"].eq(1) | event["window_correct"].eq(1)
    ).sum())
    summary = {
        "schemaVersion": 1,
        "locationPolicy": {
            "missingRing": "unit_window_classifier",
            "falseRing": "unit_window_classifier",
            "partialMove": "partial_transition_ranker",
        },
        "events": len(event),
        "productCorrect": int(event["product_correct"].sum()),
        "completeCorrections": corrections,
        "oracleUnionCorrect": union,
        "oracleUnionAccuracy": union / max(1, len(event)),
        "byFamily": {
            family: {
                "events": len(group),
                "productCorrect": int(group["product_correct"].sum()),
                "completeCorrections": int(group.loc[
                    group["product_correct"].eq(0), "window_correct"
                ].sum()),
                "oracleUnionCorrect": int((
                    group["product_correct"].eq(1)
                    | group["window_correct"].eq(1)
                ).sum()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }
    selected.to_csv(output_dir / "operation-specific-location-top.csv", index=False)
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
