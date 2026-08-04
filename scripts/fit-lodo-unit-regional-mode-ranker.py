"""Evaluate a compact 13-year mode ranker across file-disjoint audit cohorts."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import lightgbm as lgb
import numpy as np


WINDOW_WIDTH = 13
EVENT_TYPES = ("missingRing", "falseRing")
COMMON_PROFILES = (
    "jointOperationMargin",
    "sideStepScore",
    "sideMinimumAdvantage",
    "correctedSideSupport",
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
    "cumulativeReferenceVote",
    "cumulativeReferenceVoteCusum",
    "cumulativeReferenceVoteContrast",
    "cumulativeReferenceMean",
    "cumulativeReferenceMeanCusum",
    "cumulativeReferenceMeanContrast",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMedianCusum",
    "cumulativeReferenceMedianContrast",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "rawFull",
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "pairDifferenceWeighted",
    "pairDifferenceGainWeighted",
    "pairWhitenedMean",
    "pairWhitenedGainMean",
    "pairCombinedGain",
    "pairPositiveDifferenceGainFraction",
    "pairPositiveWhitenedGainFraction",
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
)
COUNTERFACTUAL_PROFILES = {
    "missingRing": (
        "differencePredictiveWeightedHuber21",
        "differencePredictiveEnsembleHuber31",
        "differencePredictiveWeightedHuber61",
        "whitenedPredictiveEnsembleHuber21",
        "whitenedPredictiveMedianHuberEdge3Gain",
        "whitenedOlderHuberBoundary7",
        "referenceStepWeighted12",
        "referenceStepMedian12",
        "referenceStepConsensus12",
        "referenceStepWeighted20",
        "referenceStepBoundary4",
    ),
    "falseRing": (
        "differenceMasterHuber31",
        "whitenedMasterHuber31",
        "differenceReferenceWeightedHuber31",
        "differenceMasterHuber21",
        "differenceReferenceRankMean31",
        "differenceReferenceRankMedian31",
        "differenceReferencePeakKernel5",
        "differenceReferencePeakKernel9",
    ),
}


@dataclass(frozen=True)
class Candidate:
    start_year: int
    center_year: int
    features: np.ndarray
    relevance: int


@dataclass(frozen=True)
class Case:
    dataset: str
    event_type: str
    key: str
    truth_year: int
    group: str
    current_window: tuple[int, int]
    candidates: tuple[Candidate, ...]


def identity(event_type: str, context: dict[str, Any]) -> str:
    return "|".join((
        event_type,
        str(context.get("groupId", context.get("file", ""))).lower(),
        str(context.get("target", "")),
        str(int(context.get("year", 0))),
    ))


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="stable")
    result = np.zeros(len(values), dtype=np.float32)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = 0.5 if len(values) <= 1 else (start + end - 1) / (2 * (len(values) - 1))
        result[order[start:end]] = rank
        start = end
    return result


def mean(values: np.ndarray) -> float:
    return float(np.mean(values)) if len(values) else 0.0


def maximum(values: np.ndarray) -> float:
    return float(np.max(values)) if len(values) else 0.0


def minimum(values: np.ndarray) -> float:
    return float(np.min(values)) if len(values) else 0.0


def build_profiles(row: dict[str, Any], event_type: str) -> dict[str, dict[int, float]]:
    years = [int(year) for year in row.get("years", [])]
    profiles: dict[str, dict[int, float]] = {}
    for name in COMMON_PROFILES:
        values = (row.get("ranks") or {}).get(name)
        if isinstance(values, list) and len(values) == len(years):
            profiles[name] = dict(zip(years, map(float, values)))
    counterfactual_names = set(COUNTERFACTUAL_PROFILES[event_type])
    for source in row.get("unitCounterfactualRows") or []:
        year = int(source["year"])
        for name, value in (source.get("profiles") or {}).items():
            if name in counterfactual_names:
                profiles.setdefault(f"cf:{name}", {})[year] = float(value)
    return profiles


def profile_features(
    years: np.ndarray,
    values_by_year: dict[int, float] | None,
    start_year: int,
) -> list[float]:
    if not values_by_year or any(int(year) not in values_by_year for year in years):
        return [0.0] * 11
    raw = np.asarray([values_by_year[int(year)] for year in years], dtype=np.float32)
    values = percentile_ranks(raw)
    start_index = int(np.searchsorted(years, start_year))
    end_index = start_index + WINDOW_WIDTH
    center_index = start_index + WINDOW_WIDTH // 2
    window = values[start_index:end_index]
    older = values[start_index:center_index]
    newer = values[center_index + 1:end_index]
    outside = np.concatenate((values[:start_index], values[end_index:]))
    peak_index = int(np.argmax(values))
    mass_total = max(1e-8, float(np.sum(values)))
    return [
        1.0,
        float(values[center_index]),
        mean(window),
        maximum(window),
        minimum(window),
        mean(older),
        mean(newer),
        mean(window) - mean(outside),
        maximum(window) - maximum(outside),
        float(np.sum(window)) / mass_total,
        (int(years[peak_index]) - int(years[center_index])) / max(1, len(years) - 1),
    ]


def anchor_features(center_year: int, anchor: Any, span: int) -> list[float]:
    if anchor is None:
        return [0.0] * 5
    distance = center_year - int(anchor)
    return [
        1.0,
        distance / span,
        abs(distance) / span,
        float(abs(distance) <= 6),
        float(abs(distance) <= 4),
    ]


def build_case(dataset: str, row: dict[str, Any]) -> Case | None:
    event_type = str(row.get("eventType"))
    coarse = row.get("coarseWindow")
    if event_type not in EVENT_TYPES or not coarse:
        return None
    all_years = np.asarray(row.get("years") or [], dtype=int)
    start = max(int(coarse["startYear"]), int(all_years[0]))
    end = min(int(coarse["endYear"]), int(all_years[-1]))
    years = np.arange(start, end + 1, dtype=int)
    if len(years) < WINDOW_WIDTH:
        return None
    profiles = build_profiles(row, event_type)
    profile_names = (*COMMON_PROFILES, *(
        f"cf:{name}" for name in COUNTERFACTUAL_PROFILES[event_type]
    ))
    operation = row.get("selectedOperation") or {}
    anchors = (
        row.get("currentPrimaryYear"),
        operation.get("bestYear"),
        operation.get("sideStepBestYear"),
    )
    current_window = row.get("finalWindow") or row.get("modeWindow") or coarse
    current_center = (
        int(current_window["startYear"]) + int(current_window["endYear"])
    ) / 2
    coarse_center = (start + end) / 2
    span = max(1, end - start)
    truth = int(row["truthYear"])
    internal_candidates = row.get("candidates") or []
    candidates: list[Candidate] = []
    for start_year in range(start, end - WINDOW_WIDTH + 2):
        center_year = start_year + WINDOW_WIDTH // 2
        features: list[float] = [
            (center_year - start) / span,
            (center_year - coarse_center) / span,
            abs(center_year - coarse_center) / span,
            (center_year - current_center) / span,
            abs(center_year - current_center) / span,
            float(abs(center_year - current_center) <= 2),
            float(abs(center_year - current_center) <= 4),
        ]
        for anchor in anchors:
            features.extend(anchor_features(center_year, anchor, span))
        support = [
            candidate for candidate in internal_candidates
            if int(candidate["startYear"]) <= center_year <= int(candidate["endYear"])
        ]
        features.extend((
            len(support) / max(1, len(internal_candidates)),
            max((float(candidate.get("aggregateScore") or 0) for candidate in support), default=0),
            max((float(candidate.get("overlapConsensus") or 0) for candidate in support), default=0),
        ))
        for name in profile_names:
            features.extend(profile_features(
                years,
                profiles.get(name),
                start_year,
            ))
        candidates.append(Candidate(
            start_year=start_year,
            center_year=center_year,
            features=np.asarray(features, dtype=np.float32),
            relevance=max(0, 7 - abs(center_year - truth)),
        ))
    context = row.get("context") or {}
    return Case(
        dataset=dataset,
        event_type=event_type,
        key=identity(event_type, context),
        truth_year=truth,
        group=str(context.get("groupId", context.get("file", ""))).lower(),
        current_window=(
            int(current_window["startYear"]),
            int(current_window["endYear"]),
        ),
        candidates=tuple(candidates),
    )


def load_sources(arguments: Sequence[str]):
    cases: list[Case] = []
    denominators: dict[str, dict[str, int]] = {}
    baseline_hits: dict[str, dict[str, int]] = {}
    for argument in arguments:
        dataset, raw_path = argument.split("=", 1)
        payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
        denominators[dataset] = {event: 0 for event in EVENT_TYPES}
        baseline_hits[dataset] = {event: 0 for event in EVENT_TYPES}
        formal: dict[str, dict[str, Any]] = {}
        for outcome in payload.get("formalEventCaseOutcomes", []):
            event_type = str(outcome.get("eventType"))
            if event_type not in EVENT_TYPES:
                continue
            denominators[dataset][event_type] += 1
            baseline_hits[dataset][event_type] += int(bool(outcome.get("primaryMatched")))
            formal[identity(event_type, outcome.get("context") or {})] = outcome
        seen = set()
        for row in payload.get("counterfactualLocatorCases", []):
            event_type = str(row.get("eventType"))
            row_key = identity(event_type, row.get("context") or {})
            outcome = formal.get(row_key)
            if not outcome or row_key in seen or not outcome.get("answered"):
                continue
            primary = outcome.get("primaryPredictionRange")
            final = row.get("finalWindow")
            if not primary or not final or [final["startYear"], final["endYear"]] != primary:
                continue
            case = build_case(dataset, row)
            if case:
                cases.append(case)
                seen.add(row_key)
    return cases, denominators, baseline_hits


def make_model(seed: int, variant: str) -> lgb.LGBMRanker:
    settings = {
        "small": dict(n_estimators=100, num_leaves=7, max_depth=3, min_child_samples=30),
        "medium": dict(n_estimators=150, num_leaves=10, max_depth=4, min_child_samples=24),
        "wide": dict(n_estimators=180, num_leaves=15, max_depth=5, min_child_samples=20),
    }[variant]
    return lgb.LGBMRanker(
        objective="lambdarank",
        learning_rate=0.025,
        max_bin=63,
        reg_lambda=30,
        reg_alpha=6,
        colsample_bytree=0.65,
        subsample=0.85,
        subsample_freq=1,
        random_state=seed,
        n_jobs=-1,
        verbosity=-1,
        **settings,
    )


def fit_model(cases: Sequence[Case], seed: int, variant: str):
    usable = [case for case in cases if max(c.relevance for c in case.candidates) > 0]
    model = make_model(seed, variant)
    model.fit(
        np.vstack([candidate.features for case in usable for candidate in case.candidates]),
        np.asarray([candidate.relevance for case in usable for candidate in case.candidates]),
        group=[len(case.candidates) for case in usable],
    )
    return model


def predict_rows(model: Any, cases: Sequence[Case]) -> list[dict[str, Any]]:
    result = []
    for case in cases:
        scores = np.asarray(model.predict(np.vstack([
            candidate.features for candidate in case.candidates
        ])), dtype=float)
        order = sorted(
            range(len(case.candidates)),
            key=lambda index: (scores[index], case.candidates[index].center_year),
            reverse=True,
        )
        selected = case.candidates[order[0]]
        maximum = float(np.max(scores))
        masses = np.exp(np.clip(scores - maximum, -30, 0))
        current_center = sum(case.current_window) / 2
        result.append({
            "dataset": case.dataset,
            "key": case.key,
            "truth": case.truth_year,
            "baselineHit": case.current_window[0] <= case.truth_year <= case.current_window[1],
            "baselineWidth": case.current_window[1] - case.current_window[0] + 1,
            "candidateHit": abs(selected.center_year - case.truth_year) <= WINDOW_WIDTH // 2,
            "candidateCenter": selected.center_year,
            "distance": abs(selected.center_year - current_center),
            "margin": float(scores[order[0]] - scores[order[1]]) if len(order) > 1 else 1.0,
            "mass": float(masses[order[0]] / max(1e-12, np.sum(masses))),
        })
    return result


def evaluate(rows: Sequence[dict[str, Any]], denominator: int) -> dict[str, Any]:
    hits = 0
    errors: list[int] = []
    for row in rows:
        error = abs(row["candidateCenter"] - row["truth"])
        errors.append(error)
        hits += int(row["candidateHit"])
    return {
        "denominator": denominator,
        "locatedCases": len(rows),
        "hits": hits,
        "coverage": hits / max(1, denominator),
        "medianError": float(np.median(errors)) if errors else 0,
        "p90Error": float(np.quantile(errors, 0.9)) if errors else 0,
    }


def gated_metrics(rows: Sequence[dict[str, Any]], gate: dict[str, Any]):
    old_hits = new_hits = changes = gains = losses = 0
    for row in rows:
        width_matches = gate["width"] == 0 or row["baselineWidth"] == gate["width"]
        use_candidate = (
            width_matches
            and row["margin"] + 1e-12 >= gate["minimumMargin"]
            and row["mass"] + 1e-12 >= gate["minimumMass"]
            and row["distance"] <= gate["maximumDistance"] + 1e-12
        )
        old_hit = bool(row["baselineHit"])
        new_hit = bool(row["candidateHit"]) if use_candidate else old_hit
        old_hits += int(old_hit)
        new_hits += int(new_hit)
        changes += int(use_candidate)
        gains += int(new_hit and not old_hit)
        losses += int(old_hit and not new_hit)
    return {
        "cases": len(rows),
        "oldHits": old_hits,
        "newHits": new_hits,
        "delta": new_hits - old_hits,
        "changes": changes,
        "gains": gains,
        "losses": losses,
    }


def select_gate(rows: Sequence[dict[str, Any]], datasets: Sequence[str]):
    margins = np.asarray([row["margin"] for row in rows], dtype=float)
    masses = np.asarray([row["mass"] for row in rows], dtype=float)
    margin_thresholds = sorted(set([
        0.0,
        *[float(np.quantile(margins, quantile)) for quantile in (0.25, 0.5, 0.7, 0.8, 0.9, 0.95)],
    ]))
    mass_thresholds = sorted(set([
        0.0,
        *[float(np.quantile(masses, quantile)) for quantile in (0.25, 0.5, 0.7, 0.8, 0.9, 0.95)],
    ]))
    options = []
    for margin in margin_thresholds:
        for mass in mass_thresholds:
            for maximum_distance in (0, 2, 4, 6, 8, 12, 20, 10_000):
                for width in (0, 7, 9, 13):
                    gate = {
                        "minimumMargin": margin,
                        "minimumMass": mass,
                        "maximumDistance": maximum_distance,
                        "width": width,
                    }
                    folds = {
                        dataset: gated_metrics(
                            [row for row in rows if row["dataset"] == dataset],
                            gate,
                        )
                        for dataset in datasets
                    }
                    if any(fold["delta"] < 0 for fold in folds.values()):
                        continue
                    overall = gated_metrics(rows, gate)
                    score = (
                        overall["delta"],
                        min(fold["delta"] for fold in folds.values()),
                        -overall["losses"],
                        -overall["changes"],
                    )
                    options.append((score, gate, overall, folds))
    return max(options, key=lambda option: option[0]) if options else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    cases, denominators, baseline_hits = load_sources(args.source)
    datasets = sorted(denominators)
    report: dict[str, Any] = {"schemaVersion": 1, "events": {}}
    for event_type in EVENT_TYPES:
        event_cases = [case for case in cases if case.event_type == event_type]
        if not event_cases:
            report["events"][event_type] = {"skipped": "no located cases"}
            continue
        variants = {}
        for variant_index, variant in enumerate(("small", "medium", "wide")):
            folds = {}
            prediction_rows = []
            for fold_index, test_dataset in enumerate(datasets):
                train = [case for case in event_cases if case.dataset != test_dataset]
                test = [case for case in event_cases if case.dataset == test_dataset]
                model = fit_model(train, 20261010 + variant_index * 10 + fold_index, variant)
                rows = predict_rows(model, test)
                prediction_rows.extend(rows)
                folds[test_dataset] = {
                    "baselineHits": baseline_hits[test_dataset][event_type],
                    **evaluate(
                        rows,
                        denominators[test_dataset][event_type],
                    ),
                }
            gate_selection = select_gate(prediction_rows, datasets)
            variants[variant] = {
                "folds": folds,
                "minimumCoverage": min(row["coverage"] for row in folds.values()),
                "totalHits": sum(row["hits"] for row in folds.values()),
                "totalCases": sum(row["denominator"] for row in folds.values()),
                **({
                    "gate": gate_selection[1],
                    "gatedOverall": gate_selection[2],
                    "gatedFolds": gate_selection[3],
                } if gate_selection else {}),
            }
        report["events"][event_type] = variants
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
