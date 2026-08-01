"""Replay the frozen accepted/rejected RRF cases against the packaged sidecar."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


PROTOCOL = "crossdating.current-event.v1"
EXPECTED_EXE_BYTES = 77_243_967
EXPECTED_EXE_SHA256 = "f3c48133091f886ea5372235e0db520682a5a939bb9cdb2c10b03fe7be83a4a8"
EXPECTED_BUNDLE_MANIFEST_SHA256 = (
    "cda3c17af39d8a6964bf1d7ca410675919bfa0dfe0b49496569f2ba678796d3d"
)
RRF_ROUTE = "missing-current-event-rrf0-range3-v1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request(
    request_id: str,
    method: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocolVersion": PROTOCOL,
        "requestId": request_id,
        "method": method,
    }
    if params is not None:
        payload["params"] = params
    return payload


def rank_params(path: Path, series_id: str) -> dict[str, Any]:
    return {
        "rwlPath": str(path.resolve()),
        "targetSeriesId": series_id,
        "existingZeroPolicy": "remove",
        "confirmedInsertions": [],
        "topK": 5,
        "rangeRadius": 3,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--accepted-rwl", required=True, type=Path)
    parser.add_argument("--accepted-series", required=True)
    parser.add_argument("--expected-top5", required=True)
    parser.add_argument("--rejected-rwl", required=True, type=Path)
    parser.add_argument("--rejected-series", required=True)
    args = parser.parse_args()

    executable = args.executable.resolve()
    bundle = args.bundle.resolve()
    if executable.stat().st_size != EXPECTED_EXE_BYTES or sha256(executable) != EXPECTED_EXE_SHA256:
        raise AssertionError("packaged RRF executable does not match deployment_manifest.json")
    if sha256(bundle / "bundle_manifest.json") != EXPECTED_BUNDLE_MANIFEST_SHA256:
        raise AssertionError("packaged RRF bundle manifest hash drifted")

    accepted = rank_params(args.accepted_rwl, args.accepted_series)
    rejected = rank_params(args.rejected_rwl, args.rejected_series)
    requests = [
        request("health", "health"),
        request("describe", "describe"),
        request("accepted-1", "rank_current_event", accepted),
        request("accepted-2", "rank_current_event", accepted),
        request("rejected", "rank_current_event", rejected),
        request("invalid-preserve", "rank_current_event", {
            **accepted,
            "existingZeroPolicy": "preserve",
        }),
        request("invalid-radius", "rank_current_event", {
            **accepted,
            "rangeRadius": 1,
        }),
        request("invalid-confirmations", "rank_current_event", {
            **accepted,
            "confirmedInsertions": [{"year": 1900 - index} for index in range(7)],
        }),
        request("shutdown", "shutdown"),
    ]
    completed = subprocess.run(
        [str(executable), "--bundle", str(bundle)],
        input="\n".join(json.dumps(row, ensure_ascii=False) for row in requests) + "\n",
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"RRF sidecar exited {completed.returncode}: {completed.stderr[-2000:]}"
        )
    if completed.stderr:
        raise AssertionError(f"RRF sidecar wrote unexpected stderr: {completed.stderr[-2000:]}")
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    by_id = {row.get("requestId"): row for row in responses}
    if set(by_id) != {row["requestId"] for row in requests}:
        raise AssertionError("RRF sidecar did not return exactly one response per request")

    describe = by_id["describe"]["result"]
    if not (
        by_id["health"]["ok"] is True
        and describe["routeVersion"] == RRF_ROUTE
        and describe["operationScope"] == ["insert_missing"]
        and describe["defaultExistingZeroPolicy"] == "remove"
        and describe["recommendedTopK"] == 5
        and describe["recommendedRangeRadius"] == 3
        and describe["diagnosticOnly"] is True
        and describe["automaticWriteback"] is False
    ):
        raise AssertionError("RRF health/describe handshake drifted")

    first = by_id["accepted-1"]["result"]
    second = by_id["accepted-2"]["result"]
    expected_top5 = [int(value) for value in args.expected_top5.split(",")]
    actual_top5 = [row["centerYear"] for row in first["suggestions"]]
    if first["status"] != "advice" or actual_top5 != expected_top5:
        raise AssertionError(f"accepted RRF replay drifted: {actual_top5}")
    if [row["rankingScore"] for row in first["suggestions"]] != [
        row["rankingScore"] for row in second["suggestions"]
    ]:
        raise AssertionError("identical RRF requests did not produce identical scores")
    previous_score = float("inf")
    for index, suggestion in enumerate(first["suggestions"], 1):
        evidence = suggestion["evidence"]
        expected_score = (
            (1.0 / evidence["pathRank"] if evidence.get("pathRank") else 0.0)
            + (1.0 / evidence["noneRank"] if evidence.get("noneRank") else 0.0)
        )
        if not (
            suggestion["rank"] == index
            and suggestion["rangeStart"] <= suggestion["centerYear"] <= suggestion["rangeEnd"]
            and suggestion["centerYear"] - suggestion["rangeStart"] <= 3
            and suggestion["rangeEnd"] - suggestion["centerYear"] <= 3
            and suggestion["rankingScore"] <= previous_score
            and abs(suggestion["rankingScore"] - expected_score) <= 1e-12
        ):
            raise AssertionError(f"invalid RRF suggestion contract at rank {index}")
        previous_score = suggestion["rankingScore"]
    if not (
        first["routeVersion"] == RRF_ROUTE
        and first["operationScope"] == "insert_missing"
        and first["state"]["existingZeroPolicy"] == "remove"
        and first["reliability"]["accepted"] is True
        and first["automaticWriteback"] is False
        and first["diagnosticOnly"] is True
    ):
        raise AssertionError("accepted RRF response violates route/writeback contract")

    rejected_result = by_id["rejected"]["result"]
    if not (
        rejected_result["status"] == "evidence_insufficient"
        and rejected_result["suggestions"] == []
        and rejected_result["reliability"]["accepted"] is False
    ):
        raise AssertionError("RRF refusal leaked or fabricated suggestions")
    for request_id in ("invalid-preserve", "invalid-radius", "invalid-confirmations"):
        response = by_id[request_id]
        if response["ok"] is not False or response["error"]["code"] != "INVALID_REQUEST":
            raise AssertionError(f"{request_id} did not fail closed")

    print(json.dumps({
        "ok": True,
        "routeVersion": RRF_ROUTE,
        "acceptedTop5": actual_top5,
        "deterministicScores": True,
        "rejectedSuggestions": 0,
        "stderrEmpty": True,
        "executableSha256": EXPECTED_EXE_SHA256,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
