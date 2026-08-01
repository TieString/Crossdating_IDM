"""Long-lived JSONL sidecar for independently gated event-range and exact-year advice."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO))
sys.path.insert(0, str(_REPO / "src"))

from missing_ring_ranker.current_event_service import (  # noqa: E402
    CurrentEventService,
    error_response,
)


MAX_LINE_BYTES = 1024 * 1024


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", newline="\n")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--skip-hash-verification", action="store_true")
    args = parser.parse_args(argv)
    try:
        service = CurrentEventService(args.bundle, verify_hashes=not args.skip_hash_verification)
    except Exception as exc:
        print(f"current-event sidecar startup failed: {exc}", file=sys.stderr, flush=True)
        return 2
    for raw_line in sys.stdin.buffer:
        request: dict = {}
        if len(raw_line) > MAX_LINE_BYTES:
            _emit(error_response(None, ValueError("request line too large")))
            continue
        request_id = None
        try:
            request = json.loads(raw_line.decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            request_id = request.get("requestId")
            response = service.handle(request)
        except Exception as exc:
            response = error_response(request_id, exc)
        _emit(response)
        if isinstance(request, dict) and request.get("method") == "shutdown":
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
