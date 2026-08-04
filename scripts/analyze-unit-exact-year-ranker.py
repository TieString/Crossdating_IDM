"""Evaluate exact-year rankers without changing the frozen event window.

The input audits must come from file-disjoint, already-consumed development cohorts.
Each candidate year is represented by its local profile shape, counterfactual correction
shape, existing production rank, and distances to independently computed anchors. Models
are evaluated with leave-one-audit-out ranking so a cohort is never used to fit its own
predictions.
"""

from __future__ import annotations

import argparse
import itertools
import json
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import lightgbm as lgb
import numpy as np


EVENT_TYPES = ("missingRing", "falseRing")
OFFSETS = (-2, -1, 0, 1, 2)

CORE_PROFILES = {
    "missingRing": (
        "cumulativeReferenceVote",
        "comboFull",
        "piecewiseCombinedObjective",
        "cumulativeDifference",
        "differenceFull",
        "rawFull",
        "whitenedFull",
        "transitionSplitGain",
        "cumulativeReferenceMean",
        "cumulativeReferenceMedian",
        "pairDifferenceWeighted",
        "pairWhitenedMean",
        "pairPeakKernel5",
    ),
    "falseRing": (
        "differenceFull",
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeReferenceVote",
        "cumulativeReferenceVoteCusum",
        "cumulativeReferenceMean",
        "cumulativeReferenceMedian",
        "piecewiseCombinedObjective",
        "transitionSplitGain",
        "rawFull",
        "whitenedFull",
        "pairDifferenceWeighted",
        "pairWhitenedMean",
        "pairPeakKernel5",
    ),
}


@dataclass(frozen=True)
class RankingCase:
    dataset: str
    event_type: str
    key: tuple[str, str, str]
    truth_year: int
    years: np.ndarray
    features: np.ndarray
    baseline_scores: np.ndarray


@dataclass(frozen=True)
class Dataset:
    name: str
    cases: dict[str, list[RankingCase]]
    formal_denominators: dict[str, int]


@dataclass(frozen=True)
class Configuration:
    feature_set: str
    label: str
    leaves: int
    depth: int
    minimum: int
    estimators: int
    blend: float

    @property
    def name(self) -> str:
        return (
            f"{self.feature_set}:{self.label}:l{self.leaves}:d{self.depth}:"
            f"m{self.minimum}:n{self.estimators}:b{self.blend:g}"
        )


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="stable")
    result = np.zeros(len(values), dtype=float)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = 0.5 if len(values) <= 1 else (start + end - 1) / (2 * (len(values) - 1))
        result[order[start:end]] = rank
        start = end
    return result


def finite(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if np.isfinite(result) else fallback


def case_key(context: dict[str, Any], event_type: str) -> tuple[str, str, str]:
    return (
        event_type,
        str(context.get("groupId", context.get("file", ""))),
        str(context.get("target", "")),
    )


def ranking_key(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row["eventType"]),
        str(row["groupId"]),
        str(row.get("seriesId", "")),
    )


def window_values(
    locator: dict[str, Any],
    profile_name: str,
    years: np.ndarray,
) -> np.ndarray:
    all_years = locator["years"]
    index = {int(year): offset for offset, year in enumerate(all_years)}
    profile = locator["ranks"].get(profile_name)
    if profile is None:
        return np.zeros(len(years), dtype=float)
    return np.asarray([
        finite(profile[index[int(year)]]) if int(year) in index else 0.0
        for year in years
    ], dtype=float)


def shifted(values: np.ndarray, offset: int) -> np.ndarray:
    if offset == 0:
        return values.copy()
    floor = float(np.min(values) - max(1.0, np.ptp(values)))
    result = np.full(len(values), floor, dtype=float)
    for index in range(len(values)):
        source = index + offset
        if 0 <= source < len(values):
            result[index] = values[source]
    return result


def local_shape(values: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    previous = shifted(values, -1)
    following = shifted(values, 1)
    return (
        values - previous,
        values - following,
        values - (previous + following) * 0.5,
    )


def counterfactual_profiles(locator: dict[str, Any]) -> dict[str, dict[int, float]]:
    result: dict[str, dict[int, float]] = {}
    for row in locator.get("unitCounterfactualRows") or []:
        year = int(row["year"])
        for name, value in row.get("profiles", {}).items():
            result.setdefault(name, {})[year] = finite(value)
    return result


def append_profile_features(
    columns: list[np.ndarray],
    names: list[str],
    prefix: str,
    values: np.ndarray,
) -> None:
    ranked = percentile_ranks(values)
    first_older, first_newer, curvature = local_shape(ranked)
    for name, column in (
        ("rank", ranked),
        ("olderAdvantage", first_older),
        ("newerAdvantage", first_newer),
        ("curvature", curvature),
    ):
        names.append(f"{prefix}:{name}")
        columns.append(column)


def build_features(
    locator: dict[str, Any],
    ranking: dict[str, Any],
    event_type: str,
    years: np.ndarray,
) -> tuple[list[str], np.ndarray]:
    columns: list[np.ndarray] = []
    names: list[str] = []
    width = max(1, len(years) - 1)
    center = (years[0] + years[-1]) * 0.5

    def add(name: str, values: Iterable[float]) -> None:
        names.append(name)
        columns.append(np.asarray(list(values), dtype=float))

    add("position", (years - center) / width)
    add("absolutePosition", np.abs(years - center) / width)
    add("edgeDistance", np.minimum(years - years[0], years[-1] - years) / width)
    add("windowWidth", np.full(len(years), len(years) / 13))

    baseline_by_year = {
        int(row["year"]): finite(row["score"])
        for row in ranking.get("rankedYears", [])
    }
    baseline = np.asarray([
        baseline_by_year.get(int(year), min(baseline_by_year.values(), default=0.0) - 1)
        for year in years
    ], dtype=float)
    append_profile_features(columns, names, "production", baseline)
    for offset in OFFSETS:
        add(f"production:offset{offset:+d}", shifted(percentile_ranks(baseline), offset))

    operation = locator.get("selectedOperation") or {}
    anchors = {
        "current": locator.get("currentPrimaryYear"),
        "operation": operation.get("bestYear"),
        "sideStep": operation.get("sideStepBestYear"),
    }
    for anchor_name, anchor in anchors.items():
        if anchor is None:
            add(f"anchor:{anchor_name}:available", np.zeros(len(years)))
            add(f"anchor:{anchor_name}:signed", np.zeros(len(years)))
            add(f"anchor:{anchor_name}:absolute", np.ones(len(years)))
            add(f"anchor:{anchor_name}:exact", np.zeros(len(years)))
            add(f"anchor:{anchor_name}:withinOne", np.zeros(len(years)))
            continue
        delta = years - int(anchor)
        add(f"anchor:{anchor_name}:available", np.ones(len(years)))
        add(f"anchor:{anchor_name}:signed", delta / width)
        add(f"anchor:{anchor_name}:absolute", np.abs(delta) / width)
        add(f"anchor:{anchor_name}:exact", delta == 0)
        add(f"anchor:{anchor_name}:withinOne", np.abs(delta) <= 1)

    context = locator.get("context") or {}
    repeated = {
        "context:signalStrength": finite(context.get("signalStrength")),
        "context:normalizedPosition": finite(context.get("normalizedPosition"), 0.5),
        "context:referenceCount": finite(context.get("referenceCount")) / 100,
        "context:referenceSupport": finite(context.get("referenceSupportAtYear")) / 100,
        "operation:differenceGain": finite(operation.get("bestDifferenceGain")),
        "operation:combinedGain": finite(operation.get("bestCombinedGain")),
        "operation:remoteMargin": finite(operation.get("remoteDifferenceMargin")),
        "operation:sideMargin": finite(operation.get("sideStepRemoteMargin")),
    }
    for name, value in repeated.items():
        add(name, np.full(len(years), value))

    for profile_name in sorted(locator.get("ranks", {})):
        values = window_values(locator, profile_name, years)
        append_profile_features(columns, names, f"profile:{profile_name}", values)

    for profile_name, by_year in sorted(counterfactual_profiles(locator).items()):
        available = [value for year, value in by_year.items() if int(years[0]) <= year <= int(years[-1])]
        fallback = min(available, default=0.0) - max(1.0, np.ptp(available) if available else 1.0)
        values = np.asarray([by_year.get(int(year), fallback) for year in years], dtype=float)
        append_profile_features(columns, names, f"counterfactual:{profile_name}", values)

    for profile_name, profile in sorted(
        (locator.get("unitExactYearProfiles") or {}).items()
    ):
        if not isinstance(profile, list) or len(profile) != len(years):
            continue
        append_profile_features(
            columns,
            names,
            f"exact:{profile_name}",
            np.asarray([finite(value) for value in profile], dtype=float),
        )

    local_correction = locator.get("unitLocalCorrectionRanks")
    if isinstance(local_correction, list) and len(local_correction) == len(years):
        append_profile_features(
            columns,
            names,
            "exact:localCorrection",
            np.asarray([finite(value) for value in local_correction], dtype=float),
        )

    return names, np.column_stack(columns)


def selected_feature_indices(
    names: Sequence[str],
    event_type: str,
    feature_set: str,
) -> np.ndarray:
    if feature_set == "all":
        return np.arange(len(names))
    common = [
        index for index, name in enumerate(names)
        if name.startswith(("production:", "anchor:", "context:", "operation:"))
        or name in {"position", "absolutePosition", "edgeDistance", "windowWidth"}
    ]
    counterfactual = [
        index for index, name in enumerate(names)
        if name.startswith("counterfactual:")
    ]
    exact = [
        index for index, name in enumerate(names)
        if name.startswith("exact:")
    ]
    core = [
        index for index, name in enumerate(names)
        if any(name.startswith(f"profile:{profile}:") for profile in CORE_PROFILES[event_type])
    ]
    if feature_set == "compact":
        return np.asarray(
            sorted(set([*common, *core, *counterfactual, *exact])),
            dtype=int,
        )
    if feature_set == "profiles":
        return np.asarray(sorted(set([*common, *core])), dtype=int)
    if feature_set == "counterfactual":
        return np.asarray(
            sorted(set([*common, *counterfactual, *exact])),
            dtype=int,
        )
    raise ValueError(f"Unknown feature set: {feature_set}")


def load_dataset(path: Path) -> tuple[Dataset, dict[str, list[str]]]:
    source = json.loads(path.read_text(encoding="utf-8"))
    name = path.stem
    rankings = {ranking_key(row): row for row in source.get("rankingCases", [])}
    formal_outcomes = source.get("formalEventCaseOutcomes", [])
    formal_keys = {
        case_key(row["context"], str(row["eventType"]))
        for row in formal_outcomes
        if row["eventType"] in EVENT_TYPES
    }
    denominators = {
        event_type: sum(row["eventType"] == event_type for row in formal_outcomes)
        for event_type in EVENT_TYPES
    }
    cases = {event_type: [] for event_type in EVENT_TYPES}
    feature_names: dict[str, list[str]] = {}
    for locator in source.get("counterfactualLocatorCases", []):
        event_type = str(locator.get("eventType"))
        if event_type not in EVENT_TYPES or not locator.get("finalWindow"):
            continue
        key = case_key(locator["context"], event_type)
        if key not in formal_keys:
            continue
        ranking = rankings.get(key)
        if ranking is None:
            continue
        start = int(locator["finalWindow"]["startYear"])
        end = int(locator["finalWindow"]["endYear"])
        truth = int(locator["truthYear"])
        if not start <= truth <= end:
            continue
        years = np.arange(start, end + 1, dtype=int)
        names, features = build_features(locator, ranking, event_type, years)
        if event_type not in feature_names:
            feature_names[event_type] = names
        elif names != feature_names[event_type]:
            raise RuntimeError(f"Feature schema differs in {path}: {key}")
        baseline_by_year = {
            int(row["year"]): finite(row["score"])
            for row in ranking.get("rankedYears", [])
        }
        cases[event_type].append(RankingCase(
            dataset=name,
            event_type=event_type,
            key=key,
            truth_year=truth,
            years=years,
            features=features,
            baseline_scores=np.asarray([
                baseline_by_year.get(int(year), -1e6) for year in years
            ], dtype=float),
        ))
    return Dataset(name, cases, denominators), feature_names


def labels(case: RankingCase, label_type: str) -> np.ndarray:
    distance = np.abs(case.years - case.truth_year)
    if label_type == "exact":
        return (distance == 0).astype(int)
    if label_type == "central":
        return np.select((distance == 0, distance == 1, distance == 2), (3, 2, 1), 0)
    raise ValueError(label_type)


def make_model(configuration: Configuration, seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1] if configuration.label == "exact" else [0, 1, 3, 7],
        n_estimators=configuration.estimators,
        learning_rate=0.035,
        num_leaves=configuration.leaves,
        max_depth=configuration.depth,
        min_child_samples=configuration.minimum,
        max_bin=31,
        reg_lambda=20,
        reg_alpha=4,
        colsample_bytree=0.7,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
    )


def fit_model(
    cases: Sequence[RankingCase],
    feature_indices: np.ndarray,
    configuration: Configuration,
    seed: int,
) -> lgb.LGBMRanker:
    model = make_model(configuration, seed)
    model.fit(
        np.concatenate([case.features[:, feature_indices] for case in cases]),
        np.concatenate([labels(case, configuration.label) for case in cases]),
        group=[len(case.years) for case in cases],
    )
    return model


def rank_order(years: np.ndarray, scores: np.ndarray) -> np.ndarray:
    return np.lexsort((-years, -scores))


def evaluate_predictions(
    predictions: Sequence[tuple[RankingCase, np.ndarray]],
    denominator: int,
) -> dict[str, float]:
    exact = within_one = top_three = reciprocal = 0.0
    ranks = []
    center_offsets = []
    for case, scores in predictions:
        order = rank_order(case.years, scores)
        selected = int(case.years[order[0]])
        truth_index = int(np.where(case.years[order] == case.truth_year)[0][0])
        rank = truth_index + 1
        exact += selected == case.truth_year
        within_one += abs(selected - case.truth_year) <= 1
        top_three += rank <= 3
        reciprocal += 1 / rank
        ranks.append(rank)
        center_offsets.append(selected - float(np.mean(case.years)))
    covered = len(predictions)
    return {
        "formalCases": denominator,
        "coveredCases": covered,
        "top1All": exact / max(1, denominator),
        "top1Covered": exact / max(1, covered),
        "top1WithinOneAll": within_one / max(1, denominator),
        "top3All": top_three / max(1, denominator),
        "medianTruthRankCovered": float(np.median(ranks)) if ranks else 0,
        "mrrAll": reciprocal / max(1, denominator),
        "meanTopYearCenterOffset": float(np.mean(center_offsets)) if center_offsets else 0,
    }


def configurations() -> Iterable[Configuration]:
    for feature_set, label, shape, blend in itertools.product(
        ("compact", "profiles", "counterfactual", "all"),
        ("exact", "central"),
        ((3, 2, 30, 30), (5, 3, 30, 50), (7, 3, 50, 60)),
        (0.5, 0.75, 1.0),
    ):
        yield Configuration(feature_set, label, *shape, blend)


def cross_validate(
    datasets: Sequence[Dataset],
    feature_names: Sequence[str],
    event_type: str,
    configuration: Configuration,
) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    feature_indices = selected_feature_indices(
        feature_names,
        event_type,
        configuration.feature_set,
    )
    predictions: list[tuple[RankingCase, np.ndarray]] = []
    by_dataset: dict[str, dict[str, float]] = {}
    total_denominator = 0
    for fold, held_out in enumerate(datasets):
        training = [
            case
            for dataset in datasets if dataset is not held_out
            for case in dataset.cases[event_type]
        ]
        testing = held_out.cases[event_type]
        model = fit_model(training, feature_indices, configuration, 1701 + fold)
        fold_predictions = []
        for case in testing:
            model_scores = np.asarray(model.predict(case.features[:, feature_indices]), dtype=float)
            model_ranks = percentile_ranks(model_scores)
            baseline_ranks = percentile_ranks(case.baseline_scores)
            scores = (
                model_ranks * configuration.blend
                + baseline_ranks * (1 - configuration.blend)
            )
            fold_predictions.append((case, scores))
        by_dataset[held_out.name] = evaluate_predictions(
            fold_predictions,
            held_out.formal_denominators[event_type],
        )
        predictions.extend(fold_predictions)
        total_denominator += held_out.formal_denominators[event_type]
    return evaluate_predictions(predictions, total_denominator), by_dataset


def baseline_metrics(datasets: Sequence[Dataset], event_type: str) -> dict[str, float]:
    return evaluate_predictions(
        [
            (case, case.baseline_scores)
            for dataset in datasets
            for case in dataset.cases[event_type]
        ],
        sum(dataset.formal_denominators[event_type] for dataset in datasets),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audits", nargs="+", type=Path)
    parser.add_argument("--top", type=int, default=8)
    parser.add_argument("--event-type", choices=EVENT_TYPES)
    args = parser.parse_args()
    if len(args.audits) < 3:
        raise SystemExit("At least three file-disjoint consumed audit cohorts are required")
    datasets = []
    feature_names: dict[str, list[str]] = {}
    for path in args.audits:
        dataset, names = load_dataset(path)
        for event_type in EVENT_TYPES:
            if event_type not in feature_names:
                feature_names[event_type] = names[event_type]
            elif names[event_type] != feature_names[event_type]:
                raise RuntimeError(
                    f"Feature schema differs between audits for {event_type} at {path}"
                )
        datasets.append(dataset)

    warnings.filterwarnings(
        "ignore",
        message="X does not have valid feature names",
        category=UserWarning,
    )
    output: dict[str, Any] = {"datasets": [dataset.name for dataset in datasets]}
    selected_event_types = (args.event_type,) if args.event_type else EVENT_TYPES
    for event_type in selected_event_types:
        baseline = baseline_metrics(datasets, event_type)
        rows = []
        for configuration in configurations():
            pooled, folds = cross_validate(
                datasets,
                feature_names[event_type],
                event_type,
                configuration,
            )
            rows.append({
                "configuration": configuration.name,
                "metrics": pooled,
                "folds": folds,
                "minimumFoldTop1All": min(
                    fold["top1All"] for fold in folds.values()
                ),
                "top1Gain": pooled["top1All"] - baseline["top1All"],
            })
        rows.sort(key=lambda row: (
            row["metrics"]["top1All"],
            row["minimumFoldTop1All"],
            row["metrics"]["mrrAll"],
        ), reverse=True)
        output[event_type] = {
            "baseline": baseline,
            "best": rows[: args.top],
        }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
