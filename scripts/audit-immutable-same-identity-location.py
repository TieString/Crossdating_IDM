#!/usr/bin/env python3
"""Audit frozen location views under an immutable operation/shift selection."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
LOCATION_VIEWS = (
    "location_global_score",
    "location_typed_score",
    "location_global_classifier_probability",
    "location_typed_classifier_probability",
    "location_global_percentile",
    "location_typed_percentile",
    "location_global_classifier_percentile",
    "location_typed_classifier_percentile",
    "location_meta_score",
    "location_meta_percentile",
    "location_score",
)


def ensure_identity_group(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    if "identity_group" not in output:
        output["identity_group"] = (
            output["attempt_id"].astype(str)
            + "|"
            + output["event_type"].astype(str)
            + "|"
            + output["shift_years"].astype(int).astype(str)
        )
    return output


def project_location(
    operation_top: pd.DataFrame,
    location_top: pd.DataFrame,
) -> pd.DataFrame:
    selected = operation_top.copy()
    local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    lookup = location_top.set_index("identity_group")
    selected["location_correct"] = np.nan
    selected["final_correct"] = selected["operation_correct"].astype(np.int8)
    selected.loc[local, "location_correct"] = selected.loc[
        local, "identity_group"
    ].map(lookup["location_correct"])
    selected.loc[local, "final_correct"] = (
        selected.loc[local, "operation_correct"].astype(bool)
        & selected.loc[local, "location_correct"].fillna(0).astype(bool)
    ).astype(np.int8)
    selected.loc[local, "selected_candidate_year"] = selected.loc[
        local, "identity_group"
    ].map(lookup["candidate_year"])
    return selected


def summarize(selected: pd.DataFrame) -> dict:
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    return {
        "correct": int(event["final_correct"].sum()),
        "events": len(event),
        "accuracy": float(event["final_correct"].mean()),
        "operationCorrect": int(event["operation_correct"].sum()),
        "locationFailuresAfterCorrectOperation": int(
            event["operation_correct"].astype(bool).sum()
            - event["final_correct"].sum()
        ),
        "cleanFalsePositives": int(
            clean["event_type"].ne("noEvent").sum()
        ),
        "byFamily": {
            str(family): {
                "correct": int(group["final_correct"].sum()),
                "events": len(group),
                "accuracy": float(group["final_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-packages", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    packages = ensure_identity_group(
        pd.read_pickle(Path(args.location_packages).resolve())
    )
    packages = packages[
        packages["event_type"].isin(LOCAL_EVENT_TYPES)
    ].reset_index(drop=True)
    operation_top = ensure_identity_group(
        pd.read_csv(Path(args.operation_top).resolve())
    )

    identity_labels = packages.groupby("identity_group", sort=False).agg(
        attempt_id=("attempt_id", "first"),
        file_id=("file_id", "first"),
        family=("family", "first"),
        event_type=("event_type", "first"),
        shift_years=("shift_years", "first"),
        identity_operation_correct=("identity_operation_correct", "max"),
        identity_workflow_oracle=("workflow_correct", "max"),
        identity_strict_oracle=("strict_correct", "max"),
    ).reset_index()
    identity_labels.to_pickle(output_dir / "identity-location-labels.pkl")

    rows = []
    selections: dict[str, pd.DataFrame] = {}
    for view in LOCATION_VIEWS:
        if view not in packages:
            continue
        top = (
            packages.assign(_score=pd.to_numeric(packages[view], errors="coerce"))
            .sort_values(
                ["identity_group", "_score"], ascending=[True, False]
            )
            .groupby("identity_group", sort=False)
            .head(1)
        )
        selected = project_location(operation_top, top)
        result = summarize(selected)
        rows.append({"view": view, **{k: v for k, v in result.items() if k != "byFamily"}})
        selections[view] = selected

    oracle_top = (
        packages.sort_values(
            ["identity_group", "location_correct"], ascending=[True, False]
        )
        .groupby("identity_group", sort=False)
        .head(1)
    )
    oracle = project_location(operation_top, oracle_top)
    oracle_result = summarize(oracle)
    grid = pd.DataFrame(rows).sort_values(
        ["correct", "cleanFalsePositives"], ascending=[False, True]
    )
    best_view = str(grid.iloc[0]["view"])
    best = selections[best_view]
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "candidateGeneratorFrozen": True,
        "operationIdentityImmutable": True,
        "identityLabels": len(identity_labels),
        "locationViews": list(grid["view"]),
        "bestView": best_view,
        "best": summarize(best),
        "selectedIdentityLocationOracle": oracle_result,
    }
    grid.to_csv(output_dir / "location-view-grid.csv", index=False)
    best.to_csv(output_dir / "best-location-top.csv", index=False)
    oracle.to_csv(output_dir / "selected-identity-location-oracle-top.csv", index=False)
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"outputDir": str(output_dir), **payload}, ensure_ascii=False))


if __name__ == "__main__":
    main()
