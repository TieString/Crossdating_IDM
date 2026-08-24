#!/usr/bin/env python3
"""File-OOF absolute window classifier blended with the relative location ranker."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
ENRICHED = load_module(
    "location_classifier_enriched",
    ROOT / "train-enriched-hierarchical-adjudicator.py",
)


def classifier(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=600,
        learning_rate=0.02,
        num_leaves=31,
        min_child_samples=70,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=1.0,
        reg_lambda=4.0,
        scale_pos_weight=min(30.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--row-cache", required=True)
    parser.add_argument("--operation-identities", required=True)
    parser.add_argument("--ranker-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    cache = Path(args.row_cache).resolve()
    rows = pd.read_pickle(cache / "rows.pkl")
    attempts = pd.read_pickle(cache / "attempts.pkl")
    rows["identity_key"] = (
        rows["attempt_id"].astype(str)
        + "|" + rows["event_type"].astype(str)
        + "|" + rows["shift_years"].astype(int).astype(str)
    )
    ranker_scores = pd.read_pickle(Path(args.ranker_scores).resolve())
    ranker_score_by_row = ranker_scores["enriched_location_score"]
    rows["ranker_score"] = ranker_score_by_row.reindex(rows.index).to_numpy()
    if rows["ranker_score"].isna().any():
        raise RuntimeError("ranker score cache does not align with row cache")
    identities = pd.read_csv(Path(args.operation_identities).resolve())
    top_identity = identities.sort_values(
        ["attempt_id", "enriched_operation_probability"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).set_index("attempt_id")

    forbidden = {
        "identity_key", "attempt_id", "file_id", "family", "product_correct",
        "product_strict_correct", "truth_year", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "year", "ranker_score",
    }
    values, feature_names = ENRICHED.encoded_values(rows, forbidden)
    files = np.array(sorted(rows["file_id"].unique()))
    global_predictions = np.full(len(rows), np.nan)
    typed_predictions = np.full(len(rows), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        base_train_mask = (
            ~rows["file_id"].isin(held_files)
            & rows["operation_correct"].eq(1)
        )
        train = np.flatnonzero(base_train_mask.to_numpy())
        test = np.flatnonzero(rows["file_id"].isin(held_files).to_numpy())
        model = classifier(rows.loc[train, "window_correct"], 42000 + fold)
        model.fit(values.iloc[train], rows.loc[train, "window_correct"])
        global_predictions[test] = model.predict_proba(values.iloc[test])[:, 1]
        for event_index, event_type in enumerate(
            ("missingRing", "falseRing", "partialMove")
        ):
            typed_train = np.flatnonzero((
                base_train_mask & rows["event_type"].eq(event_type)
            ).to_numpy())
            typed_test = np.flatnonzero((
                rows["file_id"].isin(held_files)
                & rows["event_type"].eq(event_type)
            ).to_numpy())
            typed_model = classifier(
                rows.loc[typed_train, "window_correct"],
                42500 + fold * 10 + event_index,
            )
            typed_model.fit(
                values.iloc[typed_train], rows.loc[typed_train, "window_correct"]
            )
            typed_predictions[typed_test] = typed_model.predict_proba(
                values.iloc[typed_test]
            )[:, 1]
    if np.isnan(global_predictions).any() or np.isnan(typed_predictions).any():
        raise RuntimeError("missing enriched location classifier predictions")
    rows["location_classifier_probability"] = global_predictions
    rows["typed_location_classifier_probability"] = typed_predictions
    groups = rows.groupby("identity_key", sort=False)
    rows["ranker_percentile"] = groups["ranker_score"].rank(pct=True)
    rows["classifier_percentile"] = groups[
        "location_classifier_probability"
    ].rank(pct=True)
    rows["typed_classifier_percentile"] = groups[
        "typed_location_classifier_probability"
    ].rank(pct=True)

    selected_identity = top_identity["identity_key"]
    selected_rows = rows[
        rows["identity_key"].eq(rows["attempt_id"].map(selected_identity))
    ].copy()
    experiments = []
    selected_by_weights = {}
    for typed_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
        classifier_score = (
            selected_rows["classifier_percentile"] * (1 - typed_weight)
            + selected_rows["typed_classifier_percentile"] * typed_weight
        )
        for classifier_weight in (0.0, 0.25, 0.5, 0.75, 1.0):
            score = (
                selected_rows["ranker_percentile"] * (1 - classifier_weight)
                + classifier_score * classifier_weight
            )
            selected = selected_rows.assign(location_meta_score=score).sort_values(
                ["attempt_id", "location_meta_score"], ascending=[True, False]
            ).groupby("attempt_id", sort=False).head(1).copy()
            failures = selected[
                (selected["family"] != "Clean")
                & selected["product_correct"].eq(0)
            ]
            experiments.append({
                "typedClassifierWeight": typed_weight,
                "classifierWeight": classifier_weight,
                "completeCorrections": int(failures["window_correct"].sum()),
                "strictCorrections": int(failures["strict_correct"].sum()),
            })
            selected_by_weights[(typed_weight, classifier_weight)] = selected
    grid = pd.DataFrame(experiments)
    best = grid.sort_values(
        ["completeCorrections", "strictCorrections"], ascending=[False, False]
    ).iloc[0]
    weights = (
        float(best["typedClassifierWeight"]),
        float(best["classifierWeight"]),
    )
    top = selected_by_weights[weights]
    event = attempts[attempts["family"] != "Clean"].merge(
        top[["attempt_id", "window_correct", "strict_correct"]],
        on="attempt_id",
        how="left",
    )
    corrections = int(event.loc[
        event["product_correct"].eq(0), "window_correct"
    ].sum())
    oracle_union = int((
        event["product_correct"].eq(1) | event["window_correct"].eq(1)
    ).sum())
    summary = {
        "schemaVersion": 1,
        "files": int(event["file_id"].nunique()),
        "rows": len(rows),
        "features": len(feature_names),
        "frozenWeights": {
            "typedClassifier": weights[0],
            "classifier": weights[1],
        },
        "productCorrect": int(event["product_correct"].sum()),
        "completeCorrections": corrections,
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
    top.to_csv(output_dir / "location-classifier-top.csv", index=False)
    grid.to_csv(output_dir / "location-classifier-grid.csv", index=False)
    rows[[
        "attempt_id", "file_id", "family", "identity_key", "event_type",
        "shift_years", "year", "window_correct", "strict_correct",
        "location_classifier_probability", "typed_location_classifier_probability",
        "classifier_percentile", "typed_classifier_percentile",
    ]].to_pickle(output_dir / "location-classifier-scores.pkl")
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
