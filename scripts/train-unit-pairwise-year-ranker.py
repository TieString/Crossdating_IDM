#!/usr/bin/env python3
"""Evaluate an exportable linear pairwise ranker on consumed unit-event audits."""

from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler


def load_rules_module():
    path = Path(__file__).with_name("analyze-unit-exact-year-rules.py")
    spec = importlib.util.spec_from_file_location("unit_pairwise_rules", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


RULES = load_rules_module()
_FEATURE_MATRIX_CACHE: dict[tuple[int, tuple[str, ...]], np.ndarray] = {}
_PAIRWISE_ROWS_CACHE: dict[
    tuple[tuple[int, ...], tuple[str, ...]],
    tuple[np.ndarray, np.ndarray, np.ndarray],
] = {}


@dataclass(frozen=True)
class FeatureSpec:
    profile_names: tuple[str, ...]
    shape_profile_names: tuple[str, ...]
    feature_names: tuple[str, ...]


@dataclass(frozen=True)
class LinearPairwiseModel:
    feature_spec: FeatureSpec
    scaler: StandardScaler
    classifier: LogisticRegression


def profile_groups(profile_names: Sequence[str], feature_set: str) -> tuple[str, ...]:
    exact = tuple(name for name in profile_names if name.startswith("exact:"))
    anchors = tuple(name for name in profile_names if name.startswith("anchor:"))
    if feature_set == "new":
        selected = tuple(name for name in exact if name.startswith("exact:false"))
    elif feature_set == "compact":
        selected = tuple(name for name in exact if (
            name.startswith("exact:false")
            or "MasterRFixed" in name
            or "MasterHuberFixed" in name
            or "PredictiveWeightedHuberFixed" in name
        ))
    else:
        selected = exact
    return tuple(sorted((*selected, *anchors)))


def make_feature_spec(cases: Sequence[Any], feature_set: str) -> FeatureSpec:
    common = set(cases[0].named_profiles)
    for case in cases[1:]:
        common.intersection_update(case.named_profiles)
    profiles = profile_groups(sorted(common), feature_set)
    shape_profiles = tuple(name for name in profiles if (
        name.startswith("exact:false")
        or "MasterRFixed" in name
        or "MasterHuberFixed" in name
    ))
    names = ["baselineRank", "windowPosition", "absoluteWindowPosition"]
    names.extend(f"rank:{name}" for name in profiles)
    for name in shape_profiles:
        names.extend((
            f"prominence:{name}",
            f"olderSlope:{name}",
            f"newerSlope:{name}",
        ))
    names.extend((
        "voteFraction:all",
        "voteFraction:false",
        "voteFraction:fixed",
        "voteFraction:reference",
    ))
    return FeatureSpec(profiles, shape_profiles, tuple(names))


def neighbor_value(values: np.ndarray, index: int, offset: int) -> float:
    neighbor = index + offset
    return float(values[neighbor]) if 0 <= neighbor < len(values) else float(values[index])


def feature_matrix(case: Any, spec: FeatureSpec) -> np.ndarray:
    cache_key = (id(case), spec.feature_names)
    cached = _FEATURE_MATRIX_CACHE.get(cache_key)
    if cached is not None:
        return cached
    ranked_profiles = {
        name: RULES.percentile_ranks(case.named_profiles[name])
        for name in spec.profile_names
    }
    baseline = RULES.percentile_ranks(case.baseline)
    columns: list[np.ndarray] = [baseline]
    if len(case.years) <= 1:
        position = np.zeros(len(case.years), dtype=float)
    else:
        position = np.linspace(-1.0, 1.0, len(case.years))
    columns.extend((position, np.abs(position)))
    columns.extend(ranked_profiles[name] for name in spec.profile_names)
    for name in spec.shape_profile_names:
        values = ranked_profiles[name]
        older = np.asarray([
            neighbor_value(values, index, -1) for index in range(len(values))
        ])
        newer = np.asarray([
            neighbor_value(values, index, 1) for index in range(len(values))
        ])
        columns.extend((
            values - np.maximum(older, newer),
            values - older,
            values - newer,
        ))

    vote_groups = (
        spec.profile_names,
        tuple(name for name in spec.profile_names if name.startswith("exact:false")),
        tuple(name for name in spec.profile_names if "FixedWindow" in name),
        tuple(name for name in spec.profile_names if "Reference" in name),
    )
    for group in vote_groups:
        votes = np.zeros(len(case.years), dtype=float)
        for name in group:
            values = ranked_profiles[name]
            votes[RULES.rank_order(case.years, values)[0]] += 1
        columns.append(votes / max(1, len(group)))
    matrix = np.column_stack(columns)
    if matrix.shape[1] != len(spec.feature_names):
        raise RuntimeError((matrix.shape, len(spec.feature_names)))
    _FEATURE_MATRIX_CACHE[cache_key] = matrix
    return matrix


def pairwise_training_rows(
    cases: Sequence[Any],
    spec: FeatureSpec,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    cache_key = (tuple(id(case) for case in cases), spec.feature_names)
    cached = _PAIRWISE_ROWS_CACHE.get(cache_key)
    if cached is not None:
        return cached
    rows: list[np.ndarray] = []
    labels: list[int] = []
    weights: list[float] = []
    for case in cases:
        matrix = feature_matrix(case, spec)
        truth_indices = np.where(case.years == case.truth_year)[0]
        if len(truth_indices) != 1:
            continue
        truth_index = int(truth_indices[0])
        negatives = [index for index in range(len(case.years)) if index != truth_index]
        if not negatives:
            continue
        pair_weight = 0.5 / len(negatives)
        for negative_index in negatives:
            difference = matrix[truth_index] - matrix[negative_index]
            rows.extend((difference, -difference))
            labels.extend((1, 0))
            weights.extend((pair_weight, pair_weight))
    result = np.asarray(rows), np.asarray(labels), np.asarray(weights)
    _PAIRWISE_ROWS_CACHE[cache_key] = result
    return result


def fit_model(cases: Sequence[Any], feature_set: str, regularization: float) -> LinearPairwiseModel:
    spec = make_feature_spec(cases, feature_set)
    rows, labels, weights = pairwise_training_rows(cases, spec)
    scaler = StandardScaler().fit(rows)
    classifier = LogisticRegression(
        C=regularization,
        fit_intercept=False,
        max_iter=4000,
        random_state=0,
        solver="lbfgs",
    ).fit(scaler.transform(rows), labels, sample_weight=weights)
    return LinearPairwiseModel(spec, scaler, classifier)


def model_scores(model: LinearPairwiseModel, case: Any) -> np.ndarray:
    matrix = feature_matrix(case, model.feature_spec)
    return model.classifier.decision_function(model.scaler.transform(matrix))


def blended_selector(model: LinearPairwiseModel, blend: float):
    def select(case):
        baseline = RULES.percentile_ranks(case.baseline)
        learned = RULES.percentile_ranks(model_scores(model, case))
        return baseline * (1 - blend) + learned * blend
    return select


def deltas(baseline: dict[str, Any], selected: dict[str, Any]) -> dict[str, Any]:
    return {
        "exact": selected["exactCount"] - baseline["exactCount"],
        "withinOne": selected["withinOneCount"] - baseline["withinOneCount"],
        "topThree": selected["topThreeCount"] - baseline["topThreeCount"],
        "mrr": selected["mrrAll"] - baseline["mrrAll"],
    }


def evaluate(
    model: LinearPairwiseModel,
    datasets: Sequence[Any],
    blend: float,
) -> dict[str, Any]:
    selector = blended_selector(model, blend)
    output: dict[str, Any] = {}
    for dataset in datasets:
        cases = dataset.cases["falseRing"]
        denominator = dataset.denominators["falseRing"]
        baseline = RULES.metrics(cases, denominator, lambda case: case.baseline)
        selected = RULES.metrics(cases, denominator, selector)
        mode_deltas = {}
        for mode in sorted({case.false_ring_mode for case in cases if case.false_ring_mode}):
            mode_cases = [case for case in cases if case.false_ring_mode == mode]
            mode_baseline = RULES.metrics(
                mode_cases, len(mode_cases), lambda case: case.baseline,
            )
            mode_selected = RULES.metrics(mode_cases, len(mode_cases), selector)
            mode_deltas[mode] = deltas(mode_baseline, mode_selected)
        output[dataset.name] = {
            "baseline": baseline,
            "selected": selected,
            "deltas": deltas(baseline, selected),
            "changes": RULES.change_counts(cases, selector),
            "modeDeltas": mode_deltas,
        }
    return output


def development_search(datasets: Sequence[Any]) -> list[dict[str, Any]]:
    rows = []
    blends = (0.25, 0.5, 0.75, 1.0)
    for feature_set, regularization in itertools.product(
        ("new", "compact", "all"),
        (0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1.0),
    ):
        folds_by_blend = {blend: {} for blend in blends}
        for held_out in datasets:
            train_cases = [
                case
                for dataset in datasets if dataset is not held_out
                for case in dataset.cases["falseRing"]
            ]
            model = fit_model(train_cases, feature_set, regularization)
            for blend in blends:
                result = evaluate(model, [held_out], blend)[held_out.name]
                folds_by_blend[blend][held_out.name] = {
                    "deltas": result["deltas"],
                    "changes": result["changes"],
                    "modeDeltas": result["modeDeltas"],
                }
        for blend, folds in folds_by_blend.items():
            exact = sum(row["deltas"]["exact"] for row in folds.values())
            within_one = sum(row["deltas"]["withinOne"] for row in folds.values())
            top_three = sum(row["deltas"]["topThree"] for row in folds.values())
            mrr = sum(row["deltas"]["mrr"] for row in folds.values())
            minimum_fold_exact = min(
                row["deltas"]["exact"] for row in folds.values()
            )
            minimum_mode_exact = min(
                mode["exact"]
                for row in folds.values()
                for mode in row["modeDeltas"].values()
            )
            rows.append({
                "featureSet": feature_set,
                "regularization": regularization,
                "blend": blend,
                "deltas": {
                    "exact": exact,
                    "withinOne": within_one,
                    "topThree": top_three,
                    "mrrSum": mrr,
                },
                "minimumFoldExactDelta": minimum_fold_exact,
                "minimumModeExactDelta": minimum_mode_exact,
                "folds": folds,
            })
    rows.sort(key=lambda row: (
        row["minimumFoldExactDelta"] >= 0,
        row["minimumModeExactDelta"] >= 0,
        row["deltas"]["exact"],
        row["deltas"]["withinOne"],
        row["deltas"]["topThree"],
        row["deltas"]["mrrSum"],
    ), reverse=True)
    return rows


def export_model(model: LinearPairwiseModel) -> dict[str, Any]:
    coefficients = model.classifier.coef_[0] / model.scaler.scale_
    ranked = sorted(
        zip(model.feature_spec.feature_names, coefficients),
        key=lambda row: abs(row[1]),
        reverse=True,
    )
    return {
        "featureCount": len(model.feature_spec.feature_names),
        "profileNames": model.feature_spec.profile_names,
        "shapeProfileNames": model.feature_spec.shape_profile_names,
        "coefficients": dict(zip(model.feature_spec.feature_names, coefficients)),
        "topAbsoluteCoefficients": ranked[:30],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audits", nargs="+")
    parser.add_argument("--validation", action="append", default=[])
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--output")
    args = parser.parse_args()
    development = [RULES.load_dataset(Path(path)) for path in args.audits]
    validation = [RULES.load_dataset(Path(path)) for path in args.validation]
    search = development_search(development)
    best = search[0]
    all_development_cases = [
        case for dataset in development for case in dataset.cases["falseRing"]
    ]
    model = fit_model(
        all_development_cases,
        best["featureSet"],
        best["regularization"],
    )
    payload = {
        "developmentDatasets": [dataset.name for dataset in development],
        "validationDatasets": [dataset.name for dataset in validation],
        "bestDevelopmentRules": search[:args.top],
        "selectedRule": best,
        "validation": evaluate(model, validation, best["blend"]),
        "model": export_model(model),
    }
    if args.output:
        Path(args.output).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(json.dumps({
            "selectedRule": payload["selectedRule"],
            "validation": payload["validation"],
            "model": {
                "featureCount": payload["model"]["featureCount"],
                "topAbsoluteCoefficients": payload["model"][
                    "topAbsoluteCoefficients"
                ],
            },
            "output": args.output,
        }, indent=2))
    else:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
