"""Calibrate when a unit-event window should return to its original primary year."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


EVENT_TYPES = ("missingRing", "falseRing")


@dataclass(frozen=True)
class Case:
    group: str
    dataset: str
    event_type: str
    truth: int
    old_start: int
    old_end: int
    new_start: int
    new_end: int
    signed_distance: int
    operation_distance: float
    model_margin: float
    remote_margin: float

    @property
    def old_width(self) -> int:
        return self.old_end - self.old_start + 1

    @property
    def old_hit(self) -> bool:
        return self.old_start <= self.truth <= self.old_end

    @property
    def new_hit(self) -> bool:
        return self.new_start <= self.truth <= self.new_end


@dataclass(frozen=True)
class Gate:
    minimum_distance: int
    maximum_distance: int
    maximum_operation_distance: float
    maximum_model_margin: float
    maximum_remote_margin: float
    scope: str
    direction: str

    def accepts(self, case: Case) -> bool:
        distance = abs(case.signed_distance)
        return (
            self.minimum_distance <= distance <= self.maximum_distance
            and case.operation_distance <= self.maximum_operation_distance
            and case.model_margin <= self.maximum_model_margin
            and case.remote_margin <= self.maximum_remote_margin
            and (self.scope == "all"
                 or self.scope == "wide" and case.old_width == 13
                 or self.scope == "narrow" and case.old_width < 13)
            and (self.direction == "all"
                 or self.direction == "older" and case.signed_distance < 0
                 or self.direction == "newer" and case.signed_distance > 0)
        )


def dataset_name(path: Path) -> str:
    name = path.name.lower()
    if "calibration" in name:
        return "calibration"
    if "validation" in name or "independent" in name:
        return "validation"
    if "train" in name:
        return "train"
    return "other"


def load(path: Path, dataset: str | None = None) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = []
    for row in payload.get("counterfactualLocatorCases", []):
        context = row.get("context", {})
        event_type = row.get("eventType")
        final = row.get("finalWindow")
        current = row.get("currentPrimaryYear")
        if (
            context.get("baselineFlagged", True)
            or event_type not in EVENT_TYPES
            or not final
            or current is None
            or row.get("correctionYears") != row.get("truthCorrectionYears")
        ):
            continue
        old_start = int(final["startYear"])
        old_end = int(final["endYear"])
        width = old_end - old_start + 1
        old_center = (old_start + old_end) // 2
        current = int(current)
        operation = (row.get("selectedOperation") or {}).get("bestYear")
        new_start = current - width // 2
        result.append(Case(
            group=str(context.get("file", "")).lower(),
            dataset=dataset or dataset_name(path),
            event_type=event_type,
            truth=int(row["truthYear"]),
            old_start=old_start,
            old_end=old_end,
            new_start=new_start,
            new_end=new_start + width - 1,
            signed_distance=current - old_center,
            operation_distance=(
                abs(current - float(operation)) if operation is not None else 999
            ),
            model_margin=float(row.get("learnedWindowMargin") or 0),
            remote_margin=float(row.get("learnedWindowRemoteMargin") or 0),
        ))
    del payload
    gc.collect()
    return result


def gates() -> Iterable[Gate]:
    for minimum in (1, 2, 3):
        for maximum in (2, 3, 4, 6, 8, 12):
            if maximum < minimum:
                continue
            for operation in (1, 2, 4, 8, 999):
                for margin in (0.001, 0.005, 0.01, 0.05, 0.2, 999):
                    for remote in (0.1, 0.3, 0.6, 1.0, 999):
                        for scope in ("all", "wide", "narrow"):
                            for direction in ("all", "older", "newer"):
                                yield Gate(
                                    minimum, maximum, operation, margin,
                                    remote, scope, direction,
                                )


def summary(cases: Sequence[Case], gate: Gate) -> dict[str, int]:
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


def fold(group: str) -> int:
    return int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 5


def select(cases: Sequence[Case], event_type: str) -> list[dict[str, Any]]:
    train = [case for case in cases if case.event_type == event_type and case.dataset == "train"]
    calibration = [
        case for case in cases
        if case.event_type == event_type and case.dataset == "calibration"
    ]
    selected = []
    for gate in gates():
        overall = summary(train, gate)
        if overall["gains"] == 0:
            continue
        folds = [summary([case for case in train if fold(case.group) == index], gate)
                 for index in range(5)]
        calibrated = summary(calibration, gate)
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
        selected.append((score, gate, overall, folds, calibrated))
    selected.sort(key=lambda row: row[0], reverse=True)
    return [{
        "selectionScore": score,
        "gate": gate.__dict__,
        "train": overall,
        "folds": folded,
        "calibration": calibrated,
        **{
            dataset: summary([
                case for case in cases
                if case.event_type == event_type and case.dataset == dataset
            ], gate)
            for dataset in ("validation", "reserved1", "reserved2")
        },
    } for score, gate, overall, folded, calibrated in selected[:40]]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--reserved1", required=True)
    parser.add_argument("--reserved2", required=True)
    parser.add_argument("--report", default=".tmp-current-primary-window-gate-report.json")
    args = parser.parse_args()
    cases = []
    for raw in args.paths:
        cases.extend(load(Path(raw)))
    cases.extend(load(Path(args.reserved1), "reserved1"))
    cases.extend(load(Path(args.reserved2), "reserved2"))
    report = {
        "schemaVersion": 1,
        "eventTypes": {event_type: select(cases, event_type) for event_type in EVENT_TYPES},
    }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        event_type: rows[0] if rows else None
        for event_type, rows in report["eventTypes"].items()
    }, indent=2))


if __name__ == "__main__":
    main()
