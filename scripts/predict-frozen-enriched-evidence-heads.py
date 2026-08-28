#!/usr/bin/env python3
"""Score enriched immutable evidence with frozen operation and location heads."""

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
ENRICHED = load_module(
    "frozen_enriched_identity_builder",
    ROOT / "train-enriched-hierarchical-adjudicator.py",
)
FROZEN = load_module(
    "frozen_enriched_helpers",
    ROOT / "frozen_model_inference.py",
)


LOCAL_EVENT_TYPES = ("missingRing", "falseRing", "partialMove")


def identity_key(frame: pd.DataFrame) -> pd.Series:
    return (
        frame["attempt_id"].astype(str)
        + "|" + frame["event_type"].astype(str)
        + "|" + frame["shift_years"].astype(int).astype(str)
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--row-cache", required=True)
    parser.add_argument("--ranker-model-dir", required=True)
    parser.add_argument("--classifier-model-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    cache_dir = Path(args.row_cache).resolve()
    ranker_dir = Path(args.ranker_model_dir).resolve()
    classifier_dir = Path(args.classifier_model_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    rows = pd.read_pickle(cache_dir / "rows.pkl")
    rows["identity_key"] = identity_key(rows)
    identities = ENRICHED.build_identity_table(rows)

    operation_forbidden = {
        "identity_key", "attempt_id", "file_id", "family",
        "operation_correct", "strict_operation_correct", "product_correct",
        "product_strict_correct",
    }
    operation_columns = [
        column for column in identities if column not in operation_forbidden
    ]
    operation_features = FROZEN.load_feature_names(
        ranker_dir / "operation-feature-names.json"
    )
    operation_values = FROZEN.encode_frame(
        identities,
        operation_columns,
        operation_features,
    )
    identities["enriched_operation_probability"] = np.mean(np.stack([
        FROZEN.predict(ranker_dir / f"operation-model-{index}.txt", operation_values)
        for index in range(3)
    ]), axis=0)
    identities["operation_classifier_percentile"] = identities.groupby(
        "attempt_id", sort=False
    )["enriched_operation_probability"].rank(pct=True)

    row_forbidden = {
        "identity_key", "attempt_id", "file_id", "family", "product_correct",
        "product_strict_correct", "truth_year", "operation_correct",
        "strict_operation_correct", "window_correct", "strict_correct",
        "top_exact", "year", "ranker_score",
    }
    row_columns = [column for column in rows if column not in row_forbidden]
    ranker_features = FROZEN.load_feature_names(
        ranker_dir / "location-feature-names.json"
    )
    classifier_features = FROZEN.load_feature_names(
        classifier_dir / "feature-names.json"
    )
    ranker_values = FROZEN.encode_frame(rows, row_columns, ranker_features)
    classifier_values = FROZEN.encode_frame(rows, row_columns, classifier_features)

    rows["enriched_location_score"] = FROZEN.predict(
        ranker_dir / "location-global-model.txt", ranker_values
    )
    rows["enriched_typed_location_score"] = np.nan
    rows["location_classifier_probability"] = FROZEN.predict(
        classifier_dir / "location-global-classifier.txt", classifier_values
    )
    rows["typed_location_classifier_probability"] = np.nan
    for event_type in LOCAL_EVENT_TYPES:
        indices = rows.index[rows["event_type"].eq(event_type)].to_numpy(dtype=int)
        rows.loc[indices, "enriched_typed_location_score"] = FROZEN.predict(
            ranker_dir / f"location-{event_type}-model.txt",
            ranker_values.loc[indices],
        )
        rows.loc[indices, "typed_location_classifier_probability"] = FROZEN.predict(
            classifier_dir / f"location-{event_type}-classifier.txt",
            classifier_values.loc[indices],
        )
    if rows[[
        "enriched_typed_location_score",
        "typed_location_classifier_probability",
    ]].isna().any().any():
        raise RuntimeError("frozen enriched head left unscored local rows")

    ranker_summary = json.loads(
        (ranker_dir / "summary.json").read_text(encoding="utf8")
    )
    classifier_summary = json.loads(
        (classifier_dir / "summary.json").read_text(encoding="utf8")
    )
    typed_ranker_weight = float(ranker_summary["frozenWeights"]["typedLocation"])
    typed_classifier_weight = float(
        classifier_summary["frozenWeights"]["typedClassifier"]
    )
    classifier_weight = float(classifier_summary["frozenWeights"]["classifier"])
    groups = rows.groupby("identity_key", sort=False)
    rows["location_global_percentile"] = groups[
        "enriched_location_score"
    ].rank(pct=True)
    rows["location_typed_percentile"] = groups[
        "enriched_typed_location_score"
    ].rank(pct=True)
    rows["location_blend_score"] = (
        rows["location_global_percentile"] * (1 - typed_ranker_weight)
        + rows["location_typed_percentile"] * typed_ranker_weight
    )
    rows["ranker_score"] = rows["enriched_location_score"]
    rows["ranker_percentile"] = groups["ranker_score"].rank(pct=True)
    rows["classifier_percentile"] = groups[
        "location_classifier_probability"
    ].rank(pct=True)
    rows["typed_classifier_percentile"] = groups[
        "typed_location_classifier_probability"
    ].rank(pct=True)
    rows["classifier_blend"] = (
        rows["classifier_percentile"] * (1 - typed_classifier_weight)
        + rows["typed_classifier_percentile"] * typed_classifier_weight
    )
    rows["location_classifier_blend"] = (
        rows["ranker_percentile"] * (1 - classifier_weight)
        + rows["classifier_blend"] * classifier_weight
    )

    identities.to_csv(output_dir / "target-enriched-operation-identities.csv", index=False)
    rows[[
        "attempt_id", "file_id", "family", "identity_key", "event_type",
        "shift_years", "operation_correct", "strict_operation_correct",
        "year", "window_correct", "strict_correct", "enriched_location_score",
        "enriched_typed_location_score", "location_global_percentile",
        "location_typed_percentile", "location_blend_score",
    ]].to_pickle(output_dir / "target-enriched-location-scores.pkl")
    rows[[
        "attempt_id", "file_id", "family", "identity_key", "event_type",
        "shift_years", "year", "window_correct", "strict_correct",
        "location_classifier_probability", "typed_location_classifier_probability",
        "ranker_score", "ranker_percentile", "classifier_percentile",
        "typed_classifier_percentile", "classifier_blend",
        "location_classifier_blend",
    ]].to_pickle(output_dir / "target-location-classifier-scores.pkl")
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "frozen_enriched_evidence_heads_predict_only",
        "trainingCalls": 0,
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "targetRows": len(rows),
        "targetIdentities": len(identities),
        "operationFeatures": len(operation_features),
        "rankerLocationFeatures": len(ranker_features),
        "classifierLocationFeatures": len(classifier_features),
        "rankerWeights": ranker_summary["frozenWeights"],
        "classifierWeights": classifier_summary["frozenWeights"],
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
