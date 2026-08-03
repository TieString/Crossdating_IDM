"""Calibrate a conservative false-ring fallback to a remote side-step mode."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


@dataclass(frozen=True)
class Case:
    group: str
    dataset: str
    truth: int
    old_start: int
    old_end: int
    side_year: int
    coarse_start: int
    coarse_end: int
    distance: float
    minimum_advantage: float
    corrected_support: float
    remote_margin: float

    @property
    def old_hit(self) -> bool:
        return self.old_start <= self.truth <= self.old_end

    def new_hit(self, placement: str, center_adjustment: int) -> bool:
        if placement == "edge":
            if self.side_year > self.old_end:
                return self.side_year - 12 <= self.truth <= self.side_year
            if self.side_year < self.old_start:
                return self.side_year <= self.truth <= self.side_year + 12
            return self.old_hit
        center = self.side_year + center_adjustment
        return center - 6 <= self.truth <= center + 6


@dataclass(frozen=True)
class Gate:
    minimum_distance: int
    minimum_advantage: float
    minimum_support: float
    minimum_remote_margin: float
    placement: str
    center_adjustment: int

    def accepts(self, case: Case) -> bool:
        return (
            case.coarse_start <= case.side_year <= case.coarse_end
            and case.distance >= self.minimum_distance
            and (
                self.placement != "edge"
                or case.side_year < case.old_start
                or case.side_year > case.old_end
            )
            and case.minimum_advantage >= self.minimum_advantage
            and case.corrected_support >= self.minimum_support
            and case.remote_margin >= self.minimum_remote_margin
        )


def load(path: Path, dataset: str) -> list[Case]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = []
    seen = set()
    for row in payload.get("counterfactualLocatorCases", []):
        context = row.get("context", {})
        final = row.get("finalWindow")
        coarse = row.get("coarseWindow")
        operation = row.get("selectedOperation") or {}
        side_year = operation.get("sideStepBestYear")
        key = (
            str(context.get("file", "")).lower(),
            str(context.get("target", "")).lower(),
            row.get("truthYear"),
        )
        if (
            key in seen
            or context.get("baselineFlagged", True)
            or row.get("eventType") != "falseRing"
            or row.get("correctionYears") != row.get("truthCorrectionYears")
            or not final
            or not coarse
            or side_year is None
        ):
            continue
        seen.add(key)
        old_start = int(final["startYear"])
        old_end = int(final["endYear"])
        result.append(Case(
            group=key[0],
            dataset=dataset,
            truth=int(row["truthYear"]),
            old_start=old_start,
            old_end=old_end,
            side_year=int(side_year),
            coarse_start=int(coarse["startYear"]),
            coarse_end=int(coarse["endYear"]),
            distance=abs(int(side_year) - (old_start + old_end) / 2),
            minimum_advantage=float(
                operation.get("bestSideMinimumAdvantage") or 0
            ),
            corrected_support=float(
                operation.get("bestCorrectedSideSupport") or 0
            ),
            remote_margin=float(operation.get("sideStepRemoteMargin") or 0),
        ))
    return result


def gates() -> Iterable[Gate]:
    for distance in (5, 6, 7, 8, 9, 10, 12):
        for advantage in (0.35, 0.4, 0.45, 0.5, 0.55, 0.6):
            for support in (0.35, 0.4, 0.45, 0.5, 0.55, 0.6):
                for margin in (0.02, 0.03, 0.05, 0.08, 0.1, 0.2, 0.4):
                    for placement in ("center", "edge"):
                        for adjustment in (-1, 0, 1):
                            if placement == "edge" and adjustment != 0:
                                continue
                            yield Gate(
                                distance,
                                advantage,
                                support,
                                margin,
                                placement,
                                adjustment,
                            )


def summarize(cases: Sequence[Case], gate: Gate) -> dict[str, int]:
    old_hits = sum(case.old_hit for case in cases)
    changed = [case for case in cases if gate.accepts(case)]
    new_hits = sum(
        case.new_hit(gate.placement, gate.center_adjustment)
        if gate.accepts(case)
        else case.old_hit
        for case in cases
    )
    return {
        "cases": len(cases),
        "oldHits": old_hits,
        "newHits": new_hits,
        "delta": new_hits - old_hits,
        "gains": sum(
            not case.old_hit
            and case.new_hit(gate.placement, gate.center_adjustment)
            for case in changed
        ),
        "losses": sum(
            case.old_hit
            and not case.new_hit(gate.placement, gate.center_adjustment)
            for case in changed
        ),
        "changes": len(changed),
    }


def fold(group: str) -> int:
    return int(hashlib.sha256(group.encode()).hexdigest()[:8], 16) % 5


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", required=True)
    parser.add_argument("--calibration", required=True)
    parser.add_argument("--validation", required=True)
    parser.add_argument("--reserved1", required=True)
    parser.add_argument("--reserved2", required=True)
    parser.add_argument(
        "--report",
        default=".tmp-false-ring-remote-side-gate-report.json",
    )
    args = parser.parse_args()
    cases = []
    for dataset in (
        "train", "calibration", "validation", "reserved1", "reserved2"
    ):
        cases.extend(load(Path(getattr(args, dataset)), dataset))
    train = [case for case in cases if case.dataset == "train"]
    calibration = [case for case in cases if case.dataset == "calibration"]
    selected: list[tuple[Any, ...]] = []
    for gate in gates():
        train_summary = summarize(train, gate)
        if train_summary["delta"] <= 0:
            continue
        folds = [summarize(
            [case for case in train if fold(case.group) == index], gate
        ) for index in range(5)]
        calibrated = summarize(calibration, gate)
        if any(row["delta"] < 0 for row in folds) or calibrated["delta"] < 0:
            continue
        score = (
            min(row["delta"] for row in folds),
            calibrated["delta"],
            train_summary["delta"],
            -train_summary["changes"],
        )
        selected.append((score, gate, train_summary, folds, calibrated))
    selected.sort(key=lambda row: row[0], reverse=True)
    report = []
    for score, gate, train_summary, folds, calibrated in selected[:100]:
        report.append({
            "selectionScore": score,
            "gate": gate.__dict__,
            "train": train_summary,
            "folds": folds,
            "calibration": calibrated,
            **{
                dataset: summarize(
                    [case for case in cases if case.dataset == dataset], gate
                )
                for dataset in ("validation", "reserved1", "reserved2")
            },
        })
    Path(args.report).write_text(
        json.dumps({"schemaVersion": 1, "candidates": report}, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(report[:5], indent=2))


if __name__ == "__main__":
    main()
