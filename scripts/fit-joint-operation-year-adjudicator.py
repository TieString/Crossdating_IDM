#!/usr/bin/env python3
"""Fit the frozen joint operation-year head on development and predict calibration."""

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
JOINT = load_module(
    "joint_operation_year_adjudicator",
    ROOT / "train-joint-operation-year-adjudicator.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-rows-manifest", required=True)
    parser.add_argument("--development-run-dir", required=True)
    parser.add_argument("--development-operation-identities", required=True)
    parser.add_argument("--target-rows-manifest", required=True)
    parser.add_argument("--target-run-dir", required=True)
    parser.add_argument("--target-operation-identities", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stride", type=int, default=5)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    development, _ = JOINT.build_table(
        Path(args.development_rows_manifest).resolve(),
        Path(args.development_run_dir).resolve(),
        Path(args.development_operation_identities).resolve(),
        max(1, args.stride),
    )
    target, attempts = JOINT.build_table(
        Path(args.target_rows_manifest).resolve(),
        Path(args.target_run_dir).resolve(),
        Path(args.target_operation_identities).resolve(),
        max(1, args.stride),
    )
    development["fit_role"] = "development"
    target["fit_role"] = "target"
    combined = pd.concat([development, target], ignore_index=True)
    forbidden = {
        "attempt_id", "file_id", "family", "fit_role", "product_correct",
        "product_strict_correct", "truth_year", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "year",
    }
    feature_columns = [column for column in combined.columns if column not in forbidden]
    values = pd.get_dummies(
        combined[feature_columns], columns=["event_type"], dtype=float
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    feature_names = list(values.columns)
    train_mask = combined["fit_role"].eq("development")
    positive_attempts = set(combined.loc[
        train_mask & combined["window_correct"].eq(1), "attempt_id"
    ])
    train = np.flatnonzero(
        train_mask.to_numpy()
        & combined["attempt_id"].isin(positive_attempts).to_numpy()
    )
    test = np.flatnonzero(combined["fit_role"].eq("target").to_numpy())
    ordered = combined.iloc[train].sort_values("attempt_id").index.to_numpy(dtype=int)
    groups = combined.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
    predictions = []
    models = []
    for seed in (37000, 37001, 37002):
        estimator = JOINT.ranker(seed)
        estimator.fit(
            values.loc[ordered],
            combined.loc[ordered, "window_correct"],
            group=groups,
        )
        predictions.append(estimator.predict(values.iloc[test]))
        models.append(estimator)
    target = target.copy()
    target["joint_score"] = np.mean(np.stack(predictions), axis=0)
    identity_top = target.sort_values(
        ["attempt_id", "event_type", "shift_years", "joint_score"],
        ascending=[True, True, True, False],
    ).groupby(
        ["attempt_id", "event_type", "shift_years"], as_index=False
    ).head(1).copy()
    identity_groups = identity_top.groupby("attempt_id", sort=False)
    identity_top["joint_z"] = (
        identity_top["joint_score"]
        - identity_groups["joint_score"].transform("mean")
    ) / identity_groups["joint_score"].transform("std").replace(0, 1)
    identity_top["operation_percentile"] = identity_groups[
        "operation_probability"
    ].rank(pct=True)
    identity_top["blend_score"] = (
        identity_top["joint_z"]
        + 0.75 * identity_top["operation_percentile"]
    )
    direct = target.sort_values(
        ["attempt_id", "joint_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    blended = identity_top.sort_values(
        ["attempt_id", "blend_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()

    def summarize(selected: pd.DataFrame) -> dict:
        result = attempts.merge(
            selected,
            on=["attempt_id", "file_id", "family"],
            how="left",
            suffixes=("", "_proposal"),
        )
        event = result[result["family"] != "Clean"]
        product_correct = int(event["product_correct"].sum())
        proposal_correct = int(event["window_correct"].sum())
        corrections = int((
            event["product_correct"].eq(0)
            & event["window_correct"].eq(1)
        ).sum())
        harms = int((
            event["product_correct"].eq(1)
            & event["window_correct"].eq(0)
        ).sum())
        oracle_union = int((
            event["product_correct"].eq(1)
            | event["window_correct"].eq(1)
        ).sum())
        return {
            "events": len(event),
            "productCorrect": product_correct,
            "proposalCorrect": proposal_correct,
            "proposalStrictCorrect": int(event["strict_correct"].sum()),
            "correctedProductFailures": corrections,
            "harmedProductCorrect": harms,
            "oracleUnionCorrect": oracle_union,
            "oracleUnionAccuracy": oracle_union / max(1, len(event)),
            "byFamily": {
                family: {
                    "events": len(group),
                    "productCorrect": int(group["product_correct"].sum()),
                    "proposalCorrect": int(group["window_correct"].sum()),
                    "corrections": int((
                        group["product_correct"].eq(0)
                        & group["window_correct"].eq(1)
                    ).sum()),
                }
                for family, group in event.groupby("family", sort=True)
            },
        }

    direct_summary = summarize(direct)
    blended_summary = summarize(blended)
    summary = {
        "schemaVersion": 1,
        "developmentRows": len(development),
        "targetRows": len(target),
        "features": len(feature_names),
        "frozenBlend": {
            "locationScore": "joint_z",
            "operationScore": "operation_percentile",
            "operationWeight": 0.75,
            "packageWeight": 0.0,
        },
        "direct": direct_summary,
        "blended": blended_summary,
    }
    direct.to_csv(output_dir / "target-joint-top.csv", index=False)
    blended.to_csv(output_dir / "target-blended-top.csv", index=False)
    target.to_pickle(output_dir / "target-joint-scores.pkl")
    for index, estimator in enumerate(models):
        (output_dir / f"joint-model-{index}.txt").write_text(
            estimator.booster_.model_to_string(), encoding="utf8"
        )
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
