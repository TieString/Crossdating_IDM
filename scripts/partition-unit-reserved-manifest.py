"""Partition the novel ITRDB manifest without leaking previously audited files."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def normalized(value: str) -> str:
    return value.replace("\\", "/").lower().lstrip("/")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--audits", required=True)
    parser.add_argument("--train-count", type=int, default=400)
    parser.add_argument("--use-consumed", action="store_true")
    parser.add_argument("--train-output", required=True)
    parser.add_argument("--holdout-output", required=True)
    args = parser.parse_args()

    manifest = [
        normalized(value)
        for value in json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    ]
    consumed = set()
    for raw_path in args.audits.split(","):
        payload = json.loads(Path(raw_path.strip()).read_text(encoding="utf-8"))
        for context in payload.get("caseContexts", []):
            file_name = context.get("file")
            if file_name:
                consumed.add(normalized(str(file_name)))

    consumed_names = {Path(item).name for item in consumed}
    remaining = [
        value for value in manifest
        if (
            value in consumed or Path(value).name in consumed_names
        ) == args.use_consumed
    ]
    ordered = sorted(
        remaining,
        key=lambda value: hashlib.sha256(
            f"unit-event-novel-v2|{value}".encode()
        ).hexdigest(),
    )
    train = sorted(ordered[:args.train_count])
    holdout = sorted(ordered[args.train_count:])
    Path(args.train_output).write_text(
        json.dumps(train, indent=2), encoding="utf-8"
    )
    Path(args.holdout_output).write_text(
        json.dumps(holdout, indent=2), encoding="utf-8"
    )
    print(json.dumps({
        "manifest": len(manifest),
        "consumed": len(consumed),
        "pool": "consumed" if args.use_consumed else "unconsumed",
        "remaining": len(remaining),
        "train": len(train),
        "holdout": len(holdout),
    }, indent=2))


if __name__ == "__main__":
    main()
