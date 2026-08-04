"""Search cross-split-safe operation-anchor overrides for 13-year modes."""

from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Sequence


EVENT_TYPES = ("missingRing", "falseRing")
WINDOW_WIDTH = 13


def hit(window: Sequence[int], truth: int) -> bool:
    return window[0] <= truth <= window[1]


def bounded_window(center: float, coarse: Sequence[int]) -> tuple[int, int]:
    start = round(center) - WINDOW_WIDTH // 2
    start = max(int(coarse[0]), min(start, int(coarse[1]) - WINDOW_WIDTH + 1))
    return start, start + WINDOW_WIDTH - 1


def direction(value: float, origin: float) -> int:
    return (value > origin) - (value < origin)


def anchor(method: str, source: dict[str, Any]) -> float | None:
    current = source.get("primaryTopYear")
    operation = source.get("operationBestYear")
    side = source.get("sideStepBestYear")
    if method == "current":
        return current
    if method == "operation":
        return operation
    if method == "side":
        return side
    values = [value for value in (current, operation, side) if value is not None]
    if method == "anchorMedian":
        return median(values) if values else None
    values = [value for value in (operation, side) if value is not None]
    if method == "operationSideMedian":
        return median(values) if values else None
    return None


def prepare(
    source: dict[str, Any],
    method: str,
    bounds_field: str,
) -> dict[str, Any] | None:
    selected_anchor = anchor(method, source)
    if selected_anchor is None:
        return None
    current = tuple(map(int, source["primaryRange"]))
    current_center = sum(current) / 2
    bounds = source.get(bounds_field) or source["coarseRange"]
    selected = bounded_window(float(selected_anchor), bounds)
    if selected == current:
        return None
    selected_center = sum(selected) / 2
    selected_direction = direction(selected_center, current_center)
    anchors = [
        float(value) for value in (
            source.get("primaryTopYear"),
            source.get("operationBestYear"),
            source.get("sideStepBestYear"),
        ) if value is not None
    ]
    return {
        "key": source["key"],
        "dataset": source["split"],
        "file": source["file"],
        "target": source["target"],
        "truth": int(source["truthYear"]),
        "sourceRule": source.get("windowCenteringRule"),
        "current": current,
        "selected": selected,
        "distance": abs(selected[0] - current[0]),
        "votes": sum(
            direction(value, current_center) == selected_direction
            for value in anchors
        ),
        "spread": max(anchors) - min(anchors) if anchors else math.inf,
        "operationDifference": float(
            source.get("operationBestDifferenceGain") or 0
        ),
        "operationRemote": float(
            source.get("operationRemoteDifferenceMargin") or 0
        ),
        "sideScore": float(source.get("sideStepBestScore") or 0),
        "sideRemote": float(source.get("sideStepRemoteMargin") or 0),
    }


def use(row: dict[str, Any], gate: dict[str, float]) -> bool:
    return (
        row["distance"] >= gate["minimumDistance"]
        and row["distance"] <= gate["maximumDistance"]
        and row["votes"] >= gate["minimumVotes"]
        and row["spread"] <= gate["maximumSpread"]
        and row["operationDifference"] >= gate["minimumOperationDifference"]
        and row["operationRemote"] >= gate["minimumOperationRemote"]
        and row["sideScore"] >= gate["minimumSideScore"]
        and row["sideRemote"] >= gate["minimumSideRemote"]
    )


def metrics(rows: Iterable[dict[str, Any]], gate: dict[str, float]):
    result = {
        "cases": 0,
        "oldHits": 0,
        "newHits": 0,
        "gains": 0,
        "losses": 0,
        "changes": 0,
    }
    for row in rows:
        result["cases"] += 1
        changed = use(row, gate)
        old_hit = hit(row["current"], row["truth"])
        new_hit = hit(row["selected"], row["truth"]) if changed else old_hit
        result["oldHits"] += int(old_hit)
        result["newHits"] += int(new_hit)
        result["gains"] += int(changed and new_hit and not old_hit)
        result["losses"] += int(changed and old_hit and not new_hit)
        result["changes"] += int(changed)
    return result


def gates(method: str):
    common = itertools.product(
        (1, 2, 3, 5, 7, 9),
        (4, 8, 12, 20, math.inf),
        (1, 2, 3),
        (3, 5, 8, 12, 20, math.inf),
    )
    if method == "operation":
        quality = itertools.product(
            (0, 0.1, 0.2, 0.3, 0.5, 0.7),
            (0, 0.01, 0.03, 0.05, 0.1),
        )
        quality_rows = [(op, remote, -math.inf, -math.inf) for op, remote in quality]
    elif method == "side":
        quality = itertools.product(
            (0, 0.2, 0.4, 0.6, 0.8),
            (0, 0.01, 0.03, 0.05, 0.1),
        )
        quality_rows = [(-math.inf, -math.inf, score, remote) for score, remote in quality]
    elif method == "current":
        quality_rows = [(-math.inf, -math.inf, -math.inf, -math.inf)]
    else:
        quality_rows = [
            (op, -math.inf, side, -math.inf)
            for op, side in itertools.product(
                (0, 0.2, 0.4, 0.6),
                (0, 0.3, 0.5, 0.7),
            )
        ]
    for minimum_distance, maximum_distance, votes, spread in common:
        if maximum_distance < minimum_distance:
            continue
        for op, op_remote, side, side_remote in quality_rows:
            yield {
                "minimumDistance": minimum_distance,
                "maximumDistance": maximum_distance,
                "minimumVotes": votes,
                "maximumSpread": spread,
                "minimumOperationDifference": op,
                "minimumOperationRemote": op_remote,
                "minimumSideScore": side,
                "minimumSideRemote": side_remote,
            }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--bounds", choices=("coarse", "series"), default="coarse")
    args = parser.parse_args()
    raw = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    datasets = sorted({str(row["split"]) for row in raw})
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in EVENT_TYPES:
        sources = [row for row in raw if row["eventType"] == event_type]
        candidates = []
        source_rules = sorted({str(row.get("windowCenteringRule")) for row in sources})
        for method, source_rule in itertools.product(
            (
                "current", "operation", "side", "anchorMedian",
                "operationSideMedian",
            ),
            (None, *source_rules),
        ):
            rows = [row for source in sources if (
                (source_rule is None or source.get("windowCenteringRule") == source_rule)
                and (
                    row := prepare(
                        source,
                        method,
                        "seriesRange" if args.bounds == "series" else "coarseRange",
                    )
                )
            )]
            for gate in gates(method):
                total = metrics(rows, gate)
                if total["newHits"] <= total["oldHits"]:
                    continue
                by_dataset = {
                    name: metrics(
                        (row for row in rows if row["dataset"] == name), gate
                    ) for name in datasets
                }
                if any(
                    summary["newHits"] < summary["oldHits"]
                    for summary in by_dataset.values()
                ):
                    continue
                support = sum(
                    summary["newHits"] > summary["oldHits"]
                    for summary in by_dataset.values()
                )
                candidates.append({
                    "method": method,
                    "sourceRule": source_rule,
                    "gate": gate,
                    "supportDatasets": support,
                    "total": total,
                    "byDataset": by_dataset,
                })
        candidates.sort(key=lambda row: (
            row["supportDatasets"],
            row["total"]["newHits"] - row["total"]["oldHits"],
            -row["total"]["losses"],
            -row["total"]["changes"],
        ), reverse=True)
        selected = candidates[0] if candidates else None
        changes = []
        if selected:
            rows = [
                row for source in sources
                if (
                    (
                        selected["sourceRule"] is None
                        or source.get("windowCenteringRule")
                            == selected["sourceRule"]
                    )
                    and (
                        row := prepare(
                            source,
                            selected["method"],
                            "seriesRange"
                                if args.bounds == "series"
                                else "coarseRange",
                        )
                    )
                )
            ]
            changes = [{
                **row,
                "oldHit": hit(row["current"], row["truth"]),
                "newHit": hit(row["selected"], row["truth"]),
            } for row in rows if use(row, selected["gate"])]
        report["eventTypes"][event_type] = {
            "selected": selected,
            "changes": changes,
            "candidates": candidates[:100],
        }
        print(json.dumps({event_type: candidates[:5]}, indent=2))
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
