"""Extract whole coarse-window virtual-correction rows from ITRDB audits."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EVENTS = {"missingRing", "falseRing"}


def key(file_name: str, target: str, event_type: str, truth: int):
    return (
        file_name.replace("\\", "/").lower(),
        str(target),
        str(event_type),
        int(truth),
    )


def extract(path: Path, split: str) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    locators = {}
    for row in payload.get("counterfactualLocatorCases", []):
        context = row.get("context", {})
        event_type = row.get("eventType")
        if event_type not in EVENTS or context.get("baselineFlagged", True):
            continue
        locators[key(
            context.get("file", context.get("groupId", "")),
            context.get("target", ""),
            event_type,
            row["truthYear"],
        )] = row

    result = []
    for fixed in payload.get("fixedWindowCounterfactualCases", []):
        event_type = fixed.get("eventType")
        if event_type not in EVENTS:
            continue
        identity = key(
            fixed.get("file", ""),
            fixed.get("target", ""),
            event_type,
            fixed["truthYear"],
        )
        locator = locators.get(identity)
        if locator is None:
            continue
        coarse = locator.get("coarseWindow")
        mode = locator.get("modeWindow")
        final = locator.get("finalWindow")
        if not coarse or not mode or not final:
            continue
        coarse_rows = [
            window for window in fixed.get("windows", [])
            if window.get("source") == "counterfactual_coarse"
            and int(window.get("startYear", -1)) == int(coarse["startYear"])
            and int(window.get("endYear", -1)) == int(coarse["endYear"])
        ]
        if not coarse_rows:
            continue
        selected = coarse_rows[0]
        rows = sorted(selected.get("rows", []), key=lambda row: int(row["year"]))
        years = [int(row["year"]) for row in rows]
        if years != list(range(int(coarse["startYear"]), int(coarse["endYear"]) + 1)):
            continue
        locator_years = [int(year) for year in locator.get("years", [])]
        locator_indexes = {year: index for index, year in enumerate(locator_years)}
        locator_ranks = {
            name: values
            for name, values in (locator.get("ranks") or {}).items()
            if isinstance(values, list) and len(values) == len(locator_years)
        }
        for point in rows:
            index = locator_indexes.get(int(point["year"]))
            features = point.setdefault("features", {})
            for name, values in locator_ranks.items():
                features[f"locatorRank:{name}"] = (
                    float(values[index]) if index is not None else 0.0
                )
        context = locator.get("context", {})
        operation = locator.get("selectedOperation") or {}
        result.append({
            "key": "|".join(map(str, identity)),
            "split": split,
            "eventType": event_type,
            "truthYear": int(fixed["truthYear"]),
            "file": identity[0],
            "target": identity[1],
            "coarseRange": [int(coarse["startYear"]), int(coarse["endYear"])],
            "primaryRange": [int(mode["startYear"]), int(mode["endYear"])],
            "finalRange": [int(final["startYear"]), int(final["endYear"])],
            "calibratedWidth": int(
                locator.get("calibratedWidth")
                or int(final["endYear"]) - int(final["startYear"]) + 1
            ),
            "windowCenteringRule": locator.get("windowCenteringRule"),
            "widthSelectionRule": locator.get("widthSelectionRule"),
            "falseRingMode": locator.get("falseRingMode"),
            "primaryTopYear": locator.get("currentPrimaryYear"),
            "operationBestYear": operation.get("bestYear"),
            "operationBestRawGain": operation.get("bestRawGain"),
            "operationBestDifferenceGain": operation.get("bestDifferenceGain"),
            "operationBestCombinedGain": operation.get("bestCombinedGain"),
            "operationTopThreeDifferenceGain": operation.get("topThreeDifferenceGain"),
            "operationRemoteDifferenceMargin": operation.get("remoteDifferenceMargin"),
            "sideStepBestYear": operation.get("sideStepBestYear"),
            "sideStepBestScore": operation.get("bestSideStepScore"),
            "sideStepTopThreeScore": operation.get("topThreeSideStepScore"),
            "sideMinimumAdvantage": operation.get("bestSideMinimumAdvantage"),
            "sideCorrectedSupport": operation.get("bestCorrectedSideSupport"),
            "sideStepRemoteMargin": operation.get("sideStepRemoteMargin"),
            "signalStrength": float(context.get("signalStrength") or 0),
            "positionStratum": context.get("positionStratum"),
            "rows": rows,
            "sourceAudit": str(path),
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
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    result = []
    seen = set()
    for source in args.source:
        split, raw_path = source.split("=", 1)
        for row in extract(Path(raw_path), split):
            identity = row["key"]
            if identity in seen:
                continue
            seen.add(identity)
            result.append(row)
    feature_sets = [
        set(row["features"])
        for case in result
        for row in case["rows"]
    ]
    common = set.intersection(*feature_sets) if feature_sets else set()
    for case in result:
        case["rows"] = [
            {
                "year": int(row["year"]),
                "features": {
                    name: float(row["features"][name]) for name in sorted(common)
                },
            }
            for row in case["rows"]
        ]
    Path(args.output).write_text(
        json.dumps(result, separators=(",", ":")), encoding="utf-8"
    )
    counts = {}
    for row in result:
        selected = f"{row['split']}/{row['eventType']}"
        counts[selected] = counts.get(selected, 0) + 1
    print(json.dumps({
        "cases": len(result),
        "featureCount": len(common),
        "boundaryFeatureCount": sum("Boundary" in name for name in common),
        "counts": counts,
    }, indent=2))


if __name__ == "__main__":
    main()
