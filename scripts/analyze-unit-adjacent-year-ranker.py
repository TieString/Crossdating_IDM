"""Audit conservative adjacent-year promotions for unit-event Top1 ranking."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


SPLITS = ("train", "calibration", "holdout", "legacyValidation")


@dataclass
class PairRow:
    case_key: str
    file: str
    candidate_year: int
    features: np.ndarray
    label: int


@dataclass
class RankCase:
    key: str
    file: str
    split: str
    event_type: str
    truth_year: int
    years: list[int]
    baseline_scores: np.ndarray
    pair_rows: list[PairRow]


def normalize(values: np.ndarray) -> np.ndarray:
    scale = float(np.std(values))
    return (values - float(np.mean(values))) / (scale if scale > 1e-8 else 1.0)


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), dtype=np.float64)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = 0.5 if len(order) <= 1 else ((start + end - 1) / 2) / (len(order) - 1)
        ranks[order[start:end]] = rank
        start = end
    return ranks


def top_order(scores: np.ndarray, years: list[int]) -> np.ndarray:
    return np.lexsort((-np.asarray(years), -scores))


def file_from_key(key: str) -> str:
    parts = key.split("|")
    return parts[1].replace("\\", "/").lower() if len(parts) > 1 else key


def signal_years(notes: dict[str, Any]) -> list[int]:
    return [
        int(value)
        for name, value in notes.items()
        if (
            (name.endswith("year") or name.endswith("top_year"))
            and isinstance(value, (int, float))
            and np.isfinite(value)
        )
    ]


def feature_groups(
    fixed_names: list[str],
    profile_names: list[str],
) -> dict[str, list[str]]:
    fixed = [f"fixed:{name}" for name in fixed_names]
    profiles = [f"profile:{name}" for name in profile_names]
    boundary = [name for name in fixed if "Boundary" in name]
    boundary_side = [
        name for name in boundary
        if any(token in name for token in (
            "OlderHuber",
            "NewerHuber",
            "SideMinimum",
            "SideMean",
        ))
    ]
    predictive_boundary = [
        name for name in fixed
        if "Predictive" in name
        and any(token in name for token in (
            "HuberEdge",
            "HuberOlder",
            "HuberNewer",
            "HuberSideMinimum",
            "HuberSideMean",
            "HuberEdgeVsSide",
        ))
    ]
    raw_predictive_boundary = [
        name for name in predictive_boundary
        if name.removeprefix("fixed:").startswith("rawPredictive")
    ]
    profile_core = [
        name for name in profiles
        if name.removeprefix("profile:") in {
            "comboFull",
            "cumulativeCombined",
            "cumulativeDifference",
            "cumulativeReferenceMean",
            "cumulativeReferenceMedian",
            "cumulativeReferenceVote",
            "differenceFull",
            "jointOperationMargin",
            "piecewiseCombinedObjective",
            "reference:peakKernel5",
            "reference:peakKernel9",
            "reference:rankMean",
            "reference:rankMedian",
            "reference:weightedRankMean",
            "transitionSplitGain",
        }
    ]
    return {
        "all": [*fixed, *profiles],
        "fixedAll": fixed,
        "profiles": profiles,
        "profileCore": profile_core,
        "boundaryAll": boundary,
        "boundaryGain": [name for name in boundary if "Gain" in name],
        "boundarySide": boundary_side,
        "boundaryHuber": [name for name in boundary if "Huber" in name],
        "boundary5": [name for name in boundary if name.endswith("Boundary5")],
        "boundary57": [
            name for name in boundary
            if name.endswith("Boundary5") or name.endswith("Boundary7")
        ],
        "boundaryDifference": [
            name for name in boundary
            if name.removeprefix("fixed:").startswith("difference")
        ],
        "boundaryWhitened": [
            name for name in boundary
            if name.removeprefix("fixed:").startswith("whitened")
        ],
        "boundarySideProfiles": [*boundary_side, *profiles],
        "predictiveBoundary": predictive_boundary,
        "rawPredictiveBoundary": raw_predictive_boundary,
        "rawPredictiveSide": [
            name for name in raw_predictive_boundary
            if "SideMinimum" in name or "SideMean" in name
        ],
        "rawPredictiveSideMinimum": [
            name for name in raw_predictive_boundary
            if "SideMinimum" in name
        ],
        "rawPredictiveFocused": [
            name for name in raw_predictive_boundary
            if name.removeprefix("fixed:") in {
                "rawPredictiveEnsembleHuberSideMinimum3",
                "rawPredictiveEnsembleHuberSideMinimum5",
                "rawPredictiveMedianHuberSideMinimum3",
                "rawPredictiveWeightedHuberSideMinimum5",
                "rawPredictiveEnsembleHuberSideMean5",
                "rawPredictiveWeightedHuberSideMean5",
            }
        ],
        "huberProfiles": [
            *[name for name in fixed if "Huber" in name],
            *profiles,
        ],
        "differenceProfiles": [
            *[
                name for name in fixed
                if name.removeprefix("fixed:").startswith("difference")
            ],
            *profiles,
        ],
        "predictiveProfiles": [
            *[name for name in fixed if "Predictive" in name],
            *profiles,
        ],
        "differencePredictive": [
            name for name in fixed
            if name.removeprefix("fixed:").startswith("differencePredictive")
        ],
        "whitenedProfiles": [
            *[
                name for name in fixed
                if name.removeprefix("fixed:").startswith("whitened")
            ],
            *profiles,
        ],
    }


def build_cases(raw: list[dict[str, Any]], selected_names: list[str]) -> list[RankCase]:
    result: list[RankCase] = []
    for item in raw:
        years = [int(year) for year in item["years"]]
        if not years:
            continue
        score_by_year = {
            int(row["year"]): float(row["score"])
            for row in item["baselineRanked"]
        }
        baseline_scores = np.asarray(
            [score_by_year[year] for year in years], dtype=np.float64
        )
        baseline_order = top_order(baseline_scores, years)
        baseline_index = int(baseline_order[0])
        baseline_year = years[baseline_index]
        baseline_normalized = normalize(baseline_scores)
        baseline_ranks = percentile_ranks(baseline_scores)
        evidence = {
            name: np.asarray(
                [float(row[name.removeprefix("fixed:")])
                 for row in item["fixedFeatures"]]
                if name.startswith("fixed:")
                else [
                    float(value) for value in item["profileScores"][
                        name.removeprefix("profile:")
                    ]
                ],
                dtype=np.float64,
            )
            for name in selected_names
        }
        evidence_normalized = {
            name: normalize(values) for name, values in evidence.items()
        }
        evidence_ranks = {
            name: percentile_ranks(values) for name, values in evidence.items()
        }
        notes = item.get("notes", {})
        signals = signal_years(notes)
        context = item.get("context", {})
        pair_rows: list[PairRow] = []
        for direction in (-1, 1):
            candidate_year = baseline_year + direction
            if candidate_year not in years:
                continue
            candidate_index = years.index(candidate_year)
            baseline_votes = sum(year == baseline_year for year in signals)
            candidate_votes = sum(year == candidate_year for year in signals)
            baseline_near = sum(abs(year - baseline_year) <= 1 for year in signals)
            candidate_near = sum(abs(year - candidate_year) <= 1 for year in signals)
            features = [
                float(direction),
                float(baseline_normalized[candidate_index] - baseline_normalized[baseline_index]),
                float(baseline_ranks[candidate_index] - baseline_ranks[baseline_index]),
                float(candidate_votes - baseline_votes) / max(1, len(signals)),
                float(candidate_near - baseline_near) / max(1, len(signals)),
                float(candidate_votes) / max(1, len(signals)),
                float(candidate_near) / max(1, len(signals)),
                float(len(years)) / 13,
                float(baseline_index) / max(1, len(years) - 1),
                float(context.get("referenceCount", 0)) / 50,
                float(context.get("referenceSupportAtYear", 0)) / 50,
                float(context.get("signalStrength", 0) or 0),
            ]
            for name in selected_names:
                features.extend([
                    float(evidence_normalized[name][candidate_index]
                          - evidence_normalized[name][baseline_index]),
                    float(evidence_ranks[name][candidate_index]
                          - evidence_ranks[name][baseline_index]),
                ])
            key = str(item["key"])
            pair_rows.append(PairRow(
                case_key=key,
                file=file_from_key(key),
                candidate_year=candidate_year,
                features=np.asarray(features, dtype=np.float32),
                label=int(candidate_year == int(item["truthYear"])),
            ))
        result.append(RankCase(
            key=str(item["key"]),
            file=file_from_key(str(item["key"])),
            split=str(item["split"]),
            event_type=str(item["eventType"]),
            truth_year=int(item["truthYear"]),
            years=years,
            baseline_scores=baseline_scores,
            pair_rows=pair_rows,
        ))
    return result


def flatten(cases: list[RankCase]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rows = [row for case in cases for row in case.pair_rows]
    return (
        np.vstack([row.features for row in rows]),
        np.asarray([row.label for row in rows], dtype=np.int32),
        np.asarray([row.file for row in rows]),
    )


def local_truth_cases(cases: list[RankCase]) -> list[RankCase]:
    return [
        case for case in cases
        if abs(
            case.years[int(top_order(case.baseline_scores, case.years)[0])]
            - case.truth_year
        ) <= 1
    ]


def fit_logistic(cases: list[RankCase], c_value: float) -> Any:
    x, y, _ = flatten(cases)
    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(
            C=c_value,
            class_weight="balanced",
            max_iter=3000,
            random_state=20260802,
        ),
    )
    model.fit(x, y)
    return model


def fit_lgbm(cases: list[RankCase], config: dict[str, Any], seed: int) -> Any:
    x, y, _ = flatten(cases)
    model = lgb.LGBMClassifier(
        objective="binary",
        verbosity=-1,
        n_jobs=-1,
        random_state=seed,
        class_weight="balanced",
        **config,
    )
    model.fit(x, y)
    return model


def predict(model: Any, cases: list[RankCase]) -> dict[tuple[str, int], float]:
    rows = [row for case in cases for row in case.pair_rows]
    if not rows:
        return {}
    probabilities = model.predict_proba(
        np.vstack([row.features for row in rows])
    )[:, 1]
    return {
        (row.case_key, row.candidate_year): float(probabilities[index])
        for index, row in enumerate(rows)
    }


def oof_predictions(
    cases: list[RankCase],
    fit: Callable[[list[RankCase], int], Any],
) -> dict[tuple[str, int], float]:
    files = np.asarray([case.file for case in cases])
    splitter = GroupKFold(n_splits=min(5, len(set(files))))
    indices = np.arange(len(cases))
    result: dict[tuple[str, int], float] = {}
    for fold, (train_indices, test_indices) in enumerate(
        splitter.split(indices, groups=files)
    ):
        training = [cases[index] for index in train_indices]
        testing = [cases[index] for index in test_indices]
        result.update(predict(fit(training, fold), testing))
    return result


def rank_with_policy(
    case: RankCase,
    probabilities: dict[tuple[str, int], float],
    threshold: float,
    probability_margin: float,
) -> list[int]:
    baseline_order = top_order(case.baseline_scores, case.years)
    ranked = [case.years[int(index)] for index in baseline_order]
    candidates = sorted(
        (
            probabilities.get((case.key, row.candidate_year), 0.0),
            row.candidate_year,
        )
        for row in case.pair_rows
    )
    if not candidates:
        return ranked
    best_probability, best_year = candidates[-1]
    second_probability = candidates[-2][0] if len(candidates) > 1 else 0.0
    if (
        best_probability >= threshold
        and best_probability - second_probability >= probability_margin
    ):
        ranked.remove(best_year)
        ranked.insert(0, best_year)
    return ranked


def summarize(
    cases: list[RankCase],
    probabilities: dict[tuple[str, int], float] | None = None,
    threshold: float = 1.0,
    probability_margin: float = 1.0,
) -> dict[str, Any]:
    exact = within_one = top_three = gains = losses = changes = 0
    reciprocal = bias = 0.0
    ranks: list[int] = []
    for case in cases:
        baseline = [
            case.years[int(index)]
            for index in top_order(case.baseline_scores, case.years)
        ]
        ranked = baseline if probabilities is None else rank_with_policy(
            case, probabilities, threshold, probability_margin
        )
        truth_rank = ranked.index(case.truth_year) + 1
        top_year = ranked[0]
        exact += int(top_year == case.truth_year)
        within_one += int(abs(top_year - case.truth_year) <= 1)
        top_three += int(truth_rank <= 3)
        reciprocal += 1 / truth_rank
        bias += top_year - case.truth_year
        ranks.append(truth_rank)
        changes += int(top_year != baseline[0])
        gains += int(top_year == case.truth_year and baseline[0] != case.truth_year)
        losses += int(top_year != case.truth_year and baseline[0] == case.truth_year)
    count = max(1, len(cases))
    return {
        "cases": len(cases),
        "top1": exact / count,
        "withinOne": within_one / count,
        "top3": top_three / count,
        "medianRank": float(np.median(ranks)) if ranks else 0.0,
        "mrr": reciprocal / count,
        "bias": bias / count,
        "changes": changes,
        "gains": gains,
        "losses": losses,
    }


def score(metrics: dict[str, dict[str, Any]]) -> tuple[float, ...]:
    train = metrics["train"]
    calibration = metrics["calibration"]
    train_delta = train["top1"] - metrics["trainBaseline"]["top1"]
    calibration_delta = (
        calibration["top1"] - metrics["calibrationBaseline"]["top1"]
    )
    return (
        min(train_delta, calibration_delta),
        train_delta + calibration_delta,
        min(train["mrr"], calibration["mrr"]),
        -max(train["losses"], calibration["losses"]),
        -train["changes"] - calibration["changes"],
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--event-type",
        choices=("missingRing", "falseRing"),
    )
    parser.add_argument("--skip-lgbm", action="store_true")
    args = parser.parse_args()
    raw = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    fixed_names = sorted(raw[0]["fixedFeatures"][0])
    profile_names = sorted(raw[0]["profileScores"])
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    event_types = (args.event_type,) if args.event_type else (
        "missingRing",
        "falseRing",
    )
    for event_type in event_types:
        typed = [row for row in raw if row["eventType"] == event_type]
        candidates: list[dict[str, Any]] = []
        for group_name, selected_names in feature_groups(
            fixed_names,
            profile_names,
        ).items():
            cases = build_cases(typed, selected_names)
            by_split = {
                split: [case for case in cases if case.split == split]
                for split in SPLITS
            }
            model_specs: list[tuple[str, Callable[[list[RankCase], int], Any]]] = []
            for c_value in (0.003, 0.01, 0.03, 0.1, 0.3):
                model_specs.append((
                    f"local-logistic:C={c_value}",
                    lambda rows, _seed, c_value=c_value: fit_logistic(
                        local_truth_cases(rows),
                        c_value,
                    ),
                ))
            if not args.skip_lgbm:
                for config in (
                    dict(n_estimators=30, learning_rate=0.03, num_leaves=3,
                         max_depth=2, min_child_samples=60, reg_lambda=30,
                         reg_alpha=5, colsample_bytree=0.65),
                    dict(n_estimators=50, learning_rate=0.025, num_leaves=3,
                         max_depth=2, min_child_samples=90, reg_lambda=40,
                         reg_alpha=8, colsample_bytree=0.6),
                ):
                    model_specs.append((
                        f"local-lgbm:{json.dumps(config, sort_keys=True)}",
                        lambda rows, seed, config=config: fit_lgbm(
                            local_truth_cases(rows),
                            config,
                            20260802 + seed,
                        ),
                    ))
            for model_name, fit in model_specs:
                train_predictions = oof_predictions(by_split["train"], fit)
                fitted = fit(by_split["train"], 99)
                split_predictions = {
                    "train": train_predictions,
                    **{
                        split: predict(fitted, by_split[split])
                        for split in SPLITS if split != "train"
                    },
                }
                baselines = {
                    split: summarize(by_split[split]) for split in SPLITS
                }
                for threshold in np.arange(0.35, 0.91, 0.05):
                    for margin in (0.0, 0.05, 0.1, 0.15, 0.2):
                        metrics = {
                            split: summarize(
                                by_split[split],
                                split_predictions[split],
                                float(threshold),
                                margin,
                            )
                            for split in SPLITS
                        }
                        metrics["trainBaseline"] = baselines["train"]
                        metrics["calibrationBaseline"] = baselines["calibration"]
                        candidates.append({
                            "featureGroup": group_name,
                            "featureCount": len(selected_names),
                            "model": model_name,
                            "threshold": float(threshold),
                            "probabilityMargin": margin,
                            "metrics": metrics,
                            "baselines": baselines,
                        })
        candidates.sort(key=lambda row: score(row["metrics"]), reverse=True)
        report["eventTypes"][event_type] = {
            "topCandidates": candidates[:30],
        }
    Path(args.output).write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    for event_type, payload in report["eventTypes"].items():
        top = payload["topCandidates"][0]
        print(event_type, json.dumps(top, indent=2))


if __name__ == "__main__":
    main()
