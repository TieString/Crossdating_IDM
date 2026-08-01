"""Train an experimental JS-portable boundary ranker from frozen arbitrary-year audits.

The model never sees the original uncorrupted target at inference time. Local features are
computed from the corrupted target, a leave-one-out reference chronology, and the candidate
operation. Offsets 0-7 train; offsets 8-12 are a file-disjoint development holdout.
"""

from __future__ import annotations

import json
import math
import os
import random
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor


ROOT = Path(__file__).resolve().parents[1]
AUDIT_ROOTS = [
    ROOT / ".tmp-window-ranker-broad",
    ROOT / ".tmp-window-ranker",
]
ITRDB_ROOT = Path(
    os.environ.get(
        "CROSSDATING_ITRDB_DIR",
        "D:/软件测试/数据/ITRDB/itrdb_download/measurements",
    )
)
TRAIN_OFFSETS = set(range(8))
TEST_OFFSETS = set(range(8, 13))
STOP_MARKERS = {999, -999, 9990, -9999}
EVENT_TYPES = ("missingRing", "falseRing", "partialMove")
LOCAL_RADIUS = int(os.environ.get("LOCAL_RANK_RADIUS", "16"))
WINDOW_RADIUS = int(os.environ.get("LOCAL_RANK_WINDOW_RADIUS", "4"))
RANDOM_SEED = 41729


def iter_audits() -> Iterable[dict[str, Any]]:
    for offset in sorted(TRAIN_OFFSETS | TEST_OFFSETS):
        name = f"offset-{offset}-cases-25.json"
        path = next((root / name for root in AUDIT_ROOTS if (root / name).exists()), None)
        if path is None:
            raise FileNotFoundError(name)
        payload = json.loads(path.read_text(encoding="utf-8"))
        for case in payload["cases"]:
            case["offset"] = offset
            yield case


def parse_rwl(path: Path) -> dict[str, dict[int, float]]:
    by_id: dict[str, dict[int, float]] = {}
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        tokens = raw.strip().split()
        if len(tokens) < 3:
            continue
        try:
            decade = int(tokens[1])
        except ValueError:
            continue
        if decade < 1000 or decade > 2100:
            continue
        values = by_id.setdefault(tokens[0], {})
        year = decade
        for token in tokens[2:]:
            try:
                value = float(token)
            except ValueError:
                continue
            if value in STOP_MARKERS:
                break
            if value < 0:
                continue
            values[year] = value
            year += 1
    return {
        series_id: values
        for series_id, values in by_id.items()
        if len(values) >= 30 and min(values) >= 1000 and max(values) <= 2100
    }


def standardize(
    series: dict[int, float],
    *,
    positive_only: bool = False,
) -> dict[int, float]:
    usable = {
        year: value
        for year, value in series.items()
        if math.isfinite(value) and (not positive_only or value > 0)
    }
    values = np.asarray(list(usable.values()), dtype=float)
    if len(values) == 0:
        return {}
    center = float(values.mean())
    scale = float(values.std()) or 1.0
    return {
        year: (value - center) / scale
        for year, value in usable.items()
    }


def zscore(series: dict[int, float]) -> dict[int, float]:
    return standardize(series, positive_only=True)


def differences(series: dict[int, float]) -> dict[int, float]:
    result = {
        year: series[year] - series[year - 1]
        for year in series
        if year - 1 in series
    }
    return standardize(result)


def whiten(series: dict[int, float]) -> dict[int, float]:
    years = sorted(series)
    if len(years) < 4:
        return standardize(series)
    values = np.asarray([series[year] for year in years], dtype=float)
    center = float(values.mean())
    denominator = float(np.square(values - center).sum())
    numerator = sum(
        (series[year] - center) * (series[year - 1] - center)
        for year in years
        if year - 1 in series
    )
    phi = max(0.0, min(0.9, numerator / denominator if denominator > 0 else 0.0))
    residual = {
        year: series[year] - phi * series[year - 1]
        for year in years
        if year - 1 in series
    }
    return standardize(residual)


def overlap(left: dict[int, float], right: dict[int, float]) -> int:
    return len(set(left).intersection(right))


def corrupt(
    correct: dict[int, float],
    event_type: str,
    truth_year: int,
    truth_shift: int | None,
    false_mode: str = "moderate",
) -> dict[int, float]:
    start = min(correct)
    end = max(correct)
    if event_type == "missingRing":
        return {
            year: correct[source]
            for year in range(start + 1, end + 1)
            if (source := year if year > truth_year else year - 1) in correct
        }
    if event_type == "falseRing":
        neighborhood = [
            correct[year]
            for year in range(truth_year - 3, truth_year + 4)
            if year in correct and correct[year] > 0
        ]
        left = correct.get(truth_year - 1, correct.get(truth_year, 1.0))
        right = correct.get(truth_year + 1, correct.get(truth_year, 1.0))
        if false_mode == "average":
            false_value = float(round((left + right) / 2))
        elif false_mode == "splitLike":
            local_mean = float(np.mean(neighborhood)) if neighborhood else (left + right) / 2
            false_value = float(max(1, round(local_mean * 0.45)))
        else:
            false_value = (
                float(max(1, round(float(np.median(neighborhood)))))
                if neighborhood
                else 1.0
            )
        result: dict[int, float] = {}
        for year in range(start - 1, end + 1):
            if year > truth_year and year in correct:
                result[year] = correct[year]
            elif year == truth_year:
                result[year] = false_value
            elif year + 1 in correct:
                result[year] = correct[year + 1]
        return result
    shift = int(truth_shift or 0)
    return {
        year: correct[source]
        for year in range(start, end + 1)
        if (source := year + shift if year <= truth_year else year) in correct
    }


@lru_cache(maxsize=None)
def sampled_file_index(offset: int, sample_count: int = 200) -> dict[str, int]:
    all_files = sorted(
        path
        for path in ITRDB_ROOT.rglob("*")
        if path.is_file() and path.suffix.lower() == ".rwl"
    )
    stride = max(1, len(all_files) // sample_count)
    normalized_offset = offset % stride
    sampled = [
        path
        for index, path in enumerate(all_files)
        if index >= normalized_offset and (index - normalized_offset) % stride == 0
    ][:sample_count]
    return {
        "/" + path.relative_to(ITRDB_ROOT).as_posix(): index
        for index, path in enumerate(sampled)
    }


def false_mode_for_case(case: dict[str, Any]) -> str:
    file_index = sampled_file_index(int(case["offset"])).get(case["context"]["file"])
    if file_index is None:
        return "moderate"
    return ("average", "moderate", "splitLike")[file_index % 3]


def pearson(left: dict[int, float], right: dict[int, float], lag: int = 0) -> float:
    pairs = [
        (value, right[year + lag])
        for year, value in left.items()
        if year + lag in right
    ]
    if len(pairs) < 20:
        return -1.0
    a = np.asarray([pair[0] for pair in pairs])
    b = np.asarray([pair[1] for pair in pairs])
    if a.std() == 0 or b.std() == 0:
        return -1.0
    return float(np.corrcoef(a, b)[0, 1])


def master_for(
    all_series: dict[str, dict[int, float]],
    target_id: str,
    corrupted: dict[int, float],
) -> tuple[dict[str, dict[int, float]], int]:
    target_z = zscore(corrupted)
    references = [
        (series_id, values)
        for series_id, values in all_series.items()
        if series_id != target_id
        and sum(value == 0 for value in values.values()) == 0
        and overlap(values, corrupted) >= 80
    ]
    references.sort(key=lambda item: (-overlap(item[1], corrupted), item[0]))
    references = references[:24]
    prepared: list[tuple[str, dict[int, float], float]] = []
    for series_id, values in references:
        data = zscore(values)
        best = max(pearson(target_z, data, lag) for lag in range(-3, 4))
        prepared.append((series_id, data, max(0.05, best + 0.15)))
    views: dict[str, dict[int, float]] = {}
    for view_name, transform in (
        ("raw", lambda value: value),
        ("difference", differences),
        ("whitened", whiten),
    ):
        buckets: dict[int, list[tuple[float, float]]] = defaultdict(list)
        for _, raw, weight in prepared:
            view = transform(raw)
            for year, value in view.items():
                buckets[year].append((value, weight))
        master = {
            year: sum(value * weight for value, weight in rows)
            / sum(weight for _, weight in rows)
            for year, rows in buckets.items()
            if rows
        }
        views[view_name] = zscore(master)
    return views, len(prepared)


def huber(value: float, transition: float = 1.5) -> float:
    absolute = abs(value)
    return (
        0.5 * absolute * absolute
        if absolute <= transition
        else transition * (absolute - 0.5 * transition)
    )


def safe_value(mapping: dict[int, float], year: int) -> float:
    return float(mapping.get(year, math.nan))


def local_features(
    target_views: dict[str, dict[int, float]],
    master_views: dict[str, dict[int, float]],
    candidate_year: int,
    candidate_lag: int,
) -> list[float]:
    result: list[float] = []
    for view_name in ("raw", "difference", "whitened"):
        target = target_views[view_name]
        master = master_views[view_name]
        preferences: list[float] = []
        cross_products: list[float] = []
        for relative in range(-LOCAL_RADIUS, LOCAL_RADIUS + 1):
            year = candidate_year + relative
            target_value = target.get(year)
            zero = master.get(year)
            shifted = master.get(year + candidate_lag)
            if target_value is None or zero is None or shifted is None:
                preference = math.nan
                cross_product = math.nan
            else:
                preference = huber(target_value - zero) - huber(target_value - shifted)
                cross_product = target_value * (shifted - zero)
            preferences.append(preference)
            cross_products.append(cross_product)
        result.extend(preferences)
        result.extend(cross_products)
        for radius in (3, 5, 8, 12, 16):
            older = [
                preferences[index]
                for index, relative in enumerate(range(-LOCAL_RADIUS, LOCAL_RADIUS + 1))
                if -radius <= relative <= 0 and math.isfinite(preferences[index])
            ]
            newer = [
                preferences[index]
                for index, relative in enumerate(range(-LOCAL_RADIUS, LOCAL_RADIUS + 1))
                if 1 <= relative <= radius and math.isfinite(preferences[index])
            ]
            older_mean = float(np.mean(older)) if older else math.nan
            newer_mean = float(np.mean(newer)) if newer else math.nan
            result.extend(
                [
                    older_mean,
                    newer_mean,
                    older_mean - newer_mean
                    if math.isfinite(older_mean) and math.isfinite(newer_mean)
                    else math.nan,
                    sum(value > 0 for value in older) / len(older) if older else math.nan,
                    sum(value < 0 for value in newer) / len(newer) if newer else math.nan,
                ]
            )
        for relative in range(-3, 4):
            year = candidate_year + relative
            result.extend(
                [
                    safe_value(target, year),
                    safe_value(master, year),
                    safe_value(master, year + candidate_lag),
                ]
            )
    return result


def case_rows(
    case: dict[str, Any],
    file_cache: dict[str, dict[str, dict[int, float]]],
) -> tuple[np.ndarray, list[dict[str, Any]], list[str]]:
    relative = case["context"]["file"].lstrip("/\\")
    all_series = file_cache.get(relative)
    if all_series is None:
        if len(file_cache) >= 8:
            file_cache.pop(next(iter(file_cache)))
        all_series = parse_rwl(ITRDB_ROOT / relative)
        file_cache[relative] = all_series
    target_id = case["context"]["target"]
    correct = all_series[target_id]
    corrupted = corrupt(
        correct,
        case["eventType"],
        int(case["truthYear"]),
        case.get("truthShiftYears"),
        false_mode_for_case(case),
    )
    target_raw = zscore(corrupted)
    target_views = {
        "raw": target_raw,
        "difference": differences(target_raw),
        "whitened": whiten(target_raw),
    }
    master_views, reference_count = master_for(all_series, target_id, corrupted)
    engineered_names = sorted(
        {
            name
            for row in case["rows"]
            for name, value in row["features"].items()
            if isinstance(value, (int, float))
        }
    )
    rows: list[dict[str, Any]] = []
    vectors: list[list[float]] = []
    truth_shift = case.get("truthShiftYears")
    for audit_row in case["rows"]:
        candidate_lag = (
            -1
            if case["eventType"] == "missingRing"
            else 1
            if case["eventType"] == "falseRing"
            else int(audit_row.get("shiftYears") or 0)
        )
        engineered = [
            float(audit_row["features"].get(name, math.nan))
            for name in engineered_names
        ]
        vectors.append(
            engineered
            + [
                float(reference_count),
                float(candidate_lag),
                float(audit_row["year"] - min(corrupted))
                / max(1, max(corrupted) - min(corrupted)),
            ]
            + local_features(
                target_views,
                master_views,
                int(audit_row["year"]),
                candidate_lag,
            )
        )
        distance = abs(int(audit_row["year"]) - int(case["truthYear"]))
        shift_matches = (
            case["eventType"] != "partialMove"
            or int(audit_row.get("shiftYears") or 0) == int(truth_shift or 0)
        )
        rows.append(
            {
                "year": int(audit_row["year"]),
                "shiftYears": audit_row.get("shiftYears"),
                "distance": distance,
                "shiftMatches": shift_matches,
                "positive": shift_matches and distance <= WINDOW_RADIUS,
                "target": max(0.0, 1.0 - distance / 10.0) if shift_matches else 0.0,
            }
        )
    local_names: list[str] = []
    for view in ("raw", "difference", "whitened"):
        local_names.extend(
            f"{view}:preference:{relative}"
            for relative in range(-LOCAL_RADIUS, LOCAL_RADIUS + 1)
        )
        local_names.extend(
            f"{view}:crossProduct:{relative}"
            for relative in range(-LOCAL_RADIUS, LOCAL_RADIUS + 1)
        )
        local_names.extend(
            f"{view}:summary:{radius}:{metric}"
            for radius in (3, 5, 8, 12, 16)
            for metric in (
                "olderMean",
                "newerMean",
                "contrast",
                "olderPositive",
                "newerNegative",
            )
        )
        local_names.extend(
            f"{view}:value:{relative}:{channel}"
            for relative in range(-3, 4)
            for channel in ("target", "master0", "masterShift")
        )
    names = (
        engineered_names
        + ["referenceCountLocal", "candidateLagLocal", "candidatePositionLocal"]
        + local_names
    )
    return np.asarray(vectors, dtype=np.float32), rows, names


def sampled_training_indices(
    case: dict[str, Any],
    rows: list[dict[str, Any]],
) -> list[int]:
    selected = {
        index
        for index, row in enumerate(rows)
        if row["distance"] <= 20
        and (
            case["eventType"] != "partialMove"
            or row["shiftMatches"]
        )
    }
    feature_names = (
        "rawFull",
        "differenceFull",
        "whitenedFull",
        "comboFull",
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeWhitened",
        "cumulativeReferenceMean",
    )
    for feature in feature_names:
        ranked = sorted(
            range(len(rows)),
            key=lambda index: (
                case["rows"][index]["features"].get(feature, -math.inf),
                case["rows"][index]["year"],
            ),
            reverse=True,
        )
        selected.update(ranked[:12])
    current_top = case.get("currentTopYear")
    if isinstance(current_top, (int, float)):
        selected.update(
            index
            for index, row in enumerate(rows)
            if abs(row["year"] - current_top) <= 12
        )
    rng = random.Random(f"{RANDOM_SEED}:{case['groupId']}:{case['eventType']}")
    remaining = [index for index in range(len(rows)) if index not in selected]
    selected.update(rng.sample(remaining, min(32, len(remaining))))
    return sorted(selected)


def current_hit(case: dict[str, Any]) -> bool:
    current_range = case.get("currentRange")
    return bool(
        current_range
        and current_range[0] <= case["truthYear"] <= current_range[1]
        and (
            case["eventType"] != "partialMove"
            or case.get("currentShiftYears") == case.get("truthShiftYears")
        )
    )


def evaluate_model(
    model: Any,
    cases: list[tuple[dict[str, Any], np.ndarray, list[dict[str, Any]]]],
) -> dict[str, Any]:
    outcomes = []
    for case, matrix, rows in cases:
        scores = model.predict(matrix)
        ranking = sorted(
            range(len(rows)),
            key=lambda index: (scores[index], rows[index]["year"]),
            reverse=True,
        )
        selected = rows[ranking[0]]
        outcomes.append(
            {
                "eventType": case["eventType"],
                "offset": case["offset"],
                "hit": selected["positive"],
                "exact": selected["shiftMatches"] and selected["distance"] == 0,
                "withinOne": selected["shiftMatches"] and selected["distance"] <= 1,
                "shift": selected["shiftMatches"],
                "currentHit": current_hit(case),
                "year": selected["year"],
                "truthYear": case["truthYear"],
                "scoreMargin": float(
                    scores[ranking[0]] - scores[ranking[1]]
                    if len(ranking) > 1
                    else 0.0
                ),
            }
        )

    def summarize(rows: Iterable[dict[str, Any]]) -> dict[str, float | int]:
        values = list(rows)
        count = len(values)
        return {
            "cases": count,
            "coverage": sum(row["hit"] for row in values) / max(1, count),
            "exact": sum(row["exact"] for row in values) / max(1, count),
            "withinOne": sum(row["withinOne"] for row in values) / max(1, count),
            "shiftAccuracy": sum(row["shift"] for row in values) / max(1, count),
            "currentCoverage": sum(row["currentHit"] for row in values) / max(1, count),
        }

    return {
        "overall": summarize(outcomes),
        "byType": {
            event_type: summarize(
                row for row in outcomes if row["eventType"] == event_type
            )
            for event_type in EVENT_TYPES
        },
        "byOffset": {
            str(offset): summarize(row for row in outcomes if row["offset"] == offset)
            for offset in sorted(TEST_OFFSETS)
        },
        "failures": [
            row for row in outcomes if not row["hit"]
        ],
    }


def main() -> None:
    file_cache: dict[str, dict[str, dict[int, float]]] = {}
    train_by_type: dict[str, list[tuple[np.ndarray, list[dict[str, Any]]]]] = defaultdict(list)
    test_by_type: dict[
        str, list[tuple[dict[str, Any], np.ndarray, list[dict[str, Any]]]]
    ] = defaultdict(list)
    feature_names: list[str] | None = None
    total_cases = len(TRAIN_OFFSETS | TEST_OFFSETS) * 25 * len(EVENT_TYPES)
    for case_index, case in enumerate(iter_audits(), start=1):
        matrix, rows, names = case_rows(case, file_cache)
        if feature_names is None:
            feature_names = names
        elif feature_names != names:
            raise RuntimeError("Feature schema changed between cases")
        if case["offset"] in TRAIN_OFFSETS:
            indices = sampled_training_indices(case, rows)
            train_by_type[case["eventType"]].append(
                (matrix[indices], [rows[index] for index in indices])
            )
        else:
            test_by_type[case["eventType"]].append((case, matrix, rows))
        if case_index % 50 == 0:
            print(f"prepared {case_index}/{total_cases} cases", flush=True)

    reports: dict[str, Any] = {}
    for event_type in EVENT_TYPES:
        matrices = train_by_type[event_type]
        x_train = np.concatenate([matrix for matrix, _ in matrices])
        train_rows = [row for _, rows in matrices for row in rows]
        y_train = np.asarray([row["target"] for row in train_rows], dtype=np.float32)
        weights = np.asarray(
            [
                3.0 if row["positive"] else 1.0
                for row in train_rows
            ],
            dtype=np.float32,
        )
        models = {
            "hist": HistGradientBoostingRegressor(
                learning_rate=0.06,
                max_iter=220,
                max_leaf_nodes=31,
                min_samples_leaf=20,
                l2_regularization=1.0,
                random_state=RANDOM_SEED,
            ),
            "extraTrees": ExtraTreesRegressor(
                n_estimators=240,
                max_depth=16,
                min_samples_leaf=3,
                max_features=0.55,
                n_jobs=-1,
                random_state=RANDOM_SEED,
            ),
        }
        reports[event_type] = {}
        for model_name, model in models.items():
            print(
                f"training {event_type}/{model_name}: "
                f"rows={len(y_train)} features={x_train.shape[1]}",
                flush=True,
            )
            if model_name == "hist":
                model.fit(x_train, y_train, sample_weight=weights)
            else:
                model.fit(x_train, y_train, sample_weight=weights)
            reports[event_type][model_name] = evaluate_model(
                model,
                test_by_type[event_type],
            )

    output = {
        "sampling": "calendar-position-stratified-signal-independent",
        "trainOffsets": sorted(TRAIN_OFFSETS),
        "testOffsets": sorted(TEST_OFFSETS),
        "windowWidth": WINDOW_RADIUS * 2 + 1,
        "featureCount": len(feature_names or []),
        "reports": reports,
    }
    compact = {
        "sampling": output["sampling"],
        "trainOffsets": output["trainOffsets"],
        "testOffsets": output["testOffsets"],
        "windowWidth": output["windowWidth"],
        "featureCount": output["featureCount"],
        "reports": {
            event_type: {
                model_name: {
                    "overall": report["overall"],
                    "byOffset": report["byOffset"],
                }
                for model_name, report in model_reports.items()
            }
            for event_type, model_reports in reports.items()
        },
    }
    prefix = (
        "LOCAL_BOUNDARY_RANKER "
        if os.environ.get("LOCAL_RANK_FULL_REPORT") == "1"
        else "LOCAL_BOUNDARY_RANKER_COMPACT "
    )
    print(
        prefix
        + json.dumps(
            output if os.environ.get("LOCAL_RANK_FULL_REPORT") == "1" else compact,
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
