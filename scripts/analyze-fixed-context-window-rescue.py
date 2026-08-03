"""Audit whether fixed-context lag peaks can safely recenter unit-event windows.

The threshold search uses the supplied development audits only. A reserved audit is
reported after rule selection and never participates in choosing the rule.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


EVENT_TYPES = ("missingRing", "falseRing")


@dataclass(frozen=True)
class Case:
    source: str
    group: str
    event_type: str
    truth: int
    current_start: int
    current_end: int
    peak_year: int
    peak_score: float
    peak_z: float
    peak_margin: float
    minimum_side: float
    side_balance: float
    center_distance: float

    @property
    def old_hit(self) -> bool:
        return self.current_start <= self.truth <= self.current_end

    @property
    def new_hit(self) -> bool:
        return abs(self.peak_year - self.truth) <= 6


@dataclass(frozen=True)
class Rule:
    radius: int
    minimum_z: float
    minimum_margin: float
    minimum_side: float
    maximum_distance: int
    only_wide: bool

    def accepts(self, case: Case) -> bool:
        return (
            case.peak_z >= self.minimum_z
            and case.peak_margin >= self.minimum_margin
            and case.minimum_side >= self.minimum_side
            and case.center_distance <= self.maximum_distance
            and (not self.only_wide or case.current_end - case.current_start + 1 >= 13)
        )


def matching_window(row: dict[str, Any]) -> tuple[int, int] | None:
    event_type = row.get("eventType")
    for event in row.get("currentEvents", []):
        if event.get("eventType") == event_type:
            return int(event["startYear"]), int(event["endYear"])
    return None


def load_cases(paths: Sequence[Path], radius: int) -> list[Case]:
    result: list[Case] = []
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for row in payload.get("fixedContextCases", []):
            event_type = row.get("eventType")
            if event_type not in EVENT_TYPES:
                continue
            window = matching_window(row)
            if window is None:
                continue
            center = (window[0] + window[1]) / 2
            peaks = [
                peak for peak in row.get("peaks", [])
                if abs(float(peak["year"]) - center) <= radius
            ]
            if not peaks:
                continue
            peaks.sort(key=lambda peak: (float(peak["score"]), int(peak["year"])), reverse=True)
            peak = peaks[0]
            competing = max(
                (float(other["score"]) for other in row.get("peaks", [])
                 if abs(int(other["year"]) - int(peak["year"])) > 7),
                default=float(peak["score"]),
            )
            scale = max(1e-9, float(row.get("scoreScale") or 0))
            score = float(peak["score"])
            older = float(peak.get("olderAdvantage") or 0)
            newer = float(peak.get("newerAdvantage") or 0)
            result.append(Case(
                source=path.name,
                group=str(row.get("file", "")),
                event_type=event_type,
                truth=int(row["truthYear"]),
                current_start=window[0],
                current_end=window[1],
                peak_year=int(peak["year"]),
                peak_score=score,
                peak_z=(score - float(row.get("scoreMean") or 0)) / scale,
                peak_margin=score - competing,
                minimum_side=float(peak.get("minimumSideAdvantage") or 0),
                side_balance=min(older, newer),
                center_distance=abs(float(peak["year"]) - center),
            ))
    return result


def summarize(cases: Iterable[Case], rule: Rule) -> dict[str, Any]:
    rows = list(cases)
    changed = [case for case in rows if rule.accepts(case)]
    old_hits = sum(case.old_hit for case in rows)
    new_hits = sum(
        case.new_hit if rule.accepts(case) else case.old_hit
        for case in rows
    )
    return {
        "cases": len(rows),
        "oldHits": old_hits,
        "newHits": new_hits,
        "delta": new_hits - old_hits,
        "changes": len(changed),
        "gains": sum(not case.old_hit and case.new_hit for case in changed),
        "losses": sum(case.old_hit and not case.new_hit for case in changed),
    }


def rule_grid(radius: int) -> Iterable[Rule]:
    for minimum_z in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0):
        for minimum_margin in (-1.0, -0.25, 0.0, 0.1, 0.25, 0.5):
            for minimum_side in (-0.5, -0.25, 0.0, 0.1, 0.2, 0.3):
                for maximum_distance in (2, 4, 6, 8, 10, 12, radius):
                    for only_wide in (False, True):
                        yield Rule(
                            radius,
                            minimum_z,
                            minimum_margin,
                            minimum_side,
                            maximum_distance,
                            only_wide,
                        )


def choose_rule(cases: Sequence[Case], radius: int) -> tuple[Rule, dict[str, Any]]:
    sources = sorted({case.source for case in cases})
    candidates = []
    for rule in rule_grid(radius):
        overall = summarize(cases, rule)
        folds = [summarize((case for case in cases if case.source == source), rule)
                 for source in sources]
        if any(fold["losses"] > fold["gains"] for fold in folds):
            continue
        candidates.append((
            (
                min(fold["delta"] for fold in folds),
                overall["delta"],
                -overall["losses"],
                -overall["changes"],
                -rule.maximum_distance,
            ),
            rule,
            {"overall": overall, "folds": folds},
        ))
    if not candidates:
        fallback = Rule(radius, 99, 99, 99, 0, True)
        return fallback, {"overall": summarize(cases, fallback), "folds": []}
    candidates.sort(key=lambda row: row[0], reverse=True)
    return candidates[0][1], candidates[0][2]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development", nargs="+", required=True)
    parser.add_argument("--reserved", required=True)
    parser.add_argument("--report", default=".tmp-fixed-context-window-rescue-report.json")
    args = parser.parse_args()

    development_paths = [Path(value) for value in args.development]
    reserved_path = Path(args.reserved)
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in EVENT_TYPES:
        radius_candidates = []
        for radius in (6, 8, 10, 12, 16, 24):
            development = [
                case for case in load_cases(development_paths, radius)
                if case.event_type == event_type
            ]
            rule, selection = choose_rule(development, radius)
            radius_candidates.append((
                (
                    min((fold["delta"] for fold in selection["folds"]), default=0),
                    selection["overall"]["delta"],
                    -selection["overall"]["losses"],
                    -selection["overall"]["changes"],
                ),
                rule,
                selection,
            ))
        radius_candidates.sort(key=lambda row: row[0], reverse=True)
        _, rule, development_summary = radius_candidates[0]
        reserved = [
            case for case in load_cases([reserved_path], rule.radius)
            if case.event_type == event_type
        ]
        report["eventTypes"][event_type] = {
            "rule": rule.__dict__,
            "development": development_summary,
            "reserved": summarize(reserved, rule),
            "reservedChanges": [case.__dict__ for case in reserved if rule.accepts(case)],
        }
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
