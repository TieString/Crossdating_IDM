#!/usr/bin/env python3
"""Fit the frozen enriched window classifier and predict calibration."""

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
TRAINER = load_module(
    "fit_location_classifier_trainer",
    ROOT / "train-enriched-location-classifier.py",
)
ENRICHED = load_module(
    "fit_location_classifier_enriched",
    ROOT / "train-enriched-hierarchical-adjudicator.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--development-row-cache",
        required=True,
        nargs="+",
        help="One or more development row caches; attempt identities are isolated.",
    )
    parser.add_argument("--development-model-dir", required=True)
    parser.add_argument("--target-row-cache", required=True)
    parser.add_argument("--target-operation-identities", required=True)
    parser.add_argument("--target-ranker-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    target_cache = Path(args.target_row_cache).resolve()
    development_frames = []
    for index, cache_path in enumerate(args.development_row_cache):
        development_cache = Path(cache_path).resolve()
        frame = pd.read_pickle(development_cache / "rows.pkl")
        frame["attempt_id"] = (
            f"development-cache-{index}:" + frame["attempt_id"].astype(str)
        )
        development_frames.append(frame)
    development = pd.concat(development_frames, ignore_index=True, sort=False)
    del development_frames
    target = pd.read_pickle(target_cache / "rows.pkl")
    attempts = pd.read_pickle(target_cache / "attempts.pkl")
    for table in (development, target):
        table["identity_key"] = (
            table["attempt_id"].astype(str)
            + "|" + table["event_type"].astype(str)
            + "|" + table["shift_years"].astype(int).astype(str)
        )
    frozen = json.loads((
        Path(args.development_model_dir).resolve() / "summary.json"
    ).read_text(encoding="utf8"))["frozenWeights"]
    typed_weight = float(frozen["typedClassifier"])
    classifier_weight = float(frozen["classifier"])
    ranker_scores = pd.read_pickle(Path(args.target_ranker_scores).resolve())
    ranker_score_by_row = ranker_scores["enriched_location_score"]
    target["ranker_score"] = ranker_score_by_row.reindex(target.index).to_numpy()
    if target["ranker_score"].isna().any():
        raise RuntimeError("target ranker score cache does not align with row cache")
    target_identities = pd.read_csv(
        Path(args.target_operation_identities).resolve()
    )
    top_identity = target_identities.sort_values(
        ["attempt_id", "enriched_operation_probability"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).set_index("attempt_id")

    forbidden = {
        "identity_key", "attempt_id", "file_id", "family", "product_correct",
        "product_strict_correct", "truth_year", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "year", "ranker_score",
    }
    development["fit_role"] = "development"
    target["fit_role"] = "target"
    combined = pd.concat([development, target], ignore_index=True)
    feature_columns = [
        column for column in combined.columns
        if column not in forbidden and column != "fit_role"
    ]
    values = pd.get_dummies(
        combined[feature_columns],
        columns=[
            column for column in feature_columns
            if combined[column].dtype == object
        ],
        dtype=float,
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    split = len(development)
    train = np.flatnonzero(development["operation_correct"].eq(1).to_numpy())
    global_model = TRAINER.classifier(
        development.loc[train, "window_correct"], 43000
    )
    global_model.fit(values.iloc[train], development.loc[train, "window_correct"])
    target["location_classifier_probability"] = global_model.predict_proba(
        values.iloc[split:]
    )[:, 1]
    typed_models = {}
    target["typed_location_classifier_probability"] = np.nan
    for event_index, event_type in enumerate(
        ("missingRing", "falseRing", "partialMove")
    ):
        typed_train = np.flatnonzero((
            development["operation_correct"].eq(1)
            & development["event_type"].eq(event_type)
        ).to_numpy())
        model = TRAINER.classifier(
            development.loc[typed_train, "window_correct"],
            43500 + event_index,
        )
        model.fit(
            values.iloc[typed_train], development.loc[typed_train, "window_correct"]
        )
        target_indices = np.flatnonzero(target["event_type"].eq(event_type).to_numpy())
        target.loc[target_indices, "typed_location_classifier_probability"] = (
            model.predict_proba(values.iloc[split + target_indices])[:, 1]
        )
        typed_models[event_type] = model
    if target["typed_location_classifier_probability"].isna().any():
        raise RuntimeError("missing target typed classifier predictions")
    groups = target.groupby("identity_key", sort=False)
    target["ranker_percentile"] = groups["ranker_score"].rank(pct=True)
    target["classifier_percentile"] = groups[
        "location_classifier_probability"
    ].rank(pct=True)
    target["typed_classifier_percentile"] = groups[
        "typed_location_classifier_probability"
    ].rank(pct=True)
    target["classifier_blend"] = (
        target["classifier_percentile"] * (1 - typed_weight)
        + target["typed_classifier_percentile"] * typed_weight
    )
    target["location_classifier_blend"] = (
        target["ranker_percentile"] * (1 - classifier_weight)
        + target["classifier_blend"] * classifier_weight
    )
    selected_identity = top_identity["identity_key"]
    selected_rows = target[
        target["identity_key"].eq(target["attempt_id"].map(selected_identity))
    ]
    top = selected_rows.sort_values(
        ["attempt_id", "location_classifier_blend"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    event = attempts[attempts["family"] != "Clean"].merge(
        top[[
            "attempt_id", "operation_correct", "strict_operation_correct",
            "window_correct", "strict_correct",
        ]],
        on="attempt_id",
        how="left",
    )
    failures = event[event["product_correct"].eq(0)]
    corrections = int(failures["window_correct"].sum())
    oracle_union = int((
        event["product_correct"].eq(1) | event["window_correct"].eq(1)
    ).sum())
    summary = {
        "schemaVersion": 1,
        "developmentRows": len(development),
        "targetRows": len(target),
        "features": len(values.columns),
        "frozenWeights": frozen,
        "events": len(event),
        "productCorrect": int(event["product_correct"].sum()),
        "operationTopCorrect": int(failures["operation_correct"].sum()),
        "completeCorrections": corrections,
        "strictCompleteCorrections": int(failures["strict_correct"].sum()),
        "oracleUnionCorrect": oracle_union,
        "oracleUnionAccuracy": oracle_union / max(1, len(event)),
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
    top.to_csv(output_dir / "target-location-classifier-top.csv", index=False)
    target[[
        "attempt_id", "file_id", "family", "identity_key", "event_type",
        "shift_years", "year", "window_correct", "strict_correct",
        "location_classifier_probability", "typed_location_classifier_probability",
        "ranker_score", "ranker_percentile", "classifier_percentile",
        "typed_classifier_percentile", "classifier_blend",
        "location_classifier_blend",
    ]].to_pickle(output_dir / "target-location-classifier-scores.pkl")
    (output_dir / "location-global-classifier.txt").write_text(
        global_model.booster_.model_to_string(), encoding="utf8"
    )
    for event_type, model in typed_models.items():
        (output_dir / f"location-{event_type}-classifier.txt").write_text(
            model.booster_.model_to_string(), encoding="utf8"
        )
    (output_dir / "feature-names.json").write_text(
        json.dumps(list(values.columns), indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
