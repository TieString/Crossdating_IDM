#!/usr/bin/env python3
"""Append whole-series identities projected from existing negative partial evidence."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def attempt_steps(run_dir: Path, dataset_id: str) -> dict[str, pd.Series]:
    steps = pd.read_json(run_dir / "steps.json")
    return {
        f"{dataset_id}:evaluation:{int(row['caseIndex'])}:{int(row['step'])}": row
        for _, row in steps.iterrows()
    }


def append_whole_projections(
    table: pd.DataFrame,
    steps: dict[str, pd.Series],
) -> pd.DataFrame:
    source = table[
        table["candidate_source"].eq("enrichedProposal")
        & table["event_type"].eq("partialMove")
        & table["shift_years"].lt(0)
    ].copy()
    score_column = (
        "evidence_enriched_location_score"
        if "evidence_enriched_location_score" in source
        else "evidence_operation_probability"
    )
    strongest = source.sort_values(
        ["attempt_id", "shift_years", score_column],
        ascending=[True, True, False],
    ).groupby(["attempt_id", "shift_years"], sort=False).head(1).copy()
    correct = []
    for attempt_id, shift_years in strongest[[
        "attempt_id", "shift_years"
    ]].itertuples(index=False):
        step = steps[str(attempt_id)]
        truth_shift = step.get("diagnosedTruthShiftYears")
        correct.append(int(
            str(step.get("diagnosedTruthType") or "") == "wholeSeriesMove"
            and pd.notna(truth_shift)
            and int(truth_shift) == int(shift_years)
        ))
    strongest["candidate_source"] = "wholeProjection"
    strongest["event_type"] = "wholeSeriesMove"
    strongest["shift_abs"] = strongest["shift_years"].abs()
    strongest["candidate_has_response"] = 1
    strongest["candidate_year_present"] = 0
    strongest["candidate_year"] = np.nan
    strongest["operation_correct"] = correct
    strongest["location_correct"] = correct
    strongest["location_relevance"] = correct
    strongest["location_error_years"] = np.nan
    strongest["workflow_correct"] = correct
    strongest["strict_correct"] = correct
    strongest["bundle_has_alternative"] = 0
    for column, value in (
        ("runtime_score", np.nan),
        ("runtime_score_margin", np.nan),
        ("runtime_confidence", "none"),
        ("runtime_window_width", 0),
        ("runtime_source_count", 0),
        ("runtime_note_count", 0),
        ("runtime_review_only", 0),
    ):
        if column in strongest:
            strongest[column] = value
    for column in strongest:
        if column.startswith("runtime_source__") or column.startswith(
            "runtime_note__"
        ):
            strongest[column] = 0
        elif column.startswith("bundle_alternative_"):
            strongest[column] = np.nan
    existing = table[
        table["candidate_source"].eq("wholeProjection")
    ][["attempt_id", "shift_years"]].drop_duplicates()
    if not existing.empty:
        existing_keys = set(existing.itertuples(index=False, name=None))
        strongest = strongest[
            ~strongest[["attempt_id", "shift_years"]].apply(
                tuple, axis=1
            ).isin(existing_keys)
        ]
    return inherit_equivalent_bundles(
        pd.concat([table, strongest], ignore_index=True, sort=False)
    )


def inherit_equivalent_bundles(table: pd.DataFrame) -> pd.DataFrame:
    """Replay the package builder's same-identity interpretation contract."""
    output = table.copy()
    output["_bundle_identity"] = (
        output["attempt_id"].astype(str)
        + "|" + output["event_type"].astype(str)
        + "|" + output["shift_years"].astype(int).astype(str)
        + "|" + output["candidate_year"].fillna("none").astype(str)
    )
    primary = output[
        output["candidate_source"].eq("productPrimary")
        & output["bundle_has_alternative"].eq(1)
    ].drop_duplicates("_bundle_identity").set_index("_bundle_identity")
    if primary.empty:
        return output.drop(columns="_bundle_identity")
    matched = output["_bundle_identity"].isin(primary.index)
    bundle_columns = [column for column in output if column.startswith("bundle_")]
    for column in bundle_columns:
        output.loc[matched, column] = output.loc[
            matched, "_bundle_identity"
        ].map(primary[column]).to_numpy()
    for label in ("operation_correct", "location_correct", "workflow_correct"):
        inherited = output.loc[matched, "_bundle_identity"].map(
            primary[label]
        ).fillna(0).astype(int).to_numpy()
        output.loc[matched, label] = np.maximum(
            output.loc[matched, label].astype(int).to_numpy(), inherited
        )
    return output.drop(columns="_bundle_identity")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--table", required=True)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source = Path(args.table).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    table = pd.read_pickle(source)
    result = append_whole_projections(
        table,
        attempt_steps(Path(args.run_dir).resolve(), args.dataset_id),
    )
    result.to_pickle(output)
    summary = {
        "schemaVersion": 1,
        "datasetId": args.dataset_id,
        "sourceRows": len(table),
        "wholeProjectionRows": int(
            result["candidate_source"].eq("wholeProjection").sum()
        ),
        "rows": len(result),
        "eventAttempts": int(
            result[result["family"].ne("Clean")]["attempt_id"].nunique()
        ),
        "cleanAttempts": int(
            result[result["family"].eq("Clean")]["attempt_id"].nunique()
        ),
        "candidateOracleCorrect": int(
            result[result["family"].ne("Clean")]
            .groupby("attempt_id")["workflow_correct"].max().sum()
        ),
    }
    output.with_suffix(".summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"output": str(output), **summary}))


if __name__ == "__main__":
    main()
