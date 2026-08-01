"""Calibrate one-mode 5/7/9/11/13-year diagnosis windows.

The input is the signal-independent, calendar-stratified counterfactual corpus
produced by .tmp-analyze-calibrated-single-window-v2.mjs. Offsets 0-4 train the
confidence models, 5-7 calibrate the minimum confidence for each width, and
8-12 remain untouched validation offsets.

This script is an offline calibration aid. Production inference stays in
TypeScript and receives only the selected profile policy and compact trees.
"""

from __future__ import annotations

import json
import math
import os
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.metrics import roc_auc_score


INPUT_PATH = Path(
    os.environ.get(
        "COUNTERFACTUAL_CASE_DATA_PATH",
        ".tmp-counterfactual-cases-0-12.json",
    )
)
OUTPUT_PATH = Path(
    os.environ.get(
        "NARROW_WINDOW_REPORT_PATH",
        ".tmp-narrow-event-window-calibration-report.json",
    )
)

EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
WIDTHS = (5, 7, 9, 11, 13)
CASE_FEATURE_NAMES = (
    "window_score",
    "window_second_margin",
    "window_remote_margin",
    "window_mass_fraction",
    "profile_peak",
    "profile_peak_gap",
    "profile_sd",
    "profile_center_sd",
    "profile_center_range",
    "center_delta_9",
    "center_delta_13",
    "candidate_center_sd",
    "coarse_center_distance",
    "coarse_edge_clearance",
)

MODE_PROFILES: dict[str, tuple[str, ...]] = {
    "missingRing": ("cumulativeCombined",),
    "falseRing": (
        "comboFull",
        "pairDifferenceWeighted",
        "transitionSplitGain",
    ),
    "partialMove": (
        "cumulativeReferenceVote",
        "cumulativeReferenceMedian",
        "pairDifferenceMean",
    ),
}

NARROW_PROFILES: dict[str, dict[int, tuple[str, ...]]] = {
    "missingRing": {
        5: ("comboFull",),
        7: ("whitenedFull",),
        9: ("whitenedFull",),
        11: ("cumulativeCombined",),
        13: MODE_PROFILES["missingRing"],
    },
    "falseRing": {
        5: ("comboFull",),
        7: ("comboFull",),
        9: ("differenceFull",),
        11: ("whitenedFull", "cumulativeCombined"),
        13: MODE_PROFILES["falseRing"],
    },
    "partialMove": {
        5: ("comboFull", "currentPeak"),
        7: ("comboFull", "currentPeak"),
        9: ("whitenedFull", "comboFull", "currentPeak"),
        11: (
            "cumulativeReferenceMedian",
            "currentWindow",
            "pairDifferenceMean",
        ),
        13: MODE_PROFILES["partialMove"],
    },
}


@dataclass(frozen=True)
class Window:
    start_year: int
    end_year: int
    score: float
    second_margin: float
    remote_margin: float

    @property
    def width(self) -> int:
        return self.end_year - self.start_year + 1

    @property
    def center(self) -> float:
        return (self.start_year + self.end_year) / 2

    def contains(self, year: int) -> bool:
        return self.start_year <= year <= self.end_year


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def percentile_ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    result = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = ((start + end - 1) / 2) / max(1, len(order) - 1)
        for index in order[start:end]:
            result[index] = rank
        start = end
    return result


def fuse_profiles(
    case: dict[str, Any],
    profiles: tuple[str, ...],
    power: float,
    sharpness: float,
) -> list[tuple[int, float]]:
    local_indexes = [
        index
        for index, year in enumerate(case["years"])
        if case["coarse"]["startYear"] <= year <= case["coarse"]["endYear"]
    ]
    base = [
        mean(
            max(0.0, float(case["ranks"][profile][index])) ** power
            for profile in profiles
        )
        for index in local_indexes
    ]
    if sharpness > 0 and len(base) >= 9:
        sharpened: list[float] = []
        for index, value in enumerate(base):
            shoulders = [
                base[other]
                for other in range(max(0, index - 6), min(len(base), index + 7))
                if 3 <= abs(other - index) <= 6
            ]
            contrast = value - mean(shoulders)
            sharpened.append(max(0.0, value + sharpness * contrast))
        base = sharpened
    return [
        (int(case["years"][index]), float(base[local_index]))
        for local_index, index in enumerate(local_indexes)
    ]


def score_windows(
    rows: list[tuple[int, float]],
    width: int,
    predicate: Any = None,
) -> list[Window]:
    if not rows:
        return []
    minimum_year = rows[0][0]
    maximum_year = rows[-1][0]
    maximum_start = maximum_year - width + 1
    candidates: list[tuple[int, int, float]] = []
    for start_year in range(minimum_year, maximum_start + 1):
        end_year = start_year + width - 1
        if predicate is not None and not predicate(start_year, end_year):
            continue
        values = [
            value
            for year, value in rows
            if start_year <= year <= end_year
        ]
        if not values:
            continue
        candidates.append((start_year, end_year, sum(values) / math.sqrt(width)))
    candidates.sort(key=lambda row: (row[2], row[0]), reverse=True)
    result: list[Window] = []
    for start_year, end_year, score in candidates:
        second = candidates[1][2] if len(candidates) > 1 else score
        remote = next(
            (
                candidate[2]
                for candidate in candidates
                if candidate[1] < start_year or candidate[0] > end_year
            ),
            score,
        )
        result.append(
            Window(
                start_year=start_year,
                end_year=end_year,
                score=score,
                second_margin=score - second,
                remote_margin=score - remote,
            )
        )
    return result


def prepare_case(
    source: dict[str, Any],
    event_type: str,
) -> dict[str, Any] | None:
    case = dict(source)
    mode_rows = fuse_profiles(case, MODE_PROFILES[event_type], 1.0, 0.0)
    mode_candidates = score_windows(mode_rows, 13)
    if not mode_candidates:
        return None
    mode = mode_candidates[0]
    windows: dict[int, Window] = {13: mode}
    profile_rows: dict[int, list[tuple[int, float]]] = {13: mode_rows}
    for width in WIDTHS[:-1]:
        rows = fuse_profiles(
            case,
            NARROW_PROFILES[event_type][width],
            1.0,
            0.0,
        )
        candidates = score_windows(
            rows,
            width,
            lambda start, end: (
                start >= mode.start_year and end <= mode.end_year
            ),
        )
        if not candidates:
            return None
        windows[width] = candidates[0]
        profile_rows[width] = rows
    case["windows"] = windows
    case["profileRows"] = profile_rows
    return case


def coverage(cases: list[dict[str, Any]], width: int) -> float:
    if not cases:
        return 0.0
    return mean(
        case["windows"][width].contains(case["truthYear"])
        for case in cases
        if width in case["windows"]
    )


def robust_score(cases: list[dict[str, Any]], width: int) -> dict[str, Any]:
    by_offset = []
    for offset in range(8):
        rows = [case for case in cases if case["offset"] == offset]
        by_offset.append(coverage(rows, width))
    average = mean(by_offset)
    deviation = math.sqrt(mean((value - average) ** 2 for value in by_offset))
    return {
        "byOffset": by_offset,
        "mean": average,
        "minimum": min(by_offset),
        "sd": deviation,
        "score": average - deviation / 2,
    }


def profile_peak_centers(
    case: dict[str, Any],
    profiles: tuple[str, ...],
) -> list[float]:
    centers = []
    for profile in profiles:
        rows = fuse_profiles(case, (profile,), 1.0, 0.0)
        candidates = score_windows(rows, 5)
        if candidates:
            centers.append(candidates[0].center)
    return centers


def case_features(
    case: dict[str, Any],
    profiles: tuple[str, ...],
    width: int,
) -> list[float]:
    rows = case["profileRows"][width]
    window = case["windows"][width]
    values = [value for _, value in rows]
    inside = [
        value
        for year, value in rows
        if window.start_year <= year <= window.end_year
    ]
    total = sum(max(0.0, value) for value in values)
    ordered = sorted(values, reverse=True)
    profile_centers = profile_peak_centers(case, profiles)
    candidate_centers = [
        (candidate["startYear"] + candidate["endYear"]) / 2
        for candidate in case.get("candidates", [])
    ]
    anchor = case["windows"][9]
    return [
        window.score,
        window.second_margin,
        window.remote_margin,
        sum(inside) / max(1e-9, total),
        max(values, default=0.0),
        max(values, default=0.0) - (ordered[1] if len(ordered) > 1 else 0.0),
        float(np.std(values)),
        float(np.std(profile_centers)) / 25 if profile_centers else 0.0,
        (
            max(profile_centers) - min(profile_centers)
        ) / 25 if profile_centers else 0.0,
        abs(window.center - anchor.center) / 25,
        abs(window.center - case["windows"][13].center) / 25,
        (
            float(np.std(candidate_centers)) / 25
            if candidate_centers
            else 0.0
        ),
        (
            abs(
                window.center
                - (
                    case["coarse"]["startYear"]
                    + case["coarse"]["endYear"]
                ) / 2
            )
            / 25
        ),
        min(
            window.start_year - case["coarse"]["startYear"],
            case["coarse"]["endYear"] - window.end_year,
        ) / 25,
    ]


def safe_auc(labels: np.ndarray, scores: np.ndarray) -> float:
    return (
        float(roc_auc_score(labels, scores))
        if len(set(labels.tolist())) > 1
        else 0.5
    )


def calibrated_threshold(
    probabilities: np.ndarray,
    labels: np.ndarray,
    minimum_cases: int = 8,
) -> tuple[float, dict[str, Any]]:
    candidates = sorted(set(float(value) for value in probabilities), reverse=True)
    best: tuple[int, float, float] | None = None
    for threshold in candidates:
        selected = probabilities >= threshold
        count = int(selected.sum())
        if count < minimum_cases:
            continue
        precision = float(labels[selected].mean())
        if precision + 1e-12 < 0.9:
            continue
        candidate = (count, precision, threshold)
        if best is None or candidate > best:
            best = candidate
    if best is None:
        return 1.01, {"selected": 0, "coverage": None}
    return best[2], {"selected": best[0], "coverage": best[1]}


def threshold_candidates(probabilities: np.ndarray) -> list[float]:
    ordered = np.sort(np.unique(probabilities))[::-1]
    if len(ordered) == 0:
        return [1.01]
    counts = {
        0,
        8,
        12,
        16,
        20,
        25,
        32,
        40,
        50,
        65,
        80,
        100,
        125,
        150,
        len(probabilities),
    }
    thresholds = {1.01}
    for count in counts:
        if count <= 0:
            continue
        index = min(len(ordered) - 1, count - 1)
        thresholds.add(float(ordered[index]))
    return sorted(thresholds, reverse=True)


def apply_threshold_policy(
    probabilities: dict[int, np.ndarray],
    labels: dict[int, np.ndarray],
    thresholds: dict[int, float],
) -> dict[str, Any]:
    case_count = len(labels[13])
    selected_widths = np.full(case_count, 13, dtype=int)
    remaining = np.ones(case_count, dtype=bool)
    for width in WIDTHS[:-1]:
        selected = remaining & (probabilities[width] >= thresholds[width])
        selected_widths[selected] = width
        remaining[selected] = False
    hits = np.asarray(
        [
            bool(labels[int(width)][index])
            for index, width in enumerate(selected_widths)
        ]
    )
    conditional = {}
    valid_groups = True
    for width in WIDTHS:
        selected = selected_widths == width
        count = int(selected.sum())
        group_coverage = float(hits[selected].mean()) if count else None
        conditional[width] = {
            "cases": count,
            "coverage": group_coverage,
        }
        if width < 13 and 0 < count < 8:
            valid_groups = False
        if width < 13 and count >= 8 and group_coverage is not None:
            valid_groups = valid_groups and group_coverage >= 0.9
    return {
        "coverage": float(hits.mean()),
        "meanWidth": float(selected_widths.mean()),
        "medianWidth": float(np.median(selected_widths)),
        "p90Width": float(np.percentile(selected_widths, 90, method="higher")),
        "narrowCases": int((selected_widths <= 9).sum()),
        "conditional": conditional,
        "validGroups": valid_groups,
    }


def select_joint_thresholds(
    probabilities: dict[int, np.ndarray],
    labels: dict[int, np.ndarray],
) -> tuple[dict[int, float], dict[str, Any]]:
    candidates = {
        width: threshold_candidates(probabilities[width])
        for width in WIDTHS[:-1]
    }
    baseline_coverage = float(labels[13].mean())
    minimum_coverage = max(0.88, baseline_coverage)
    best: tuple[tuple[float, ...], dict[int, float], dict[str, Any]] | None = None
    for threshold5 in candidates[5]:
        for threshold7 in candidates[7]:
            for threshold9 in candidates[9]:
                for threshold11 in candidates[11]:
                    thresholds = {
                        5: threshold5,
                        7: threshold7,
                        9: threshold9,
                        11: threshold11,
                    }
                    metrics = apply_threshold_policy(
                        probabilities,
                        labels,
                        thresholds,
                    )
                    if (
                        not metrics["validGroups"]
                        or metrics["coverage"] + 1e-12 < minimum_coverage
                    ):
                        continue
                    objective = (
                        float(metrics["medianWidth"] <= 9),
                        metrics["narrowCases"],
                        -metrics["meanWidth"],
                        metrics["coverage"],
                    )
                    if best is None or objective > best[0]:
                        best = (objective, thresholds, metrics)
    if best is None:
        disabled = {width: 1.01 for width in WIDTHS[:-1]}
        return disabled, apply_threshold_policy(
            probabilities,
            labels,
            disabled,
        )
    return best[1], {
        **best[2],
        "baseline13Coverage": baseline_coverage,
        "minimumCoverage": minimum_coverage,
    }


def cross_fitted_probabilities(
    cases: list[dict[str, Any]],
    profiles: tuple[str, ...],
    width: int,
) -> tuple[np.ndarray, np.ndarray]:
    probabilities = np.zeros(len(cases), dtype=float)
    labels = np.asarray(
        [
            case["windows"][width].contains(case["truthYear"])
            for case in cases
        ],
        dtype=int,
    )
    for offset in sorted(set(case["offset"] for case in cases)):
        train_indexes = [
            index
            for index, case in enumerate(cases)
            if case["offset"] != offset
        ]
        validation_indexes = [
            index
            for index, case in enumerate(cases)
            if case["offset"] == offset
        ]
        model = ExtraTreesClassifier(
            n_estimators=160,
            max_depth=4,
            min_samples_leaf=8,
            max_features="sqrt",
            class_weight="balanced",
            random_state=20260730 + width + offset * 100,
        )
        model.fit(
            np.asarray(
                [
                    case_features(cases[index], profiles, width)
                    for index in train_indexes
                ]
            ),
            labels[train_indexes],
        )
        probabilities[validation_indexes] = model.predict_proba(
            np.asarray(
                [
                    case_features(cases[index], profiles, width)
                    for index in validation_indexes
                ]
            )
        )[:, 1]
    return probabilities, labels


def simple_gate_search(
    development: list[dict[str, Any]],
    validation: list[dict[str, Any]],
    profiles: tuple[str, ...],
    width: int,
) -> dict[str, Any]:
    development_x = np.asarray(
        [case_features(case, profiles, width) for case in development]
    )
    development_y = np.asarray(
        [
            case["windows"][width].contains(case["truthYear"])
            for case in development
        ],
        dtype=bool,
    )
    validation_x = np.asarray(
        [case_features(case, profiles, width) for case in validation]
    )
    validation_y = np.asarray(
        [
            case["windows"][width].contains(case["truthYear"])
            for case in validation
        ],
        dtype=bool,
    )
    development_13 = np.asarray(
        [
            case["windows"][13].contains(case["truthYear"])
            for case in development
        ],
        dtype=bool,
    )
    validation_13 = np.asarray(
        [
            case["windows"][13].contains(case["truthYear"])
            for case in validation
        ],
        dtype=bool,
    )
    baseline_coverage = float(development_13.mean())
    predicates = []
    quantiles = np.linspace(0.05, 0.95, 19)
    for feature_index, name in enumerate(CASE_FEATURE_NAMES):
        values = development_x[:, feature_index]
        for threshold in sorted(set(np.quantile(values, quantiles).tolist())):
            for direction in ("atLeast", "atMost"):
                selected = (
                    values >= threshold
                    if direction == "atLeast"
                    else values <= threshold
                )
                count = int(selected.sum())
                if count < 12:
                    continue
                hit_rate = float(development_y[selected].mean())
                if hit_rate < 0.9:
                    continue
                by_offset = []
                for offset in range(8):
                    offset_mask = np.asarray(
                        [case["offset"] == offset for case in development]
                    )
                    group = selected & offset_mask
                    if int(group.sum()) >= 3:
                        by_offset.append(float(development_y[group].mean()))
                stability = min(by_offset, default=hit_rate)
                predicates.append(
                    {
                        "featureIndex": feature_index,
                        "feature": name,
                        "direction": direction,
                        "threshold": float(threshold),
                        "selected": count,
                        "coverage": hit_rate,
                        "minimumOffsetCoverage": stability,
                        "mask": selected,
                        "score": count + stability * 10,
                    }
                )
    predicates.sort(
        key=lambda row: (
            row["score"],
            row["minimumOffsetCoverage"],
            row["coverage"],
        ),
        reverse=True,
    )
    options = predicates[:40]
    combinations = [(option,) for option in options]
    combinations.extend(
        (options[left], options[right])
        for left in range(min(20, len(options)))
        for right in range(left + 1, min(20, len(options)))
    )
    best = None
    for combination in combinations:
        selected = np.ones(len(development), dtype=bool)
        for option in combination:
            selected &= option["mask"]
        count = int(selected.sum())
        if count < 12:
            continue
        hit_rate = float(development_y[selected].mean())
        if hit_rate < 0.9:
            continue
        policy_coverage = float(
            np.where(selected, development_y, development_13).mean()
        )
        if policy_coverage + 1e-12 < baseline_coverage:
            continue
        by_offset = []
        for offset in range(8):
            offset_mask = np.asarray(
                [case["offset"] == offset for case in development]
            )
            group = selected & offset_mask
            if int(group.sum()) >= 3:
                by_offset.append(float(development_y[group].mean()))
        stability = min(by_offset, default=hit_rate)
        score = count + stability * 10
        if best is None or (score, hit_rate) > (best["score"], best["coverage"]):
            best = {
                "conditions": [
                    {
                        key: option[key]
                        for key in (
                            "feature",
                            "featureIndex",
                            "direction",
                            "threshold",
                        )
                    }
                    for option in combination
                ],
                "selected": count,
                "coverage": hit_rate,
                "policyCoverage": policy_coverage,
                "minimumOffsetCoverage": stability,
                "score": score,
            }
    if best is None:
        return {
            "conditions": [],
            "development": {"selected": 0, "coverage": None},
            "validation": {"selected": 0, "coverage": None},
        }
    validation_selected = np.ones(len(validation), dtype=bool)
    for condition in best["conditions"]:
        values = validation_x[:, condition["featureIndex"]]
        validation_selected &= (
            values >= condition["threshold"]
            if condition["direction"] == "atLeast"
            else values <= condition["threshold"]
        )
    development_selected = np.ones(len(development), dtype=bool)
    for condition in best["conditions"]:
        values = development_x[:, condition["featureIndex"]]
        development_selected &= (
            values >= condition["threshold"]
            if condition["direction"] == "atLeast"
            else values <= condition["threshold"]
        )
    development_policy_hits = np.where(
        development_selected,
        development_y,
        development_13,
    )
    validation_policy_hits = np.where(
        validation_selected,
        validation_y,
        validation_13,
    )
    return {
        "conditions": best["conditions"],
        "development": {
            "selected": best["selected"],
            "coverage": best["coverage"],
            "policyCoverage": best["policyCoverage"],
            "minimumOffsetCoverage": best["minimumOffsetCoverage"],
        },
        "validation": {
            "selected": int(validation_selected.sum()),
            "coverage": (
                float(validation_y[validation_selected].mean())
                if validation_selected.any()
                else None
            ),
        },
        "fallback13Policy": {
            "developmentCoverage": float(development_policy_hits.mean()),
            "validationCoverage": float(validation_policy_hits.mean()),
            "validationMedianWidth": (
                width
                if int(validation_selected.sum()) >= len(validation) / 2
                else 13
            ),
            "validationMeanWidth": float(
                np.where(validation_selected, width, 13).mean()
            ),
        },
    }


def summarize_policy(
    cases: list[dict[str, Any]],
    models: dict[int, ExtraTreesClassifier],
    thresholds: dict[int, float],
    event_type: str,
) -> dict[str, Any]:
    widths: list[int] = []
    hits: list[bool] = []
    conditional: dict[int, list[bool]] = {width: [] for width in WIDTHS}
    for case in cases:
        chosen = 13
        for width in WIDTHS[:-1]:
            features = np.asarray([
                case_features(
                    case,
                    NARROW_PROFILES[event_type][width],
                    width,
                )
            ])
            probability = float(models[width].predict_proba(features)[0, 1])
            if probability >= thresholds[width]:
                chosen = width
                break
        hit = case["windows"][chosen].contains(case["truthYear"])
        widths.append(chosen)
        hits.append(hit)
        conditional[chosen].append(hit)
    ordered_widths = sorted(widths)
    return {
        "cases": len(cases),
        "hits": sum(hits),
        "coverage": mean(hits),
        "medianWidth": ordered_widths[len(ordered_widths) // 2],
        "p90Width": ordered_widths[
            min(len(ordered_widths) - 1, math.ceil(len(ordered_widths) * 0.9) - 1)
        ],
        "meanWidth": mean(widths),
        "widthCounts": dict(sorted(Counter(widths).items())),
        "conditionalCoverage": {
            str(width): {
                "cases": len(values),
                "coverage": mean(values) if values else None,
            }
            for width, values in conditional.items()
        },
    }


def main() -> None:
    payload = json.loads(INPUT_PATH.read_text(encoding="utf-8"))
    source_cases = payload["cases"]
    report: dict[str, Any] = {
        "input": str(INPUT_PATH),
        "split": {
            "trainOffsets": [0, 1, 2, 3, 4],
            "calibrationOffsets": [5, 6, 7],
            "validationOffsets": [8, 9, 10, 11, 12],
        },
        "byType": {},
    }

    for event_type in EVENT_TYPES:
        typed = [
            prepared
            for case in source_cases
            if case["eventType"] == event_type
            for prepared in [prepare_case(case, event_type)]
            if prepared is not None
        ]
        profiles = MODE_PROFILES[event_type]
        cases = typed
        development = [case for case in cases if case["offset"] <= 7]
        train = [case for case in cases if case["offset"] <= 4]
        calibration = [case for case in cases if 5 <= case["offset"] <= 7]
        validation = [case for case in cases if case["offset"] >= 8]

        models: dict[int, ExtraTreesClassifier] = {}
        model_report: dict[str, Any] = {}
        independent_thresholds: dict[int, float] = {}
        cross_fitted_probabilities_by_width: dict[int, np.ndarray] = {}
        labels_by_width: dict[int, np.ndarray] = {
            13: np.asarray(
                [
                    case["windows"][13].contains(case["truthYear"])
                    for case in development
                ],
                dtype=int,
            )
        }
        for width in WIDTHS[:-1]:
            width_profiles = NARROW_PROFILES[event_type][width]
            train_x = np.asarray(
                [
                    case_features(case, width_profiles, width)
                    for case in development
                ]
            )
            train_y = np.asarray(
                [
                    case["windows"][width].contains(case["truthYear"])
                    for case in development
                ],
                dtype=int,
            )
            model = ExtraTreesClassifier(
                n_estimators=160,
                max_depth=4,
                min_samples_leaf=8,
                max_features="sqrt",
                class_weight="balanced",
                random_state=20260730 + width,
            )
            model.fit(train_x, train_y)
            models[width] = model
            cross_fitted_p, cross_fitted_y = cross_fitted_probabilities(
                development,
                width_profiles,
                width,
            )
            cross_fitted_probabilities_by_width[width] = cross_fitted_p
            labels_by_width[width] = cross_fitted_y
            validation_x = np.asarray(
                [
                    case_features(case, width_profiles, width)
                    for case in validation
                ]
            )
            validation_y = np.asarray(
                [
                    case["windows"][width].contains(case["truthYear"])
                    for case in validation
                ],
                dtype=int,
            )
            validation_p = model.predict_proba(validation_x)[:, 1]
            threshold, calibration_gate = calibrated_threshold(
                cross_fitted_p,
                cross_fitted_y,
                minimum_cases=12,
            )
            independent_thresholds[width] = threshold
            validation_selected = validation_p >= threshold
            model_report[str(width)] = {
                "threshold": threshold,
                "trainAuc": safe_auc(
                    train_y,
                    model.predict_proba(train_x)[:, 1],
                ),
                "crossFittedAuc": safe_auc(
                    cross_fitted_y,
                    cross_fitted_p,
                ),
                "validationAuc": safe_auc(validation_y, validation_p),
                "crossFittedGate": calibration_gate,
                "validationGate": {
                    "selected": int(validation_selected.sum()),
                    "coverage": (
                        float(validation_y[validation_selected].mean())
                        if validation_selected.any()
                        else None
                    ),
                },
            }

        thresholds, joint_calibration = select_joint_thresholds(
            cross_fitted_probabilities_by_width,
            labels_by_width,
        )
        for width in WIDTHS[:-1]:
            model_report[str(width)]["jointThreshold"] = thresholds[width]

        fixed = {
            split_name: {
                str(width): coverage(rows, width)
                for width in WIDTHS
            }
            for split_name, rows in (
                ("train", train),
                ("calibration", calibration),
                ("validation", validation),
            )
        }
        report["byType"][event_type] = {
            "selectedProfile": {
                "profiles": list(profiles),
                "narrowProfiles": {
                    str(width): list(NARROW_PROFILES[event_type][width])
                    for width in WIDTHS
                },
                "robust13": robust_score(development, 13),
                "robust9": robust_score(development, 9),
            },
            "fixed": fixed,
            "confidenceModels": model_report,
            "simpleGates": {
                str(width): simple_gate_search(
                    development,
                    validation,
                    NARROW_PROFILES[event_type][width],
                    width,
                )
                for width in WIDTHS[:-1]
            },
            "jointCalibration": joint_calibration,
            "singleWidthPolicies": {
                str(width): {
                    "threshold": independent_thresholds[width],
                    "validation": summarize_policy(
                        validation,
                        models,
                        {
                            candidate_width: (
                                independent_thresholds[width]
                                if candidate_width == width
                                else 1.01
                            )
                            for candidate_width in WIDTHS[:-1]
                        },
                        event_type,
                    ),
                }
                for width in WIDTHS[:-1]
            },
            "policy": {
                "train": summarize_policy(train, models, thresholds, event_type),
                "calibration": summarize_policy(
                    calibration,
                    models,
                    thresholds,
                    event_type,
                ),
                "validation": summarize_policy(
                    validation,
                    models,
                    thresholds,
                    event_type,
                ),
            },
        }
        print(
            event_type,
            report["byType"][event_type]["selectedProfile"],
            report["byType"][event_type]["policy"]["validation"],
            flush=True,
        )

    OUTPUT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
