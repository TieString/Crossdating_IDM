"""Fit file-disjoint year rankers for unit missing- and false-ring windows.

The runtime remains TypeScript-only. This script reproduces the feature columns
from ``unitEventPointWindowSelector.ts``, selects model complexity without using
the validation audits, and exports LightGBM tree dumps that the JS evaluator can
consume directly.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


EVENT_TYPES = ("missingRing", "falseRing")
WINDOW_WIDTH = 13
HALF_WIDTH = WINDOW_WIDTH // 2
ANCHOR_FEATURES = (
    "relativeOlder",
    "relativeNewer",
    "currentSigned",
    "currentDistance",
    "operationSigned",
    "operationDistance",
    "sideSigned",
    "sideDistance",
)
COUNTERFACTUAL_PROFILES = {
    "missingRing": (
        "differencePredictiveWeightedHuber21",
        "differencePredictiveEnsembleHuber31",
        "differencePredictiveWeightedHuber61",
        "whitenedPredictiveEnsembleHuber21",
    ),
    "falseRing": (
        "differenceMasterHuber31",
        "whitenedMasterHuber31",
        "differenceReferenceWeightedHuber31",
        "differenceMasterHuber21",
    ),
}
FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES = (
    "differenceReferenceRankMean31",
    "differenceReferenceRankMedian31",
    "differenceReferencePeakKernel5",
    "differenceReferencePeakKernel9",
    "differenceReferenceTopVote3",
)
CORE_LOCATOR_PROFILES = (
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "transitionSplitGain",
    "piecewiseCombinedObjective",
    "pairDifferenceWeighted",
    "reference:weightedRankMean",
    "reference:weightedWindowVote25",
    "sideStepScore",
    "correctedSideSupport",
)
COMPACT_LOCATOR_PROFILES = (
    "cumulativeCombined",
    "differenceFull",
    "comboFull",
    "transitionSplitGain",
    "piecewiseCombinedObjective",
    "pairDifferenceWeighted",
    "reference:weightedRankMean",
)


@dataclass(frozen=True)
class PreparedCase:
    source: dict[str, Any]
    features: np.ndarray
    labels: np.ndarray
    years: np.ndarray
    group: str
    dataset: str


@dataclass(frozen=True)
class Configuration:
    feature_set: str
    num_leaves: int
    max_depth: int
    min_child_samples: int
    learning_rate: float
    n_estimators: int

    @property
    def name(self) -> str:
        return (
            f"{self.feature_set}:l{self.num_leaves}:d{self.max_depth}:"
            f"m{self.min_child_samples}:r{self.learning_rate}:n{self.n_estimators}"
        )


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def percentile_ranks(values: Sequence[float]) -> list[float]:
    if len(values) <= 1:
        return [0.5] * len(values)
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    result = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = (start + end - 1) / (2 * (len(order) - 1))
        for index in order[start:end]:
            result[index] = rank
        start = end
    return result


def moving_mean5(values: Sequence[float]) -> list[float]:
    result: list[float] = []
    for index in range(len(values)):
        start = max(0, index - 2)
        end = min(len(values), index + 3)
        result.append(mean(values[start:end]))
    return result


BOUNDARY_STATISTICS = (
    "olderDelta",
    "newerDelta",
    "step3",
    "curvature",
)


def boundary_columns(values: Sequence[float]) -> dict[str, list[float]]:
    result = {name: [] for name in BOUNDARY_STATISTICS}
    for index, value in enumerate(values):
        previous = values[max(0, index - 1)]
        following = values[min(len(values) - 1, index + 1)]
        older = values[max(0, index - 3):index]
        newer = values[index + 1:min(len(values), index + 4)]
        result["olderDelta"].append(value - previous)
        result["newerDelta"].append(following - value)
        result["step3"].append(mean(newer) - mean(older))
        result["curvature"].append(value - (previous + following) / 2)
    return result


def locator_feature_names(profiles: Sequence[str]) -> list[str]:
    return [
        name
        for profile in profiles
        for name in (f"loc:{profile}:value", f"loc:{profile}:mean5")
    ]


def counterfactual_feature_names(event_type: str) -> list[str]:
    return [
        name
        for profile in COUNTERFACTUAL_PROFILES[event_type]
        for name in (f"cf:{profile}:rank", f"cf:{profile}:mean5")
    ]


def boundary_feature_names(event_type: str) -> list[str]:
    bases = [
        *[
            ("cf", profile, "rank")
            for profile in COUNTERFACTUAL_PROFILES[event_type]
        ],
        *[
            ("loc", profile, "value")
            for profile in COMPACT_LOCATOR_PROFILES
        ],
    ]
    return [
        f"{family}:{profile}:{statistic}"
        for family, profile, _ in bases
        for statistic in BOUNDARY_STATISTICS
    ]


def feature_sets(event_type: str, current_bundle: dict[str, Any]) -> dict[str, list[str]]:
    current_names = current_bundle.get("eventTypes", {}).get(
        event_type, {}
    ).get("featureNames")
    common = counterfactual_feature_names(event_type)
    result = {
        "locator": [
            *locator_feature_names(COMPACT_LOCATOR_PROFILES),
            *ANCHOR_FEATURES,
        ],
        "compact": [
            *common,
            *locator_feature_names(COMPACT_LOCATOR_PROFILES),
            *ANCHOR_FEATURES,
        ],
        "core": [
            *common,
            *locator_feature_names(CORE_LOCATOR_PROFILES),
            *ANCHOR_FEATURES,
        ],
        "boundary": [
            *common,
            *locator_feature_names(COMPACT_LOCATOR_PROFILES),
            *boundary_feature_names(event_type),
            *ANCHOR_FEATURES,
        ],
    }
    if event_type == "falseRing":
        reference = [
            name
            for profile in FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES
            for name in (f"cf:{profile}:rank", f"cf:{profile}:mean5")
        ]
        reference_boundary = [
            f"cf:{profile}:{statistic}"
            for profile in FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES
            for statistic in BOUNDARY_STATISTICS
        ]
        result["referenceConsensus"] = [
            *common,
            *reference,
            *locator_feature_names(COMPACT_LOCATOR_PROFILES),
            *ANCHOR_FEATURES,
        ]
        result["referenceBoundary"] = [
            *common,
            *reference,
            *reference_boundary,
            *locator_feature_names(COMPACT_LOCATOR_PROFILES),
            *ANCHOR_FEATURES,
        ]
    if current_names:
        result["full"] = list(current_names)
    elif event_type == "falseRing":
        missing_names = current_bundle.get("eventTypes", {}).get(
            "missingRing", {}
        ).get("featureNames", [])
        locator_and_anchor = [
            name for name in missing_names if not name.startswith("cf:")
        ]
        result["full"] = [*common, *locator_and_anchor]
    return result


def feature_columns(
    source: dict[str, Any],
    feature_names: Sequence[str],
) -> tuple[np.ndarray, np.ndarray]:
    ordered_rows = sorted(
        source.get("unitCounterfactualRows", []),
        key=lambda row: int(row["year"]),
    )
    requires_counterfactual = any(
        name.startswith("cf:") for name in feature_names
    )
    if not ordered_rows and not requires_counterfactual:
        coarse = source["coarseWindow"]
        coarse_start = int(coarse["startYear"])
        coarse_end = int(coarse["endYear"])
        ordered_rows = [
            {"year": int(year), "profiles": {}}
            for year in source.get("years", [])
            if coarse_start <= int(year) <= coarse_end
        ]
    years = [int(row["year"]) for row in ordered_rows]
    if not years:
        return np.empty((0, len(feature_names))), np.empty(0, dtype=int)
    columns: dict[str, list[float]] = {}
    cf_profiles = sorted({
        name.split(":")[1]
        for name in feature_names
        if name.startswith("cf:")
    })
    for profile in cf_profiles:
        values = [float(row.get("profiles", {}).get(profile, -10)) for row in ordered_rows]
        ranks = percentile_ranks(values)
        columns[f"cf:{profile}:rank"] = ranks
        columns[f"cf:{profile}:mean5"] = moving_mean5(ranks)
        for statistic, values in boundary_columns(ranks).items():
            columns[f"cf:{profile}:{statistic}"] = values

    full_years = [int(year) for year in source.get("years", [])]
    year_indexes = {year: index for index, year in enumerate(full_years)}
    locator_profiles = sorted({
        name[4:name.rfind(":")]
        for name in feature_names
        if name.startswith("loc:")
    })
    ranks_by_profile = source.get("ranks", {})
    for profile in locator_profiles:
        source_values = ranks_by_profile.get(profile, [])
        values = []
        for year in years:
            index = year_indexes.get(year)
            value = source_values[index] if index is not None and index < len(source_values) else 0
            values.append(float(value) if math.isfinite(float(value)) else 0.0)
        columns[f"loc:{profile}:value"] = values
        columns[f"loc:{profile}:mean5"] = moving_mean5(values)
        for statistic, boundary_values in boundary_columns(values).items():
            columns[f"loc:{profile}:{statistic}"] = boundary_values

    coarse = source["coarseWindow"]
    coarse_start = int(coarse["startYear"])
    coarse_end = int(coarse["endYear"])
    span = max(1, coarse_end - coarse_start)
    operation = source.get("selectedOperation") or {}
    anchors = {
        "current": source.get("currentPrimaryYear"),
        "operation": operation.get("bestYear"),
        "side": operation.get("sideStepBestYear"),
    }
    columns["relativeOlder"] = [(year - coarse_start) / span for year in years]
    columns["relativeNewer"] = [(coarse_end - year) / span for year in years]
    for name, anchor in anchors.items():
        signed = f"{name}Signed"
        distance = f"{name}Distance"
        if anchor is None:
            columns[signed] = [0.0] * len(years)
            columns[distance] = [1.0] * len(years)
        else:
            anchor_year = float(anchor)
            columns[signed] = [(year - anchor_year) / span for year in years]
            columns[distance] = [abs(year - anchor_year) / span for year in years]

    unavailable = [name for name in feature_names if name not in columns]
    if unavailable:
        raise ValueError(f"Unavailable point features: {unavailable}")
    matrix = np.asarray([
        [np.float32(columns[name][index]) for name in feature_names]
        for index in range(len(years))
    ], dtype=np.float32)
    return matrix, np.asarray(years, dtype=int)


def load_cases(
    paths: Sequence[Path],
    dataset: str,
    event_type: str,
    feature_names: Sequence[str],
) -> list[PreparedCase]:
    result: list[PreparedCase] = []
    seen: set[tuple[str, str, int]] = set()
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("counterfactualLocatorCases", []):
            context = source.get("context", {})
            if context.get("baselineFlagged", True):
                continue
            if source.get("eventType") != event_type:
                continue
            if source.get("correctionYears") != source.get("truthCorrectionYears"):
                continue
            key = (
                str(context.get("file", "")),
                str(context.get("target", "")),
                int(source["truthYear"]),
            )
            if key in seen:
                continue
            seen.add(key)
            matrix, years = feature_columns(source, feature_names)
            if len(years) < WINDOW_WIDTH:
                continue
            truth = int(source["truthYear"])
            # Central labels retain exact-year information while all years that can
            # produce a covering 13-year window remain relevant.
            labels = np.asarray([
                max(0, HALF_WIDTH + 1 - abs(int(year) - truth))
                for year in years
            ], dtype=int)
            result.append(PreparedCase(
                source=source,
                features=matrix,
                labels=labels,
                years=years,
                group=str(context.get("file", key[0])),
                dataset=dataset,
            ))
    return result


def flatten(cases: Sequence[PreparedCase]) -> tuple[np.ndarray, np.ndarray, list[int]]:
    return (
        np.concatenate([case.features for case in cases]),
        np.concatenate([case.labels for case in cases]),
        [len(case.years) for case in cases],
    )


def make_ranker(configuration: Configuration, seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1, 3, 7, 15, 31, 63, 127],
        n_estimators=configuration.n_estimators,
        learning_rate=configuration.learning_rate,
        num_leaves=configuration.num_leaves,
        max_depth=configuration.max_depth,
        min_child_samples=configuration.min_child_samples,
        max_bin=63,
        feature_fraction=0.8,
        bagging_fraction=0.85,
        bagging_freq=1,
        reg_lambda=2.0,
        verbosity=-1,
        random_state=seed,
        n_jobs=-1,
    )


def fit_ranker(
    cases: Sequence[PreparedCase],
    configuration: Configuration,
    seed: int,
) -> lgb.LGBMRanker:
    x, y, groups = flatten(cases)
    model = make_ranker(configuration, seed)
    model.fit(x, y, group=groups)
    return model


def bounded_window(source: dict[str, Any], center_year: int) -> tuple[int, int]:
    years = [int(year) for year in source["years"]]
    first_year = years[0]
    last_year = years[-1]
    start = max(first_year, min(center_year - HALF_WIDTH, last_year - WINDOW_WIDTH + 1))
    return start, start + WINDOW_WIDTH - 1


def predict_window(
    case: PreparedCase,
    raw_scores: Sequence[float],
    temperature: float,
) -> tuple[int, int, int]:
    scores = np.asarray(raw_scores, dtype=float)
    peak_index = int(np.argmax(scores))
    peak_year = int(case.years[peak_index])
    shifted = np.clip((scores - float(np.max(scores))) / temperature, -30, 0)
    probabilities = np.exp(shifted)
    probabilities /= max(1e-12, float(np.sum(probabilities)))
    minimum = int(case.years[0])
    maximum = int(case.years[-1])
    rows = []
    for center in range(minimum, maximum + 1):
        mass = sum(
            float(probability)
            for year, probability in zip(case.years, probabilities)
            if abs(int(year) - center) <= HALF_WIDTH
        )
        rows.append((mass, -abs(center - peak_year), center))
    center = max(rows)[2]
    start, end = bounded_window(case.source, center)
    return start, end, center


def current_window(case: PreparedCase) -> tuple[int, int]:
    window = case.source["modeWindow"]
    return int(window["startYear"]), int(window["endYear"])


def summarize_predictions(
    cases: Sequence[PreparedCase],
    predictions: Sequence[tuple[int, int, int]],
) -> dict[str, Any]:
    hits = []
    current_hits = []
    center_errors = []
    by_dataset: dict[str, list[bool]] = {}
    for case, (start, end, center) in zip(cases, predictions):
        truth = int(case.source["truthYear"])
        hit = start <= truth <= end
        hits.append(hit)
        old_start, old_end = current_window(case)
        current_hits.append(old_start <= truth <= old_end)
        center_errors.append(abs(center - truth))
        by_dataset.setdefault(case.dataset, []).append(hit)
    return {
        "cases": len(cases),
        "hits": sum(hits),
        "coverage": mean(hits),
        "currentHits": sum(current_hits),
        "currentCoverage": mean(current_hits),
        "delta": sum(hits) - sum(current_hits),
        "medianCenterError": float(np.median(center_errors)) if center_errors else 0,
        "byDataset": {
            name: {
                "cases": len(values),
                "hits": sum(values),
                "coverage": mean(values),
            }
            for name, values in sorted(by_dataset.items())
        },
    }


def predict_cases(
    model: lgb.LGBMRanker,
    cases: Sequence[PreparedCase],
    temperature: float,
) -> list[tuple[int, int, int]]:
    return [
        predict_window(case, model.predict(case.features), temperature)
        for case in cases
    ]


def cross_validated_predictions(
    cases: Sequence[PreparedCase],
    configuration: Configuration,
    folds: int,
) -> tuple[list[tuple[int, int, int]], list[dict[str, Any]]]:
    groups = np.asarray([case.group for case in cases])
    splitter = GroupKFold(n_splits=min(folds, len(set(groups))))
    predictions: list[tuple[int, int, int] | None] = [None] * len(cases)
    fold_rows = []
    for fold, (train_indexes, test_indexes) in enumerate(
        splitter.split(np.arange(len(cases)), groups=groups)
    ):
        train = [cases[index] for index in train_indexes]
        test = [cases[index] for index in test_indexes]
        model = fit_ranker(train, configuration, 20260802 + fold)
        raw_by_case = [model.predict(case.features) for case in test]
        # OOF model selection uses a fixed neutral temperature. Temperature is
        # calibrated later on the file-disjoint calibration pool.
        selected = [
            predict_window(case, raw, 1.0)
            for case, raw in zip(test, raw_by_case)
        ]
        for index, prediction in zip(test_indexes, selected):
            predictions[int(index)] = prediction
        fold_rows.append({
            "fold": fold,
            **summarize_predictions(test, selected),
        })
    return [prediction for prediction in predictions if prediction is not None], fold_rows


def configurations(feature_set_names: Sequence[str]) -> list[Configuration]:
    rows = []
    for feature_set in feature_set_names:
        for leaves, depth in ((5, 3), (7, 3), (9, 4), (15, 4)):
            for minimum in (20, 40, 70):
                for estimators in (50, 100):
                    rows.append(Configuration(
                        feature_set=feature_set,
                        num_leaves=leaves,
                        max_depth=depth,
                        min_child_samples=minimum,
                        learning_rate=0.03,
                        n_estimators=estimators,
                    ))
    return rows


def parse_paths(value: str) -> list[Path]:
    return [Path(item.strip()) for item in value.split(",") if item.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", default="")
    parser.add_argument(
        "--bundle",
        default="src/features/crossdating/diagnosis/unitEventPointWindowModel.json",
    )
    parser.add_argument("--report", default=".tmp-file-grouped-unit-point-report.json")
    parser.add_argument("--model", default=".tmp-file-grouped-unit-point-model.json")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--event-types", default=",".join(EVENT_TYPES))
    parser.add_argument("--feature-sets", default="")
    args = parser.parse_args()

    train_paths = parse_paths(args.train)
    calibration_paths = parse_paths(args.calibration)
    validation_paths = parse_paths(args.validation)
    current_bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "splitPolicy": "file-disjoint train/calibration/validation; file-grouped OOF",
        "trainAudits": [str(path) for path in train_paths],
        "calibrationAudits": [str(path) for path in calibration_paths],
        "validationAudits": [str(path) for path in validation_paths],
        "eventTypes": {},
    }
    bundle = {"version": 2, "eventTypes": {}}

    selected_event_types = tuple(
        value.strip()
        for value in args.event_types.split(",")
        if value.strip() in EVENT_TYPES
    )
    selected_feature_sets = {
        value.strip()
        for value in args.feature_sets.split(",")
        if value.strip()
    }
    for event_type in selected_event_types:
        available_feature_sets = feature_sets(event_type, current_bundle)
        if selected_feature_sets:
            available_feature_sets = {
                name: names
                for name, names in available_feature_sets.items()
                if name in selected_feature_sets
            }
        prepared: dict[str, dict[str, list[PreparedCase]]] = {}
        for name, names in available_feature_sets.items():
            prepared[name] = {
                "train": load_cases(train_paths, "train", event_type, names),
                "calibration": load_cases(
                    calibration_paths, "calibration", event_type, names
                ),
                "validation": load_cases(
                    validation_paths, "validation", event_type, names
                ),
            }

        candidates = []
        for configuration in configurations(tuple(available_feature_sets)):
            datasets = prepared[configuration.feature_set]
            train = datasets["train"]
            oof_predictions, fold_rows = cross_validated_predictions(
                train, configuration, args.folds
            )
            oof = summarize_predictions(train, oof_predictions)
            model = fit_ranker(train, configuration, 20260802)
            calibration_raw = [
                model.predict(case.features) for case in datasets["calibration"]
            ]
            temperatures = []
            for temperature in (0.25, 0.5, 1.0, 2.0, 4.0):
                predictions = [
                    predict_window(case, raw, temperature)
                    for case, raw in zip(datasets["calibration"], calibration_raw)
                ]
                temperatures.append({
                    "temperature": temperature,
                    **summarize_predictions(datasets["calibration"], predictions),
                })
            temperatures.sort(
                key=lambda row: (
                    row["coverage"],
                    -row["medianCenterError"],
                    -abs(math.log2(row["temperature"])),
                ),
                reverse=True,
            )
            calibrated = temperatures[0]
            worst_fold = min(row["coverage"] for row in fold_rows)
            score = (
                min(worst_fold, calibrated["coverage"]),
                mean((oof["coverage"], calibrated["coverage"])),
                calibrated["coverage"],
                -calibrated["medianCenterError"],
            )
            candidates.append({
                "configuration": configuration,
                "model": model,
                "temperature": calibrated["temperature"],
                "oof": oof,
                "folds": fold_rows,
                "worstFoldCoverage": worst_fold,
                "calibration": calibrated,
                "temperatureSearch": temperatures,
                "selectionScore": score,
            })

        candidates.sort(key=lambda row: row["selectionScore"], reverse=True)
        selected = candidates[0]
        configuration = selected["configuration"]
        datasets = prepared[configuration.feature_set]
        final_training = [*datasets["train"], *datasets["calibration"]]
        final_model = fit_ranker(final_training, configuration, 20260803)
        validation = datasets["validation"]
        validation_metrics = summarize_predictions(
            validation,
            predict_cases(final_model, validation, selected["temperature"]),
        ) if validation else None
        feature_names = available_feature_sets[configuration.feature_set]
        event_report = {
            "selected": {
                "configuration": configuration.name,
                "featureCount": len(feature_names),
                "temperature": selected["temperature"],
                "oof": selected["oof"],
                "folds": selected["folds"],
                "worstFoldCoverage": selected["worstFoldCoverage"],
                "calibration": selected["calibration"],
                "validation": validation_metrics,
            },
            "runnerUp": [
                {
                    "configuration": row["configuration"].name,
                    "temperature": row["temperature"],
                    "worstFoldCoverage": row["worstFoldCoverage"],
                    "oof": row["oof"],
                    "calibration": row["calibration"],
                }
                for row in candidates[:12]
            ],
        }
        report["eventTypes"][event_type] = event_report
        bundle["eventTypes"][event_type] = {
            "featureNames": feature_names,
            "temperature": selected["temperature"],
            "windowWidth": WINDOW_WIDTH,
            "training": {
                "configuration": configuration.name,
                "trainCases": len(datasets["train"]),
                "calibrationCases": len(datasets["calibration"]),
                "validationCases": len(validation),
                "selection": "minimum of file-grouped OOF worst fold and calibration coverage",
            },
            "model": final_model.booster_.dump_model(),
        }
        print(json.dumps({event_type: event_report["selected"]}, ensure_ascii=False))

    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    Path(args.model).write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Wrote {args.report} and {args.model}")


if __name__ == "__main__":
    main()
