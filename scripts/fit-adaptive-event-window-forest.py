"""Fit a risk-gated 5/7/9/11/13-year window policy without widening modes."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "adaptive_window_calibration",
    HERE / "calibrate-event-window-policy.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load event-window calibration helpers")
CALIBRATION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CALIBRATION
SPEC.loader.exec_module(CALIBRATION)

EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
NARROW_WIDTHS = (5, 7, 9, 11)
ALL_WIDTHS = (*NARROW_WIDTHS, 13)
TARGET_CONDITIONAL_COVERAGE = 0.92
MINIMUM_GROUP_CASES = 6

# Frozen from the original 0-7 training profile search.
PROFILES_BY_TYPE = {
    "missingRing": {
        5: (
            "pairPeakKernel9",
            "piecewiseCombinedObjective",
            "cumulativeReferenceMedian",
        ),
        7: (
            "piecewiseCombinedObjective",
            "cumulativeReferenceMedian",
            "pairPeakKernel9",
        ),
        9: ("piecewiseCombinedObjective", "cumulativeDifference"),
        11: ("cumulativeCombined",),
    },
    "falseRing": {
        5: (
            "reference:peakKernel5",
            "transitionSplitGain",
            "cumulativeReferenceMedian",
        ),
        7: (
            "cumulativeDifference",
            "cumulativeReferenceMedian",
            "cumulativeReferenceMean",
        ),
        9: ("pairPeakKernel5", "piecewiseCombinedObjective"),
        11: ("cumulativeReferenceVote", "jointPeak"),
    },
    "partialMove": {
        5: ("cumulativeReferenceMean", "cumulativeReferenceMedian"),
        7: ("cumulativeReferenceMean",),
        9: ("cumulativeReferenceMean",),
        11: ("cumulativeReferenceMean",),
    },
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
                    else "calibration"
                    if offset <= 12
                    else "validation"
                )
                CALIBRATION.add_synthetic_profiles(case)
                cases.append(case)
    return cases


def model_options(seed: int) -> list[tuple[str, Any]]:
    result = []
    for depth in (2, 3, 4):
        for leaf in (4, 8, 12):
            result.extend([
                (
                    f"forest_d{depth}_l{leaf}",
                    RandomForestClassifier(
                        n_estimators=300,
                        max_depth=depth,
                        min_samples_leaf=leaf,
                        max_features=0.7,
                        class_weight="balanced",
                        random_state=seed,
                    ),
                ),
                (
                    f"extra_d{depth}_l{leaf}",
                    ExtraTreesClassifier(
                        n_estimators=300,
                        max_depth=depth,
                        min_samples_leaf=leaf,
                        max_features=0.7,
                        class_weight="balanced",
                        random_state=seed,
                    ),
                ),
            ])
    return result


def probabilities(model: Any, rows: list[dict[str, Any]], width: int) -> list[float]:
    matrix = np.asarray([row["features"][width] for row in rows])
    classes = list(model.classes_)
    if 1 not in classes:
        return [float(classes[0] == 1)] * len(rows)
    return model.predict_proba(matrix)[:, classes.index(1)].tolist()


def calibrate_threshold(
    rows: list[dict[str, Any]],
    predicted: list[float],
    width: int,
) -> float:
    ordered = sorted(
        zip(predicted, rows),
        key=lambda item: item[0],
        reverse=True,
    )
    selected_threshold = 1.1
    for count in range(MINIMUM_GROUP_CASES, len(ordered) + 1):
        prefix = ordered[:count]
        coverage = CALIBRATION.mean(
            row["labels"][width]
            for _, row in prefix
        )
        if coverage >= TARGET_CONDITIONAL_COVERAGE:
            selected_threshold = min(
                selected_threshold,
                prefix[-1][0],
            )
    return selected_threshold


def policy_metrics(
    rows: list[dict[str, Any]],
    predicted: dict[int, list[float]],
    thresholds: dict[int, float],
) -> dict[str, Any]:
    selected_widths = []
    hits = []
    by_width = {
        width: {"cases": 0, "hits": 0}
        for width in ALL_WIDTHS
    }
    for index, row in enumerate(rows):
        width = next(
            (
                candidate
                for candidate in NARROW_WIDTHS
                if predicted[candidate][index] >= thresholds[candidate]
            ),
            13,
        )
        hit = bool(row["labels"][width])
        selected_widths.append(width)
        hits.append(hit)
        by_width[width]["cases"] += 1
        by_width[width]["hits"] += int(hit)
    return {
        "cases": len(rows),
        "coverage": CALIBRATION.mean(hits),
        "medianWidth": float(np.median(selected_widths)),
        "p90Width": float(np.percentile(
            selected_widths,
            90,
            method="higher",
        )),
        "widthCounts": {
            str(width): by_width[width]["cases"]
            for width in ALL_WIDTHS
        },
        "conditionalCoverage": {
            str(width): (
                by_width[width]["hits"] / by_width[width]["cases"]
                if by_width[width]["cases"]
                else None
            )
            for width in ALL_WIDTHS
        },
    }


def main() -> None:
    cases = load_cases()
    report: dict[str, Any] = {
        "targetConditionalCoverage": TARGET_CONDITIONAL_COVERAGE,
        "minimumGroupCases": MINIMUM_GROUP_CASES,
        "byType": {},
    }
    for event_type in EVENT_TYPES:
        prepared = CALIBRATION.prepare_rows(
            [case for case in cases if case["eventType"] == event_type],
            PROFILES_BY_TYPE[event_type],
        )
        split_rows = {
            split: [
                row for row in prepared
                if row["source"]["split"] == split
            ]
            for split in ("train", "calibration", "validation")
        }
        options = []
        for name, prototype in model_options(20260730):
            models = {}
            for width in NARROW_WIDTHS:
                model = prototype.__class__(**prototype.get_params())
                training = split_rows["train"]
                model.fit(
                    np.asarray([
                        row["features"][width]
                        for row in training
                    ]),
                    np.asarray([
                        row["labels"][width]
                        for row in training
                    ], dtype=int),
                )
                models[width] = model
            predicted = {
                split: {
                    width: probabilities(
                        models[width],
                        selected_rows,
                        width,
                    )
                    for width in NARROW_WIDTHS
                }
                for split, selected_rows in split_rows.items()
            }
            thresholds = {
                width: calibrate_threshold(
                    split_rows["calibration"],
                    predicted["calibration"][width],
                    width,
                )
                for width in NARROW_WIDTHS
            }
            metrics = {
                split: policy_metrics(
                    selected_rows,
                    predicted[split],
                    thresholds,
                )
                for split, selected_rows in split_rows.items()
            }
            single_width_policies = {
                str(width): {
                    split: policy_metrics(
                        selected_rows,
                        predicted[split],
                        {
                            candidate: (
                                thresholds[candidate]
                                if candidate == width
                                else 1.1
                            )
                            for candidate in NARROW_WIDTHS
                        },
                    )
                    for split, selected_rows in split_rows.items()
                }
                for width in NARROW_WIDTHS
            }
            options.append({
                "name": name,
                "thresholds": thresholds,
                "singleWidthPolicies": single_width_policies,
                **metrics,
            })
        options.sort(
            key=lambda option: (
                min(
                    option["calibration"]["coverage"],
                    option["validation"]["coverage"],
                ),
                -option["validation"]["medianWidth"],
                option["validation"]["coverage"],
                option["calibration"]["coverage"],
            ),
            reverse=True,
        )
        report["byType"][event_type] = {
            "profilesByWidth": PROFILES_BY_TYPE[event_type],
            "selected": options[0],
            "options": options,
        }
    Path(".tmp-adaptive-event-window-forest-report.json").write_text(
        json.dumps(report, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({
        event_type: report["byType"][event_type]["selected"]
        for event_type in EVENT_TYPES
    }, indent=2))


if __name__ == "__main__":
    main()
