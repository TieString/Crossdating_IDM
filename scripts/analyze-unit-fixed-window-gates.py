#!/usr/bin/env python3
"""Search conservative gates for fixed-calendar exact-year evidence."""

from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import sys
from pathlib import Path
from typing import Any, Callable, Sequence

import numpy as np


def load_rules_module():
    path = Path(__file__).with_name("analyze-unit-exact-year-rules.py")
    spec = importlib.util.spec_from_file_location("unit_exact_year_rules", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


RULES = load_rules_module()
EVENT_TYPES = ("missingRing", "falseRing")
_FIXED_VOTE_CACHE: dict[tuple[int, tuple[str, ...]], dict[int, int]] = {}
_GATE_STAT_CACHE: dict[
    tuple[int, str, float, tuple[str, ...]],
    dict[str, Any],
] = {}


FIXED_FAMILY = (
    "exact:rawMasterRFixedWindow",
    "exact:rawMasterRFixedWindowPlus4",
    "exact:rawMasterRFixedWindowPlus12",
    "exact:differenceMasterRFixedWindow",
    "exact:differenceMasterRFixedWindowPlus4",
    "exact:differenceMasterRFixedWindowPlus12",
    "exact:differenceMasterHuberFixedWindow",
    "exact:differenceMasterHuberFixedWindowPlus4",
    "exact:differenceMasterHuberFixedWindowPlus12",
    "exact:differencePredictiveWeightedHuberFixedWindow",
    "exact:differencePredictiveWeightedHuberFixedWindowPlus4",
    "exact:differencePredictiveWeightedHuberFixedWindowPlus12",
)


LOCAL_GAIN_FAMILY = tuple(
    f"exact:{channel}Master{statistic}Gain{width}"
    for channel in ("raw", "difference")
    for statistic in ("R", "Huber")
    for width in (5, 9, 13)
)


MISSING_PRIMARY_PROFILES = (
    "exact:rawMasterRFixedWindow",
    "exact:differenceMasterRFixedWindowPlus4",
    "exact:differenceMasterRFixedWindowPlus12",
    "exact:differenceMasterHuberFixedWindowPlus12",
)

FALSE_PRIMARY_PROFILES = (
    "exact:rawMasterRGain5",
    "exact:rawMasterRGain9",
    "exact:rawMasterRGain13",
    "exact:rawMasterHuberGain5",
    "exact:rawMasterHuberGain9",
    "exact:rawMasterHuberGain13",
    "exact:differenceMasterRGain5",
    "exact:differenceMasterRGain9",
    "exact:differenceMasterRGain13",
    "exact:differenceMasterHuberGain5",
    "exact:differenceMasterHuberGain9",
    "exact:differenceMasterHuberGain13",
    "exact:differenceMasterRFixedWindow",
    "exact:differenceMasterRFixedWindowPlus4",
    "exact:differenceMasterRFixedWindowPlus12",
    "exact:differenceMasterHuberFixedWindow",
    "exact:differenceMasterHuberFixedWindowPlus4",
    "exact:differenceMasterHuberFixedWindowPlus12",
    "exact:falseStateFixedWindowTopVote",
    "exact:falseStateFixedWindowPlus12Median",
    "exact:falseStateFixedWindowPlus12TopVote",
    "exact:falseBoundaryBridgeRadius2Weighted",
    "exact:falseBoundaryBridgeRadius2RankMean",
    "exact:falseBoundaryBridgeRadius3Weighted",
    "exact:falseBoundaryBridgeRadius3RankMean",
) + tuple(
    f"exact:falseLagStep{statistic}Fixed{window}{aggregate}"
    for statistic in ("Difference", "MinimumSupport")
    for window in ("Window", "WindowPlus12")
    for aggregate in ("Median", "Weighted", "RankMean", "RankMedian", "TopVote")
)

FALSE_VOTE_FAMILY = FIXED_FAMILY + LOCAL_GAIN_FAMILY + tuple(
    f"exact:falseStateFixed{window}{aggregate}"
    for window in ("Window", "WindowPlus12")
    for aggregate in ("Median", "Weighted", "RankMean", "RankMedian", "TopVote")
) + tuple(
    f"exact:falseBoundaryBridgeRadius{radius}{aggregate}"
    for radius in (1, 2, 3)
    for aggregate in ("Median", "Weighted", "RankMean", "RankMedian", "TopVote")
) + tuple(
    f"exact:falseLagStep{statistic}Fixed{window}{aggregate}"
    for statistic in ("Difference", "MinimumSupport")
    for window in ("Window", "WindowPlus12")
    for aggregate in ("Median", "Weighted", "RankMean", "RankMedian", "TopVote")
)


def aligned_profile_values(profile_name: str, values: np.ndarray) -> np.ndarray:
    # Lag-step profiles locate firstFixedYear; the false ring to delete is the
    # immediately preceding displayed year.
    if "falseLagStep" in profile_name:
        return RULES.shift_profile(values, -1)
    return values


def ranked_indices(case, scores: np.ndarray) -> np.ndarray:
    return np.lexsort((-case.years, -scores))


def margin(case, scores: np.ndarray) -> float:
    order = ranked_indices(case, scores)
    if len(order) < 2:
        return 1.0
    return float(scores[order[0]] - scores[order[1]])


def primary_scores(case, profile_name: str, blend: float) -> np.ndarray | None:
    values = case.named_profiles.get(profile_name)
    if values is None:
        return None
    return (
        RULES.percentile_ranks(case.baseline) * (1 - blend)
        + RULES.percentile_ranks(aligned_profile_values(profile_name, values)) * blend
    )


def fixed_vote_counts(case, family: Sequence[str]) -> dict[int, int]:
    key = (id(case), tuple(family))
    cached = _FIXED_VOTE_CACHE.get(key)
    if cached is not None:
        return cached
    result: dict[int, int] = {}
    for name in family:
        values = case.named_profiles.get(name)
        if values is None:
            continue
        aligned = aligned_profile_values(name, values)
        top = int(case.years[ranked_indices(case, aligned)[0]])
        result[top] = result.get(top, 0) + 1
    _FIXED_VOTE_CACHE[key] = result
    return result


def gate_stats(
    case,
    profile_name: str,
    blend: float,
    vote_family: Sequence[str],
) -> dict[str, Any] | None:
    key = (id(case), profile_name, blend, tuple(vote_family))
    cached = _GATE_STAT_CACHE.get(key)
    if cached is not None:
        return cached
    candidate = primary_scores(case, profile_name, blend)
    if candidate is None:
        return None
    baseline_ranks = RULES.percentile_ranks(case.baseline)
    baseline_top = int(ranked_indices(case, baseline_ranks)[0])
    candidate_top = int(ranked_indices(case, candidate)[0])
    baseline_year = int(case.years[baseline_top])
    candidate_year = int(case.years[candidate_top])
    result = {
        "candidate": candidate,
        "baselineYear": baseline_year,
        "candidateYear": candidate_year,
        "distance": abs(candidate_year - baseline_year),
        "candidateMargin": margin(case, candidate),
        "baselineMargin": margin(case, baseline_ranks),
        "fixedVotes": fixed_vote_counts(case, vote_family).get(candidate_year, 0),
        "exactAnchors": sum(anchor == candidate_year for anchor in case.anchors),
    }
    _GATE_STAT_CACHE[key] = result
    return result


def gate_selector(
    profile_name: str,
    blend: float,
    maximum_distance: int,
    minimum_candidate_margin: float,
    maximum_baseline_margin: float,
    minimum_fixed_votes: int,
    minimum_exact_anchors: int,
    vote_family: Sequence[str],
) -> Callable[[Any], np.ndarray]:
    def select(case):
        stats = gate_stats(case, profile_name, blend, vote_family)
        if stats is None:
            return case.baseline
        if stats["candidateYear"] == stats["baselineYear"]:
            return case.baseline
        accepts = (
            stats["distance"] <= maximum_distance
            and stats["candidateMargin"] + 1e-12 >= minimum_candidate_margin
            and stats["baselineMargin"] <= maximum_baseline_margin + 1e-12
            and stats["fixedVotes"] >= minimum_fixed_votes
            and stats["exactAnchors"] >= minimum_exact_anchors
        )
        return stats["candidate"] if accepts else case.baseline

    return select


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audits", nargs="+")
    parser.add_argument("--event-type", choices=EVENT_TYPES)
    parser.add_argument("--profile", action="append", dest="profiles")
    parser.add_argument("--include-regressions", action="store_true")
    parser.add_argument("--top", type=int, default=20)
    args = parser.parse_args()
    datasets = [RULES.load_dataset(Path(path)) for path in args.audits]
    event_types = (args.event_type,) if args.event_type else EVENT_TYPES
    output: dict[str, Any] = {
        "datasets": [dataset.name for dataset in datasets],
    }
    for event_type in event_types:
        all_cases = [
            case for dataset in datasets for case in dataset.cases[event_type]
        ]
        denominator = sum(
            dataset.denominators[event_type] for dataset in datasets
        )
        baseline_folds = {
            dataset.name: RULES.metrics(
                dataset.cases[event_type],
                dataset.denominators[event_type],
                lambda case: case.baseline,
            )
            for dataset in datasets
        }
        baseline = RULES.metrics(
            all_cases,
            denominator,
            lambda case: case.baseline,
        )
        primary_profiles = MISSING_PRIMARY_PROFILES \
            if event_type == "missingRing" else FALSE_PRIMARY_PROFILES
        if args.profiles:
            requested = set(args.profiles)
            primary_profiles = tuple(
                profile for profile in primary_profiles if profile in requested
            )
        vote_family = FIXED_FAMILY \
            if event_type == "missingRing" else FALSE_VOTE_FAMILY
        modes = sorted({
            case.false_ring_mode
            for case in all_cases
            if case.false_ring_mode is not None
        })
        cases_by_mode = {
            mode: [case for case in all_cases if case.false_ring_mode == mode]
            for mode in modes
        }
        baseline_by_mode = {
            mode: RULES.metrics(cases, len(cases), lambda case: case.baseline)
            for mode, cases in cases_by_mode.items()
        }
        rows = []
        parameters = itertools.product(
            primary_profiles,
            (0.25, 0.5, 0.75, 1.0) if event_type == "missingRing" else (0.25, 0.5),
            (1, 2, 3, 99) if event_type == "missingRing" else (1, 2, 3),
            (0.0, 0.125),
            (0.125, 0.25, 0.5, 1.0),
            (1, 2, 3, 4, 5, 6) if event_type == "missingRing"
            else (2, 3, 4, 5, 6, 8),
            (0, 1),
        )
        for (
            profile_name,
            blend,
            maximum_distance,
            minimum_candidate_margin,
            maximum_baseline_margin,
            minimum_fixed_votes,
            minimum_exact_anchors,
        ) in parameters:
            selector = gate_selector(
                profile_name,
                blend,
                maximum_distance,
                minimum_candidate_margin,
                maximum_baseline_margin,
                minimum_fixed_votes,
                minimum_exact_anchors,
                vote_family,
            )
            pooled = RULES.metrics(all_cases, denominator, selector)
            if (not args.include_regressions
                    and pooled["exactCount"] < baseline["exactCount"]):
                continue
            folds = {}
            minimum_fold_exact_delta = 10**9
            for dataset in datasets:
                fold = RULES.metrics(
                    dataset.cases[event_type],
                    dataset.denominators[event_type],
                    selector,
                )
                baseline_fold = baseline_folds[dataset.name]
                delta = {
                    "exact": fold["exactCount"] - baseline_fold["exactCount"],
                    "withinOne": (
                        fold["withinOneCount"] - baseline_fold["withinOneCount"]
                    ),
                    "topThree": (
                        fold["topThreeCount"] - baseline_fold["topThreeCount"]
                    ),
                    "mrr": fold["mrrAll"] - baseline_fold["mrrAll"],
                }
                folds[dataset.name] = delta
                minimum_fold_exact_delta = min(
                    minimum_fold_exact_delta,
                    delta["exact"],
                )
            if not args.include_regressions and minimum_fold_exact_delta < 0:
                continue
            changes = RULES.change_counts(all_cases, selector)
            mode_deltas = {}
            for mode, mode_cases in cases_by_mode.items():
                selected = RULES.metrics(mode_cases, len(mode_cases), selector)
                mode_baseline = baseline_by_mode[mode]
                mode_deltas[mode] = {
                    "cases": len(mode_cases),
                    "exact": selected["exactCount"] - mode_baseline["exactCount"],
                    "withinOne": selected["withinOneCount"]
                        - mode_baseline["withinOneCount"],
                    "topThree": selected["topThreeCount"]
                        - mode_baseline["topThreeCount"],
                }
            rows.append({
                "profile": profile_name,
                "blend": blend,
                "maximumDistance": maximum_distance,
                "minimumCandidateMargin": minimum_candidate_margin,
                "maximumBaselineMargin": maximum_baseline_margin,
                "minimumFixedVotes": minimum_fixed_votes,
                "minimumExactAnchors": minimum_exact_anchors,
                "metrics": pooled,
                "changes": changes,
                "foldDeltas": folds,
                "minimumFoldExactDelta": minimum_fold_exact_delta,
                "modeDeltas": mode_deltas,
                "minimumModeExactDelta": min(
                    (row["exact"] for row in mode_deltas.values()),
                    default=0,
                ),
                "allPooledRankingMetricsNonRegressing": (
                    pooled["withinOneCount"] >= baseline["withinOneCount"]
                    and pooled["topThreeCount"] >= baseline["topThreeCount"]
                    and pooled["mrrAll"] >= baseline["mrrAll"]
                ),
            })
        rows.sort(key=lambda row: (
            row["allPooledRankingMetricsNonRegressing"],
            row["minimumModeExactDelta"] >= 0,
            row["metrics"]["exactCount"],
            row["minimumFoldExactDelta"],
            row["minimumModeExactDelta"],
            row["metrics"]["mrrAll"],
            -row["changes"]["losses"],
        ), reverse=True)
        output[event_type] = {
            "baseline": baseline,
            "best": rows[: args.top],
        }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
