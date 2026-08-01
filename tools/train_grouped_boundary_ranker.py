"""Evaluate grouped learning-to-rank for one narrow diagnosis window.

This is an offline experiment. It reads the frozen arbitrary-calendar-year audit rows,
uses offsets 0-6 for fitting, offset 7 for early stopping, and offsets 8-12 as a
file-disjoint development holdout. The model selects exactly one operation/year row.
"""

from __future__ import annotations

import gc
import json
import math
import os
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import lightgbm as lgb
import numpy as np
from scipy.stats import rankdata

warnings.filterwarnings(
    "ignore",
    message="X does not have valid feature names",
    category=UserWarning,
)


ROOT = Path(__file__).resolve().parents[1]
AUDIT_ROOTS = [
    ROOT / ".tmp-window-ranker-broad",
    ROOT / ".tmp-window-ranker",
]
TRAIN_OFFSETS = tuple(range(7))
VALIDATION_OFFSETS = (7,)
TEST_OFFSETS = tuple(range(8, 13))
EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
WINDOW_RADIUS = int(os.environ.get("GROUPED_RANK_WINDOW_RADIUS", "4"))
RANDOM_SEED = 41729

SCORE_FEATURES = (
    "rawFull",
    "differenceFull",
    "whitenedFull",
    "comboFull",
    "differenceGain21",
    "differenceGain31",
    "differenceGain41",
    "differenceGain61",
    "whitenedGain31",
    "whitenedGain61",
    "pairDifferenceMean",
    "pairDifferenceMedian",
    "pairDifferenceTrimmed",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "pairWhitenedMedian",
    "pairDifferenceMeanGain",
    "pairDifferenceTrimmedGain",
    "pairWhitenedMeanGain",
    "piecewiseCombinedObjective",
    "piecewiseCombinedGain",
    "piecewiseCofechaObjective",
    "piecewiseWhitenedObjective",
    "piecewiseDifferenceObjective",
    "cumulativeCombined",
    "cumulativeContrast",
    "cumulativeLocal31",
    "cumulativeLocal61",
    "cumulativeRaw",
    "cumulativeRawContrast",
    "cumulativeDifference",
    "cumulativeDifferenceContrast",
    "cumulativeWhitened",
    "cumulativeWhitenedContrast",
    "cumulativeCofecha",
    "cumulativeCofechaContrast",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMedianContrast",
    "cumulativeReferenceMean",
    "cumulativeReferenceMeanContrast",
    "cumulativeReferenceVote",
    "cumulativeReferenceVoteContrast",
)

SHIFTED_FEATURES = (
    "rawFull",
    "differenceFull",
    "whitenedFull",
    "comboFull",
    "differenceGain31",
    "differenceGain61",
    "whitenedGain31",
    "whitenedGain61",
    "pairDifferenceMean",
    "pairDifferenceTrimmed",
    "pairWhitenedMean",
    "pairDifferenceMeanGain",
    "pairWhitenedMeanGain",
    "piecewiseCombinedObjective",
    "piecewiseCofechaObjective",
    "piecewiseWhitenedObjective",
    "piecewiseDifferenceObjective",
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeWhitened",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
)

ANCHOR_NAMES = (
    "currentTop",
    "profile",
    "scan",
    "rawPath",
    "candidate",
    "direct",
    "paired",
    "reference",
)

FAMILIES = {
    "localized": (
        "rawFull",
        "differenceFull",
        "whitenedFull",
        "comboFull",
        "differenceGain31",
        "differenceGain61",
        "whitenedGain31",
        "whitenedGain61",
    ),
    "pairwise": (
        "pairDifferenceMean",
        "pairDifferenceTrimmed",
        "pairDifferenceWeighted",
        "pairWhitenedMean",
        "pairDifferenceMeanGain",
        "pairWhitenedMeanGain",
    ),
    "piecewise": (
        "piecewiseCombinedObjective",
        "piecewiseCombinedGain",
        "piecewiseCofechaObjective",
        "piecewiseWhitenedObjective",
        "piecewiseDifferenceObjective",
    ),
    "cumulative": (
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeWhitened",
        "cumulativeReferenceMedian",
        "cumulativeReferenceMean",
        "cumulativeReferenceVote",
    ),
}


@dataclass
class PreparedCase:
    event_type: str
    offset: int
    group_id: str
    truth_year: int
    truth_shift: int | None
    years: np.ndarray
    shifts: np.ndarray
    features: np.ndarray
    labels: np.ndarray
    current_range: tuple[int, int] | None
    current_shift: int | None


def audit_path(offset: int) -> Path:
    name = f"offset-{offset}-cases-25.json"
    path = next((root / name for root in AUDIT_ROOTS if (root / name).exists()), None)
    if path is None:
        raise FileNotFoundError(name)
    return path


def finite(value: Any, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def percentile(values: np.ndarray) -> np.ndarray:
    if len(values) <= 1:
        return np.full(len(values), 0.5, dtype=np.float32)
    return ((rankdata(values, method="average") - 1) / (len(values) - 1)).astype(
        np.float32
    )


def feature_schema(base_names: list[str]) -> list[str]:
    return [
        *[f"raw:{name}" for name in base_names],
        *[f"rank:{name}" for name in SCORE_FEATURES],
        *[
            f"rank:{name}@{delta:+d}"
            for name in SHIFTED_FEATURES
            for delta in (-3, -2, -1, 1, 2, 3)
        ],
        *[f"prominence:{name}" for name in SHIFTED_FEATURES],
        *[f"smooth5:{name}" for name in SHIFTED_FEATURES],
        *[
            f"anchor:{name}:{shape}"
            for name in ANCHOR_NAMES
            for shape in ("near3", "near8", "older", "newer")
        ],
        *[
            f"family:{family}:{summary}"
            for family in FAMILIES
            for summary in ("mean", "max", "top90", "top97")
        ],
        "consensus:mean",
        "consensus:top90",
        "consensus:top97",
        "case:currentScore",
        "case:currentMargin",
        "case:signalStrength",
        "case:referenceCount",
        "case:olderContext",
        "case:newerContext",
        "case:hasCurrentRange",
        "case:currentRangeDistance",
    ]


def separated_peaks(
    rows: list[dict[str, Any]],
    indices: list[int],
    feature_name: str,
    count: int = 4,
) -> list[int]:
    ordered = sorted(
        indices,
        key=lambda index: (
            finite(rows[index]["features"].get(feature_name), -1e12),
            rows[index]["year"],
        ),
        reverse=True,
    )
    selected: list[int] = []
    for index in ordered:
        if len(selected) >= count:
            break
        year = int(rows[index]["year"])
        if all(abs(year - int(rows[other]["year"])) > WINDOW_RADIUS * 2 + 1 for other in selected):
            selected.append(index)
    return selected


def candidate_indices(rows: list[dict[str, Any]]) -> list[int]:
    by_shift: dict[int, list[int]] = {}
    for index, row in enumerate(rows):
        shift = int(round(finite(row["features"].get("candidateLag"))))
        by_shift.setdefault(shift, []).append(index)

    selected: set[int] = set()
    for shift_indices in by_shift.values():
        by_year = {int(rows[index]["year"]): index for index in shift_indices}
        peak_indices: set[int] = set()
        for name in SCORE_FEATURES:
            peak_indices.update(separated_peaks(rows, shift_indices, name))
        for anchor in ANCHOR_NAMES:
            if anchor == "currentTop":
                continue
            available_name = f"{anchor}Available"
            distance_name = f"{anchor}Distance"
            available = [
                index
                for index in shift_indices
                if finite(rows[index]["features"].get(available_name)) > 0
            ]
            if available:
                peak_indices.add(
                    min(
                        available,
                        key=lambda index: finite(
                            rows[index]["features"].get(distance_name), 1
                        ),
                    )
                )
        current_rows = [
            index
            for index in shift_indices
            if finite(rows[index]["features"].get("insideCurrentWindow")) > 0
        ]
        peak_indices.update(current_rows)
        for peak_index in peak_indices:
            peak_year = int(rows[peak_index]["year"])
            for delta in range(-WINDOW_RADIUS, WINDOW_RADIUS + 1):
                neighbor = by_year.get(peak_year + delta)
                if neighbor is not None:
                    selected.add(neighbor)
    return sorted(
        selected,
        key=lambda index: (
            int(round(finite(rows[index]["features"].get("candidateLag")))),
            int(rows[index]["year"]),
        ),
    )


def relevance(distance: int, shift_matches: bool) -> int:
    if not shift_matches or distance > WINDOW_RADIUS:
        return 0
    if distance == 0:
        return 4
    if distance == 1:
        return 3
    if distance == 2:
        return 2
    return 1


def prepare_case(
    raw_case: dict[str, Any],
    offset: int,
    expected_schema: list[str] | None,
) -> tuple[PreparedCase, list[str], dict[str, float]]:
    rows = sorted(
        raw_case["rows"],
        key=lambda row: (
            int(round(finite(row["features"].get("candidateLag")))),
            int(row["year"]),
        ),
    )
    base_names = sorted(rows[0]["features"])
    schema = feature_schema(base_names)
    if expected_schema is not None and schema != expected_schema:
        raise RuntimeError("Feature schema changed between cases")

    base_index = {name: index for index, name in enumerate(base_names)}
    score_index = {name: index for index, name in enumerate(SCORE_FEATURES)}
    shifted_index = {name: index for index, name in enumerate(SHIFTED_FEATURES)}
    raw = np.asarray(
        [
            [finite(row["features"].get(name)) for name in base_names]
            for row in rows
        ],
        dtype=np.float32,
    )
    years_all = np.asarray([int(row["year"]) for row in rows], dtype=np.int32)
    shifts_all = np.asarray(
        [int(round(finite(row["features"].get("candidateLag")))) for row in rows],
        dtype=np.int16,
    )
    score_ranks = np.zeros((len(rows), len(SCORE_FEATURES)), dtype=np.float32)
    shifted_neighbors = np.full(
        (len(rows), len(SHIFTED_FEATURES) * 6),
        0.5,
        dtype=np.float32,
    )
    prominence = np.zeros((len(rows), len(SHIFTED_FEATURES)), dtype=np.float32)
    smooth5 = np.zeros((len(rows), len(SHIFTED_FEATURES)), dtype=np.float32)

    for shift in sorted(set(shifts_all.tolist())):
        indices = np.flatnonzero(shifts_all == shift)
        local_years = years_all[indices]
        local_lookup = {int(year): local for local, year in enumerate(local_years)}
        local_scores = raw[indices][:, [base_index[name] for name in SCORE_FEATURES]]
        local_ranks = np.column_stack(
            [percentile(local_scores[:, column]) for column in range(local_scores.shape[1])]
        )
        score_ranks[indices] = local_ranks
        shifted_local = local_ranks[:, [score_index[name] for name in SHIFTED_FEATURES]]
        for local_index, year in enumerate(local_years):
            neighbor_columns: list[np.ndarray] = []
            for delta in (-3, -2, -1, 1, 2, 3):
                neighbor = local_lookup.get(int(year) + delta)
                neighbor_columns.append(
                    shifted_local[neighbor]
                    if neighbor is not None
                    else np.full(len(SHIFTED_FEATURES), 0.5, dtype=np.float32)
                )
            shifted_neighbors[indices[local_index]] = np.concatenate(neighbor_columns)
            near = [
                shifted_local[neighbor]
                for delta in (-3, -2, -1, 1, 2, 3)
                if (neighbor := local_lookup.get(int(year) + delta)) is not None
            ]
            prominence[indices[local_index]] = (
                shifted_local[local_index] - np.max(near, axis=0)
                if near
                else 0
            )
            smooth = [
                shifted_local[neighbor]
                for delta in (-2, -1, 0, 1, 2)
                if (neighbor := local_lookup.get(int(year) + delta)) is not None
            ]
            smooth5[indices[local_index]] = np.mean(smooth, axis=0)

    span = max(1, int(years_all.max()) - int(years_all.min()))
    anchor_columns: list[np.ndarray] = []
    for anchor in ANCHOR_NAMES:
        if anchor == "currentTop":
            available = np.full(
                len(rows),
                1.0 if raw_case.get("currentTopYear") is not None else 0.0,
                dtype=np.float32,
            )
            signed_years = (
                years_all - int(raw_case.get("currentTopYear") or 0)
            ).astype(np.float32)
            distances = np.abs(signed_years)
        else:
            available = raw[:, base_index[f"{anchor}Available"]]
            distances = raw[:, base_index[f"{anchor}Distance"]] * span
            signed_years = raw[:, base_index[f"{anchor}SignedDistance"]] * span
        anchor_columns.extend(
            [
                available * np.exp(-distances / 3),
                available * np.exp(-distances / 8),
                available * (signed_years < 0) * np.exp(-distances / 8),
                available * (signed_years > 0) * np.exp(-distances / 8),
            ]
        )
    anchors = np.column_stack(anchor_columns).astype(np.float32)

    family_columns: list[np.ndarray] = []
    for names in FAMILIES.values():
        values = score_ranks[:, [score_index[name] for name in names]]
        family_columns.extend(
            [
                values.mean(axis=1),
                values.max(axis=1),
                (values >= 0.9).mean(axis=1),
                (values >= 0.97).mean(axis=1),
            ]
        )
    all_rank_values = score_ranks
    consensus = np.column_stack(
        [
            all_rank_values.mean(axis=1),
            (all_rank_values >= 0.9).mean(axis=1),
            (all_rank_values >= 0.97).mean(axis=1),
        ]
    ).astype(np.float32)

    context = raw_case.get("context", {})
    current_range = raw_case.get("currentRange")
    range_center = (
        (int(current_range[0]) + int(current_range[1])) / 2
        if current_range
        else 0
    )
    case_columns = np.column_stack(
        [
            np.full(len(rows), finite(raw_case.get("currentScore")), dtype=np.float32),
            np.full(len(rows), finite(raw_case.get("currentMargin")), dtype=np.float32),
            np.full(len(rows), finite(context.get("signalStrength")), dtype=np.float32),
            np.full(len(rows), finite(context.get("referenceCount")) / 100, dtype=np.float32),
            np.full(len(rows), finite(context.get("olderContextYears")) / span, dtype=np.float32),
            np.full(len(rows), finite(context.get("newerContextYears")) / span, dtype=np.float32),
            np.full(len(rows), 1.0 if current_range else 0.0, dtype=np.float32),
            np.abs(years_all - range_center).astype(np.float32) / span
            if current_range
            else np.ones(len(rows), dtype=np.float32),
        ]
    )
    complete = np.column_stack(
        [
            raw,
            score_ranks,
            shifted_neighbors,
            prominence,
            smooth5,
            anchors,
            *family_columns,
            consensus,
            case_columns,
        ]
    ).astype(np.float32)
    if complete.shape[1] != len(schema):
        raise RuntimeError(f"Feature mismatch: {complete.shape[1]} != {len(schema)}")

    selected = candidate_indices(rows)
    truth_year = int(raw_case["truthYear"])
    truth_shift = (
        int(raw_case["truthShiftYears"])
        if raw_case.get("truthShiftYears") is not None
        else None
    )
    selected_years = years_all[selected]
    selected_shifts = shifts_all[selected]
    labels = np.asarray(
        [
            relevance(
                abs(int(year) - truth_year),
                truth_shift is None or int(shift) == truth_shift,
            )
            for year, shift in zip(selected_years, selected_shifts)
        ],
        dtype=np.int8,
    )
    oracle = {
        "candidateCount": float(len(selected)),
        "exact": float(np.any(labels == 4)),
        "withinOne": float(np.any(labels >= 3)),
        "window": float(np.any(labels >= 1)),
        "shift": float(
            truth_shift is None or np.any(selected_shifts == truth_shift)
        ),
    }
    return (
        PreparedCase(
            event_type=str(raw_case["eventType"]),
            offset=offset,
            group_id=str(raw_case["groupId"]),
            truth_year=truth_year,
            truth_shift=truth_shift,
            years=selected_years,
            shifts=selected_shifts,
            features=complete[selected],
            labels=labels,
            current_range=tuple(current_range) if current_range else None,
            current_shift=(
                int(raw_case["currentShiftYears"])
                if raw_case.get("currentShiftYears") is not None
                else None
            ),
        ),
        schema,
        oracle,
    )


def load_event_cases(event_type: str) -> tuple[list[PreparedCase], list[str], dict[str, float]]:
    cases: list[PreparedCase] = []
    schema: list[str] | None = None
    oracle_totals = {
        "cases": 0.0,
        "candidateCount": 0.0,
        "exact": 0.0,
        "withinOne": 0.0,
        "window": 0.0,
        "shift": 0.0,
    }
    offsets = (*TRAIN_OFFSETS, *VALIDATION_OFFSETS, *TEST_OFFSETS)
    for offset in offsets:
        with audit_path(offset).open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if payload.get("sampling") != "calendar-position-stratified-signal-independent":
            raise RuntimeError(f"Offset {offset} is not a formal arbitrary-year audit")
        for raw_case in payload["cases"]:
            if raw_case["eventType"] != event_type:
                continue
            prepared, schema, oracle = prepare_case(raw_case, offset, schema)
            cases.append(prepared)
            oracle_totals["cases"] += 1
            for key, value in oracle.items():
                oracle_totals[key] += value
        print(f"prepared {event_type} offset {offset}", flush=True)
        del payload
        gc.collect()
    count = max(1.0, oracle_totals["cases"])
    oracle_report = {
        "cases": int(oracle_totals["cases"]),
        "meanCandidates": oracle_totals["candidateCount"] / count,
        "exact": oracle_totals["exact"] / count,
        "withinOne": oracle_totals["withinOne"] / count,
        "window": oracle_totals["window"] / count,
        "shift": oracle_totals["shift"] / count,
    }
    return cases, schema or [], oracle_report


def dataset(cases: Iterable[PreparedCase]) -> tuple[np.ndarray, np.ndarray, list[int]]:
    values = list(cases)
    return (
        np.concatenate([case.features for case in values]),
        np.concatenate([case.labels for case in values]),
        [len(case.labels) for case in values],
    )


def current_hit(case: PreparedCase) -> bool:
    if case.current_range is None:
        return False
    shift_matches = case.truth_shift is None or case.current_shift == case.truth_shift
    return (
        case.current_range[0] <= case.truth_year <= case.current_range[1]
        and shift_matches
    )


def empty_metrics() -> dict[str, float]:
    return {
        "cases": 0,
        "window5": 0,
        "window7": 0,
        "window9": 0,
        "exact": 0,
        "withinOne": 0,
        "shift": 0,
        "current": 0,
        "absoluteError": 0,
    }


def add_prediction(
    metrics: dict[str, float],
    case: PreparedCase,
    selected_index: int,
) -> None:
    year = int(case.years[selected_index])
    shift = int(case.shifts[selected_index])
    distance = abs(year - case.truth_year)
    shift_matches = case.truth_shift is None or shift == case.truth_shift
    metrics["cases"] += 1
    metrics["window5"] += float(shift_matches and distance <= 2)
    metrics["window7"] += float(shift_matches and distance <= 3)
    metrics["window9"] += float(shift_matches and distance <= 4)
    metrics["exact"] += float(shift_matches and distance == 0)
    metrics["withinOne"] += float(shift_matches and distance <= 1)
    metrics["shift"] += float(shift_matches)
    metrics["current"] += float(current_hit(case))
    metrics["absoluteError"] += distance


def rates(metrics: dict[str, float]) -> dict[str, float | int]:
    count = max(1.0, metrics["cases"])
    return {
        "cases": int(metrics["cases"]),
        "window5": metrics["window5"] / count,
        "window7": metrics["window7"] / count,
        "window9": metrics["window9"] / count,
        "exact": metrics["exact"] / count,
        "withinOne": metrics["withinOne"] / count,
        "shift": metrics["shift"] / count,
        "currentWindow": metrics["current"] / count,
        "meanAbsoluteError": metrics["absoluteError"] / count,
    }


def evaluate(
    model: lgb.LGBMRanker,
    cases: list[PreparedCase],
) -> dict[str, Any]:
    overall = empty_metrics()
    by_offset = {offset: empty_metrics() for offset in sorted({case.offset for case in cases})}
    for case in cases:
        scores = model.predict(case.features, num_iteration=model.best_iteration_)
        selected = int(
            max(
                range(len(scores)),
                key=lambda index: (
                    float(scores[index]),
                    int(case.years[index]),
                    -abs(int(case.shifts[index])),
                ),
            )
        )
        add_prediction(overall, case, selected)
        add_prediction(by_offset[case.offset], case, selected)
    return {
        "overall": rates(overall),
        "byOffset": {
            str(offset): rates(metrics) for offset, metrics in by_offset.items()
        },
    }


def train_model(
    training: list[PreparedCase],
    validation: list[PreparedCase],
    feature_names: list[str],
    variant: str,
) -> lgb.LGBMRanker:
    x_train, y_train, train_groups = dataset(training)
    x_valid, y_valid, valid_groups = dataset(validation)
    params = {
        "objective": "lambdarank",
        "n_estimators": 900,
        "learning_rate": 0.03,
        "num_leaves": 15 if variant == "compact" else 31,
        "max_depth": 5 if variant == "compact" else 7,
        "min_child_samples": 35 if variant == "compact" else 24,
        "subsample": 0.85,
        "colsample_bytree": 0.65 if variant == "compact" else 0.8,
        "reg_alpha": 0.2,
        "reg_lambda": 5.0 if variant == "compact" else 3.0,
        "random_state": RANDOM_SEED,
        "n_jobs": -1,
        "verbosity": -1,
        "label_gain": [0, 1, 3, 7, 15],
    }
    model = lgb.LGBMRanker(**params)
    model.fit(
        x_train,
        y_train,
        group=train_groups,
        eval_set=[(x_valid, y_valid)],
        eval_group=[valid_groups],
        eval_at=[1, 3, 5],
        feature_name=[f"feature_{index}" for index in range(len(feature_names))],
        callbacks=[
            lgb.early_stopping(70, verbose=False),
            lgb.log_evaluation(0),
        ],
    )
    del x_train, y_train, x_valid, y_valid
    gc.collect()
    return model


def run_event(event_type: str) -> dict[str, Any]:
    cases, feature_names, oracle = load_event_cases(event_type)
    training = [case for case in cases if case.offset in TRAIN_OFFSETS]
    validation = [case for case in cases if case.offset in VALIDATION_OFFSETS]
    testing = [case for case in cases if case.offset in TEST_OFFSETS]
    reports: dict[str, Any] = {}
    for variant in ("compact", "wide"):
        print(
            f"training {event_type}/{variant}: "
            f"groups={len(training)} features={len(feature_names)}",
            flush=True,
        )
        model = train_model(training, validation, feature_names, variant)
        importance = sorted(
            zip(feature_names, model.feature_importances_.tolist()),
            key=lambda row: row[1],
            reverse=True,
        )
        reports[variant] = {
            "bestIteration": int(model.best_iteration_ or 0),
            "training": evaluate(model, training),
            "validation": evaluate(model, validation),
            "test": evaluate(model, testing),
            "topFeatures": [
                {"name": name, "importance": int(value)}
                for name, value in importance[:20]
            ],
        }
        del model
        gc.collect()
    return {
        "featureCount": len(feature_names),
        "candidateOracleAllOffsets": oracle,
        "models": reports,
    }


def main() -> None:
    requested = os.environ.get("GROUPED_RANK_EVENT")
    event_types = (requested,) if requested else EVENT_TYPES
    report = {
        "sampling": "calendar-position-stratified-signal-independent",
        "trainOffsets": TRAIN_OFFSETS,
        "validationOffsets": VALIDATION_OFFSETS,
        "testOffsets": TEST_OFFSETS,
        "singleMainWindowWidth": WINDOW_RADIUS * 2 + 1,
        "events": {
            event_type: run_event(event_type)
            for event_type in event_types
        },
    }
    print("GROUPED_BOUNDARY_RANKER " + json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
