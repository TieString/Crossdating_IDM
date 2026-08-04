"""Evaluate a physical-candidate 13-year mode ranker across audit cohorts.

The production locator already exposes multiple independent location hypotheses.
This experiment ranks only modes backed by one of those hypotheses instead of
letting a learner choose any arbitrary year in the coarse interval.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np


HERE = Path(__file__).resolve().parent
BASE_PATH = HERE / "fit-lodo-unit-regional-mode-ranker.py"
SPEC = importlib.util.spec_from_file_location("regional_mode_ranker", BASE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load {BASE_PATH}")
BASE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BASE
SPEC.loader.exec_module(BASE)

EVENT_TYPE = "missingRing"
WINDOW_WIDTH = 13
HALF_WIDTH = WINDOW_WIDTH // 2

SOURCE_NAMES = (
    "currentMode",
    "learnedMode",
    "prePointMode",
    "preDirectMode",
    "currentWindow",
    "currentAnchor",
    "operationAnchor",
    "sideAnchor",
    "internalCurrent",
    "internalJoint",
    "internalReference",
    "profilePeak",
    "profileMass",
)


def identity(context: dict[str, Any]) -> str:
    return "|".join((
        EVENT_TYPE,
        str(context.get("groupId", context.get("file", ""))).lower(),
        str(context.get("target", "")),
        str(int(context.get("year", 0))),
    ))


def finite(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    return result if np.isfinite(result) else 0.0


def percentile_ranks(values: np.ndarray) -> np.ndarray:
    order = np.argsort(values, kind="stable")
    result = np.zeros(len(values), dtype=np.float32)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = 0.5 if len(values) <= 1 else (
            start + end - 1
        ) / (2 * (len(values) - 1))
        result[order[start:end]] = rank
        start = end
    return result


def profile_maps(row: dict[str, Any]) -> dict[str, dict[int, float]]:
    years = [int(year) for year in row.get("years") or []]
    result: dict[str, dict[int, float]] = {}
    for name, values in (row.get("ranks") or {}).items():
        if isinstance(values, list) and len(values) == len(years):
            result[f"rank:{name}"] = dict(zip(years, map(finite, values)))
    for source in row.get("unitCounterfactualRows") or []:
        year = int(source["year"])
        for name, value in (source.get("profiles") or {}).items():
            result.setdefault(f"cf:{name}", {})[year] = finite(value)
    return result


def common_profile_names(rows: Sequence[dict[str, Any]]) -> tuple[str, ...]:
    if not rows:
        return ()
    availability = [set(profile_maps(row)) for row in rows]
    common = set.intersection(*availability)
    return tuple(sorted(common))


def centered_start(center: float, first: int, last: int) -> int:
    return max(first, min(round(center) - HALF_WIDTH, last - WINDOW_WIDTH + 1))


def add_window_source(
    starts: dict[int, set[str]],
    window: Any,
    source: str,
    first: int,
    last: int,
) -> None:
    if not isinstance(window, dict):
        return
    start = window.get("startYear")
    end = window.get("endYear")
    if start is None or end is None:
        return
    starts[centered_start((int(start) + int(end)) / 2, first, last)].add(source)


def add_anchor_source(
    starts: dict[int, set[str]],
    year: Any,
    source: str,
    first: int,
    last: int,
) -> None:
    if year is None:
        return
    starts[centered_start(float(year), first, last)].add(source)


def profile_candidate_starts(
    years: np.ndarray,
    values_by_year: dict[int, float],
    first: int,
    last: int,
) -> tuple[int, int] | None:
    if any(int(year) not in values_by_year for year in years):
        return None
    values = percentile_ranks(np.asarray([
        values_by_year[int(year)] for year in years
    ], dtype=np.float32))
    peak_index = int(np.argmax(values))
    peak_start = centered_start(int(years[peak_index]), first, last)
    prefix = np.concatenate(([0.0], np.cumsum(values, dtype=np.float64)))
    best_start = first
    best_score = -np.inf
    for start in range(first, last - WINDOW_WIDTH + 2):
        index = int(np.searchsorted(years, start))
        if (
            index + WINDOW_WIDTH > len(years)
            or int(years[index]) != start
            or int(years[index + WINDOW_WIDTH - 1]) != start + WINDOW_WIDTH - 1
        ):
            continue
        score = float(prefix[index + WINDOW_WIDTH] - prefix[index])
        if score >= best_score:
            best_score = score
            best_start = start
    return peak_start, best_start


def aggregate_profile_features(
    years: np.ndarray,
    values_by_year: dict[int, float] | None,
    start_year: int,
) -> list[float]:
    if not values_by_year or any(int(year) not in values_by_year for year in years):
        return [0.0] * 13
    raw = np.asarray([values_by_year[int(year)] for year in years], dtype=np.float32)
    ranked = percentile_ranks(raw)
    start_index = int(np.searchsorted(years, start_year))
    end_index = start_index + WINDOW_WIDTH
    if (
        end_index > len(years)
        or int(years[start_index]) != start_year
        or int(years[end_index - 1]) != start_year + WINDOW_WIDTH - 1
    ):
        return [0.0] * 13
    window = ranked[start_index:end_index]
    older = window[:3]
    newer = window[-3:]
    before = ranked[max(0, start_index - 3):start_index]
    after = ranked[end_index:end_index + 3]
    outside = np.concatenate((ranked[:start_index], ranked[end_index:]))
    mean = lambda values: float(np.mean(values)) if len(values) else 0.0
    maximum = lambda values: float(np.max(values)) if len(values) else 0.0
    return [
        1.0,
        mean(window),
        maximum(window),
        float(window[HALF_WIDTH]),
        mean(older),
        mean(newer),
        mean(newer) - mean(older),
        mean(before),
        mean(after),
        mean(older) - mean(before),
        mean(after) - mean(newer),
        mean(window) - mean(outside),
        maximum(window) - maximum(outside),
    ]


def source_kind(source: str) -> str:
    if source == "current_event":
        return "internalCurrent"
    if source == "joint_counterfactual_operation":
        return "internalJoint"
    if source.startswith("reference_transition:"):
        return "internalReference"
    return "internalReference"


def build_case(
    dataset: str,
    row: dict[str, Any],
    profile_names: Sequence[str],
) -> Any | None:
    all_years = np.asarray(row.get("years") or [], dtype=int)
    if len(all_years) < WINDOW_WIDTH:
        return None
    first = int(all_years[0])
    last = int(all_years[-1])
    mode = row.get("modeWindow") or row.get("finalWindow")
    coarse = row.get("coarseWindow")
    if not mode or not coarse:
        return None
    profiles = profile_maps(row)
    operation = row.get("selectedOperation") or {}
    starts: dict[int, set[str]] = defaultdict(set)
    add_window_source(starts, mode, "currentMode", first, last)
    add_window_source(starts, row.get("learnedWindow"), "learnedMode", first, last)
    add_window_source(starts, row.get("prePointModeWindow"), "prePointMode", first, last)
    add_window_source(starts, row.get("preDirectModeWindow"), "preDirectMode", first, last)
    add_window_source(starts, row.get("currentWindow"), "currentWindow", first, last)
    add_anchor_source(starts, row.get("currentPrimaryYear"), "currentAnchor", first, last)
    add_anchor_source(starts, operation.get("bestYear"), "operationAnchor", first, last)
    add_anchor_source(starts, operation.get("sideStepBestYear"), "sideAnchor", first, last)
    for candidate in row.get("candidates") or []:
        add_window_source(
            starts,
            candidate,
            source_kind(str(candidate.get("source", ""))),
            first,
            last,
        )
    for name in profile_names:
        selected = profile_candidate_starts(
            all_years,
            profiles.get(name, {}),
            first,
            last,
        )
        if selected:
            starts[selected[0]].add("profilePeak")
            starts[selected[1]].add("profileMass")
    if not starts:
        return None

    coarse_start = int(coarse["startYear"])
    coarse_end = int(coarse["endYear"])
    coarse_center = (coarse_start + coarse_end) / 2
    mode_center = (int(mode["startYear"]) + int(mode["endYear"])) / 2
    span = max(1, last - first)
    anchors = (
        row.get("currentPrimaryYear"),
        operation.get("bestYear"),
        operation.get("sideStepBestYear"),
    )
    internal = row.get("candidates") or []
    truth = int(row["truthYear"])
    candidates = []
    for start in sorted(starts):
        center = start + HALF_WIDTH
        sources = starts[start]
        features: list[float] = [
            (center - first) / span,
            (center - coarse_center) / span,
            abs(center - coarse_center) / span,
            (center - mode_center) / span,
            abs(center - mode_center) / span,
            float(coarse_start <= center <= coarse_end),
            len(sources) / len(SOURCE_NAMES),
            *[float(name in sources) for name in SOURCE_NAMES],
        ]
        for anchor in anchors:
            if anchor is None:
                features.extend((0.0, 0.0, 0.0, 0.0))
            else:
                distance = center - int(anchor)
                features.extend((
                    1.0,
                    distance / span,
                    abs(distance) / span,
                    float(abs(distance) <= HALF_WIDTH),
                ))
        supporting = [
            candidate for candidate in internal
            if int(candidate["startYear"]) <= center <= int(candidate["endYear"])
        ]
        features.extend((
            len(supporting) / max(1, len(internal)),
            max((finite(candidate.get("aggregateScore")) for candidate in supporting), default=0.0),
            max((finite(candidate.get("overlapConsensus")) for candidate in supporting), default=0.0),
        ))
        for name in profile_names:
            features.extend(aggregate_profile_features(
                all_years,
                profiles.get(name),
                start,
            ))
        candidates.append(BASE.Candidate(
            start_year=start,
            center_year=center,
            features=np.asarray(features, dtype=np.float32),
            relevance=max(0, HALF_WIDTH + 1 - abs(center - truth)),
        ))
    context = row.get("context") or {}
    return BASE.Case(
        dataset=dataset,
        event_type=EVENT_TYPE,
        key=identity(context),
        truth_year=truth,
        group=str(context.get("groupId", context.get("file", ""))).lower(),
        current_window=(int(mode["startYear"]), int(mode["endYear"])),
        candidates=tuple(candidates),
    )


def load_rows(arguments: Iterable[str]):
    datasets: dict[str, dict[str, Any]] = {}
    locator_rows = []
    for argument in arguments:
        dataset, raw_path = argument.split("=", 1)
        payload = json.loads(Path(raw_path).read_text(encoding="utf-8"))
        formal = {
            identity(outcome.get("context") or {}): outcome
            for outcome in payload.get("formalEventCaseOutcomes", [])
            if outcome.get("eventType") == EVENT_TYPE
        }
        datasets[dataset] = {
            "denominator": len(formal),
            "finalHits": sum(bool(row.get("primaryMatched")) for row in formal.values()),
        }
        seen = set()
        for row in payload.get("counterfactualLocatorCases", []):
            if row.get("eventType") != EVENT_TYPE:
                continue
            key = identity(row.get("context") or {})
            outcome = formal.get(key)
            if (
                not outcome
                or not outcome.get("answered")
                or key in seen
                or row.get("correctionYears") != row.get("truthCorrectionYears")
            ):
                continue
            locator_rows.append((dataset, row))
            seen.add(key)
    return datasets, locator_rows


def evaluate(rows: Sequence[dict[str, Any]], denominator: int) -> dict[str, Any]:
    errors = [abs(row["candidateCenter"] - row["truth"]) for row in rows]
    return {
        "denominator": denominator,
        "locatedCases": len(rows),
        "modeBaselineHits": sum(bool(row["baselineHit"]) for row in rows),
        "candidateHits": sum(bool(row["candidateHit"]) for row in rows),
        "candidateCoverage": sum(bool(row["candidateHit"]) for row in rows)
            / max(1, denominator),
        "medianError": float(np.median(errors)) if errors else 0.0,
        "p90Error": float(np.quantile(errors, 0.9)) if errors else 0.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    datasets, locator_rows = load_rows(args.source)
    profile_names = common_profile_names([row for _, row in locator_rows])
    cases = [
        case
        for dataset, row in locator_rows
        for case in [build_case(dataset, row, profile_names)]
        if case is not None
    ]
    dataset_names = sorted(datasets)
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "profileCount": len(profile_names),
        "profiles": profile_names,
        "datasets": datasets,
        "variants": {},
    }
    for variant_index, variant in enumerate(("small", "medium", "wide")):
        folds = {}
        prediction_rows = []
        for fold_index, held_name in enumerate(dataset_names):
            held = [case for case in cases if case.dataset == held_name]
            held_groups = {case.group for case in held}
            train = [
                case for case in cases
                if case.dataset != held_name and case.group not in held_groups
            ]
            model = BASE.fit_model(
                train,
                20261310 + variant_index * 10 + fold_index,
                variant,
            )
            rows = BASE.predict_rows(model, held)
            prediction_rows.extend(rows)
            folds[held_name] = {
                "finalBaselineHits": datasets[held_name]["finalHits"],
                **evaluate(rows, datasets[held_name]["denominator"]),
            }
        gate = BASE.select_gate(prediction_rows, dataset_names)
        report["variants"][variant] = {
            "folds": folds,
            **({
                "gate": gate[1],
                "gatedOverall": gate[2],
                "gatedFolds": gate[3],
            } if gate else {}),
        }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
