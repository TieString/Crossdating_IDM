#!/usr/bin/env python3
"""Evaluate a shallow ExtraTrees pairwise exact-year ranker on consumed audits."""

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
from sklearn.ensemble import ExtraTreesClassifier


def load_module(name: str, filename: str):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


PAIRWISE = load_module("unit_pairwise_linear", "train-unit-pairwise-year-ranker.py")
RULES = PAIRWISE.RULES


@dataclass(frozen=True)
class PairwiseTreeModel:
    feature_spec: Any
    classifier: ExtraTreesClassifier
    score_cache: dict[int, np.ndarray]


def fit_model(
    cases: Sequence[Any],
    feature_set: str,
    maximum_depth: int,
    minimum_leaf: int,
    maximum_features: float,
    tree_count: int = 128,
) -> PairwiseTreeModel:
    spec = PAIRWISE.make_feature_spec(cases, feature_set)
    rows, labels, weights = PAIRWISE.pairwise_training_rows(cases, spec)
    classifier = ExtraTreesClassifier(
        n_estimators=tree_count,
        criterion="log_loss",
        max_depth=maximum_depth,
        min_samples_leaf=minimum_leaf,
        max_features=maximum_features,
        bootstrap=False,
        n_jobs=-1,
        random_state=0,
    ).fit(rows, labels, sample_weight=weights)
    return PairwiseTreeModel(spec, classifier, {})


def pairwise_scores(model: PairwiseTreeModel, case: Any) -> np.ndarray:
    cache_key = id(case)
    cached = model.score_cache.get(cache_key)
    if cached is not None:
        return cached
    matrix = PAIRWISE.feature_matrix(case, model.feature_spec)
    pairs: list[np.ndarray] = []
    indices: list[tuple[int, int]] = []
    for left in range(len(matrix)):
        for right in range(left + 1, len(matrix)):
            difference = matrix[left] - matrix[right]
            pairs.extend((difference, -difference))
            indices.append((left, right))
    if not pairs:
        return np.zeros(len(matrix), dtype=float)
    probabilities = model.classifier.predict_proba(np.asarray(pairs))[:, 1]
    scores = np.zeros(len(matrix), dtype=float)
    cursor = 0
    for left, right in indices:
        preference = (probabilities[cursor] + 1 - probabilities[cursor + 1]) / 2
        scores[left] += preference
        scores[right] += 1 - preference
        cursor += 2
    result = scores / max(1, len(matrix) - 1)
    model.score_cache[cache_key] = result
    return result


def selector(model: PairwiseTreeModel, blend: float):
    def select(case):
        baseline = RULES.percentile_ranks(case.baseline)
        learned = RULES.percentile_ranks(pairwise_scores(model, case))
        return baseline * (1 - blend) + learned * blend
    return select


def evaluate(model: PairwiseTreeModel, datasets: Sequence[Any], blend: float):
    select = selector(model, blend)
    output = {}
    for dataset in datasets:
        cases = dataset.cases["falseRing"]
        denominator = dataset.denominators["falseRing"]
        baseline = RULES.metrics(cases, denominator, lambda case: case.baseline)
        selected = RULES.metrics(cases, denominator, select)
        mode_deltas = {}
        for mode in sorted({case.false_ring_mode for case in cases if case.false_ring_mode}):
            mode_cases = [case for case in cases if case.false_ring_mode == mode]
            mode_baseline = RULES.metrics(
                mode_cases, len(mode_cases), lambda case: case.baseline,
            )
            mode_selected = RULES.metrics(mode_cases, len(mode_cases), select)
            mode_deltas[mode] = PAIRWISE.deltas(mode_baseline, mode_selected)
        output[dataset.name] = {
            "baseline": baseline,
            "selected": selected,
            "deltas": PAIRWISE.deltas(baseline, selected),
            "changes": RULES.change_counts(cases, select),
            "modeDeltas": mode_deltas,
        }
    return output


def development_search(
    datasets: Sequence[Any],
    configurations: Sequence[tuple[str, int, int, float]],
    tree_count: int,
):
    rows = []
    blends = (0.25, 0.5, 0.75, 1.0)
    for feature_set, maximum_depth, minimum_leaf, maximum_features in configurations:
        folds_by_blend = {blend: {} for blend in blends}
        for held_out in datasets:
            train_cases = [
                case
                for dataset in datasets if dataset is not held_out
                for case in dataset.cases["falseRing"]
            ]
            model = fit_model(
                train_cases,
                feature_set,
                maximum_depth,
                minimum_leaf,
                maximum_features,
                tree_count,
            )
            for blend in blends:
                result = evaluate(model, [held_out], blend)[held_out.name]
                folds_by_blend[blend][held_out.name] = {
                    "deltas": result["deltas"],
                    "changes": result["changes"],
                    "modeDeltas": result["modeDeltas"],
                }
        for blend, folds in folds_by_blend.items():
            aggregate = {
                key: sum(row["deltas"][key] for row in folds.values())
                for key in ("exact", "withinOne", "topThree", "mrr")
            }
            rows.append({
                "featureSet": feature_set,
                "maximumDepth": maximum_depth,
                "minimumLeaf": minimum_leaf,
                "maximumFeatures": maximum_features,
                "blend": blend,
                "deltas": aggregate,
                "minimumFoldExactDelta": min(
                    row["deltas"]["exact"] for row in folds.values()
                ),
                "minimumModeExactDelta": min(
                    mode["exact"]
                    for row in folds.values()
                    for mode in row["modeDeltas"].values()
                ),
                "folds": folds,
            })
    rows.sort(key=lambda row: (
        row["minimumFoldExactDelta"] >= 0,
        row["minimumModeExactDelta"] >= 0,
        row["deltas"]["exact"],
        row["deltas"]["withinOne"],
        row["deltas"]["topThree"],
        row["deltas"]["mrr"],
    ), reverse=True)
    return rows


def configuration_key(row: dict[str, Any]) -> tuple[str, int, int, float]:
    return (
        row["featureSet"],
        row["maximumDepth"],
        row["minimumLeaf"],
        row["maximumFeatures"],
    )


def shortlist_configurations(
    rows: Sequence[dict[str, Any]],
    limit: int,
) -> list[tuple[str, int, int, float]]:
    output: list[tuple[str, int, int, float]] = []
    seen: set[tuple[str, int, int, float]] = set()
    for row in rows:
        key = configuration_key(row)
        if key in seen:
            continue
        seen.add(key)
        output.append(key)
        if len(output) >= limit:
            break
    return output


def export_summary(model: PairwiseTreeModel) -> dict[str, Any]:
    node_counts = [estimator.tree_.node_count for estimator in model.classifier.estimators_]
    importances = sorted(
        zip(model.feature_spec.feature_names, model.classifier.feature_importances_),
        key=lambda row: row[1],
        reverse=True,
    )
    return {
        "featureCount": len(model.feature_spec.feature_names),
        "treeCount": len(node_counts),
        "totalNodeCount": sum(node_counts),
        "maximumNodeCount": max(node_counts),
        "topFeatureImportances": importances[:30],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audits", nargs="+")
    parser.add_argument("--validation", action="append", default=[])
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--shortlist", type=int, default=6)
    parser.add_argument("--output")
    args = parser.parse_args()
    development = [RULES.load_dataset(Path(path)) for path in args.audits]
    validation = [RULES.load_dataset(Path(path)) for path in args.validation]
    coarse_configurations = tuple(itertools.product(
        ("new", "compact", "all"),
        (2, 3, 4),
        (10, 20),
        (0.5, 1.0),
    ))
    coarse_search = development_search(
        development,
        coarse_configurations,
        tree_count=32,
    )
    refined_configurations = shortlist_configurations(
        coarse_search,
        args.shortlist,
    )
    search = development_search(
        development,
        refined_configurations,
        tree_count=128,
    )
    best = search[0]
    train_cases = [
        case for dataset in development for case in dataset.cases["falseRing"]
    ]
    model = fit_model(
        train_cases,
        best["featureSet"],
        best["maximumDepth"],
        best["minimumLeaf"],
        best["maximumFeatures"],
        128,
    )
    payload = {
        "developmentDatasets": [dataset.name for dataset in development],
        "validationDatasets": [dataset.name for dataset in validation],
        "coarseSearch": coarse_search[:args.top],
        "refinedConfigurations": refined_configurations,
        "bestDevelopmentRules": search[:args.top],
        "selectedRule": best,
        "validation": evaluate(model, validation, best["blend"]),
        "model": export_summary(model),
    }
    if args.output:
        Path(args.output).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(json.dumps({
            "selectedRule": payload["selectedRule"],
            "validation": payload["validation"],
            "model": payload["model"],
            "output": args.output,
        }, indent=2))
    else:
        print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
