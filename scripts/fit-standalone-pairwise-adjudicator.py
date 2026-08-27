#!/usr/bin/env python3
"""Fit the frozen same-identity pairwise head and predict a target set."""

from __future__ import annotations

import argparse
import gc
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
PAIRWISE = load_module(
    "fit_standalone_pairwise_trainer",
    ROOT / "train-standalone-pairwise-adjudicator.py",
)
FIT = load_module(
    "fit_standalone_pairwise_encoder",
    ROOT / "fit-standalone-hierarchical-package.py",
)


def aggregate_pair_scores(
    frame_length: int,
    comparisons: pd.DataFrame,
    probabilities: np.ndarray,
) -> np.ndarray:
    scored = comparisons.copy()
    scored["left_win_probability"] = probabilities
    aggregate = scored.groupby("left_index", sort=False)[
        "left_win_probability"
    ].mean()
    scores = np.full(frame_length, 0.5, dtype=np.float32)
    scores[aggregate.index.to_numpy(dtype=int)] = aggregate.to_numpy(
        dtype=np.float32
    )
    return scores


def fit_location_pair_head(
    development: pd.DataFrame,
    target: pd.DataFrame,
    training_pairs: pd.DataFrame,
    output_dir: Path,
    anchor_count: int,
) -> tuple[pd.DataFrame, list[str], int]:
    columns = PAIRWISE.location_feature_columns(development)
    train_values, target_values, feature_names = FIT.encode_train_target(
        development, target, columns
    )
    pair_train_values = PAIRWISE.pair_values(
        train_values, training_pairs, include_year_delta=True
    )
    score_columns = [
        column for column in (
            "location_meta_percentile",
            "location_global_percentile",
            "location_typed_percentile",
            "location_global_classifier_percentile",
            "location_typed_classifier_percentile",
            "evidence_consensus_family_mean_percentile",
        )
        if column in target
    ]
    comparisons = PAIRWISE.comparison_pairs(
        target,
        group_column="identity_group",
        score_columns=score_columns,
        anchor_count=anchor_count,
    )
    pair_target_values = PAIRWISE.pair_values(
        target_values, comparisons, include_year_delta=True
    )
    predictions = np.full(len(comparisons), np.nan)
    for offset, event_type in enumerate(sorted(PAIRWISE.LOCAL_EVENT_TYPES)):
        train_indices = training_pairs.index[
            training_pairs["event_type"].eq(event_type)
        ].to_numpy(dtype=int)
        target_indices = comparisons.index[
            comparisons["event_type"].eq(event_type)
        ].to_numpy(dtype=int)
        labels = training_pairs.loc[train_indices, "left_better"]
        if labels.nunique() < 2:
            raise RuntimeError(f"pair head lacks both labels for {event_type}")
        model = PAIRWISE.pair_classifier(132000 + offset, location=True)
        model.fit(pair_train_values.loc[train_indices], labels)
        predictions[target_indices] = model.predict_proba(
            pair_target_values.loc[target_indices]
        )[:, 1]
        (output_dir / f"location-{event_type}-pair-classifier.txt").write_text(
            model.booster_.model_to_string(), encoding="utf8"
        )
    if np.isnan(predictions).any():
        raise RuntimeError("missing target pairwise predictions")
    target = target.copy()
    target["pairwise_score"] = aggregate_pair_scores(
        len(target), comparisons, predictions
    )
    target["pairwise_percentile"] = target.groupby(
        "identity_group", sort=False
    )["pairwise_score"].rank(pct=True)
    del train_values, target_values, pair_train_values, pair_target_values
    gc.collect()
    return target, feature_names, len(comparisons)


def select_target(
    operations: pd.DataFrame,
    locations: pd.DataFrame,
    baseline_weights: dict[str, float],
    pair_weights: dict[str, float],
) -> pd.DataFrame:
    operations = operations.copy()
    operations["base_score"] = PAIRWISE.base_operation_score(
        operations, baseline_weights
    )
    operation_weight = float(pair_weights["operationPair"])
    if operation_weight != 0:
        raise RuntimeError("frozen operation pair weight is no longer zero")
    operation_top = PAIRWISE.choose_top(
        operations, group_column="attempt_id", score=operations["base_score"]
    )
    locations = locations.copy()
    locations["base_score"] = PAIRWISE.base_location_score(
        locations, baseline_weights
    )
    location_weight = float(pair_weights["locationPair"])
    location_score = (
        locations["base_score"] * (1 - location_weight)
        + locations["pairwise_percentile"] * location_weight
    )
    location_top = PAIRWISE.choose_top(
        locations, group_column="identity_group", score=location_score
    ).set_index("identity_group")
    strict_identity = locations.groupby("identity_group", sort=False)[
        "strict_correct"
    ].max()
    selected = operation_top.copy()
    for output, source in (
        ("selected_candidate_source", "candidate_source"),
        ("selected_candidate_year", "candidate_year"),
        ("selected_package_correct", "workflow_correct"),
        ("selected_package_strict_correct", "strict_correct"),
    ):
        selected[output] = selected["identity_group"].map(location_top[source])
    local = selected["event_type"].isin(PAIRWISE.LOCAL_EVENT_TYPES)
    selected["final_correct"] = selected["operation_correct"].astype(int)
    selected.loc[local, "final_correct"] = selected.loc[
        local, "selected_package_correct"
    ].fillna(0).astype(int)
    selected["final_strict_correct"] = selected["identity_group"].map(
        strict_identity
    ).fillna(0).astype(int)
    selected.loc[local, "final_strict_correct"] = selected.loc[
        local, "selected_package_strict_correct"
    ].fillna(0).astype(int)
    selected["candidate_has_response"] = selected["event_type"].ne(
        "noEvent"
    ).astype(int)
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-location-scores", required=True)
    parser.add_argument("--development-training-pairs", required=True)
    parser.add_argument("--development-pairwise-dir", required=True)
    parser.add_argument("--target-operation-scores", required=True)
    parser.add_argument("--target-location-scores", required=True)
    parser.add_argument("--target-baseline-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development_pairwise_dir = Path(args.development_pairwise_dir).resolve()
    pair_summary = json.loads(
        (development_pairwise_dir / "summary.json").read_text(encoding="utf8")
    )
    baseline_dir = Path(args.target_baseline_dir).resolve()
    baseline_summary = json.loads(
        (baseline_dir / "summary.json").read_text(encoding="utf8")
    )
    operations = pd.read_pickle(Path(args.target_operation_scores).resolve())
    target_all = pd.read_pickle(Path(args.target_location_scores).resolve())
    target = target_all[
        target_all["event_type"].isin(PAIRWISE.LOCAL_EVENT_TYPES)
    ].copy().reset_index(drop=True)
    del target_all
    development_all = pd.read_pickle(
        Path(args.development_location_scores).resolve()
    )
    development = development_all[
        development_all["event_type"].isin(PAIRWISE.LOCAL_EVENT_TYPES)
    ].copy().reset_index(drop=True)
    del development_all
    development["base_score"] = PAIRWISE.base_location_score(
        development, baseline_summary["weights"]
    )
    target["base_score"] = PAIRWISE.base_location_score(
        target, baseline_summary["weights"]
    )
    training_pairs = pd.read_pickle(
        Path(args.development_training_pairs).resolve()
    )
    target, feature_names, comparison_count = fit_location_pair_head(
        development,
        target,
        training_pairs,
        output_dir,
        anchor_count=6,
    )
    del development, training_pairs
    gc.collect()
    selected = select_target(
        operations,
        target,
        baseline_summary["weights"],
        pair_summary["weights"],
    )
    event = selected[selected["family"].ne("Clean")].copy()
    clean = selected[selected["family"].eq("Clean")].copy()
    baseline = pd.read_csv(
        baseline_dir / "target-standalone-hierarchical-top.csv"
    ).set_index("attempt_id")
    compared = event.set_index("attempt_id")
    shared = baseline.index.intersection(compared.index)
    before = baseline.loc[shared, "final_correct"].astype(int)
    after = compared.loc[shared, "final_correct"].astype(int)
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictAccuracy": float(group["final_strict_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": PAIRWISE.clustered_lower(
                group, 133000 + ord(family[0]), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family", sort=True)
    }
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "standalone_pairwise_fit_predict",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "targetFiles": int(selected["cluster_id"].nunique()),
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "locationFeatures": len(feature_names),
        "locationTrainingPairs": int(pair_summary["locationTrainingPairs"]),
        "locationComparisonPairs": comparison_count,
        "weights": pair_summary["weights"],
        "workflowCorrect": int(event["final_correct"].sum()),
        "workflowAccuracy": float(event["final_correct"].mean()),
        "strictAccuracy": float(event["final_strict_correct"].mean()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "correctToWrong": int((before.eq(1) & after.eq(0)).sum()),
        "wrongToCorrect": int((before.eq(0) & after.eq(1)).sum()),
        "overallOneSided95FileClusterLower": PAIRWISE.clustered_lower(
            event, 133999, args.bootstrap_repetitions
        ),
        "byFamily": by_family,
    }
    target.to_pickle(output_dir / "target-location-pairwise-scores.pkl")
    selected.to_csv(output_dir / "target-standalone-pairwise-top.csv", index=False)
    event.to_csv(output_dir / "target-event-evaluation.csv", index=False)
    (output_dir / "location-feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
