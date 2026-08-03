"""Create a deterministic ITRDB manifest excluding previously evaluated cases."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def normalized(value: str) -> str:
    return value.replace("\\", "/").lower().lstrip("/")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--audits", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--metadata-output", required=True)
    parser.add_argument("--count", type=int, default=500)
    parser.add_argument("--seed", default="unit-event-holdout-v1")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    all_files = [
        normalized(str(path.relative_to(root)))
        for path in root.rglob("*.rwl")
    ]
    consumed = set()
    audits = [Path(value.strip()) for value in args.audits.split(",") if value.strip()]
    for path in audits:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for context in payload.get("caseContexts", []):
            file_name = context.get("file")
            if file_name:
                consumed.add(normalized(str(file_name)))
        del payload

    consumed_names = {Path(value).name for value in consumed}
    remaining = [
        value for value in all_files
        if value not in consumed and Path(value).name not in consumed_names
    ]
    ordered = sorted(
        remaining,
        key=lambda value: hashlib.sha256(
            f"{args.seed}|{value}".encode()
        ).hexdigest(),
    )
    selected = sorted(ordered[: max(0, args.count)])
    manifest_text = json.dumps(selected, indent=2)
    Path(args.output).write_text(manifest_text, encoding="utf-8")
    metadata = {
        "schemaVersion": 1,
        "root": root.as_posix(),
        "seed": args.seed,
        "audits": [path.as_posix() for path in audits],
        "allFiles": len(all_files),
        "consumedCaseFiles": len(consumed),
        "remainingFiles": len(remaining),
        "selectedFiles": len(selected),
        "manifest": args.output,
        "manifestSha256": hashlib.sha256(
            manifest_text.encode("utf-8")
        ).hexdigest(),
    }
    Path(args.metadata_output).write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
