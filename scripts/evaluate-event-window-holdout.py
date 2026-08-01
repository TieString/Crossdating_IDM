"""Evaluate frozen breakpoint locators once on untouched offset holdouts.

The profile ensembles and regressor names in this file are selected from offsets
0-12. They must be changed only before evaluating a new holdout directory.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np


HERE = Path(__file__).resolve().parent


def load_module(name: str, filename: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


CALIBRATION = load_module(
    "event_window_calibration_holdout",
    "calibrate-event-window-policy.py",
)
CENTER = load_module(
    "event_center_regressors_holdout",
    "evaluate-event-center-regressors.py",
)

DEV_DIR = Path(".tmp-window-calibration-v117")
HOLDOUT_DIR = Path(".tmp-window-holdout-v117")
OUTPUT_PATH = Path(".tmp-event-window-holdout-v1-report.json")
EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
WIDTHS = (5, 7, 9, 11, 13)

# Frozen before offsets 13-17 were read.
PROFILE_ENSEMBLES = {
    "missingRing": (
        "cumulativeReferenceMean",
        "reference:weightedWindowVote25",
        "stepTurn4",
    ),
    "falseRing": (
        "cumulativeReferenceVote",
        "piecewiseCombinedObjective",
        "reference:weightedWindowVote25",
    ),
    "partialMove": (
        "candidateConsensus",
        "currentPeak",
        "jointPeak",
    ),
}
REGRESSOR_NAMES = {
    "missingRing": "forest_d2_l12",
    "falseRing": "forest_d2_l12",
    "partialMove": "ridge_100",
}


def load_locator_cases(
    directory: Path,
    offsets: range,
) -> list[dict[str, Any]]:
    cases = []
    for offset in offsets:
        path = directory / f"offset-{offset}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        for source in payload.get("counterfactualLocatorCases", []):
            context = source.get("context", {})
            if context.get("baselineFlagged", True):
                continue
            if source.get("correctionYears") != source.get("truthCorrectionYears"):
                continue
            if source.get("eventType") not in EVENT_TYPES:
                continue
            case = dict(source)
            case["offset"] = offset
            CALIBRATION.add_synthetic_profiles(case)
            cases.append(case)
    return cases


def fixed_window_metrics(
    cases: list[dict[str, Any]],
    profiles: tuple[str, ...],
) -> dict[str, Any]:
    by_width = {}
    for width in WIDTHS:
        windows = [
            CALIBRATION.best_window(
                case,
                profiles,
                width,
                CALIBRATION.available_coarse_bounds(case),
            )
            for case in cases
        ]
        center_errors = [
            abs(window.center - case["truthYear"])
            for case, window in zip(cases, windows)
        ]
        by_width[str(width)] = {
            "coverage": CALIBRATION.mean(
                window.contains(case["truthYear"])
                for case, window in zip(cases, windows)
            ),
            "medianCenterError": float(np.median(center_errors)),
            "p90CenterError": float(np.percentile(
                center_errors,
                90,
                method="higher",
            )),
        }
    return {
        "cases": len(cases),
        "profiles": profiles,
        "byWidth": by_width,
    }


def production_mode_metrics(
    cases: list[dict[str, Any]],
) -> dict[str, Any]:
    hits = []
    widths = []
    for case in cases:
        window = case.get("modeWindow") or case["finalWindow"]
        hits.append(
            window["startYear"] <= case["truthYear"] <= window["endYear"]
        )
        widths.append(window["endYear"] - window["startYear"] + 1)
    return {
        "cases": len(cases),
        "coverage": CALIBRATION.mean(hits),
        "medianWidth": float(np.median(widths)),
    }


def fit_frozen_regressor(
    event_type: str,
    development: list[dict[str, Any]],
    holdout: list[dict[str, Any]],
) -> dict[str, Any]:
    requested = REGRESSOR_NAMES[event_type]
    model = dict(CENTER.model_options())[requested]
    train_x = np.asarray([CENTER.case_features(case) for case in development])
    train_y = np.asarray([CENTER.target_position(case) for case in development])
    model.fit(train_x, train_y)
    return {
        "name": requested,
        "development": CENTER.evaluate(development, model),
        "holdout": CENTER.evaluate(holdout, model),
    }


def operation_metrics(
    directory: Path,
    offsets: range,
) -> dict[str, Any]:
    rows = {event_type: [] for event_type in EVENT_TYPES}
    clean_controls = []
    for offset in offsets:
        payload = json.loads(
            (directory / f"offset-{offset}.json").read_text(encoding="utf-8"),
        )
        for row in payload.get("eventCaseOutcomes", []):
            if row.get("eventType") not in EVENT_TYPES:
                continue
            if row.get("context", {}).get("baselineFlagged", True):
                continue
            rows[row["eventType"]].append(row)
        clean_controls.extend(
            row
            for row in payload.get("cleanCaseOutcomes", [])
            if not row.get("context", {}).get("baselineFlagged", True)
        )
    result = {}
    for event_type, selected in rows.items():
        result[event_type] = {
            "cases": len(selected),
            "responseRate": CALIBRATION.mean(
                bool(row.get("answered"))
                for row in selected
            ),
            "exactOperationAccuracy": CALIBRATION.mean(
                bool(row.get("operationMatched"))
                for row in selected
            ),
            "completeAccuracy": CALIBRATION.mean(
                bool(row.get("complete"))
                for row in selected
            ),
        }
        if event_type == "partialMove":
            shifts = sorted(set(
                int(row["truthShiftYears"])
                for row in selected
                if row.get("truthShiftYears") is not None
            ))
            result[event_type]["byShift"] = {
                str(shift): {
                    "cases": len(group),
                    "responseRate": CALIBRATION.mean(
                        bool(row.get("answered"))
                        for row in group
                    ),
                    "exactOperationAccuracy": CALIBRATION.mean(
                        bool(row.get("operationMatched"))
                        for row in group
                    ),
                    "completeAccuracy": CALIBRATION.mean(
                        bool(row.get("complete"))
                        for row in group
                    ),
                }
                for shift in shifts
                if (group := [
                    row for row in selected
                    if row.get("truthShiftYears") == shift
                ])
            }
    result["clean"] = {
        "cases": len(clean_controls),
        "falsePositiveRate": CALIBRATION.mean(
            bool(row.get("falsePositive"))
            for row in clean_controls
        ),
    }
    return result


def main() -> None:
    development = load_locator_cases(DEV_DIR, range(0, 13))
    holdout = load_locator_cases(HOLDOUT_DIR, range(13, 18))
    report: dict[str, Any] = {
        "protocol": {
            "developmentOffsets": list(range(0, 13)),
            "holdoutOffsets": list(range(13, 18)),
            "caseDefinition": (
                "baseline-clean cases with the exact selected operation"
            ),
            "profileEnsemblesFrozenBeforeHoldout": PROFILE_ENSEMBLES,
            "regressorsFrozenBeforeHoldout": REGRESSOR_NAMES,
        },
        "operationMetrics": operation_metrics(
            HOLDOUT_DIR,
            range(13, 18),
        ),
        "byType": {},
    }
    for event_type in EVENT_TYPES:
        development_cases = [
            case for case in development
            if case["eventType"] == event_type
        ]
        holdout_cases = [
            case for case in holdout
            if case["eventType"] == event_type
        ]
        report["byType"][event_type] = {
            "productionMode": {
                "development": production_mode_metrics(development_cases),
                "holdout": production_mode_metrics(holdout_cases),
            },
            "frozenProfileEnsemble": {
                "development": fixed_window_metrics(
                    development_cases,
                    PROFILE_ENSEMBLES[event_type],
                ),
                "holdout": fixed_window_metrics(
                    holdout_cases,
                    PROFILE_ENSEMBLES[event_type],
                ),
            },
            "frozenRegressor": fit_frozen_regressor(
                event_type,
                development_cases,
                holdout_cases,
            ),
        }
    OUTPUT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        event_type: report["byType"][event_type]
        for event_type in EVENT_TYPES
    }, indent=2))


if __name__ == "__main__":
    main()
