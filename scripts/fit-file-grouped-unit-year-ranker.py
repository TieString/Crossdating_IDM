"""Fit file-grouped exact-year rankers for missing-ring and false-ring windows."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


RANK_PROFILES = [
    "cumulativeCombined",
    "cumulativeCombinedCusum",
    "cumulativeCombinedContrast",
    "cumulativeDifference",
    "cumulativeDifferenceCusum",
    "cumulativeDifferenceContrast",
    "cumulativeRawCusum",
    "cumulativeRawContrast",
    "cumulativeWhitenedCusum",
    "cumulativeWhitenedContrast",
    "cumulativeCofechaCusum",
    "cumulativeCofechaContrast",
    "cumulativeLocal31",
    "cumulativeLocal61",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMedianCusum",
    "cumulativeReferenceMedianContrast",
    "cumulativeReferenceMean",
    "cumulativeReferenceMeanCusum",
    "cumulativeReferenceMeanContrast",
    "cumulativeReferenceVote",
    "cumulativeReferenceVoteCusum",
    "cumulativeReferenceVoteContrast",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "rawFull",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "jointOperationMargin",
    "sideStepScore",
    "sideMinimumAdvantage",
    "correctedSideSupport",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "pairPeakKernel5",
    "pairPeakKernel9",
    "reference:rankMean",
    "reference:rankMedian",
    "reference:weightedRankMean",
    "reference:peakKernel5",
    "reference:peakKernel9",
    "reference:peakKernel13",
    "reference:windowVote25",
    "reference:weightedWindowVote25",
]

SHAPE_PROFILES = [
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeWhitenedCusum",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "rawFull",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "pairPeakKernel5",
    "pairPeakKernel9",
    "reference:rankMedian",
    "reference:weightedRankMean",
    "reference:peakKernel5",
    "reference:peakKernel9",
]

COUNTERFACTUAL_PROFILES = {
    "missingRing": [
        "differencePredictiveWeightedHuber21",
        "differencePredictiveEnsembleHuber31",
        "differencePredictiveWeightedHuber61",
        "whitenedPredictiveEnsembleHuber21",
    ],
    "falseRing": [
        "differenceMasterHuber31",
        "whitenedMasterHuber31",
        "differenceReferenceWeightedHuber31",
        "differenceMasterHuber21",
    ],
}


@dataclass
class RankCase:
    key: str
    file: str
    target: str
    event_type: str
    truth_year: int
    years: list[int]
    features: np.ndarray
    baseline_scores: np.ndarray
    final_scores: np.ndarray


def percentile_ranks(values: Iterable[float]) -> np.ndarray:
    array = np.asarray(list(values), dtype=np.float64)
    order = np.argsort(array, kind="mergesort")
    ranks = np.empty(len(array), dtype=np.float64)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and array[order[end]] == array[order[start]]:
            end += 1
        rank = 0.5 if len(order) <= 1 else ((start + end - 1) / 2) / (len(order) - 1)
        ranks[order[start:end]] = rank
        start = end
    return ranks


def median(values: list[float]) -> float:
    return float(np.median(values)) if values else 0.0


def normalize_file(value: str) -> str:
    return value.replace("\\", "/").lower()


def case_key(file: str, target: str, event_type: str, truth_year: int) -> str:
    return "\0".join([normalize_file(file), target, event_type, str(truth_year)])


def feature_names_for(event_type: str) -> list[str]:
    names = ["baselineScore"]
    names.extend(f"rank:{name}" for name in RANK_PROFILES)
    for name in SHAPE_PROFILES:
        names.extend([
            f"leftDelta:{name}",
            f"rightDelta:{name}",
            f"slope:{name}",
            f"curvature:{name}",
        ])
    for name in COUNTERFACTUAL_PROFILES[event_type]:
        names.extend([
            f"cf:{name}",
            f"cfLeftDelta:{name}",
            f"cfRightDelta:{name}",
            f"cfCurvature:{name}",
        ])
    names.extend([
        "rankMean",
        "rankMedian",
        "rankStd",
        "rankTop90Share",
        "rankLocalMaximumShare",
        "cfMean",
        "cfMedian",
        "cfStd",
        "cfTop90Share",
    ])
    for anchor in ["current", "operation", "sideStep"]:
        names.extend([
            f"anchorExact:{anchor}",
            f"anchorNear1:{anchor}",
            f"anchorNear3:{anchor}",
            f"anchorSignedDistance:{anchor}",
        ])
    names.extend([
        "windowSignedPosition",
        "windowAbsolutePosition",
        "coarseSignedDistance",
        "modeSignedDistance",
        "windowWidth",
        "coarseWidth",
        "referenceCount",
        "signalStrength",
        "learnedWindowMargin",
        "learnedWindowRemoteMargin",
        "nineYearSafety",
    ])
    return names


def read_cases(path: Path) -> list[RankCase]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    audits: dict[str, list[dict[str, Any]]] = {}
    for audit in payload.get("counterfactualLocatorCases", []):
        context = audit.get("context", {})
        key = case_key(
            context.get("file", context.get("groupId", "")),
            context.get("target", ""),
            audit.get("eventType", ""),
            int(audit.get("truthYear", 0)),
        )
        audits.setdefault(key, []).append(audit)

    cases: list[RankCase] = []
    for ranking in payload.get("rankingCases", []):
        event_type = ranking.get("eventType")
        if event_type not in ("missingRing", "falseRing"):
            continue
        truth_year = int(ranking["truthYear"])
        start_year, end_year = map(int, ranking["range"])
        if not start_year <= truth_year <= end_year:
            continue
        key = case_key(
            ranking["groupId"],
            ranking["seriesId"],
            event_type,
            truth_year,
        )
        matching = [
            row for row in audits.get(key, [])
            if int(row["finalWindow"]["startYear"]) == start_year
            and int(row["finalWindow"]["endYear"]) == end_year
        ]
        if not matching:
            continue
        audit = matching[-1]
        context = audit.get("context", {})
        if context.get("baselineFlagged") is not False:
            continue
        all_years = [int(year) for year in audit["years"]]
        all_index = {year: index for index, year in enumerate(all_years)}
        years = list(range(start_year, end_year + 1))
        if any(year not in all_index for year in years):
            continue

        rank_values: dict[str, np.ndarray] = {}
        for name in RANK_PROFILES:
            source = audit.get("ranks", {}).get(name, [])
            rank_values[name] = np.asarray([
                float(source[all_index[year]]) if all_index[year] < len(source) else 0.0
                for year in years
            ])

        counterfactual_by_year = {
            int(row["year"]): row.get("profiles", {})
            for row in audit.get("unitCounterfactualRows", [])
        }
        counterfactual_values: dict[str, np.ndarray] = {}
        for name in COUNTERFACTUAL_PROFILES[event_type]:
            raw = [
                float(counterfactual_by_year.get(year, {}).get(name, -10.0))
                for year in years
            ]
            counterfactual_values[name] = percentile_ranks(raw)

        anchors = {
            "current": audit.get("currentPrimaryYear"),
            "operation": audit.get("selectedOperation", {}).get("bestYear"),
            "sideStep": audit.get("selectedOperation", {}).get("sideStepBestYear"),
        }
        available_anchors = sorted(
            int(value) for value in anchors.values() if value is not None
        )
        anchor_median = median(available_anchors) if available_anchors else None
        baseline_scores = np.zeros(len(years), dtype=np.float64)
        if event_type == "missingRing":
            baseline_scores = (
                rank_values["cumulativeReferenceVote"]
                + rank_values["comboFull"]
                + rank_values["piecewiseCombinedObjective"]
            ) / 3
            if anchor_median is not None:
                scale = max(1, len(years) - 1)
                baseline_scores += np.asarray([
                    -abs(year - anchor_median) / scale * 0.02 for year in years
                ])
        else:
            baseline_scores = rank_values["differenceFull"].copy()

        final_score_by_year = {
            int(row["year"]): float(row.get("score", 0.0))
            for row in ranking.get("rankedYears", [])
        }
        final_scores = np.asarray([
            final_score_by_year.get(year, 0.0) for year in years
        ])
        center = (start_year + end_year) / 2
        radius = max(1.0, (end_year - start_year) / 2)
        coarse = audit.get("coarseWindow", {})
        coarse_center = (
            float(coarse.get("startYear", center))
            + float(coarse.get("endYear", center))
        ) / 2
        coarse_width = max(
            1.0,
            float(coarse.get("endYear", end_year))
            - float(coarse.get("startYear", start_year))
            + 1,
        )
        mode = audit.get("modeWindow") or {}
        mode_center = (
            float(mode.get("startYear", center))
            + float(mode.get("endYear", center))
        ) / 2
        feature_rows: list[list[float]] = []
        for index, year in enumerate(years):
            values: list[float] = [float(baseline_scores[index])]
            profile_values = [float(rank_values[name][index]) for name in RANK_PROFILES]
            values.extend(profile_values)
            for name in SHAPE_PROFILES:
                profile = rank_values[name]
                value = float(profile[index])
                left = float(profile[max(0, index - 1)])
                right = float(profile[min(len(years) - 1, index + 1)])
                values.extend([
                    value - left,
                    value - right,
                    (right - left) / 2,
                    value * 2 - left - right,
                ])
            cf_values: list[float] = []
            for name in COUNTERFACTUAL_PROFILES[event_type]:
                profile = counterfactual_values[name]
                value = float(profile[index])
                left = float(profile[max(0, index - 1)])
                right = float(profile[min(len(years) - 1, index + 1)])
                cf_values.append(value)
                values.extend([
                    value,
                    value - left,
                    value - right,
                    value * 2 - left - right,
                ])
            local_maximum_share = np.mean([
                rank_values[name][index]
                >= rank_values[name][max(0, index - 1)]
                and rank_values[name][index]
                >= rank_values[name][min(len(years) - 1, index + 1)]
                for name in SHAPE_PROFILES
            ])
            values.extend([
                float(np.mean(profile_values)),
                float(np.median(profile_values)),
                float(np.std(profile_values)),
                float(np.mean(np.asarray(profile_values) >= 0.9)),
                float(local_maximum_share),
                float(np.mean(cf_values)),
                float(np.median(cf_values)),
                float(np.std(cf_values)),
                float(np.mean(np.asarray(cf_values) >= 0.9)),
            ])
            for name in ["current", "operation", "sideStep"]:
                anchor = anchors[name]
                if anchor is None:
                    values.extend([0.0, 0.0, 0.0, 0.0])
                else:
                    distance = year - int(anchor)
                    values.extend([
                        float(distance == 0),
                        math.exp(-abs(distance)),
                        math.exp(-abs(distance) / 3),
                        math.tanh(distance / 4),
                    ])
            values.extend([
                (year - center) / radius,
                abs(year - center) / radius,
                (year - coarse_center) / max(1.0, coarse_width / 2),
                (year - mode_center) / radius,
                len(years) / 13,
                coarse_width / 45,
                float(context.get("referenceCount", 0)) / 20,
                float(context.get("signalStrength", 0)),
                float(audit.get("learnedWindowMargin", 0) or 0),
                float(audit.get("learnedWindowRemoteMargin", 0) or 0),
                float(audit.get("nineYearSafety", 0) or 0),
            ])
            feature_rows.append(values)
        expected = feature_names_for(event_type)
        if any(len(row) != len(expected) for row in feature_rows):
            raise RuntimeError(f"feature mismatch in {key}")
        cases.append(RankCase(
            key=key,
            file=normalize_file(context.get("file", ranking["groupId"])),
            target=ranking["seriesId"],
            event_type=event_type,
            truth_year=truth_year,
            years=years,
            features=np.asarray(feature_rows, dtype=np.float32),
            baseline_scores=baseline_scores.astype(np.float32),
            final_scores=final_scores.astype(np.float32),
        ))
    return cases


def deduplicate(cases: Iterable[RankCase]) -> list[RankCase]:
    result: dict[str, RankCase] = {}
    for case in cases:
        result[case.key] = case
    return list(result.values())


def flatten(cases: list[RankCase]) -> tuple[np.ndarray, np.ndarray, list[int]]:
    features = np.vstack([case.features for case in cases])
    labels = np.concatenate([
        np.asarray([
            3 if year == case.truth_year else 1 if abs(year - case.truth_year) == 1 else 0
            for year in case.years
        ], dtype=np.int32)
        for case in cases
    ])
    return features, labels, [len(case.years) for case in cases]


def fit_model(cases: list[RankCase], config: dict[str, Any], seed: int) -> lgb.LGBMRanker:
    features, labels, groups = flatten(cases)
    model = lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        importance_type="gain",
        verbosity=-1,
        random_state=seed,
        n_jobs=-1,
        **config,
    )
    model.fit(features, labels, group=groups)
    return model


def model_predictions(cases: list[RankCase], model: lgb.LGBMRanker) -> dict[str, np.ndarray]:
    return {
        case.key: np.asarray(model.predict(case.features), dtype=np.float64)
        for case in cases
    }


def top_order(scores: np.ndarray, years: list[int]) -> np.ndarray:
    return np.lexsort((-np.asarray(years), -scores))


def summarize(
    cases: list[RankCase],
    score_for: Callable[[RankCase], np.ndarray],
) -> dict[str, Any]:
    exact = within_one = top_three = 0
    reciprocal_rank = bias = absolute_error = 0.0
    ranks: list[int] = []
    for case in cases:
        order = top_order(score_for(case), case.years)
        ranked_years = [case.years[index] for index in order]
        top_year = ranked_years[0]
        truth_rank = ranked_years.index(case.truth_year) + 1
        error = top_year - case.truth_year
        exact += int(error == 0)
        within_one += int(abs(error) <= 1)
        top_three += int(truth_rank <= 3)
        reciprocal_rank += 1 / truth_rank
        bias += error
        absolute_error += abs(error)
        ranks.append(truth_rank)
    count = max(1, len(cases))
    return {
        "cases": len(cases),
        "top1": exact / count,
        "withinOne": within_one / count,
        "top3": top_three / count,
        "medianRank": float(np.median(ranks)) if ranks else 0,
        "mrr": reciprocal_rank / count,
        "bias": bias / count,
        "meanAbsoluteError": absolute_error / count,
    }


def hybrid_scores(
    case: RankCase,
    model_scores: np.ndarray,
    gate: dict[str, Any],
) -> np.ndarray:
    baseline_ranks = percentile_ranks(case.baseline_scores)
    model_ranks = percentile_ranks(model_scores)
    model_order = top_order(model_scores, case.years)
    baseline_order = top_order(case.baseline_scores, case.years)
    model_top = int(model_order[0])
    baseline_top = int(baseline_order[0])
    model_margin = float(
        model_scores[model_top]
        - model_scores[int(model_order[1] if len(model_order) > 1 else model_top)]
    )
    use_model = (
        model_margin >= gate["minimumModelMargin"]
        and abs(case.years[model_top] - case.years[baseline_top])
        <= gate["maximumTopDistance"]
    )
    if not use_model:
        return baseline_ranks
    return baseline_ranks * (1 - gate["blend"]) + model_ranks * gate["blend"]


def score_gate(
    cases: list[RankCase],
    predictions: dict[str, np.ndarray],
    gate: dict[str, Any],
) -> dict[str, Any]:
    return summarize(cases, lambda case: hybrid_scores(
        case,
        predictions[case.key],
        gate,
    ))


def metric_sort_key(metrics: dict[str, Any]) -> tuple[float, ...]:
    return (
        metrics["top1"],
        metrics["withinOne"],
        metrics["top3"],
        metrics["mrr"],
        -abs(metrics["bias"]),
        -metrics["meanAbsoluteError"],
    )


def candidate_configs() -> list[dict[str, Any]]:
    return [
        dict(n_estimators=40, learning_rate=0.03, num_leaves=3, max_depth=2,
             min_child_samples=50, reg_lambda=20, reg_alpha=2,
             colsample_bytree=0.65, subsample=0.85),
        dict(n_estimators=70, learning_rate=0.025, num_leaves=3, max_depth=2,
             min_child_samples=70, reg_lambda=30, reg_alpha=3,
             colsample_bytree=0.65, subsample=0.85),
        dict(n_estimators=50, learning_rate=0.025, num_leaves=5, max_depth=3,
             min_child_samples=60, reg_lambda=30, reg_alpha=3,
             colsample_bytree=0.6, subsample=0.85),
        dict(n_estimators=80, learning_rate=0.02, num_leaves=5, max_depth=3,
             min_child_samples=80, reg_lambda=40, reg_alpha=5,
             colsample_bytree=0.55, subsample=0.85),
        dict(n_estimators=50, learning_rate=0.025, num_leaves=7, max_depth=3,
             min_child_samples=80, reg_lambda=50, reg_alpha=5,
             colsample_bytree=0.55, subsample=0.8),
    ]


def cross_validated_predictions(
    cases: list[RankCase],
    config: dict[str, Any],
) -> dict[str, np.ndarray]:
    files = np.asarray([case.file for case in cases])
    folds = min(5, len(set(files)))
    splitter = GroupKFold(n_splits=folds)
    predictions: dict[str, np.ndarray] = {}
    indices = np.arange(len(cases))
    for fold, (train_indices, test_indices) in enumerate(
        splitter.split(indices, groups=files)
    ):
        training = [cases[index] for index in train_indices]
        model = fit_model(training, config, 20260802 + fold)
        for index in test_indices:
            case = cases[index]
            predictions[case.key] = np.asarray(
                model.predict(case.features), dtype=np.float64
            )
    return predictions


def simplify_tree(node: dict[str, Any]) -> dict[str, Any]:
    if "leaf_value" in node:
        return {"value": float(node["leaf_value"])}
    return {
        "feature": int(node["split_feature"]),
        "threshold": float(node["threshold"]),
        "defaultLeft": bool(node.get("default_left", True)),
        "left": simplify_tree(node["left_child"]),
        "right": simplify_tree(node["right_child"]),
    }


def export_model(
    model: lgb.LGBMRanker,
    event_type: str,
    gate: dict[str, Any],
    config: dict[str, Any],
    train_paths: list[str],
    calibration_paths: list[str],
) -> dict[str, Any]:
    dumped = model.booster_.dump_model()
    return {
        "schemaVersion": 1,
        "eventType": event_type,
        "featureNames": feature_names_for(event_type),
        "gate": gate,
        "trainingConfig": config,
        "trainingPaths": train_paths,
        "calibrationPaths": calibration_paths,
        "trees": [
            simplify_tree(tree["tree_structure"])
            for tree in dumped["tree_info"]
        ],
    }


def parse_paths(value: str) -> list[Path]:
    return [Path(part.strip()) for part in value.split(",") if part.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", default="")
    parser.add_argument("--report", required=True)
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()

    train_paths = parse_paths(args.train)
    calibration_paths = parse_paths(args.calibration)
    validation_paths = parse_paths(args.validation)
    training = deduplicate(case for path in train_paths for case in read_cases(path))
    calibration = deduplicate(
        case for path in calibration_paths for case in read_cases(path)
    )
    validation = deduplicate(
        case for path in validation_paths for case in read_cases(path)
    )
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "trainPaths": [str(path) for path in train_paths],
        "calibrationPaths": [str(path) for path in calibration_paths],
        "validationPaths": [str(path) for path in validation_paths],
        "eventTypes": {},
    }
    model_dir = Path(args.model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)

    for event_type in ["missingRing", "falseRing"]:
        train_cases = [case for case in training if case.event_type == event_type]
        calibration_cases = [
            case for case in calibration if case.event_type == event_type
        ]
        validation_cases = [
            case for case in validation if case.event_type == event_type
        ]
        config_rows = []
        for config in candidate_configs():
            predictions = cross_validated_predictions(train_cases, config)
            metrics = summarize(train_cases, lambda case: predictions[case.key])
            config_rows.append({
                "config": config,
                "oof": metrics,
            })
        config_rows.sort(key=lambda row: metric_sort_key(row["oof"]), reverse=True)
        selected_config = config_rows[0]["config"]
        model = fit_model(train_cases, selected_config, 20260802)
        calibration_predictions = model_predictions(calibration_cases, model)
        raw_margins = []
        for case in calibration_cases:
            scores = calibration_predictions[case.key]
            order = top_order(scores, case.years)
            raw_margins.append(float(
                scores[int(order[0])]
                - scores[int(order[1] if len(order) > 1 else order[0])]
            ))
        positive_margins = [value for value in raw_margins if value > 0]
        thresholds = [0.0]
        if positive_margins:
            thresholds.extend(float(np.quantile(positive_margins, quantile))
                              for quantile in [0.25, 0.5, 0.75])
        gate_rows = []
        for blend in [0.25, 0.5, 0.75, 1.0]:
            for maximum_distance in [1, 2, 3, 99]:
                for threshold in sorted(set(thresholds)):
                    gate = {
                        "blend": blend,
                        "maximumTopDistance": maximum_distance,
                        "minimumModelMargin": threshold,
                    }
                    gate_rows.append({
                        "gate": gate,
                        "calibration": score_gate(
                            calibration_cases,
                            calibration_predictions,
                            gate,
                        ),
                    })
        gate_rows.sort(
            key=lambda row: metric_sort_key(row["calibration"]), reverse=True
        )
        selected_gate = gate_rows[0]["gate"]
        validation_predictions = model_predictions(validation_cases, model)
        model_payload = export_model(
            model,
            event_type,
            selected_gate,
            selected_config,
            [str(path) for path in train_paths],
            [str(path) for path in calibration_paths],
        )
        model_path = model_dir / f"{event_type}-year-ranker.json"
        model_path.write_text(
            json.dumps(model_payload, ensure_ascii=True, separators=(",", ":")),
            encoding="utf-8",
        )
        report["eventTypes"][event_type] = {
            "counts": {
                "training": len(train_cases),
                "calibration": len(calibration_cases),
                "validation": len(validation_cases),
                "trainingFiles": len({case.file for case in train_cases}),
                "calibrationFiles": len({case.file for case in calibration_cases}),
                "validationFiles": len({case.file for case in validation_cases}),
            },
            "featureCount": len(feature_names_for(event_type)),
            "baseline": {
                "training": summarize(train_cases, lambda case: case.baseline_scores),
                "calibration": summarize(
                    calibration_cases, lambda case: case.baseline_scores
                ),
                "validation": summarize(
                    validation_cases, lambda case: case.baseline_scores
                ),
            },
            "finalPipelineBaseline": {
                "training": summarize(train_cases, lambda case: case.final_scores),
                "calibration": summarize(
                    calibration_cases, lambda case: case.final_scores
                ),
                "validation": summarize(
                    validation_cases, lambda case: case.final_scores
                ),
            },
            "configCandidates": config_rows,
            "selectedConfig": selected_config,
            "selectedGate": selected_gate,
            "calibration": gate_rows[0]["calibration"],
            "validation": score_gate(
                validation_cases,
                validation_predictions,
                selected_gate,
            ),
            "topCalibrationGates": gate_rows[:10],
            "modelPath": str(model_path),
        }

    Path(args.report).write_text(
        json.dumps(report, ensure_ascii=True, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
