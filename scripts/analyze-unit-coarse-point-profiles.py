"""Audit direct coarse-window point localizers on consumed ITRDB cohorts.

This is a diagnostic tool only. It asks whether a single annual evidence profile has a
sharper and more stable event-year peak than the current final-window selector. Cohorts
remain separate in every reported metric so pooled gains cannot conceal a regression.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np


WINDOW_WIDTHS = (5, 7, 9, 13)
TRANSFORMS = ("point", "mass3", "mass5", "sharp", "olderStep", "newerStep")


@dataclass(frozen=True)
class Case:
    split: str
    event_type: str
    false_ring_mode: str | None
    truth_year: int
    years: np.ndarray
    features: dict[str, np.ndarray]
    final_range: tuple[int, int]


def finite(value: Any, fallback: float = -10.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if np.isfinite(result) else fallback


def load_cases(path: Path) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    cases = []
    for row in payload:
        years = np.asarray([int(point["year"]) for point in row["rows"]])
        names = set.intersection(*(
            set(point["features"]) for point in row["rows"]
        ))
        features = {
            name: np.asarray([
                finite(point["features"].get(name)) for point in row["rows"]
            ])
            for name in names
        }
        cases.append(Case(
            split=str(row["split"]),
            event_type=str(row["eventType"]),
            false_ring_mode=(
                str(row["falseRingMode"])
                if row.get("falseRingMode") is not None
                else None
            ),
            truth_year=int(row["truthYear"]),
            years=years,
            features=features,
            final_range=(int(row["finalRange"][0]), int(row["finalRange"][1])),
        ))
    return cases


def shifted(values: np.ndarray, offset: int) -> np.ndarray:
    floor = float(np.min(values) - max(1.0, np.ptp(values)))
    result = np.full(len(values), floor)
    for index in range(len(values)):
        source = index + offset
        if 0 <= source < len(values):
            result[index] = values[source]
    return result


def moving_mean(values: np.ndarray, radius: int) -> np.ndarray:
    return np.asarray([
        float(np.mean(values[max(0, index - radius):index + radius + 1]))
        for index in range(len(values))
    ])


def transformed(values: np.ndarray, name: str) -> np.ndarray:
    if name == "point":
        return values
    if name == "mass3":
        return moving_mean(values, 1)
    if name == "mass5":
        return moving_mean(values, 2)
    older = shifted(values, -1)
    newer = shifted(values, 1)
    if name == "sharp":
        return values - (older + newer) * 0.5
    if name == "olderStep":
        return values - older
    if name == "newerStep":
        return values - newer
    raise ValueError(name)


def selected_year(case: Case, feature: str, transform: str) -> int:
    scores = transformed(case.features[feature], transform)
    order = np.lexsort((-case.years, -scores))
    return int(case.years[order[0]])


def summarize(cases: Sequence[Case], predictions: np.ndarray) -> dict[str, Any]:
    truths = np.asarray([case.truth_year for case in cases])
    signed = predictions - truths
    distances = np.abs(signed)
    dynamic_radius = np.asarray([
        (case.final_range[1] - case.final_range[0]) // 2 for case in cases
    ])
    baseline_hits = np.asarray([
        case.final_range[0] <= case.truth_year <= case.final_range[1]
        for case in cases
    ])
    selected_hits = distances <= dynamic_radius
    return {
        "cases": len(cases),
        "exact": int(np.sum(distances == 0)),
        "within1": int(np.sum(distances <= 1)),
        "within2": int(np.sum(distances <= 2)),
        "within4": int(np.sum(distances <= 4)),
        "within6": int(np.sum(distances <= 6)),
        "coverage": {
            str(width): int(np.sum(distances <= (width - 1) // 2))
            for width in WINDOW_WIDTHS
        },
        "sameWidthCoverage": int(np.sum(selected_hits)),
        "sameWidthGains": int(np.sum(selected_hits & ~baseline_hits)),
        "sameWidthLosses": int(np.sum(~selected_hits & baseline_hits)),
        "medianAbsoluteError": float(np.median(distances)) if len(distances) else 0.0,
        "p90AbsoluteError": float(np.percentile(distances, 90)) if len(distances) else 0.0,
        "meanSignedError": float(np.mean(signed)) if len(signed) else 0.0,
    }


def final_summary(cases: Sequence[Case]) -> dict[str, Any]:
    return {
        "cases": len(cases),
        "covered": sum(
            case.final_range[0] <= case.truth_year <= case.final_range[1]
            for case in cases
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--event-type", choices=("missingRing", "falseRing"), default="falseRing")
    parser.add_argument("--top", type=int, default=30)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--selection-split",
        action="append",
        default=[],
        help="Rank profiles on these splits while still reporting every split",
    )
    parser.add_argument(
        "--feature-prefix",
        default="",
        help="Restrict the diagnostic scan to feature names with this prefix",
    )
    parser.add_argument(
        "--selection-mode",
        default="",
        help="Rank profiles only on this false-ring physical mode",
    )
    args = parser.parse_args()

    cases = [case for case in load_cases(args.dataset) if case.event_type == args.event_type]
    by_split = defaultdict(list)
    by_mode = defaultdict(list)
    by_split_mode = defaultdict(list)
    for index, case in enumerate(cases):
        by_split[case.split].append(index)
        if case.false_ring_mode is not None:
            by_mode[case.false_ring_mode].append(index)
            by_split_mode[f"{case.split}/{case.false_ring_mode}"].append(index)
    common = sorted(set.intersection(*(set(case.features) for case in cases)))
    if args.feature_prefix:
        common = [name for name in common if name.startswith(args.feature_prefix)]
    rows = []
    for feature in common:
        for transform in TRANSFORMS:
            base_predictions = np.asarray([
                selected_year(case, feature, transform) for case in cases
            ])
            for shift in range(-3, 4):
                predictions = base_predictions + shift
                overall = summarize(cases, predictions)
                splits = {
                    name: summarize(
                        [cases[index] for index in indexes],
                        predictions[indexes],
                    )
                    for name, indexes in by_split.items()
                }
                modes = {
                    name: summarize(
                        [cases[index] for index in indexes],
                        predictions[indexes],
                    )
                    for name, indexes in by_mode.items()
                }
                split_modes = {
                    name: summarize(
                        [cases[index] for index in indexes],
                        predictions[indexes],
                    )
                    for name, indexes in by_split_mode.items()
                }
                selection_indexes = [
                    index for index, case in enumerate(cases)
                    if (not args.selection_split or case.split in args.selection_split)
                    and (not args.selection_mode or case.false_ring_mode == args.selection_mode)
                ]
                selection = summarize(
                    [cases[index] for index in selection_indexes],
                    predictions[selection_indexes],
                )
                rows.append({
                    "feature": feature,
                    "transform": transform,
                    "shift": shift,
                    "overall": overall,
                    "selection": selection,
                    "splits": splits,
                    "modes": modes,
                    "splitModes": split_modes,
                    "minimumSplitCoverage13": min(
                        metric["coverage"]["13"] / max(1, metric["cases"])
                        for metric in splits.values()
                    ),
                })
    def mode_sort_key(row: dict[str, Any], mode: str):
        development = [
            row["splitModes"].get(f"{split}/{mode}")
            for split in args.selection_split
        ]
        development = [metric for metric in development if metric is not None]
        return (
            sum(metric["sameWidthCoverage"] for metric in development),
            -sum(metric["sameWidthLosses"] for metric in development),
            sum(metric["coverage"]["13"] for metric in development),
            sum(metric["within2"] for metric in development),
            sum(metric["exact"] for metric in development),
        )

    def compact_mode_row(row: dict[str, Any], mode: str) -> dict[str, Any]:
        return {
            "feature": row["feature"],
            "transform": row["transform"],
            "shift": row["shift"],
            "development": {
                split: row["splitModes"].get(f"{split}/{mode}")
                for split in args.selection_split
            },
            "validation": row["splitModes"].get(f"fresh/{mode}"),
        }

    mode_leaderboards = {
        mode: [
            compact_mode_row(row, mode)
            for row in sorted(
                rows,
                key=lambda candidate, selected_mode=mode: mode_sort_key(
                    candidate,
                    selected_mode,
                ),
                reverse=True,
            )[:args.top]
        ]
        for mode in ("average", "moderate", "splitLike")
    }

    rows.sort(key=lambda row: (
        row["selection"]["sameWidthCoverage"],
        -row["selection"]["sameWidthLosses"],
        row["selection"]["coverage"]["13"],
        row["selection"]["coverage"]["9"],
        row["selection"]["within2"],
        row["selection"]["exact"],
        -row["selection"]["p90AbsoluteError"],
    ), reverse=True)
    report = {
        "eventType": args.event_type,
        "caseCount": len(cases),
        "featureCount": len(common),
        "selectionSplits": args.selection_split,
        "selectionMode": args.selection_mode,
        "baselineFinal": {
            "overall": final_summary(cases),
            "splits": {
                name: final_summary([cases[index] for index in indexes])
                for name, indexes in by_split.items()
            },
            "modes": {
                name: final_summary([cases[index] for index in indexes])
                for name, indexes in by_mode.items()
            },
        },
        "topByDevelopmentMode": mode_leaderboards,
        "top": rows[:args.top],
    }
    rendered = json.dumps(report, indent=2)
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
