"""Fit a compact 5/7/9/11/13-year event-window policy.

Offsets 0-4 select profiles and fit hit models, offsets 5-7 calibrate the
smallest admissible width, and offsets 8-12 are reported without tuning.
Only baseline-clean cases with the correct selected operation are used.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from sklearn.linear_model import LogisticRegression


INPUT_DIR = Path(os.environ.get(
    "EVENT_WINDOW_AUDIT_DIR",
    ".tmp-window-calibration-v117",
))
REPORT_PATH = Path(os.environ.get(
    "EVENT_WINDOW_REPORT_PATH",
    ".tmp-event-window-policy-report.json",
))
MODEL_PATH = Path(os.environ.get(
    "EVENT_WINDOW_MODEL_PATH",
    ".tmp-event-window-policy-model.json",
))

def integer_set(name: str, fallback: str) -> set[int]:
    return {
        int(value.strip())
        for value in os.environ.get(name, fallback).split(",")
        if value.strip()
    }


EVENT_TYPES = tuple(
    value.strip()
    for value in os.environ.get(
        "EVENT_WINDOW_EVENT_TYPES",
        "missingRing,falseRing,partialMove",
    ).split(",")
    if value.strip()
)
WIDTHS = (5, 7, 9, 11)
ALL_WIDTHS = (*WIDTHS, 13)
TRAIN_OFFSETS = integer_set("EVENT_WINDOW_TRAIN_OFFSETS", "0,1,2,3,4")
CALIBRATION_OFFSETS = integer_set("EVENT_WINDOW_CALIBRATION_OFFSETS", "5,6,7")
VALIDATION_OFFSETS = integer_set(
    "EVENT_WINDOW_VALIDATION_OFFSETS",
    "8,9,10,11,12",
)
ALL_OFFSETS = TRAIN_OFFSETS | CALIBRATION_OFFSETS | VALIDATION_OFFSETS
REQUIRE_BASELINE_CLEAN = (
    os.environ.get("EVENT_WINDOW_REQUIRE_BASELINE_CLEAN", "1") != "0"
)
MINIMUM_CALIBRATION_GROUP = 6
MODE_STRATEGY = os.environ.get(
    "EVENT_WINDOW_MODE_STRATEGY",
    "pairwise",
)
RUN_EXHAUSTIVE_MODE_SEARCH = os.environ.get(
    "EVENT_WINDOW_EXHAUSTIVE_MODE",
) == "1"

SYNTHETIC_PROFILES = (
    "currentPeak",
    "jointPeak",
    "candidateConsensus",
    "stepTurn4",
    "stepContrast2x8",
    "boundaryContrast1x5",
    "referenceContrast2x8",
    "localBoundaryConsensus",
)

FEATURE_NAMES = (
    "windowScore",
    "windowSecondMargin",
    "windowRemoteMargin",
    "windowMassFraction",
    "profilePeak",
    "profilePeakGap",
    "profileSd",
    "candidateCenterSd",
    "candidateCenterRange",
    "candidateAggregateMargin",
    "modeCenterDistance",
    "currentCenterDistance",
    "jointCenterDistance",
    "hasJoint",
    "widerCenterDistance",
    "profileCenterSd",
    "coarseEdgeClearance",
    "jointTopThreeGain",
    "jointRemoteMargin",
    "jointSideRemoteMargin",
    "referenceCount",
    "centerEdgeDistance",
)

MODE_STATISTICS = ("mean", "max", "center", "contrast")
MODE_EXTRA_FEATURE_NAMES = (
    "absoluteCoarseCenterDistance",
    "signedCoarseCenterDistance",
    "olderEdgeClearance",
    "newerEdgeClearance",
)


@dataclass(frozen=True)
class Window:
    start_year: int
    end_year: int
    score: float
    second_margin: float
    remote_margin: float

    @property
    def center(self) -> float:
        return (self.start_year + self.end_year) / 2

    def contains(self, year: int) -> bool:
        return self.start_year <= year <= self.end_year


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def finite(value: Any, fallback: float = 0.0) -> float:
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return fallback
    return converted if math.isfinite(converted) else fallback


def standard_deviation(values: Iterable[float]) -> float:
    rows = list(values)
    center = mean(rows)
    return math.sqrt(mean((value - center) ** 2 for value in rows))


def percentile_ranks(values: list[float]) -> list[float]:
    ordered = sorted(
        ((value, index) for index, value in enumerate(values)),
        key=lambda row: (row[0], row[1]),
    )
    result = [0.0] * len(values)
    start = 0
    while start < len(ordered):
        end = start + 1
        while end < len(ordered) and ordered[end][0] == ordered[start][0]:
            end += 1
        rank = ((start + end - 1) / 2) / max(1, len(ordered) - 1)
        for _, index in ordered[start:end]:
            result[index] = rank
        start = end
    return result


def local_mean(
    values: list[float],
    start: int,
    end: int,
) -> float:
    bounded_start = max(0, start)
    bounded_end = min(len(values) - 1, end)
    if bounded_end < bounded_start:
        return 0.0
    return mean(values[bounded_start:bounded_end + 1])


def local_peak_contrast(
    values: list[float],
    inner_radius: int,
    outer_radius: int,
) -> list[float]:
    result = []
    for index in range(len(values)):
        inner = local_mean(
            values,
            index - inner_radius,
            index + inner_radius,
        )
        left = local_mean(
            values,
            index - outer_radius,
            index - inner_radius - 1,
        )
        right = local_mean(
            values,
            index + inner_radius + 1,
            index + outer_radius,
        )
        result.append(inner - (left + right) / 2)
    return percentile_ranks(result)


def local_slope_turn(
    values: list[float],
    radius: int,
) -> list[float]:
    result = []
    for index in range(len(values)):
        older_far = local_mean(
            values,
            index - radius * 2 + 1,
            index - radius,
        )
        older_near = local_mean(
            values,
            index - radius + 1,
            index,
        )
        newer_near = local_mean(
            values,
            index + 1,
            index + radius,
        )
        newer_far = local_mean(
            values,
            index + radius + 1,
            index + radius * 2,
        )
        rise = older_near - older_far
        fall = newer_near - newer_far
        result.append(min(rise, fall))
    return percentile_ranks(result)


def aggregate_transformed_profiles(
    ranks: dict[str, list[float]],
    profiles: tuple[str, ...],
    transform: Any,
) -> list[float]:
    available = [
        transform(ranks[profile])
        for profile in profiles
        if profile in ranks
    ]
    if not available:
        return [0.0] * len(next(iter(ranks.values()), []))
    return percentile_ranks([
        mean(profile[index] for profile in available)
        for index in range(len(available[0]))
    ])


def split_for(offset: int) -> str:
    if offset in TRAIN_OFFSETS:
        return "train"
    if offset in CALIBRATION_OFFSETS:
        return "calibration"
    return "validation"


def load_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for offset in sorted(ALL_OFFSETS):
        path = INPUT_DIR / f"offset-{offset}.json"
        if not path.exists():
            raise FileNotFoundError(path)
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("counterfactualLocatorCases", []):
            context = source.get("context", {})
            if REQUIRE_BASELINE_CLEAN and context.get("baselineFlagged", True):
                continue
            if source.get("correctionYears") != source.get("truthCorrectionYears"):
                continue
            if source.get("eventType") not in EVENT_TYPES:
                continue
            case = dict(source)
            case["offset"] = offset
            case["split"] = split_for(offset)
            cases.append(case)
    return cases


def add_synthetic_profiles(case: dict[str, Any]) -> None:
    years = case["years"]
    current_year = case.get("currentPrimaryYear")
    joint_year = (case.get("selectedOperation") or {}).get("bestYear")
    candidates = case.get("candidates", [])
    current_values = [
        0.0 if current_year is None else max(0.0, 1 - abs(year - current_year) / 9)
        for year in years
    ]
    joint_values = [
        0.0 if joint_year is None else max(0.0, 1 - abs(year - joint_year) / 9)
        for year in years
    ]
    candidate_values = []
    for year in years:
        candidate_values.append(sum(
            (finite(candidate.get("aggregateScore")) + 0.1)
            * max(
                0.0,
                1 - abs(
                    year
                    - (
                        candidate["startYear"]
                        + candidate["endYear"]
                    ) / 2
                ) / 13,
            )
            for candidate in candidates
        ))
    ranks = {
        **case["ranks"],
        "currentPeak": percentile_ranks(current_values),
        "jointPeak": percentile_ranks(joint_values),
        "candidateConsensus": percentile_ranks(candidate_values),
    }
    step_profiles = (
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeReferenceMean",
        "cumulativeReferenceVote",
    )
    boundary_profiles = (
        "differenceFull",
        "whitenedFull",
        "comboFull",
        "piecewiseCombinedObjective",
        "transitionSplitGain",
    )
    reference_profiles = (
        "pairDifferenceWeighted",
        "pairWhitenedMean",
        "reference:rankMedian",
        "reference:weightedRankMean",
    )
    ranks["stepTurn4"] = aggregate_transformed_profiles(
        ranks,
        step_profiles,
        lambda values: local_slope_turn(values, 4),
    )
    ranks["stepContrast2x8"] = aggregate_transformed_profiles(
        ranks,
        step_profiles,
        lambda values: local_peak_contrast(values, 2, 8),
    )
    ranks["boundaryContrast1x5"] = aggregate_transformed_profiles(
        ranks,
        boundary_profiles,
        lambda values: local_peak_contrast(values, 1, 5),
    )
    ranks["referenceContrast2x8"] = aggregate_transformed_profiles(
        ranks,
        reference_profiles,
        lambda values: local_peak_contrast(values, 2, 8),
    )
    ranks["localBoundaryConsensus"] = percentile_ranks([
        mean((
            ranks["stepTurn4"][index],
            ranks["stepContrast2x8"][index],
            ranks["boundaryContrast1x5"][index],
            ranks["referenceContrast2x8"][index],
        ))
        for index in range(len(years))
    ])
    case["ranks"] = ranks


def mode_window(case: dict[str, Any]) -> dict[str, int]:
    source = (
        case.get("_calibratedModeWindow")
        or case.get("modeWindow")
        or case["finalWindow"]
    )
    return {
        "startYear": int(source["startYear"]),
        "endYear": int(source["endYear"]),
    }


def fused_rows(
    case: dict[str, Any],
    profiles: tuple[str, ...],
    bounds: dict[str, int] | None = None,
) -> list[tuple[int, float]]:
    selected_bounds = bounds or mode_window(case)
    return [
        (
            int(year),
            mean(float(case["ranks"][profile][index]) for profile in profiles),
        )
        for index, year in enumerate(case["years"])
        if (
            selected_bounds["startYear"]
            <= year
            <= selected_bounds["endYear"]
        )
    ]


def score_windows(
    rows: list[tuple[int, float]],
    width: int,
) -> list[Window]:
    if not rows:
        return []
    minimum_year = rows[0][0]
    maximum_start = rows[-1][0] - width + 1
    candidates: list[tuple[int, int, float]] = []
    for start_year in range(minimum_year, maximum_start + 1):
        end_year = start_year + width - 1
        values = [
            value
            for year, value in rows
            if start_year <= year <= end_year
        ]
        if len(values) != width:
            continue
        candidates.append((
            start_year,
            end_year,
            sum(values) / math.sqrt(width),
        ))
    candidates.sort(key=lambda row: (row[2], row[0]), reverse=True)
    result = []
    for index, (start_year, end_year, score) in enumerate(candidates):
        second = next(
            (
                candidate[2]
                for other_index, candidate in enumerate(candidates)
                if other_index != index
            ),
            score,
        )
        remote = next(
            (
                candidate[2]
                for candidate in candidates
                if candidate[1] < start_year or candidate[0] > end_year
            ),
            score,
        )
        result.append(Window(
            start_year,
            end_year,
            score,
            score - second,
            score - remote,
        ))
    return result


def best_window(
    case: dict[str, Any],
    profiles: tuple[str, ...],
    width: int,
    bounds: dict[str, int] | None = None,
) -> Window:
    candidates = score_windows(fused_rows(case, profiles, bounds), width)
    if not candidates:
        raise ValueError(f"No {width}-year window for case")
    return candidates[0]


def coverage(
    cases: list[dict[str, Any]],
    profiles: tuple[str, ...],
    width: int,
    use_coarse_bounds: bool = False,
) -> float:
    return mean(
        best_window(
            case,
            profiles,
            width,
            case["coarseWindow"] if use_coarse_bounds else None,
        ).contains(case["truthYear"])
        for case in cases
    )


def robust_profile_score(
    cases: list[dict[str, Any]],
    profiles: tuple[str, ...],
    width: int,
    use_coarse_bounds: bool = False,
) -> tuple[float, float, float, float, int]:
    by_offset = [
        coverage(
            [case for case in cases if case["offset"] == offset],
            profiles,
            width,
            use_coarse_bounds,
        )
        for offset in sorted(TRAIN_OFFSETS)
    ]
    average = mean(by_offset)
    deviation = standard_deviation(by_offset)
    return (
        average - deviation * 0.35,
        min(by_offset),
        average,
        -deviation,
        -len(profiles),
    )


def select_profiles(
    cases: list[dict[str, Any]],
    event_type: str,
    width: int,
    use_coarse_bounds: bool = False,
) -> tuple[str, ...]:
    typed = [
        case
        for case in cases
        if case["eventType"] == event_type and case["offset"] in TRAIN_OFFSETS
    ]
    available = sorted(set.intersection(*(
        set(case["ranks"])
        for case in typed
    )))
    singles = sorted(
        ((profile,) for profile in available),
        key=lambda profiles: robust_profile_score(
            typed,
            profiles,
            width,
            use_coarse_bounds,
        ),
        reverse=True,
    )
    pool = [profiles[0] for profiles in singles[:8]]
    candidates = list(singles)
    candidates.extend(
        (pool[left], pool[right])
        for left in range(len(pool))
        for right in range(left + 1, len(pool))
    )
    candidates.extend(
        (pool[first], pool[second], pool[third])
        for first in range(min(6, len(pool)))
        for second in range(first + 1, min(6, len(pool)))
        for third in range(second + 1, min(6, len(pool)))
    )
    return max(
        candidates,
        key=lambda profiles: robust_profile_score(
            typed,
            profiles,
            width,
            use_coarse_bounds,
        ),
    )


def enumerate_windows_in_bounds(
    bounds: dict[str, int],
    width: int,
) -> list[tuple[int, int]]:
    return [
        (start_year, start_year + width - 1)
        for start_year in range(
            bounds["startYear"],
            bounds["endYear"] - width + 2,
        )
    ]


def available_coarse_bounds(case: dict[str, Any]) -> dict[str, int]:
    return {
        "startYear": max(
            int(case["coarseWindow"]["startYear"]),
            int(case["years"][0]),
        ),
        "endYear": min(
            int(case["coarseWindow"]["endYear"]),
            int(case["years"][-1]),
        ),
    }


def mode_feature_vector(
    case: dict[str, Any],
    start_year: int,
    end_year: int,
    profiles: tuple[str, ...],
) -> list[float]:
    coarse = available_coarse_bounds(case)
    coarse_indexes = [
        index
        for index, year in enumerate(case["years"])
        if coarse["startYear"] <= year <= coarse["endYear"]
    ]
    inside_indexes = [
        index
        for index in coarse_indexes
        if start_year <= case["years"][index] <= end_year
    ]
    outside_indexes = [
        index for index in coarse_indexes
        if index not in inside_indexes
    ]
    center = (start_year + end_year) / 2
    center_index = min(
        coarse_indexes,
        key=lambda index: abs(case["years"][index] - center),
    )
    features = []
    for profile in profiles:
        values = case["ranks"][profile]
        inside = [float(values[index]) for index in inside_indexes]
        outside = [float(values[index]) for index in outside_indexes]
        features.extend([
            mean(inside),
            max(inside, default=0.0),
            float(values[center_index]),
            mean(inside) - mean(outside),
        ])
    coarse_center = (coarse["startYear"] + coarse["endYear"]) / 2
    features.extend([
        abs(center - coarse_center) / 25,
        (center - coarse_center) / 25,
        (start_year - coarse["startYear"]) / 25,
        (coarse["endYear"] - end_year) / 25,
    ])
    return features


def fit_pairwise_mode_model(
    cases: list[dict[str, Any]],
    profiles: tuple[str, ...],
    regularization: float,
) -> dict[str, Any]:
    differences = []
    labels = []
    for case in cases:
        windows = enumerate_windows_in_bounds(available_coarse_bounds(case), 13)
        rows = [
            (
                start_year,
                end_year,
                mode_feature_vector(
                    case,
                    start_year,
                    end_year,
                    profiles,
                ),
            )
            for start_year, end_year in windows
        ]
        positive = [
            row for row in rows
            if row[0] <= case["truthYear"] <= row[1]
        ]
        negative = [
            row for row in rows
            if not (row[0] <= case["truthYear"] <= row[1])
        ]
        for positive_row in positive:
            for negative_row in negative:
                difference = np.asarray(positive_row[2]) - np.asarray(negative_row[2])
                differences.extend([difference, -difference])
                labels.extend([1, 0])
    matrix = np.asarray(differences)
    target = np.asarray(labels)
    scales = matrix.std(axis=0)
    scales[scales < 1e-9] = 1
    normalized = matrix / scales
    model = LogisticRegression(
        C=regularization,
        fit_intercept=False,
        max_iter=4000,
        random_state=20260730,
    )
    model.fit(normalized, target)
    return {
        "profiles": profiles,
        "statistics": MODE_STATISTICS,
        "extraFeatureNames": MODE_EXTRA_FEATURE_NAMES,
        "weights": (model.coef_[0] / scales).tolist(),
        "regularization": regularization,
    }


def select_mode_with_ranker(
    case: dict[str, Any],
    model: dict[str, Any],
) -> Window:
    candidates = []
    weights = np.asarray(model["weights"])
    profiles = tuple(model["profiles"])
    for start_year, end_year in enumerate_windows_in_bounds(
        available_coarse_bounds(case),
        13,
    ):
        features = mode_feature_vector(
            case,
            start_year,
            end_year,
            profiles,
        )
        candidates.append(Window(
            start_year,
            end_year,
            float(np.dot(weights, features)),
            0,
            0,
        ))
    return max(
        candidates,
        key=lambda window: (window.score, window.start_year),
    )


def mode_ranker_metrics(
    cases: list[dict[str, Any]],
    model: dict[str, Any],
) -> dict[str, Any]:
    selected = [
        select_mode_with_ranker(case, model)
        for case in cases
    ]
    errors = [
        0
        if window.contains(case["truthYear"])
        else min(
            abs(case["truthYear"] - window.start_year),
            abs(case["truthYear"] - window.end_year),
        )
        for case, window in zip(cases, selected)
    ]
    center_errors = [
        abs(window.center - case["truthYear"])
        for case, window in zip(cases, selected)
    ]
    return {
        "cases": len(cases),
        "coverage": mean(error == 0 for error in errors),
        "withinOne": mean(error <= 1 for error in errors),
        "medianCenterError": float(np.median(center_errors)),
        "p90CenterError": float(np.percentile(
            center_errors,
            90,
            method="higher",
        )),
    }


def select_mode_ranker(
    cases: list[dict[str, Any]],
    event_type: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    typed = [case for case in cases if case["eventType"] == event_type]
    training = [
        case for case in typed
        if case["offset"] in TRAIN_OFFSETS
    ]
    calibration = [
        case for case in typed
        if case["offset"] in CALIBRATION_OFFSETS
    ]
    profiles = tuple(sorted(set.intersection(*(
        set(case["ranks"])
        for case in training
    ))))
    options = []
    for regularization in (0.003, 0.01, 0.03, 0.1, 0.3, 1.0):
        model = fit_pairwise_mode_model(
            training,
            profiles,
            regularization,
        )
        train_metrics = mode_ranker_metrics(training, model)
        calibration_metrics = mode_ranker_metrics(calibration, model)
        options.append({
            "model": model,
            "train": train_metrics,
            "calibration": calibration_metrics,
        })
    selected = max(
        options,
        key=lambda option: (
            option["calibration"]["coverage"],
            option["calibration"]["withinOne"],
            -option["calibration"]["medianCenterError"],
            option["train"]["coverage"],
            -option["model"]["regularization"],
        ),
    )
    return selected["model"], {
        "selectedRegularization": selected["model"]["regularization"],
        "train": selected["train"],
        "calibration": selected["calibration"],
        "options": [{
            "regularization": option["model"]["regularization"],
            "train": option["train"],
            "calibration": option["calibration"],
        } for option in options],
    }


def centered_window_in_coarse(
    case: dict[str, Any],
    center: float,
) -> Window:
    bounds = available_coarse_bounds(case)
    start_year = max(
        bounds["startYear"],
        min(
            round(center) - 6,
            bounds["endYear"] - 12,
        ),
    )
    return Window(start_year, start_year + 12, 0, 0, 0)


def mode_baseline_report(
    cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    profiles = sorted(set.intersection(*(
        set(case["ranks"])
        for case in cases
    )))
    strategies = [
        "existingMode",
        "coarseCenter",
        "currentPrimary",
        "jointBest",
        *[f"profile:{profile}" for profile in profiles],
    ]

    def select(case: dict[str, Any], strategy: str) -> Window:
        if strategy == "existingMode":
            source = case.get("modeWindow") or case["finalWindow"]
            return Window(
                source["startYear"],
                source["endYear"],
                0,
                0,
                0,
            )
        if strategy == "coarseCenter":
            coarse = available_coarse_bounds(case)
            return centered_window_in_coarse(
                case,
                (coarse["startYear"] + coarse["endYear"]) / 2,
            )
        if strategy == "currentPrimary":
            return centered_window_in_coarse(
                case,
                case.get("currentPrimaryYear")
                or (
                    case["currentWindow"]["startYear"]
                    + case["currentWindow"]["endYear"]
                ) / 2,
            )
        if strategy == "jointBest":
            operation = case.get("selectedOperation") or {}
            return centered_window_in_coarse(
                case,
                operation.get("bestYear")
                or (
                    case["currentWindow"]["startYear"]
                    + case["currentWindow"]["endYear"]
                ) / 2,
            )
        return best_window(
            case,
            (strategy.removeprefix("profile:"),),
            13,
            available_coarse_bounds(case),
        )

    result = []
    for strategy in strategies:
        split_metrics = {}
        for split in ("train", "calibration", "validation"):
            selected_cases = [
                case for case in cases
                if case["split"] == split
            ]
            windows = [
                select(case, strategy)
                for case in selected_cases
            ]
            split_metrics[split] = {
                "cases": len(selected_cases),
                "coverage": mean(
                    window.contains(case["truthYear"])
                    for case, window in zip(selected_cases, windows)
                ),
                "medianCenterError": float(np.median([
                    abs(window.center - case["truthYear"])
                    for case, window in zip(selected_cases, windows)
                ])),
            }
        result.append({
            "strategy": strategy,
            **split_metrics,
        })
    return sorted(
        result,
        key=lambda row: (
            row["train"]["coverage"],
            row["calibration"]["coverage"],
            -row["train"]["medianCenterError"],
        ),
        reverse=True,
    )


def exhaustive_mode_ensemble_report(
    cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    profiles = sorted(set.intersection(*(
        set(case["ranks"])
        for case in cases
    )))
    profile_sets = [
        *(tuple([profile]) for profile in profiles),
        *combinations(profiles, 2),
        *combinations(profiles, 3),
    ]
    rows = []
    for selected_profiles in profile_sets:
        metrics = {}
        for split in ("train", "calibration", "validation"):
            selected_cases = [
                case for case in cases
                if case["split"] == split
            ]
            metrics[split] = coverage(
                selected_cases,
                selected_profiles,
                13,
                use_coarse_bounds=True,
            )
        rows.append({
            "profiles": selected_profiles,
            **metrics,
            "minimum": min(metrics.values()),
            "mean": mean(metrics.values()),
        })
    rows.sort(
        key=lambda row: (
            row["minimum"],
            row["mean"],
            row["validation"],
            -len(row["profiles"]),
        ),
        reverse=True,
    )
    return rows[:30]


def profile_center_sd(
    case: dict[str, Any],
    profiles: tuple[str, ...],
) -> float:
    centers = [
        best_window(case, (profile,), 5).center
        for profile in profiles
    ]
    return standard_deviation(centers) / 13


def feature_vector(
    case: dict[str, Any],
    profiles: tuple[str, ...],
    width: int,
    windows: dict[int, Window],
) -> list[float]:
    window = windows[width]
    rows = fused_rows(case, profiles)
    values = [value for _, value in rows]
    inside = [
        value
        for year, value in rows
        if window.start_year <= year <= window.end_year
    ]
    ordered_values = sorted(values, reverse=True)
    candidate_centers = [
        (candidate["startYear"] + candidate["endYear"]) / 2
        for candidate in case.get("candidates", [])
    ]
    aggregate_scores = sorted(
        (
            finite(candidate.get("aggregateScore"))
            for candidate in case.get("candidates", [])
        ),
        reverse=True,
    )
    mode = mode_window(case)
    mode_center = (mode["startYear"] + mode["endYear"]) / 2
    current_year = case.get("currentPrimaryYear")
    operation = case.get("selectedOperation") or {}
    joint_year = operation.get("bestYear")
    wider_width = next(
        (candidate for candidate in ALL_WIDTHS if candidate > width),
        13,
    )
    wider_center = (
        windows[wider_width].center
        if wider_width in windows
        else mode_center
    )
    total = sum(max(0.0, value) for value in values)
    target_start = case["years"][0]
    target_end = case["years"][-1]
    target_width = max(1, target_end - target_start)
    center = window.center
    return [
        window.score,
        window.second_margin,
        window.remote_margin,
        sum(max(0.0, value) for value in inside) / max(1e-9, total),
        max(values, default=0.0),
        (
            ordered_values[0] - ordered_values[1]
            if len(ordered_values) > 1
            else 0.0
        ),
        standard_deviation(values),
        standard_deviation(candidate_centers) / 25,
        (
            (max(candidate_centers) - min(candidate_centers)) / 25
            if candidate_centers
            else 0.0
        ),
        (
            aggregate_scores[0] - aggregate_scores[1]
            if len(aggregate_scores) > 1
            else aggregate_scores[0] if aggregate_scores else 0.0
        ),
        abs(center - mode_center) / 13,
        0.0 if current_year is None else abs(center - current_year) / 13,
        0.0 if joint_year is None else abs(center - joint_year) / 13,
        float(joint_year is not None),
        abs(center - wider_center) / 13,
        profile_center_sd(case, profiles),
        min(
            window.start_year - mode["startYear"],
            mode["endYear"] - window.end_year,
        ) / 13,
        finite(operation.get("topThreeDifferenceGain")),
        finite(operation.get("remoteDifferenceMargin")),
        finite(operation.get("sideStepRemoteMargin")),
        finite(case.get("context", {}).get("referenceCount")) / 20,
        min(center - target_start, target_end - center) / target_width,
    ]


def prepare_rows(
    cases: list[dict[str, Any]],
    profiles_by_width: dict[int, tuple[str, ...]],
) -> list[dict[str, Any]]:
    prepared = []
    for case in cases:
        windows = {
            width: best_window(case, profiles_by_width[width], width)
            for width in WIDTHS
        }
        mode = mode_window(case)
        windows[13] = Window(
            mode["startYear"],
            mode["endYear"],
            0,
            0,
            0,
        )
        prepared.append({
            "source": case,
            "windows": windows,
            "features": {
                width: feature_vector(
                    case,
                    profiles_by_width[width],
                    width,
                    windows,
                )
                for width in WIDTHS
            },
            "labels": {
                width: windows[width].contains(case["truthYear"])
                for width in ALL_WIDTHS
            },
        })
    return prepared


def fit_model(rows: list[dict[str, Any]], width: int) -> dict[str, Any]:
    training = [
        row for row in rows
        if row["source"]["offset"] in TRAIN_OFFSETS
    ]
    matrix = np.asarray([row["features"][width] for row in training])
    labels = np.asarray([row["labels"][width] for row in training], dtype=int)
    centers = matrix.mean(axis=0)
    scales = matrix.std(axis=0)
    scales[scales < 1e-9] = 1
    normalized = (matrix - centers) / scales
    if len(set(labels.tolist())) < 2:
        coefficients = np.zeros(matrix.shape[1])
        probability = min(1 - 1e-6, max(1e-6, float(labels.mean())))
        intercept = math.log(probability / (1 - probability))
    else:
        model = LogisticRegression(
            C=0.3,
            class_weight="balanced",
            max_iter=4000,
            random_state=20260730 + width,
        )
        model.fit(normalized, labels)
        coefficients = model.coef_[0]
        intercept = float(model.intercept_[0])
    return {
        "centers": centers.tolist(),
        "scales": scales.tolist(),
        "coefficients": coefficients.tolist(),
        "intercept": intercept,
    }


def predict(model: dict[str, Any], features: list[float]) -> float:
    values = np.asarray(features)
    normalized = (
        values - np.asarray(model["centers"])
    ) / np.asarray(model["scales"])
    score = float(np.dot(normalized, model["coefficients"]) + model["intercept"])
    return 1 / (1 + math.exp(max(-30, min(30, -score))))


def policy_metrics(
    rows: list[dict[str, Any]],
    probabilities: dict[int, list[float]],
    thresholds: dict[int, float],
) -> dict[str, Any]:
    chosen_widths = []
    hits = []
    for index, row in enumerate(rows):
        width = next(
            (
                candidate
                for candidate in WIDTHS
                if probabilities[candidate][index] >= thresholds[candidate]
            ),
            13,
        )
        chosen_widths.append(width)
        hits.append(bool(row["labels"][width]))
    widths_array = np.asarray(chosen_widths)
    hit_array = np.asarray(hits)
    conditional = {}
    for width in ALL_WIDTHS:
        selected = widths_array == width
        count = int(selected.sum())
        conditional[str(width)] = {
            "cases": count,
            "coverage": float(hit_array[selected].mean()) if count else None,
        }
    return {
        "cases": len(rows),
        "coverage": float(hit_array.mean()) if len(rows) else 0.0,
        "medianWidth": float(np.median(widths_array)) if len(rows) else 0.0,
        "p90Width": (
            float(np.percentile(widths_array, 90, method="higher"))
            if len(rows)
            else 0.0
        ),
        "meanWidth": float(widths_array.mean()) if len(rows) else 0.0,
        "widthCounts": {
            str(width): int((widths_array == width).sum())
            for width in ALL_WIDTHS
        },
        "conditional": conditional,
    }


def threshold_options(probabilities: list[float]) -> list[float]:
    unique = sorted(set(probabilities), reverse=True)
    return [1.1, *unique, -0.1]


def calibrate_thresholds(
    rows: list[dict[str, Any]],
    probabilities: dict[int, list[float]],
) -> tuple[dict[int, float], dict[str, Any]]:
    states = [({width: 1.1 for width in WIDTHS}, set(range(len(rows))))]
    for width in WIDTHS:
        expanded = []
        for thresholds, remaining in states:
            ordered = sorted(
                remaining,
                key=lambda index: probabilities[width][index],
                reverse=True,
            )
            for threshold in threshold_options([
                probabilities[width][index]
                for index in ordered
            ]):
                selected = {
                    index for index in remaining
                    if probabilities[width][index] >= threshold
                }
                if 0 < len(selected) < MINIMUM_CALIBRATION_GROUP:
                    continue
                target = 0.95 if width in (5, 7) else 0.9
                if selected and mean(
                    rows[index]["labels"][width]
                    for index in selected
                ) + 1e-12 < target:
                    continue
                expanded.append((
                    {**thresholds, width: threshold},
                    remaining - selected,
                ))
        expanded.sort(
            key=lambda state: (
                len(state[1]),
                sum(
                    width
                    for width, threshold in state[0].items()
                    if threshold < 1.1
                ),
            ),
        )
        states = expanded[:1200]

    candidates = []
    for thresholds, _ in states:
        metrics = policy_metrics(rows, probabilities, thresholds)
        valid_groups = all(
            group["cases"] == 0
            or group["cases"] >= MINIMUM_CALIBRATION_GROUP
            for width, group in metrics["conditional"].items()
            if int(width) < 13
        )
        if not valid_groups or metrics["coverage"] + 1e-12 < 0.9:
            continue
        objective = (
            int(metrics["medianWidth"] <= 9),
            metrics["widthCounts"]["5"],
            metrics["widthCounts"]["5"] + metrics["widthCounts"]["7"],
            sum(
                metrics["widthCounts"][str(width)]
                for width in (5, 7, 9)
            ),
            -metrics["meanWidth"],
            metrics["coverage"],
        )
        candidates.append((objective, thresholds, metrics))
    if not candidates:
        thresholds = {width: 1.1 for width in WIDTHS}
        return thresholds, policy_metrics(rows, probabilities, thresholds)
    _, thresholds, metrics = max(candidates, key=lambda row: row[0])
    return thresholds, metrics


def fixed_metrics(rows: list[dict[str, Any]]) -> dict[str, float]:
    return {
        str(width): mean(row["labels"][width] for row in rows)
        for width in ALL_WIDTHS
    }


def main() -> None:
    cases = load_cases()
    for case in cases:
        add_synthetic_profiles(case)

    report: dict[str, Any] = {
        "inputDirectory": str(INPUT_DIR),
        "caseDefinition": (
            (
                "baseline-clean and selected operation exactly correct"
                if REQUIRE_BASELINE_CLEAN
                else "crossdated source and selected operation exactly correct"
            )
        ),
        "splits": {
            "train": sorted(TRAIN_OFFSETS),
            "calibration": sorted(CALIBRATION_OFFSETS),
            "validation": sorted(VALIDATION_OFFSETS),
        },
        "featureNames": FEATURE_NAMES,
        "byType": {},
    }
    exported_model: dict[str, Any] = {
        "schemaVersion": 1,
        "featureNames": FEATURE_NAMES,
        "widths": ALL_WIDTHS,
        "byType": {},
    }

    for event_type in EVENT_TYPES:
        typed_cases = [
            case for case in cases
            if case["eventType"] == event_type
        ]
        if MODE_STRATEGY == "existing":
            mode_ranker = None
            mode_ranker_report = {
                "strategy": "existing_production_mode",
            }
        else:
            mode_ranker, mode_ranker_report = select_mode_ranker(
                cases,
                event_type,
            )
            for case in typed_cases:
                mode = select_mode_with_ranker(case, mode_ranker)
                case["_calibratedModeWindow"] = {
                    "startYear": mode.start_year,
                    "endYear": mode.end_year,
                }
        profiles_by_width = {
            width: select_profiles(cases, event_type, width)
            for width in WIDTHS
        }
        rows = prepare_rows(typed_cases, profiles_by_width)
        models = {
            width: fit_model(rows, width)
            for width in WIDTHS
        }
        split_rows = {
            split: [
                row for row in rows
                if row["source"]["split"] == split
            ]
            for split in ("train", "calibration", "validation")
        }
        probabilities = {
            split: {
                width: [
                    predict(models[width], row["features"][width])
                    for row in selected_rows
                ]
                for width in WIDTHS
            }
            for split, selected_rows in split_rows.items()
        }
        thresholds, calibration_metrics = calibrate_thresholds(
            split_rows["calibration"],
            probabilities["calibration"],
        )
        metrics = {
            split: policy_metrics(
                selected_rows,
                probabilities[split],
                thresholds,
            )
            for split, selected_rows in split_rows.items()
        }
        metrics["calibration"] = calibration_metrics
        report["byType"][event_type] = {
            "caseCounts": {
                split: len(selected_rows)
                for split, selected_rows in split_rows.items()
            },
            "profilesByWidth": {
                str(width): profiles_by_width[width]
                for width in WIDTHS
            },
            "modeRanker": {
                **mode_ranker_report,
                **({} if mode_ranker is None else {
                    "validation": mode_ranker_metrics(
                        [
                            row["source"]
                            for row in split_rows["validation"]
                        ],
                        mode_ranker,
                    ),
                }),
            },
            "modeBaselines": mode_baseline_report(typed_cases),
            "modeEnsembles": (
                exhaustive_mode_ensemble_report(typed_cases)
                if RUN_EXHAUSTIVE_MODE_SEARCH
                else []
            ),
            "fixedCoverage": {
                split: fixed_metrics(selected_rows)
                for split, selected_rows in split_rows.items()
            },
            "thresholds": {
                str(width): thresholds[width]
                for width in WIDTHS
            },
            "policy": metrics,
        }
        exported_model["byType"][event_type] = {
            "modeStrategy": MODE_STRATEGY,
            **({} if mode_ranker is None else {
                "modeRanker": mode_ranker,
            }),
            "profilesByWidth": {
                str(width): profiles_by_width[width]
                for width in WIDTHS
            },
            "models": {
                str(width): {
                    **models[width],
                    "threshold": thresholds[width],
                }
                for width in WIDTHS
            },
        }

    REPORT_PATH.write_text(
        json.dumps(report, indent=2),
        encoding="utf-8",
    )
    MODEL_PATH.write_text(
        json.dumps(exported_model, separators=(",", ":")),
        encoding="utf-8",
    )
    print(json.dumps({
        event_type: {
            "calibration": report["byType"][event_type]["policy"]["calibration"],
            "validation": report["byType"][event_type]["policy"]["validation"],
        }
        for event_type in EVENT_TYPES
    }, indent=2))


if __name__ == "__main__":
    main()
