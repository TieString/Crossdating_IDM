#!/usr/bin/env python3
"""Freeze a development-only blend of operation prior and yearly OOF score."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scores", required=True)
    parser.add_argument("--joint-top", required=True)
    parser.add_argument("--safe-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = pd.read_pickle(Path(args.scores).resolve())
    metadata = pd.read_csv(Path(args.joint_top).resolve()).set_index("attempt_id")
    safe = pd.read_csv(Path(args.safe_dir).resolve() / "decisions.csv").set_index(
        "attempt_id"
    )
    identities = rows.sort_values(
        ["attempt_id", "event_type", "shift_years", "joint_score"],
        ascending=[True, True, True, False],
    ).groupby(
        ["attempt_id", "event_type", "shift_years"], as_index=False
    ).head(1).copy()
    groups = identities.groupby("attempt_id", sort=False)
    identities["joint_z"] = (
        identities["joint_score"] - groups["joint_score"].transform("mean")
    ) / groups["joint_score"].transform("std").replace(0, 1)
    identities["operation_percentile"] = groups["operation_probability"].rank(
        pct=True
    )
    identities["operation_logit"] = np.log(
        np.clip(identities["operation_probability"], 1e-6, 1 - 1e-6)
        / np.clip(1 - identities["operation_probability"], 1e-6, 1)
    )
    identities["product_correct_for_blend"] = identities["attempt_id"].map(
        metadata["product_correct"]
    ).fillna(0).astype(int)
    identities["safe_correct_for_blend"] = identities["attempt_id"].map(
        safe["model_workflow_correct"]
    ).fillna(False).astype(bool)

    experiments = []
    for location_name in ("joint_z",):
        for operation_name in ("operation_percentile", "operation_logit"):
            for operation_weight in (
                0.0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5,
                0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0,
            ):
                for package_weight in (0.0, 0.01, 0.03, 0.05, 0.1, 0.2, 0.4):
                    score = (
                        identities[location_name]
                        + operation_weight * identities[operation_name]
                        + package_weight * identities["package_identity"]
                    )
                    selected = identities.assign(blend_score=score).sort_values(
                        ["attempt_id", "blend_score"], ascending=[True, False]
                    ).groupby("attempt_id", sort=False).head(1)
                    event = selected[selected["family"] != "Clean"]
                    product_benefits = int((
                        event["product_correct_for_blend"].eq(0)
                        & event["window_correct"].eq(1)
                    ).sum())
                    safe_benefits = int((
                        ~event["safe_correct_for_blend"]
                        & event["window_correct"].eq(1)
                    ).sum())
                    safe_harms = int((
                        event["safe_correct_for_blend"]
                        & event["window_correct"].eq(0)
                    ).sum())
                    record = {
                        "locationScore": location_name,
                        "operationScore": operation_name,
                        "operationWeight": operation_weight,
                        "packageWeight": package_weight,
                        "proposalCorrect": int(event["window_correct"].sum()),
                        "productBenefits": product_benefits,
                        "safeBenefits": safe_benefits,
                        "safeHarms": safe_harms,
                    }
                    experiments.append(record)
    grid = pd.DataFrame(experiments)
    best_row = grid.sort_values(
        ["safeBenefits", "productBenefits", "proposalCorrect", "safeHarms"],
        ascending=[False, False, False, True],
    ).iloc[0]
    best_key = (
        best_row["locationScore"],
        best_row["operationScore"],
        float(best_row["operationWeight"]),
        float(best_row["packageWeight"]),
    )
    # Compute the runner-up from the full identity table with the frozen blend.
    full_score = (
        identities[best_key[0]]
        + best_key[2] * identities[best_key[1]]
        + best_key[3] * identities["package_identity"]
    )
    ranked = identities.assign(blend_score=full_score).sort_values(
        ["attempt_id", "blend_score"], ascending=[True, False]
    )
    second = ranked.groupby("attempt_id")["blend_score"].agg(
        lambda values: values.iloc[1] if len(values) > 1 else values.iloc[0]
    )
    selected = ranked.groupby("attempt_id", sort=False).head(1).copy()
    selected["blend_margin"] = (
        selected["blend_score"] - selected["attempt_id"].map(second)
    )
    metadata_columns = [
        column for column in metadata.columns
        if column not in selected.columns
    ]
    selected = selected.merge(
        metadata[metadata_columns],
        left_on="attempt_id",
        right_index=True,
        how="left",
    )
    selected["proposal_correct"] = selected["window_correct"]
    selected["proposal_strict_correct"] = selected["strict_correct"]
    event = selected[selected["family"] != "Clean"]
    summary = {
        "schemaVersion": 1,
        "frozenBlend": {
            "locationScore": best_key[0],
            "operationScore": best_key[1],
            "operationWeight": best_key[2],
            "packageWeight": best_key[3],
        },
        "eventAttempts": len(event),
        "proposalCorrect": int(event["proposal_correct"].sum()),
        "productBenefits": int((
            event["product_correct_for_blend"].eq(0)
            & event["proposal_correct"].eq(1)
        ).sum()),
        "safeBenefits": int((
            ~event["safe_correct_for_blend"]
            & event["proposal_correct"].eq(1)
        ).sum()),
        "safeHarmsIfUnconditional": int((
            event["safe_correct_for_blend"]
            & event["proposal_correct"].eq(0)
        ).sum()),
    }
    grid.to_csv(output_dir / "blend-grid.csv", index=False)
    selected.to_csv(output_dir / "joint-blended-top.csv", index=False)
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
