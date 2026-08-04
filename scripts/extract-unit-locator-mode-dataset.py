"""Extract compact unit-event mode and anchor metadata from locator audits."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EVENT_TYPES = {"missingRing", "falseRing"}


def identity(row: dict[str, Any]) -> str:
    context = row.get("context") or {}
    return "|".join((
        str(context.get("file", context.get("groupId", ""))).lower(),
        str(context.get("target", "")),
        str(row.get("eventType", "")),
        str(int(row.get("truthYear", 0))),
    ))


def extract(path: Path, split: str) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    formal = {
        "|".join((
            str((row.get("context") or {}).get("file", "")).lower(),
            str((row.get("context") or {}).get("target", "")),
            str(row.get("eventType", "")),
            str(int((row.get("context") or {}).get("year", 0))),
        )): row
        for row in payload.get("formalEventCaseOutcomes", [])
        if row.get("eventType") in EVENT_TYPES
    }
    result = []
    seen = set()
    for row in payload.get("counterfactualLocatorCases", []):
        event_type = row.get("eventType")
        key = identity(row)
        outcome = formal.get(key)
        if (
            event_type not in EVENT_TYPES
            or key in seen
            or not outcome
            or not outcome.get("answered")
            or row.get("correctionYears") != row.get("truthCorrectionYears")
        ):
            continue
        coarse = row.get("coarseWindow")
        mode = row.get("modeWindow")
        final = row.get("finalWindow")
        if not coarse or not mode or not final:
            continue
        context = row.get("context") or {}
        operation = row.get("selectedOperation") or {}
        years = row.get("years") or []
        pre_point = row.get("prePointModeWindow") or mode
        pre_direct = row.get("preDirectModeWindow") or mode
        result.append({
            "key": key,
            "split": split,
            "eventType": event_type,
            "truthYear": int(row["truthYear"]),
            "file": str(context.get("file", context.get("groupId", ""))),
            "target": str(context.get("target", "")),
            "coarseRange": [int(coarse["startYear"]), int(coarse["endYear"])],
            "seriesRange": [int(years[0]), int(years[-1])] if years else None,
            "primaryRange": [int(mode["startYear"]), int(mode["endYear"])],
            "finalRange": [int(final["startYear"]), int(final["endYear"])],
            "prePointRange": [
                int(pre_point["startYear"]), int(pre_point["endYear"]),
            ],
            "preDirectRange": [
                int(pre_direct["startYear"]), int(pre_direct["endYear"]),
            ],
            "coarseCandidates": [{
                "source": candidate.get("source"),
                "range": [
                    int(candidate["startYear"]),
                    int(candidate["endYear"]),
                ],
                "score": candidate.get("aggregateScore"),
            } for candidate in row.get("candidates", [])],
            "calibratedWidth": int(row.get("calibratedWidth") or (
                int(final["endYear"]) - int(final["startYear"]) + 1
            )),
            "windowCenteringRule": row.get("windowCenteringRule"),
            "widthSelectionRule": row.get("widthSelectionRule"),
            "primaryTopYear": row.get("currentPrimaryYear"),
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
        })
        seen.add(key)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    rows = []
    for source in args.source:
        split, raw_path = source.split("=", 1)
        rows.extend(extract(Path(raw_path), split))
    Path(args.output).write_text(
        json.dumps(rows, separators=(",", ":")),
        encoding="utf-8",
    )
    counts: dict[str, int] = {}
    for row in rows:
        key = f"{row['split']}/{row['eventType']}"
        counts[key] = counts.get(key, 0) + 1
    print(json.dumps({"cases": len(rows), "counts": counts}, indent=2))


if __name__ == "__main__":
    main()
