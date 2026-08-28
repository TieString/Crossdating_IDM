#!/usr/bin/env python3
"""Fit enriched operation/location heads on development and predict calibration once."""

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
    "fit_enriched_joint_rows",
    ROOT / "train-joint-operation-year-adjudicator.py",
)
ENRICHED = load_module(
    "fit_enriched_hierarchical",
    ROOT / "train-enriched-hierarchical-adjudicator.py",
)


def encode_combined(
    development: pd.DataFrame,
    target: pd.DataFrame,
    forbidden: set[str],
) -> tuple[pd.DataFrame, int, list[str]]:
    development = development.copy()
    target = target.copy()
    development["fit_role"] = "development"
    target["fit_role"] = "target"
    combined = pd.concat([development, target], ignore_index=True)
    columns = [
        column for column in combined.columns
        if column not in forbidden and column != "fit_role"
    ]
    values = pd.get_dummies(
        combined[columns],
        columns=[column for column in columns if combined[column].dtype == object],
        dtype=np.float32,
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, len(development), list(values.columns)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-rows-manifest", required=True)
    parser.add_argument("--development-run-dir", required=True)
    parser.add_argument("--development-operation-identities", required=True)
    parser.add_argument(
        "--development-row-cache",
        nargs="+",
        help="One or more development row caches; attempt identities are isolated.",
    )
    parser.add_argument("--development-model-dir", required=True)
    parser.add_argument("--target-rows-manifest", required=True)
    parser.add_argument("--target-run-dir", required=True)
    parser.add_argument("--target-operation-identities", required=True)
    parser.add_argument("--target-row-cache")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stride", type=int, default=5)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.development_row_cache:
        development_frames = []
        for index, cache_path in enumerate(args.development_row_cache):
            development_cache = Path(cache_path).resolve()
            frame = pd.read_pickle(development_cache / "rows.pkl")
            frame["attempt_id"] = (
                f"development-cache-{index}:" + frame["attempt_id"].astype(str)
            )
            development_frames.append(frame)
        development_rows = pd.concat(
            development_frames, ignore_index=True, sort=False
        )
        del development_frames
    else:
        development_rows, _ = JOINT.build_table(
            Path(args.development_rows_manifest).resolve(),
            Path(args.development_run_dir).resolve(),
            Path(args.development_operation_identities).resolve(),
            max(1, args.stride),
        )
    if args.target_row_cache:
        target_cache = Path(args.target_row_cache).resolve()
        target_rows = pd.read_pickle(target_cache / "rows.pkl")
        target_attempts = pd.read_pickle(target_cache / "attempts.pkl")
    else:
        target_rows, target_attempts = JOINT.build_table(
            Path(args.target_rows_manifest).resolve(),
            Path(args.target_run_dir).resolve(),
            Path(args.target_operation_identities).resolve(),
            max(1, args.stride),
        )
    for table in (development_rows, target_rows):
        table["identity_key"] = (
            table["attempt_id"].astype(str)
            + "|" + table["event_type"].astype(str)
            + "|" + table["shift_years"].astype(int).astype(str)
        )
    development_identities = ENRICHED.build_identity_table(development_rows)
    target_identities = ENRICHED.build_identity_table(target_rows)
    frozen = json.loads((
        Path(args.development_model_dir).resolve() / "summary.json"
    ).read_text(encoding="utf8"))["frozenWeights"]
    if float(frozen["operationRanker"]) != 0:
        raise RuntimeError("frozen operation ranker weight is not supported by this fit")
    typed_weight = float(frozen["typedLocation"])

    operation_forbidden = {
        "identity_key", "attempt_id", "file_id", "family",
        "operation_correct", "strict_operation_correct", "product_correct",
        "product_strict_correct",
    }
    operation_values, operation_split, operation_features = encode_combined(
        development_identities,
        target_identities,
        operation_forbidden,
    )
    operation_predictions = []
    operation_models = []
    labels = development_identities["operation_correct"]
    for seed in (40000, 40001, 40002):
        estimator = ENRICHED.operation_classifier(labels, seed)
        estimator.fit(operation_values.iloc[:operation_split], labels)
        operation_predictions.append(
            estimator.predict_proba(operation_values.iloc[operation_split:])[:, 1]
        )
        operation_models.append(estimator)
    target_identities["enriched_operation_probability"] = np.mean(
        np.stack(operation_predictions), axis=0
    )
    target_identities["operation_classifier_percentile"] = target_identities.groupby(
        "attempt_id", sort=False
    )["enriched_operation_probability"].rank(pct=True)

    row_forbidden = {
        "identity_key", "attempt_id", "file_id", "family", "product_correct",
        "product_strict_correct", "truth_year", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "year",
    }
    row_values, row_split, row_features = encode_combined(
        development_rows,
        target_rows,
        row_forbidden,
    )
    development_correct = np.flatnonzero(
        development_rows["operation_correct"].eq(1).to_numpy()
    )
    ordered = development_rows.iloc[development_correct].sort_values(
        "identity_key"
    ).index.to_numpy(dtype=int)
    groups = development_rows.loc[ordered].groupby(
        "identity_key", sort=False
    ).size().to_numpy()
    global_model = ENRICHED.location_ranker(41000)
    global_model.fit(
        row_values.loc[ordered],
        development_rows.loc[ordered, "window_correct"],
        group=groups,
    )
    target_rows["enriched_location_score"] = global_model.predict(
        row_values.iloc[row_split:]
    )
    typed_models = {}
    target_rows["enriched_typed_location_score"] = np.nan
    for event_index, event_type in enumerate(
        ("missingRing", "falseRing", "partialMove")
    ):
        typed_train = np.flatnonzero((
            development_rows["operation_correct"].eq(1)
            & development_rows["event_type"].eq(event_type)
        ).to_numpy())
        typed_ordered = development_rows.iloc[typed_train].sort_values(
            "identity_key"
        ).index.to_numpy(dtype=int)
        typed_groups = development_rows.loc[typed_ordered].groupby(
            "identity_key", sort=False
        ).size().to_numpy()
        model = ENRICHED.location_ranker(41500 + event_index)
        model.fit(
            row_values.loc[typed_ordered],
            development_rows.loc[typed_ordered, "window_correct"],
            group=typed_groups,
        )
        target_indices = np.flatnonzero(
            target_rows["event_type"].eq(event_type).to_numpy()
        )
        target_rows.loc[target_indices, "enriched_typed_location_score"] = model.predict(
            row_values.iloc[row_split + target_indices]
        )
        typed_models[event_type] = model
    if target_rows["enriched_typed_location_score"].isna().any():
        raise RuntimeError("missing target typed location predictions")
    location_groups = target_rows.groupby("identity_key", sort=False)
    target_rows["location_global_percentile"] = location_groups[
        "enriched_location_score"
    ].rank(pct=True)
    target_rows["location_typed_percentile"] = location_groups[
        "enriched_typed_location_score"
    ].rank(pct=True)
    target_rows["location_blend_score"] = (
        target_rows["location_global_percentile"] * (1 - typed_weight)
        + target_rows["location_typed_percentile"] * typed_weight
    )

    top_identity = target_identities.sort_values(
        ["attempt_id", "operation_classifier_percentile"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1)
    selected_identity = top_identity.set_index("attempt_id")["identity_key"]
    selected_rows = target_rows[
        target_rows["identity_key"].eq(
            target_rows["attempt_id"].map(selected_identity)
        )
    ]
    top = selected_rows.sort_values(
        ["attempt_id", "location_blend_score"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()
    result = target_attempts.merge(
        top,
        on=["attempt_id", "file_id", "family"],
        how="left",
        suffixes=("", "_proposal"),
    )
    event = result[result["family"] != "Clean"]
    failures = event[event["product_correct"].eq(0)]
    corrections = int(failures["window_correct"].sum())
    oracle_union = int((
        event["product_correct"].eq(1) | event["window_correct"].eq(1)
    ).sum())
    summary = {
        "schemaVersion": 1,
        "developmentRows": len(development_rows),
        "targetRows": len(target_rows),
        "developmentIdentities": len(development_identities),
        "targetIdentities": len(target_identities),
        "operationFeatures": len(operation_features),
        "locationFeatures": len(row_features),
        "frozenWeights": frozen,
        "events": len(event),
        "productCorrect": int(event["product_correct"].sum()),
        "productFailures": len(failures),
        "operationTopCorrect": int(failures["operation_correct"].sum()),
        "completeCorrections": corrections,
        "strictCompleteCorrections": int(failures["strict_correct"].sum()),
        "oracleUnionCorrect": oracle_union,
        "oracleUnionAccuracy": oracle_union / max(1, len(event)),
        "byFamily": {
            family: {
                "events": len(group),
                "productCorrect": int(group["product_correct"].sum()),
                "operationTopCorrect": int(group.loc[
                    group["product_correct"].eq(0), "operation_correct"
                ].sum()),
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
    top.to_csv(output_dir / "target-enriched-hierarchical-top.csv", index=False)
    target_identities.to_csv(
        output_dir / "target-enriched-operation-identities.csv", index=False
    )
    target_rows[[
        "attempt_id", "file_id", "family", "identity_key", "event_type",
        "shift_years", "operation_correct", "strict_operation_correct",
        "year", "window_correct", "strict_correct", "enriched_location_score",
        "enriched_typed_location_score", "location_global_percentile",
        "location_typed_percentile", "location_blend_score",
    ]].to_pickle(output_dir / "target-enriched-location-scores.pkl")
    for index, model in enumerate(operation_models):
        (output_dir / f"operation-model-{index}.txt").write_text(
            model.booster_.model_to_string(), encoding="utf8"
        )
    (output_dir / "location-global-model.txt").write_text(
        global_model.booster_.model_to_string(), encoding="utf8"
    )
    for event_type, model in typed_models.items():
        (output_dir / f"location-{event_type}-model.txt").write_text(
            model.booster_.model_to_string(), encoding="utf8"
        )
    (output_dir / "operation-feature-names.json").write_text(
        json.dumps(operation_features, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "location-feature-names.json").write_text(
        json.dumps(row_features, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
