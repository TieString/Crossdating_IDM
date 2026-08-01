"""Train and audit a unique local-mode selector inside the coarse event region."""

from __future__ import annotations

import json
import math
import os
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier


INPUT_PATH = Path(
    os.environ.get(
        "COUNTERFACTUAL_CASE_DATA_PATH",
        ".tmp-counterfactual-cases-0-12.json",
    )
)
OUTPUT_PATH = Path(
    os.environ.get(
        "EVENT_MODE_REPORT_PATH",
        ".tmp-event-mode-selector-report.json",
    )
)

EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
WIDTH = 13
CLUSTER_DISTANCE = 4
CORE_PROFILES = {
    "missingRing": (
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeReferenceMean",
        "cumulativeReferenceVote",
        "comboFull",
        "whitenedFull",
    ),
    "falseRing": (
        "comboFull",
        "differenceFull",
        "whitenedFull",
        "pairDifferenceWeighted",
        "transitionSplitGain",
        "cumulativeCombined",
    ),
    "partialMove": (
        "comboFull",
        "differenceFull",
        "cumulativeReferenceMedian",
        "cumulativeReferenceMean",
        "cumulativeReferenceVote",
        "pairDifferenceMean",
        "currentPeak",
    ),
}
BASE_PROFILES = {
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


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def median(values: Iterable[float]) -> float:
    rows = sorted(values)
    if not rows:
        return 0.0
    middle = len(rows) // 2
    return (
        rows[middle]
        if len(rows) % 2
        else (rows[middle - 1] + rows[middle]) / 2
    )


def contains(window: tuple[int, int], year: int) -> bool:
    return window[0] <= year <= window[1]


def local_rows(case: dict[str, Any], profile: str) -> list[tuple[int, float]]:
    return [
        (int(year), float(case["ranks"][profile][index]))
        for index, year in enumerate(case["years"])
        if contains(
            (
                case["coarse"]["startYear"],
                case["coarse"]["endYear"],
            ),
            year,
        )
    ]


def bounded_window(
    center: float,
    width: int,
    bounds: tuple[int, int],
) -> tuple[int, int]:
    start = round(center) - width // 2
    start = max(bounds[0], min(start, bounds[1] - width + 1))
    return start, start + width - 1


def score_window(
    rows: list[tuple[int, float]],
    window: tuple[int, int],
) -> float:
    values = [
        value for year, value in rows if contains(window, year)
    ]
    return sum(values) / math.sqrt(max(1, len(values)))


def best_window(
    rows: list[tuple[int, float]],
    width: int,
    bounds: tuple[int, int],
) -> tuple[int, int]:
    candidates = [
        bounded_window(year + (width - 1) / 2, width, bounds)
        for year, _ in rows
    ]
    return max(
        candidates,
        key=lambda window: (score_window(rows, window), window[0]),
    )


def cluster_centers(centers: list[float]) -> list[float]:
    if not centers:
        return []
    groups: list[list[float]] = []
    for center in sorted(centers):
        if not groups or center - median(groups[-1]) > CLUSTER_DISTANCE:
            groups.append([center])
        else:
            groups[-1].append(center)
    return [median(group) for group in groups]


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


def prepare_case(
    source: dict[str, Any],
    profile_names: list[str],
) -> dict[str, Any]:
    case = dict(source)
    event_type = case["eventType"]
    bounds = (
        int(case["coarse"]["startYear"]),
        int(case["coarse"]["endYear"]),
    )
    centers: list[float] = []
    peak_centers: dict[str, float] = {}
    for profile in profile_names:
        rows = local_rows(case, profile)
        if not rows:
            continue
        window5 = best_window(rows, 5, bounds)
        peak_center = (window5[0] + window5[1]) / 2
        peak_centers[profile] = peak_center
        if profile in CORE_PROFILES[event_type]:
            centers.append(peak_center)
            for width in (9, 13):
                window = best_window(rows, width, bounds)
                centers.append((window[0] + window[1]) / 2)
    for candidate in case.get("candidates", []):
        centers.append(
            (candidate["startYear"] + candidate["endYear"]) / 2
        )
    clustered = cluster_centers(centers)
    if not clustered:
        clustered = [(bounds[0] + bounds[1]) / 2]

    candidates = []
    for center in clustered:
        window = bounded_window(center, WIDTH, bounds)
        values: list[float] = []
        names: list[str] = []
        for profile in profile_names:
            rows = local_rows(case, profile)
            inside = [
                value for year, value in rows if contains(window, year)
            ]
            outside = [
                value for year, value in rows if not contains(window, year)
            ]
            center_value = min(
                rows,
                key=lambda row: abs(row[0] - center),
            )[1] if rows else 0.0
            peak_delta = abs(peak_centers.get(profile, center) - center) / 25
            names.extend(
                (
                    f"{profile}:mean13",
                    f"{profile}:max13",
                    f"{profile}:contrast13",
                    f"{profile}:center",
                    f"{profile}:peakProximity",
                )
            )
            values.extend(
                (
                    mean(inside),
                    max(inside, default=0.0),
                    mean(inside) - mean(outside),
                    center_value,
                    max(0.0, 1 - peak_delta),
                )
            )
        base_support = mean(
            score_window(local_rows(case, profile), window)
            for profile in BASE_PROFILES[event_type]
        )
        core_votes = sum(
            abs(peak_centers.get(profile, center) - center) <= 3
            for profile in CORE_PROFILES[event_type]
        )
        names.extend(
            (
                "mode:baseSupport",
                "mode:coreVotes",
                "mode:coarseCenterDistance",
                "mode:currentPeakDistance",
                "mode:candidateVote",
            )
        )
        coarse_center = (bounds[0] + bounds[1]) / 2
        current_peak = next(
            (
                case["years"][index]
                for index, rank in enumerate(case["ranks"]["currentPeak"])
                if rank == max(case["ranks"]["currentPeak"])
            ),
            coarse_center,
        )
        candidate_vote = sum(
            abs(
                (
                    candidate["startYear"] + candidate["endYear"]
                ) / 2 - center
            ) <= 4
            for candidate in case.get("candidates", [])
        )
        values.extend(
            (
                base_support,
                core_votes / max(1, len(CORE_PROFILES[event_type])),
                abs(center - coarse_center) / 25,
                abs(center - current_peak) / 25,
                candidate_vote / max(1, len(case.get("candidates", []))),
            )
        )
        candidates.append(
            {
                "center": center,
                "window": window,
                "featureNames": names,
                "features": values,
                "label": int(contains(window, case["truthYear"])),
            }
        )

    # Candidate-relative ranks make the classifier a pairwise mode comparator.
    for feature_index in range(len(candidates[0]["features"])):
        ranks = percentile_ranks(
            [
                candidate["features"][feature_index]
                for candidate in candidates
            ]
        )
        for candidate, rank in zip(candidates, ranks):
            candidate["features"].append(rank)
    candidates[0]["featureNames"].extend(
        f"rank:{name}" for name in candidates[0]["featureNames"][:]
    )
    case["modeCandidates"] = candidates
    return case


def flatten(
    cases: list[dict[str, Any]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    features = []
    labels = []
    weights = []
    for case in cases:
        count = len(case["modeCandidates"])
        for candidate in case["modeCandidates"]:
            features.append(candidate["features"])
            labels.append(candidate["label"])
            weights.append(1 / max(1, count))
    return (
        np.asarray(features, dtype=float),
        np.asarray(labels, dtype=int),
        np.asarray(weights, dtype=float),
    )


def predict_cases(
    model: Any,
    cases: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    results = []
    for case in cases:
        candidates = case["modeCandidates"]
        probabilities = model.predict_proba(
            np.asarray(
                [candidate["features"] for candidate in candidates],
                dtype=float,
            )
        )[:, 1]
        selected_index = max(
            range(len(candidates)),
            key=lambda index: (
                probabilities[index],
                candidates[index]["center"],
            ),
        )
        selected = candidates[selected_index]
        results.append(
            {
                "hit": bool(selected["label"]),
                "oracle": any(candidate["label"] for candidate in candidates),
                "probability": float(probabilities[selected_index]),
                "margin": float(
                    probabilities[selected_index]
                    - max(
                        (
                            value
                            for index, value in enumerate(probabilities)
                            if index != selected_index
                        ),
                        default=probabilities[selected_index],
                    )
                ),
                "window": selected["window"],
            }
        )
    return results


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "cases": len(results),
        "hits": sum(row["hit"] for row in results),
        "coverage": mean(row["hit"] for row in results),
        "oracleCoverage": mean(row["oracle"] for row in results),
        "medianMargin": median(row["margin"] for row in results),
    }


def main() -> None:
    payload = json.loads(INPUT_PATH.read_text(encoding="utf-8"))
    profile_names = payload["retainedFeatures"]
    all_cases = [
        prepare_case(source, profile_names)
        for source in payload["cases"]
    ]
    report: dict[str, Any] = {
        "input": str(INPUT_PATH),
        "width": WIDTH,
        "clusterDistance": CLUSTER_DISTANCE,
        "profileNames": profile_names,
        "byType": {},
    }
    for event_type in EVENT_TYPES:
        typed = [
            case for case in all_cases if case["eventType"] == event_type
        ]
        train = [case for case in typed if case["offset"] <= 4]
        calibration = [
            case for case in typed if 5 <= case["offset"] <= 7
        ]
        validation = [case for case in typed if case["offset"] >= 8]
        train_x, train_y, train_weights = flatten(train)
        configurations = []
        for kind in ("extra", "random"):
            for depth in (2, 3, 4, 5):
                for leaf in (5, 8, 12, 16):
                    model_class = (
                        ExtraTreesClassifier
                        if kind == "extra"
                        else RandomForestClassifier
                    )
                    model = model_class(
                        n_estimators=240,
                        max_depth=depth,
                        min_samples_leaf=leaf,
                        max_features="sqrt",
                        class_weight="balanced",
                        random_state=20260730 + depth * 100 + leaf,
                    )
                    model.fit(
                        train_x,
                        train_y,
                        sample_weight=train_weights,
                    )
                    train_metrics = summarize(predict_cases(model, train))
                    calibration_metrics = summarize(
                        predict_cases(model, calibration)
                    )
                    configurations.append(
                        {
                            "kind": kind,
                            "depth": depth,
                            "leaf": leaf,
                            "model": model,
                            "train": train_metrics,
                            "calibration": calibration_metrics,
                            "score": (
                                calibration_metrics["coverage"]
                                - abs(
                                    train_metrics["coverage"]
                                    - calibration_metrics["coverage"]
                                ) * 0.25
                            ),
                        }
                    )
        configurations.sort(
            key=lambda row: (
                row["score"],
                row["calibration"]["coverage"],
                -row["depth"],
                -row["leaf"],
            ),
            reverse=True,
        )
        selected = configurations[0]
        validation_metrics = summarize(
            predict_cases(selected["model"], validation)
        )
        candidate_counts = [
            len(case["modeCandidates"]) for case in typed
        ]
        report["byType"][event_type] = {
            "configuration": {
                key: selected[key] for key in ("kind", "depth", "leaf")
            },
            "train": selected["train"],
            "calibration": selected["calibration"],
            "validation": validation_metrics,
            "candidateCounts": dict(sorted(Counter(candidate_counts).items())),
            "runnerUp": [
                {
                    "kind": row["kind"],
                    "depth": row["depth"],
                    "leaf": row["leaf"],
                    "train": row["train"],
                    "calibration": row["calibration"],
                }
                for row in configurations[:8]
            ],
        }
        print(event_type, report["byType"][event_type], flush=True)
    OUTPUT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
