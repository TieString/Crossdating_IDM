"""Find explainable 13-year coarse-window feature rescues across consumed splits."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence


WINDOW_WIDTH = 13
EVENT_TYPES = ("missingRing", "falseRing")


def mean(values: Iterable[float]) -> float:
    rows = list(values)
    return sum(rows) / max(1, len(rows))


def percentile_ranks(values: Sequence[float]) -> list[float]:
    if len(values) <= 1:
        return [0.5] * len(values)
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    result = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start + 1
        while end < len(order) and values[order[end]] == values[order[start]]:
            end += 1
        rank = (start + end - 1) / (2 * (len(order) - 1))
        for index in order[start:end]:
            result[index] = rank
        start = end
    return result


def bounded_start(center: int, first: int, last: int) -> int:
    return max(first, min(center - WINDOW_WIDTH // 2, last - WINDOW_WIDTH + 1))


def window_hit(window: tuple[int, int], truth: int) -> bool:
    return window[0] <= truth <= window[1]


def prepare_case(source: dict[str, Any], feature: str, method: str) -> dict[str, Any]:
    rows = source["rows"]
    years = [int(row["year"]) for row in rows]
    values = percentile_ranks([float(row["features"][feature]) for row in rows])
    starts = list(range(years[0], years[-1] - WINDOW_WIDTH + 2))
    current = tuple(map(int, source["primaryRange"]))
    current_start = bounded_start(
        round((current[0] + current[1]) / 2), years[0], years[-1]
    )
    current = (current_start, current_start + WINDOW_WIDTH - 1)
    if method == "peak":
        peak_index = max(range(len(values)), key=lambda index: (values[index], years[index]))
        selected_start = bounded_start(years[peak_index], years[0], years[-1])
        score_by_start = {
            start: values[years.index(start + WINDOW_WIDTH // 2)]
            for start in starts
        }
    else:
        score_by_start = {
            start: mean(values[years.index(start):years.index(start) + WINDOW_WIDTH])
            for start in starts
        }
        selected_start = max(starts, key=lambda start: (score_by_start[start], start))
    selected = (selected_start, selected_start + WINDOW_WIDTH - 1)
    selected_score = score_by_start[selected_start]
    current_score = score_by_start.get(current_start, selected_score)
    competing = [
        score for start, score in score_by_start.items()
        if start + WINDOW_WIDTH - 1 < selected[0] or start > selected[1]
    ]
    remote_margin = selected_score - max(competing, default=selected_score)
    return {
        "key": source["key"],
        "dataset": source["split"],
        "file": source["file"],
        "target": source["target"],
        "truth": int(source["truthYear"]),
        "current": current,
        "selected": selected,
        "distance": abs(selected_start - current_start),
        "advantage": selected_score - current_score,
        "remoteMargin": remote_margin,
    }


def metrics(rows: Sequence[dict[str, Any]], gate: dict[str, float]) -> dict[str, int]:
    old_hits = new_hits = gains = losses = changes = 0
    for row in rows:
        changed = (
            row["distance"] >= gate["minimumDistance"]
            and row["advantage"] >= gate["minimumAdvantage"]
            and row["remoteMargin"] >= gate["minimumRemoteMargin"]
        )
        old_hit = window_hit(row["current"], row["truth"])
        new_hit = window_hit(row["selected"], row["truth"]) if changed else old_hit
        old_hits += int(old_hit)
        new_hits += int(new_hit)
        gains += int(changed and new_hit and not old_hit)
        losses += int(changed and old_hit and not new_hit)
        changes += int(changed)
    return {
        "cases": len(rows),
        "oldHits": old_hits,
        "newHits": new_hits,
        "gains": gains,
        "losses": losses,
        "changes": changes,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--features", default="")
    parser.add_argument("--events", default="")
    args = parser.parse_args()
    raw = json.loads(Path(args.dataset).read_text(encoding="utf-8"))
    features = sorted(raw[0]["rows"][0]["features"])
    requested_features = {
        value.strip() for value in args.features.split(",") if value.strip()
    }
    if requested_features:
        missing = requested_features.difference(features)
        if missing:
            raise ValueError(f"Unknown features: {sorted(missing)}")
        features = [feature for feature in features if feature in requested_features]
    requested_events = {
        value.strip() for value in args.events.split(",") if value.strip()
    }
    event_types = tuple(
        event_type for event_type in EVENT_TYPES
        if not requested_events or event_type in requested_events
    )
    datasets = sorted({str(row["split"]) for row in raw})
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in event_types:
        sources = [row for row in raw if row["eventType"] == event_type]
        candidates = []
        for feature in features:
            for method in ("mass", "peak"):
                rows = [prepare_case(source, feature, method) for source in sources]
                for minimum_distance in (1, 2, 3, 5, 7):
                    for minimum_advantage in (0, 0.02, 0.05, 0.1, 0.15, 0.2):
                        for minimum_remote_margin in (-math.inf, 0, 0.02, 0.05, 0.1):
                            gate = {
                                "minimumDistance": minimum_distance,
                                "minimumAdvantage": minimum_advantage,
                                "minimumRemoteMargin": minimum_remote_margin,
                            }
                            by_dataset = {
                                name: metrics(
                                    [row for row in rows if row["dataset"] == name], gate
                                )
                                for name in datasets
                            }
                            if any(
                                summary["newHits"] < summary["oldHits"]
                                for summary in by_dataset.values()
                            ):
                                continue
                            total = metrics(rows, gate)
                            if total["newHits"] <= total["oldHits"]:
                                continue
                            candidates.append({
                                "feature": feature,
                                "method": method,
                                "gate": gate,
                                "total": total,
                                "byDataset": by_dataset,
                            })
        candidates.sort(key=lambda row: (
            row["total"]["newHits"] - row["total"]["oldHits"],
            -row["total"]["losses"],
            -row["total"]["changes"],
        ), reverse=True)
        selected = candidates[0] if candidates else None
        changes = []
        if selected:
            selected_rows = [
                prepare_case(source, selected["feature"], selected["method"])
                for source in sources
            ]
            gate = selected["gate"]
            for row in selected_rows:
                changed = (
                    row["distance"] >= gate["minimumDistance"]
                    and row["advantage"] >= gate["minimumAdvantage"]
                    and row["remoteMargin"] >= gate["minimumRemoteMargin"]
                )
                if not changed:
                    continue
                old_hit = window_hit(row["current"], row["truth"])
                new_hit = window_hit(row["selected"], row["truth"])
                changes.append({
                    **row,
                    "oldHit": old_hit,
                    "newHit": new_hit,
                })
        report["eventTypes"][event_type] = {
            "selected": selected,
            "changes": changes,
            "candidates": candidates[:100],
        }
        print(json.dumps({event_type: candidates[:5]}, indent=2))
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
