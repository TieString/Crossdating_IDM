"""Measure which physical candidate sources localize unit events across file splits."""

from __future__ import annotations

import argparse
import gc
import json
from collections import defaultdict
from pathlib import Path
from statistics import median
from typing import Any, Callable, Sequence


EVENT_TYPES = ("missingRing", "falseRing")


def dataset_name(path: Path) -> str:
    name = path.name.lower()
    if "calibration" in name:
        return "calibration"
    if "validation" in name or "independent" in name:
        return "validation"
    if "reserved" in name:
        return "reserved"
    if "train" in name:
        return "train"
    return "other"


def canonical_source(value: str) -> str:
    if value.startswith("profile:"):
        return value
    if value.startswith("reference_transition:"):
        return value
    return value


def load(path: Path, dataset_override: str | None = None) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = []
    for row in payload.get("counterfactualLocatorCases", []):
        context = row.get("context", {})
        event_type = row.get("eventType")
        if context.get("baselineFlagged", True) or event_type not in EVENT_TYPES:
            continue
        if row.get("correctionYears") != row.get("truthCorrectionYears"):
            continue
        final = row.get("finalWindow")
        if not final:
            continue
        candidates = defaultdict(list)
        for candidate in row.get("candidates", []):
            candidates[canonical_source(str(candidate.get("source", "")))].append({
                "center": (float(candidate["startYear"]) + float(candidate["endYear"])) / 2,
                "score": float(candidate.get("score") or 0),
                "aggregate": float(candidate.get("aggregateScore") or 0),
                "consensus": float(candidate.get("overlapConsensus") or 0),
            })
        result.append({
            "sourceAudit": path.name,
            "dataset": dataset_override or dataset_name(path),
            "eventType": event_type,
            "truth": int(row["truthYear"]),
            "oldStart": int(final["startYear"]),
            "oldEnd": int(final["endYear"]),
            "current": row.get("currentPrimaryYear"),
            "operation": (row.get("selectedOperation") or {}).get("bestYear"),
            "side": (row.get("selectedOperation") or {}).get("sideStepBestYear"),
            "candidates": dict(candidates),
        })
    del payload
    gc.collect()
    return result


def selected_center(case: dict[str, Any], method: str) -> float | None:
    candidates = [row for rows in case["candidates"].values() for row in rows]
    if method.startswith("source:"):
        rows = case["candidates"].get(method.removeprefix("source:"), [])
        return rows[0]["center"] if rows else None
    anchors = [
        float(value) for value in (case.get("current"), case.get("operation"), case.get("side"))
        if value is not None
    ]
    if method == "medianCandidates":
        return median([row["center"] for row in candidates]) if candidates else None
    if method == "medianReferences":
        rows = [
            row for source, values in case["candidates"].items()
            if source.startswith("reference_transition:")
            for row in values
        ]
        return median([row["center"] for row in rows]) if rows else None
    if method == "weightedCandidates":
        weighted = [
            (row["center"], max(0.05, row["aggregate"] + row["consensus"]))
            for row in candidates
        ]
        total = sum(weight for _, weight in weighted)
        return sum(center * weight for center, weight in weighted) / total if total else None
    if method == "anchorMedian":
        return median(anchors) if anchors else None
    if method == "candidateAnchorMedian":
        values = [row["center"] for row in candidates] + anchors
        return median(values) if values else None
    return None


def summarize(cases: Sequence[dict[str, Any]], method: str) -> dict[str, Any]:
    available = []
    for case in cases:
        center = selected_center(case, method)
        if center is not None:
            available.append((case, center))
    return {
        "cases": len(cases),
        "available": len(available),
        "hits13": sum(abs(center - case["truth"]) <= 6 for case, center in available),
        "withinOne": sum(abs(center - case["truth"]) <= 1 for case, center in available),
        "exact": sum(center == case["truth"] for case, center in available),
        "oldHitsAvailable": sum(
            case["oldStart"] <= case["truth"] <= case["oldEnd"]
            for case, _ in available
        ),
        "oracleUnion13": sum(
            case["oldStart"] <= case["truth"] <= case["oldEnd"]
            or abs(center - case["truth"]) <= 6
            for case, center in available
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--reserved", action="append", default=[])
    parser.add_argument("--report", default=".tmp-unit-candidate-centers-report.json")
    args = parser.parse_args()
    cases = []
    for raw in args.paths:
        path = Path(raw)
        loaded = load(path)
        cases.extend(loaded)
        print(f"loaded {path.name}: {len(loaded)}", flush=True)
    for raw in args.reserved:
        path = Path(raw)
        label = "reserved2" if "offset8" in path.name.lower() else "reserved1"
        loaded = load(path, label)
        cases.extend(loaded)
        print(f"loaded {path.name}: {len(loaded)}", flush=True)
    sources = sorted({source for case in cases for source in case["candidates"]})
    methods = [
        "medianCandidates", "medianReferences", "weightedCandidates",
        "anchorMedian", "candidateAnchorMedian",
        *[f"source:{source}" for source in sources],
    ]
    report: dict[str, Any] = {"schemaVersion": 1, "eventTypes": {}}
    for event_type in EVENT_TYPES:
        report["eventTypes"][event_type] = {}
        typed = [case for case in cases if case["eventType"] == event_type]
        for dataset in ("train", "calibration", "validation", "reserved1", "reserved2"):
            selected = [case for case in typed if case["dataset"] == dataset]
            if not selected:
                continue
            rows = {method: summarize(selected, method) for method in methods}
            report["eventTypes"][event_type][dataset] = dict(sorted(
                rows.items(),
                key=lambda item: (
                    item[1]["hits13"], item[1]["available"], item[0]
                ),
                reverse=True,
            ))
    Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        event_type: {
            dataset: list(rows.items())[:12]
            for dataset, rows in datasets.items()
        }
        for event_type, datasets in report["eventTypes"].items()
    }, indent=2))


if __name__ == "__main__":
    main()
