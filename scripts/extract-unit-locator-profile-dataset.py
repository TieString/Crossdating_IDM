"""Extract production coarse counterfactual profiles from locator audits."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def identity(row: dict[str, Any]) -> str:
    context = row.get("context", {})
    return "|".join(map(str, (
        str(context.get("file", context.get("groupId", ""))).replace("\\", "/").lower(),
        context.get("target", ""),
        row.get("eventType", ""),
        int(row.get("truthYear", 0)),
    )))


def extract(path: Path, split: str) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    result = []
    for locator in payload.get("counterfactualLocatorCases", []):
        context = locator.get("context", {})
        if (
            locator.get("eventType") not in {"missingRing", "falseRing"}
            or context.get("baselineFlagged", True)
        ):
            continue
        coarse = locator.get("coarseWindow")
        final = locator.get("finalWindow")
        rows = sorted(
            locator.get("unitCounterfactualRows") or [],
            key=lambda row: int(row["year"]),
        )
        if not coarse or not final or not rows:
            continue
        years = [int(row["year"]) for row in rows]
        if years != list(range(years[0], years[-1] + 1)):
            continue
        operation = locator.get("selectedOperation") or {}
        result.append({
            "key": identity(locator),
            "split": split,
            "eventType": locator["eventType"],
            "truthYear": int(locator["truthYear"]),
            "falseRingMode": locator.get("falseRingMode"),
            "finalRange": [int(final["startYear"]), int(final["endYear"])],
            "primaryTopYear": locator.get("currentPrimaryYear"),
            "operationBestYear": operation.get("bestYear"),
            "sideStepBestYear": operation.get("sideStepBestYear"),
            "rows": [{
                "year": int(row["year"]),
                "features": {
                    name: float(value)
                    for name, value in row.get("profiles", {}).items()
                },
            } for row in rows],
        })
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        action="append",
        required=True,
        help="Dataset label and audit path as label=path",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    cases = []
    seen = set()
    for source in args.source:
        split, raw_path = source.split("=", 1)
        for row in extract(Path(raw_path), split):
            if row["key"] in seen:
                continue
            seen.add(row["key"])
            cases.append(row)
    feature_sets = [
        set(point["features"])
        for case in cases
        for point in case["rows"]
    ]
    common = set.intersection(*feature_sets) if feature_sets else set()
    for case in cases:
        for point in case["rows"]:
            point["features"] = {
                name: point["features"][name] for name in sorted(common)
            }
    args.output.write_text(
        json.dumps(cases, separators=(",", ":")),
        encoding="utf-8",
    )
    print(json.dumps({
        "cases": len(cases),
        "featureCount": len(common),
        "counts": {
            split: sum(case["split"] == split for case in cases)
            for split in sorted({case["split"] for case in cases})
        },
    }, indent=2))


if __name__ == "__main__":
    main()
