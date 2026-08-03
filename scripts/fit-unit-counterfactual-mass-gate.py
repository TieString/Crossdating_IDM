"""Calibrate a conservative gate for direct unit counterfactual mass windows."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, median
from typing import Any, Iterable, Sequence


WINDOW_WIDTH = 13
EVENT_TYPES = ("missingRing", "falseRing")
PROFILES = {
    "missingRing": (
        "differencePredictiveWeightedHuber21",
        "differencePredictiveEnsembleHuber31",
        "differencePredictiveWeightedHuber61",
        "whitenedPredictiveEnsembleHuber21",
    ),
    "falseRing": (
        "differenceMasterHuber31",
        "whitenedMasterHuber31",
        "differenceReferenceWeightedHuber31",
        "differenceMasterHuber21",
    ),
}


@dataclass(frozen=True)
class Case:
    key: str
    group: str
    dataset: str
    event_type: str
    truth: int
    old_start: int
    old_end: int
    mode_start: int
    mode_end: int
    recentered_start: int
    recentered_end: int
    aggregate_advantage: float
    minimum_profile_advantage: float
    median_profile_advantage: float
    profile_center_dispersion: int
    center_distance: int
    local_margin: float

    @property
    def old_hit(self) -> bool:
        return self.old_start <= self.truth <= self.old_end

    @property
    def new_hit(self) -> bool:
        return self.recentered_start <= self.truth <= self.recentered_end

    @property
    def old_width(self) -> int:
        return self.old_end - self.old_start + 1


@dataclass(frozen=True)
class Gate:
    minimum_aggregate_advantage: float
    minimum_profile_advantage: float
    minimum_median_advantage: float
    maximum_profile_dispersion: int
    maximum_center_distance: int
    minimum_local_margin: float
    scope: str

    def accepts(self, case: Case) -> bool:
        return (
            case.aggregate_advantage >= self.minimum_aggregate_advantage
            and case.minimum_profile_advantage >= self.minimum_profile_advantage
            and case.median_profile_advantage >= self.minimum_median_advantage
            and case.profile_center_dispersion <= self.maximum_profile_dispersion
            and case.center_distance <= self.maximum_center_distance
            and case.local_margin >= self.minimum_local_margin
            and (self.scope == "all" or case.old_width == WINDOW_WIDTH)
            and (case.old_start, case.old_end)
                != (case.recentered_start, case.recentered_end)
        )


def zscore(values: Sequence[float]) -> list[float]:
    center = mean(values)
    variance = mean([(value - center) ** 2 for value in values])
    scale = variance ** 0.5 or 1.0
    return [(value - center) / scale for value in values]


def window_sums(values: Sequence[float]) -> list[float]:
    if len(values) < WINDOW_WIDTH:
        return []
    result = [sum(values[:WINDOW_WIDTH])]
    for index in range(1, len(values) - WINDOW_WIDTH + 1):
        result.append(
            result[-1] - values[index - 1] + values[index + WINDOW_WIDTH - 1]
        )
    return result


def make_case(source: dict[str, Any], dataset: str) -> Case | None:
    event_type = source.get("eventType")
    rows = source.get("rows") or source.get("unitCounterfactualRows") or []
    old = source.get("primaryRange") or (
        [source["finalWindow"]["startYear"], source["finalWindow"]["endYear"]]
        if source.get("finalWindow") else None
    )
    if event_type not in EVENT_TYPES or len(rows) < WINDOW_WIDTH or not old:
        return None
    feature_key = "features" if "features" in rows[0] else "profiles"
    names = [name for name in PROFILES[event_type] if name in rows[0][feature_key]]
    if len(names) != len(PROFILES[event_type]):
        return None
    years = [int(row["year"]) for row in rows]
    if any(right != left + 1 for left, right in zip(years, years[1:])):
        return None
    profile_windows = [
        window_sums(zscore([float(row[feature_key][name]) for row in rows]))
        for name in names
    ]
    aggregate = [
        median([profile[index] for profile in profile_windows])
        for index in range(len(profile_windows[0]))
    ]
    old_start, old_end = map(int, old)
    current_center = (old_start + old_end) / 2
    selected_index = max(
        range(len(aggregate)),
        key=lambda index: (
            aggregate[index],
            -abs(years[index] + 6 - current_center),
            years[index],
        ),
    )
    current_start = round(current_center) - 6
    current_start = max(years[0], min(current_start, years[-1] - 12))
    current_index = current_start - years[0]
    if not 0 <= current_index < len(aggregate):
        return None
    profile_advantages = [
        profile[selected_index] - profile[current_index]
        for profile in profile_windows
    ]
    profile_centers = [
        years[max(range(len(profile)), key=lambda index: (
            profile[index],
            -abs(years[index] + 6 - current_center),
            years[index],
        ))] + 6
        for profile in profile_windows
    ]
    selected_center = years[selected_index] + 6
    old_width = old_end - old_start + 1
    recentered_start = selected_center - old_width // 2
    competitors = [
        score for index, score in enumerate(aggregate)
        if abs((years[index] + 6) - selected_center) > 2
    ]
    context = source.get("context", {})
    group = str(source.get("file") or context.get("file") or "").lower()
    target = str(source.get("target") or context.get("target") or "")
    truth = int(source["truthYear"])
    return Case(
        key=f"{group}|{target}|{event_type}|{truth}",
        group=group,
        dataset=dataset,
        event_type=event_type,
        truth=truth,
        old_start=old_start,
        old_end=old_end,
        mode_start=years[selected_index],
        mode_end=years[selected_index] + 12,
        recentered_start=recentered_start,
        recentered_end=recentered_start + old_width - 1,
        aggregate_advantage=aggregate[selected_index] - aggregate[current_index],
        minimum_profile_advantage=min(profile_advantages),
        median_profile_advantage=median(profile_advantages),
        profile_center_dispersion=max(profile_centers) - min(profile_centers),
        center_distance=round(abs(selected_center - current_center)),
        local_margin=aggregate[selected_index] - max(competitors, default=aggregate[selected_index]),
    )


def rich_dataset(source: dict[str, Any]) -> str:
    audit = str(source.get("sourceAudit", "")).lower()
    if "reserved-rich" in audit:
        return "reserved1"
    return str(source.get("split") or "other")


def load(path: Path, object_dataset: str) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        cases = [make_case(source, rich_dataset(source)) for source in payload]
    else:
        cases = [make_case(source, object_dataset) for source in (
            payload.get("counterfactualLocatorCases", [])
        ) if source.get("context", {}).get("baselineFlagged") is False]
    result = [case for case in cases if case is not None]
    del payload, cases
    gc.collect()
    return result


def grid() -> Iterable[Gate]:
    for aggregate in (0.0, 0.25, 0.5, 1.0):
        for minimum in (-1.0, -0.5, 0.0, 0.1):
            for middle in (0.0, 0.25, 0.5, 1.0):
                for dispersion in (1, 2, 4, 6, 99):
                    for distance in (2, 4, 6, 8, 12):
                        for margin in (-0.5, 0.0, 0.1):
                            for scope in ("all", "wide"):
                                yield Gate(
                                    aggregate, minimum, middle, dispersion,
                                    distance, margin, scope,
                                )


def summarize(cases: Sequence[Case], gate: Gate) -> dict[str, Any]:
    changed = [case for case in cases if gate.accepts(case)]
    old_hits = sum(case.old_hit for case in cases)
    new_hits = sum(
        case.new_hit if gate.accepts(case) else case.old_hit
        for case in cases
    )
    return {
        "cases": len(cases),
        "oldHits": old_hits,
        "newHits": new_hits,
        "delta": new_hits - old_hits,
        "gains": sum(not case.old_hit and case.new_hit for case in changed),
        "losses": sum(case.old_hit and not case.new_hit for case in changed),
        "changes": len(changed),
    }


def fold_for(group: str) -> int:
    return int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 5


def select_rules(cases: Sequence[Case], event_type: str) -> list[dict[str, Any]]:
    train = [case for case in cases if case.event_type == event_type and case.dataset == "train"]
    calibration = [
        case for case in cases
        if case.event_type == event_type and case.dataset == "calibration"
    ]
    candidates = []
    for gate in grid():
        overall = summarize(train, gate)
        if overall["gains"] == 0:
            continue
        folds = [summarize([case for case in train if fold_for(case.group) == fold], gate)
                 for fold in range(5)]
        calibrated = summarize(calibration, gate)
        if any(row["delta"] < 0 for row in folds) or calibrated["delta"] < 0:
            continue
        score = (
            min(row["delta"] for row in folds),
            calibrated["delta"],
            overall["delta"],
            -calibrated["losses"],
            -overall["losses"],
            -overall["changes"],
        )
        candidates.append((score, gate, overall, folds, calibrated))
    candidates.sort(key=lambda row: row[0], reverse=True)
    report = []
    for score, gate, overall, folds, calibrated in candidates[:30]:
        report.append({
            "selectionScore": score,
            "gate": gate.__dict__,
            "train": overall,
            "folds": folds,
            "calibration": calibrated,
            **{
                dataset: summarize([
                    case for case in cases
                    if case.event_type == event_type and case.dataset == dataset
                ], gate)
                for dataset in ("validation", "reserved1", "reserved2")
            },
        })
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rich", required=True)
    parser.add_argument("--reserved2", required=True)
    parser.add_argument("--report", default=".tmp-unit-counterfactual-mass-gate-report.json")
    args = parser.parse_args()
    cases = load(Path(args.rich), "other")
    cases.extend(load(Path(args.reserved2), "reserved2"))
    report = {
        "schemaVersion": 1,
        "caseCounts": {
            event_type: {
                dataset: sum(
                    case.event_type == event_type and case.dataset == dataset
                    for case in cases
                )
                for dataset in ("train", "calibration", "validation", "reserved1", "reserved2")
            }
            for event_type in EVENT_TYPES
        },
        "eventTypes": {
            event_type: select_rules(cases, event_type)
            for event_type in EVENT_TYPES
        },
    }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        event_type: rows[0] if rows else None
        for event_type, rows in report["eventTypes"].items()
    }, indent=2))


if __name__ == "__main__":
    main()
