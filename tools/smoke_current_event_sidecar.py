"""Subprocess smoke test for the bundled current-event JSONL sidecar."""
from __future__ import annotations

import argparse
from collections import deque
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


PROTOCOL = "crossdating.current-event.v1"
REQUEST_TIMEOUT_SECONDS = 60.0
STARTUP_TIMEOUT_SECONDS = 180.0


def collect_stderr(stream: Any, lines: deque[str]) -> None:
    for line in stream:
        lines.append(line.rstrip())


def stderr_tail(process: subprocess.Popen[str]) -> str:
    lines = getattr(process, "_crossdating_stderr_lines", ())
    return "\n".join(lines)[-2000:]


def terminate_process_tree(process: subprocess.Popen[str]) -> None:
    if os.name == "nt" and isinstance(process.args, list) and process.args:
        executable = str(process.args[0]).replace("'", "''")
        command = (
            f"$target=[System.IO.Path]::GetFullPath('{executable}'); "
            "Get-CimInstance Win32_Process | "
            "Where-Object { $_.ExecutablePath -and "
            "([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target) } | "
            "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-Command", command],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    if process.poll() is None:
        process.kill()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def send(
    process: subprocess.Popen[str],
    payload: dict[str, Any],
    timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    process.stdin.flush()
    result: queue.Queue[str] = queue.Queue(maxsize=1)
    reader = threading.Thread(
        target=lambda: result.put(process.stdout.readline()),
        name="current-event-smoke-stdout",
        daemon=True,
    )
    reader.start()
    try:
        line = result.get(timeout=timeout)
    except queue.Empty as exc:
        stderr = stderr_tail(process)
        terminate_process_tree(process)
        raise TimeoutError(
            f"sidecar did not respond within {timeout:.0f}s: {stderr[-2000:]}"
        ) from exc
    if not line:
        stderr = stderr_tail(process)
        terminate_process_tree(process)
        raise RuntimeError(f"sidecar exited without a response: {stderr[-2000:]}")
    return json.loads(line)


def request(request_id: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocolVersion": PROTOCOL,
        "requestId": request_id,
        "method": method,
    }
    if params is not None:
        payload["params"] = params
    return payload


def require_ok(response: dict[str, Any], request_id: str) -> dict[str, Any]:
    if response.get("requestId") != request_id:
        raise AssertionError(f"requestId mismatch: {response}")
    if response.get("ok") is not True:
        raise AssertionError(f"sidecar returned an error: {response}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise AssertionError(f"sidecar result is missing: {response}")
    return result


def require_valid_suggestions(
    result: dict[str, Any],
    *,
    single_range: bool,
    adaptive_range: bool,
) -> None:
    suggestions = list(result.get("suggestions", []))
    scores = [float(item["rankingScore"]) for item in suggestions]
    ranks = [int(item["rank"]) for item in suggestions]
    if not single_range and scores != sorted(scores, reverse=True):
        raise AssertionError(f"suggestions are not score-descending: {scores}")
    if ranks != list(range(1, len(ranks) + 1)):
        raise AssertionError(f"suggestion ranks are not contiguous: {ranks}")
    if single_range and isinstance(result.get("eventRange"), dict):
        event_range = result["eventRange"]
        width = int(event_range["endYear"]) - int(event_range["startYear"]) + 1
        if width != int(event_range["width"]) or not 1 <= width <= 15:
            raise AssertionError(f"invalid single event range: {event_range}")
        if adaptive_range:
            max_width = int(event_range["maxEnvelopeEnd"]) - int(event_range["maxEnvelopeStart"]) + 1
            if (
                event_range.get("adaptive") is not True
                or not isinstance(event_range.get("shrunk"), bool)
                or event_range.get("windowPolicy") != "local_score_mass"
                or not 1 <= max_width <= 15
                or int(event_range["maxEnvelopeStart"]) > int(event_range["startYear"])
                or int(event_range["maxEnvelopeEnd"]) < int(event_range["endYear"])
                or bool(event_range["shrunk"]) != (width < max_width)
            ):
                raise AssertionError(f"invalid adaptive event range: {event_range}")
        for item in suggestions:
            if (
                int(item["rangeStart"]) != int(event_range["startYear"])
                or int(item["rangeEnd"]) != int(event_range["endYear"])
            ):
                raise AssertionError("suggestions do not reference the unique eventRange")


def require_valid_result_state(
    result: dict[str, Any], *, single_range: bool, dual_gate: bool
) -> None:
    allowed = {"advice", "evidence_insufficient"}
    if dual_gate:
        allowed.add("range_advice")
    status = result.get("status")
    if status not in allowed:
        raise AssertionError(f"unexpected result status: {result}")
    suggestions = list(result.get("suggestions", []))
    event_range = result.get("eventRange")
    if status == "advice" and not suggestions:
        raise AssertionError("advice must contain exact-year suggestions")
    if status == "advice" and single_range and not isinstance(event_range, dict):
        raise AssertionError("single-range advice must contain one range")
    if status == "range_advice" and (suggestions or not isinstance(event_range, dict)):
        raise AssertionError("range_advice must contain one range and no exact-year suggestions")
    if status == "evidence_insufficient" and (suggestions or event_range is not None):
        raise AssertionError("evidence_insufficient must not expose a range or suggestions")
    if dual_gate:
        range_gate = result.get("rangeReliability")
        year_gate = result.get("yearReliability")
        year_alias = result.get("reliability")
        if not all(isinstance(value, dict) for value in (range_gate, year_gate, year_alias)):
            raise AssertionError("dual-gate result is missing reliability fields")
        if range_gate.get("independentFromYearGate") is not True:
            raise AssertionError("range gate must be independent from the year gate")
        if year_gate != year_alias:
            raise AssertionError("reliability must remain an exact alias of yearReliability")
        expected_acceptance = {
            "advice": (True, True),
            "range_advice": (True, False),
            "evidence_insufficient": (False, bool(year_gate["accepted"])),
        }[status]
        if (bool(range_gate["accepted"]), bool(year_gate["accepted"])) != expected_acceptance:
            raise AssertionError("dual-gate decisions do not match result status")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument(
        "--sample-rwl",
        type=Path,
    )
    parser.add_argument("--series-id")
    args = parser.parse_args()

    executable = args.executable.resolve()
    bundle = args.bundle.resolve()
    if not executable.is_file():
        raise FileNotFoundError(executable)
    if not (bundle / "bundle_manifest.json").is_file():
        raise FileNotFoundError(bundle)
    manifest = json.loads((bundle / "bundle_manifest.json").read_text(encoding="utf-8"))
    expected_bundle_version = str(manifest["bundle_version"])
    single_range = (bundle / "range_prediction_reference.json").is_file()
    adaptive_range = (bundle / "adaptive_range_diagnostic_summary.json").is_file()
    dual_gate = (bundle / "dual_gate_raw_prediction_reference.json").is_file()
    dual_gate_reference: dict[str, Any] | None = None
    expected_top5: list[int] | None = None
    expected_range: dict[str, Any] | None = None
    if single_range:
        if dual_gate:
            dual_gate_reference = json.loads(
                (bundle / "dual_gate_raw_prediction_reference.json").read_text(encoding="utf-8")
            )
            reference_row = next(
                row for row in dual_gate_reference["rows"] if row["caseId"] == "full_advice"
            )
            base_params = dict(reference_row["params"])
            expected_result = dict(reference_row["expectedResult"])
            expected_range = dict(expected_result["eventRange"])
            expected_top5 = [int(item["centerYear"]) for item in expected_result["suggestions"]]
        else:
            reference = json.loads((bundle / "range_prediction_reference.json").read_text(encoding="utf-8"))
            reference_row = reference["rows"][0]
            base_params = dict(reference_row["rawRwlRequest"])
            expected_range = dict(reference_row["expected"])
            expected_top5 = [int(year) for year in expected_range["softTop5Years"]]
    else:
        base_params = {
            "rwlPath": str(
                (args.sample_rwl or Path(r"D:\Code\Crossdating_py\itrdb\measurements\ausl012.rwl")).resolve()
            ),
            "targetSeriesId": args.series_id or "COO504",
            "existingZeroPolicy": "remove",
            "confirmedInsertions": [],
            "topK": 5,
            "rangeRadius": 1,
        }
    if args.sample_rwl:
        base_params["rwlPath"] = str(args.sample_rwl.resolve())
    if args.series_id:
        base_params["targetSeriesId"] = args.series_id
    sample_rwl = Path(str(base_params["rwlPath"]))
    if not sample_rwl.is_file():
        raise FileNotFoundError(sample_rwl)

    started = time.perf_counter()
    process = subprocess.Popen(
        [str(executable), "--bundle", str(bundle)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env={
            **os.environ,
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )
    stderr_lines: deque[str] = deque(maxlen=200)
    setattr(process, "_crossdating_stderr_lines", stderr_lines)
    assert process.stderr is not None
    stderr_reader = threading.Thread(
        target=collect_stderr,
        args=(process.stderr, stderr_lines),
        name="current-event-smoke-stderr",
        daemon=True,
    )
    stderr_reader.start()
    try:
        health_started = time.perf_counter()
        health = require_ok(
            send(
                process,
                request("health-1", "health"),
                timeout=STARTUP_TIMEOUT_SECONDS,
            ),
            "health-1",
        )
        describe = require_ok(send(process, request("describe-1", "describe")), "describe-1")
        startup_handshake_wall_ms = (time.perf_counter() - health_started) * 1000.0
        if health.get("bundleVersion") != expected_bundle_version:
            raise AssertionError(health)
        if describe.get("bundleVersion") != expected_bundle_version:
            raise AssertionError(describe)
        if describe.get("featureCount") != 251:
            raise AssertionError(describe)
        if describe.get("diagnosticOnly") is not True or describe.get("automaticWriteback") is not False:
            raise AssertionError(describe)
        if single_range:
            event_range_contract = describe.get("eventRange")
            if not isinstance(event_range_contract, dict):
                raise AssertionError(describe)
            if (
                int(event_range_contract.get("count", 0)) != 1
                or int(event_range_contract.get("featureCount", 0)) != 70
                or int(event_range_contract.get("maxWidth", 0)) != 15
            ):
                raise AssertionError(describe)
            if adaptive_range and (
                event_range_contract.get("adaptive") is not True
                or int(event_range_contract.get("maxRadius", 0)) != 7
                or int(event_range_contract.get("maxCenters", 0)) != 120
                or not isinstance(event_range_contract.get("adaptivePolicy"), dict)
            ):
                raise AssertionError(describe)
            if dual_gate:
                range_gate_contract = event_range_contract.get("reliabilityGate")
                if (
                    not isinstance(range_gate_contract, dict)
                    or range_gate_contract.get("independentFromYearGate") is not True
                    or int(range_gate_contract.get("featureCount", 0)) != 109
                    or abs(
                        float(range_gate_contract.get("threshold", 0.0))
                        - 0.33853178198144895
                    )
                    > 1e-15
                ):
                    raise AssertionError(describe)

        desktop_params = {
            **base_params,
            "existingZeroPolicy": "preserve",
            "confirmedInsertions": [],
        }
        desktop_started = time.perf_counter()
        desktop_result = require_ok(
            send(process, request("desktop-preserve-1", "rank_current_event", desktop_params)),
            "desktop-preserve-1",
        )
        desktop_wall_ms = (time.perf_counter() - desktop_started) * 1000.0
        require_valid_result_state(
            desktop_result, single_range=single_range, dual_gate=dual_gate
        )
        require_valid_suggestions(
            desktop_result,
            single_range=single_range,
            adaptive_range=adaptive_range,
        )

        # Benchmark-only corruption replay. The desktop client and Rust
        # command are both hard-gated to preserve.
        base_params = {**base_params, "existingZeroPolicy": "remove", "confirmedInsertions": []}
        round1 = require_ok(
            send(process, request("rank-1", "rank_current_event", base_params)),
            "rank-1",
        )
        repeated = require_ok(
            send(process, request("rank-1-repeat", "rank_current_event", base_params)),
            "rank-1-repeat",
        )
        require_valid_result_state(round1, single_range=single_range, dual_gate=dual_gate)
        if round1.get("status") != "advice":
            raise AssertionError(round1)
        require_valid_suggestions(
            round1,
            single_range=single_range,
            adaptive_range=adaptive_range,
        )
        if round1.get("suggestions") != repeated.get("suggestions"):
            raise AssertionError("repeated sidecar predictions are not deterministic")
        if round1.get("eventRange") != repeated.get("eventRange"):
            raise AssertionError("repeated sidecar event ranges are not deterministic")
        for field in ("rangeReliability", "yearReliability", "reliability"):
            if round1.get(field) != repeated.get(field):
                raise AssertionError(f"repeated sidecar {field} is not deterministic")
        round1_years = [int(item["centerYear"]) for item in round1["suggestions"]]
        if not round1_years:
            raise AssertionError("round-1 returned no suggestions")
        if single_range:
            assert expected_range is not None
            actual_range = round1.get("eventRange")
            for key in ("centerYear", "startYear", "endYear", "width"):
                if int(actual_range[key]) != int(expected_range[key]):
                    raise AssertionError(f"range parity mismatch for {key}")
            if round1_years != expected_top5:
                raise AssertionError(
                    f"server Top5 order changed: expected={expected_top5}, actual={round1_years}"
                )
        elif round1_years[0] != 1910:
            raise AssertionError(f"expected round-1 top1 1910, got {round1_years}")

        round2_params = {
            **base_params,
            "confirmedInsertions": [{"year": round1_years[0]}],
        }
        round2 = require_ok(
            send(process, request("rank-2", "rank_current_event", round2_params)),
            "rank-2",
        )
        require_valid_suggestions(
            round2,
            single_range=single_range,
            adaptive_range=adaptive_range,
        )
        require_valid_result_state(round2, single_range=single_range, dual_gate=dual_gate)
        round2_years = [int(item["centerYear"]) for item in round2.get("suggestions", [])]
        if not single_range and (not round2_years or round2_years[0] != 1880):
            raise AssertionError(f"expected round-2 top1 1880, got {round2_years}")

        dual_gate_states: list[dict[str, Any]] = []
        if dual_gate_reference is not None:
            for row in dual_gate_reference["rows"]:
                case_id = str(row["caseId"])
                expected_result = row["expectedResult"]
                case_params = dict(row["params"])
                case_first = require_ok(
                    send(
                        process,
                        request(f"dual-{case_id}-1", "rank_current_event", case_params),
                    ),
                    f"dual-{case_id}-1",
                )
                case_second = require_ok(
                    send(
                        process,
                        request(f"dual-{case_id}-2", "rank_current_event", case_params),
                    ),
                    f"dual-{case_id}-2",
                )
                require_valid_result_state(
                    case_first, single_range=True, dual_gate=True
                )
                require_valid_suggestions(
                    case_first, single_range=True, adaptive_range=True
                )
                for field in (
                    "status",
                    "reasonCode",
                    "message",
                    "eventRange",
                    "suggestions",
                    "rangeReliability",
                    "yearReliability",
                    "reliability",
                ):
                    if case_first.get(field) != expected_result.get(field):
                        raise AssertionError(
                            f"dual-gate {case_id} reference mismatch for {field}"
                        )
                    if case_first.get(field) != case_second.get(field):
                        raise AssertionError(
                            f"dual-gate {case_id} repeated result changed for {field}"
                        )
                dual_gate_states.append({
                    "caseId": case_id,
                    "status": case_first["status"],
                    "eventRangePresent": case_first.get("eventRange") is not None,
                    "suggestionCount": len(case_first.get("suggestions", [])),
                })

        malformed = send(process, {
            "protocolVersion": "unsupported",
            "requestId": "bad-protocol",
            "method": "health",
        })
        if malformed.get("ok") is not False or malformed.get("error", {}).get("code") != "UNSUPPORTED_PROTOCOL":
            raise AssertionError(malformed)

        malformed_request = send(process, {
            "protocolVersion": PROTOCOL,
            "requestId": "bad-params",
            "method": "rank_current_event",
            "params": [],
        })
        malformed_error = malformed_request.get("error", {})
        if (
            malformed_request.get("ok") is not False
            or malformed_error.get("code") != "INVALID_REQUEST"
            or malformed_error.get("retryable") is not False
            or "traceback" in json.dumps(malformed_request, ensure_ascii=False).lower()
        ):
            raise AssertionError(malformed_request)

        send(process, request("shutdown-1", "shutdown"))
        process.wait(timeout=10)
        print(json.dumps({
            "ok": True,
            "pid": process.pid,
            "health": health,
            "startupHandshakeWallMs": round(startup_handshake_wall_ms, 3),
            "describe": {
                "bundleVersion": describe.get("bundleVersion"),
                "featureCount": describe.get("featureCount"),
                "candidatePool": describe.get("candidatePool"),
                "diagnosticOnly": describe.get("diagnosticOnly"),
                "automaticWriteback": describe.get("automaticWriteback"),
                "eventRange": describe.get("eventRange"),
            },
            "singleEventRange": single_range,
            "adaptiveEventRange": adaptive_range,
            "dualGate": dual_gate,
            "dualGateStates": dual_gate_states,
            "round1EventRange": round1.get("eventRange"),
            "round1Top5": round1_years,
            "round2Top5": round2_years,
            "desktopPreserveStatus": desktop_result.get("status"),
            "desktopPreserveElapsedMs": desktop_result.get("elapsedMs"),
            "desktopPreserveWallMs": round(desktop_wall_ms, 3),
            "round1ElapsedMs": round1.get("elapsedMs"),
            "round2ElapsedMs": round2.get("elapsedMs"),
            "deterministic": True,
            "structuredError": True,
            "wallSeconds": round(time.perf_counter() - started, 3),
        }, ensure_ascii=False, indent=2))
    finally:
        if process.poll() is None:
            terminate_process_tree(process)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
