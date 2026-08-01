"""Measure whether independent breakpoint centers justify a narrow window."""

from __future__ import annotations

import importlib.util
import json
import statistics
import sys
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "narrow_window_calibration",
    HERE / "calibrate-event-window-policy.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load event-window calibration helpers")
CALIBRATION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CALIBRATION
SPEC.loader.exec_module(CALIBRATION)

EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
PROFILE_GROUPS = {
    "missingRing": (
        "cumulativeReferenceMean",
        "cumulativeReferenceVote",
        "reference:rankMedian",
        "stepTurn4",
    ),
    "falseRing": (
        "cumulativeDifference",
        "cumulativeReferenceMean",
        "reference:rankMedian",
        "piecewiseCombinedObjective",
    ),
    "partialMove": (
        "candidateConsensus",
        "currentPeak",
        "jointPeak",
        "cumulativeDifference",
        "stepTurn4",
    ),
}


def load_cases() -> list[dict[str, Any]]:
    cases = []
    sources = [
        (Path(".tmp-window-calibration-v117"), range(0, 13)),
        (Path(".tmp-window-holdout-v117"), range(13, 18)),
    ]
    for directory, offsets in sources:
        for offset in offsets:
            payload = json.loads(
                (directory / f"offset-{offset}.json").read_text(
                    encoding="utf-8",
                ),
            )
            for source in payload.get("counterfactualLocatorCases", []):
                if source.get("context", {}).get("baselineFlagged", True):
                    continue
                if source.get("correctionYears") != source.get(
                    "truthCorrectionYears",
                ):
                    continue
                if source.get("eventType") not in EVENT_TYPES:
                    continue
                case = dict(source)
                case["offset"] = offset
                case["split"] = (
                    "train"
                    if offset <= 7
                    else "validation"
                    if offset <= 12
                    else "holdout"
                )
                CALIBRATION.add_synthetic_profiles(case)
                cases.append(case)
    return cases


def bounded_center_window(
    center: float,
    width: int,
    bounds: dict[str, int],
) -> tuple[int, int]:
    start = max(
        bounds["startYear"],
        min(
            round(center) - (width - 1) // 2,
            bounds["endYear"] - width + 1,
        ),
    )
    return start, start + width - 1


def case_row(case: dict[str, Any]) -> dict[str, Any]:
    mode = case.get("modeWindow") or case["finalWindow"]
    centers = []
    for profile in PROFILE_GROUPS[case["eventType"]]:
        window = CALIBRATION.best_window(case, (profile,), 5, mode)
        centers.append(window.center)
    current = case.get("currentPrimaryYear")
    if current is not None and mode["startYear"] <= current <= mode["endYear"]:
        centers.append(float(current))
    center = statistics.median(centers)
    deviations = [abs(value - center) for value in centers]
    windows = {
        width: bounded_center_window(center, width, mode)
        for width in (5, 7, 9, 11, 13)
    }
    return {
        "source": case,
        "center": center,
        "centerRange": max(centers) - min(centers),
        "centerMad": statistics.median(deviations),
        "maximumDeviation": max(deviations),
        "modeHit": mode["startYear"] <= case["truthYear"] <= mode["endYear"],
        "hits": {
            width: start <= case["truthYear"] <= end
            for width, (start, end) in windows.items()
        },
    }


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "cases": len(rows),
        "modeCoverage": CALIBRATION.mean(row["modeHit"] for row in rows),
        "coverageByWidth": {
            str(width): CALIBRATION.mean(row["hits"][width] for row in rows)
            for width in (5, 7, 9, 11, 13)
        },
    }


def main() -> None:
    cases = load_cases()
    report: dict[str, Any] = {"byType": {}}
    for event_type in EVENT_TYPES:
        rows = [
            case_row(case)
            for case in cases
            if case["eventType"] == event_type
        ]
        gates = []
        for maximum_range in (0, 1, 2, 3, 4, 5, 6, 8, 10, 12):
            by_split = {}
            for split in ("train", "validation", "holdout"):
                selected = [
                    row for row in rows
                    if row["source"]["split"] == split
                    and row["centerRange"] <= maximum_range
                ]
                by_split[split] = {
                    "cases": len(selected),
                    "share": len(selected) / max(
                        1,
                        len([
                            row for row in rows
                            if row["source"]["split"] == split
                        ]),
                    ),
                    "coverage5": (
                        CALIBRATION.mean(row["hits"][5] for row in selected)
                        if selected
                        else None
                    ),
                }
            gates.append({
                "maximumCenterRange": maximum_range,
                **by_split,
            })
        report["byType"][event_type] = {
            "profiles": PROFILE_GROUPS[event_type],
            "splits": {
                split: summarize([
                    row for row in rows
                    if row["source"]["split"] == split
                ])
                for split in ("train", "validation", "holdout")
            },
            "fiveYearGates": gates,
        }
    Path(".tmp-narrow-window-consensus-report.json").write_text(
        json.dumps(report, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
