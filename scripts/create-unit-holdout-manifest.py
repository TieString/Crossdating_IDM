"""Create a deterministic ITRDB manifest excluding previously evaluated cases."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


def normalized(value: str) -> str:
    return value.replace("\\", "/").lower().lstrip("/")


def canonical_noaa_name(value: str) -> str:
    path = Path(normalized(value))
    stem = path.stem.removesuffix("-noaa")
    return f"{stem}{path.suffix}"


def canonical_site_name(value: str) -> str:
    stem = Path(canonical_noaa_name(value)).stem
    match = re.match(r"^([a-z]+[0-9]+)", stem)
    return match.group(1) if match else stem


def read_manifest(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        payload = [line.strip() for line in text.splitlines() if line.strip()]
    if not isinstance(payload, list) or not all(isinstance(value, str) for value in payload):
        raise ValueError(f"Manifest must contain a JSON string array or one path per line: {path}")
    return [normalized(value) for value in payload]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--audits", required=True)
    parser.add_argument("--exclude-manifests", default="")
    parser.add_argument("--output", required=True)
    parser.add_argument("--metadata-output", required=True)
    parser.add_argument("--count", type=int, default=500)
    parser.add_argument("--seed", default="unit-event-holdout-v1")
    parser.add_argument("--dedupe-noaa-variants", action="store_true")
    parser.add_argument("--dedupe-site-variants", action="store_true")
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

    excluded_manifests = [
        Path(value.strip())
        for value in args.exclude_manifests.split(",")
        if value.strip()
    ]
    excluded_manifest_files = {
        file_name
        for path in excluded_manifests
        for file_name in read_manifest(path)
    }
    consumed.update(excluded_manifest_files)

    consumed_names = {Path(value).name for value in consumed}
    consumed_canonical_names = {
        canonical_noaa_name(value)
        for value in consumed
    }
    consumed_site_names = {
        canonical_site_name(value)
        for value in consumed
    }
    remaining = [
        value for value in all_files
        if value not in consumed and Path(value).name not in consumed_names
        and (
            not args.dedupe_noaa_variants
            or canonical_noaa_name(value) not in consumed_canonical_names
        )
        and (
            not args.dedupe_site_variants
            or canonical_site_name(value) not in consumed_site_names
        )
    ]
    ordered = sorted(
        remaining,
        key=lambda value: hashlib.sha256(
            f"{args.seed}|{value}".encode()
        ).hexdigest(),
    )
    if args.dedupe_noaa_variants or args.dedupe_site_variants:
        unique_ordered = []
        selected_group_names = set()
        for value in ordered:
            group_name = (
                canonical_site_name(value)
                if args.dedupe_site_variants
                else canonical_noaa_name(value)
            )
            if group_name in selected_group_names:
                continue
            selected_group_names.add(group_name)
            unique_ordered.append(value)
        ordered = unique_ordered
    selected = sorted(ordered[: max(0, args.count)])
    manifest_text = json.dumps(selected, indent=2)
    # Write the exact bytes that are hashed so Windows newline translation
    # cannot make the metadata disagree with the frozen manifest on disk.
    manifest_bytes = manifest_text.encode("utf-8")
    Path(args.output).write_bytes(manifest_bytes)
    metadata = {
        "schemaVersion": 1,
        "root": root.as_posix(),
        "seed": args.seed,
        "audits": [path.as_posix() for path in audits],
        "excludedManifests": [path.as_posix() for path in excluded_manifests],
        "excludedManifestFiles": len(excluded_manifest_files),
        "allFiles": len(all_files),
        "consumedCaseFiles": len(consumed),
        "dedupeNoaaVariants": args.dedupe_noaa_variants,
        "dedupeSiteVariants": args.dedupe_site_variants,
        "remainingFiles": len(remaining),
        "uniqueRemainingFiles": len(ordered),
        "selectedFiles": len(selected),
        "manifest": args.output,
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
    }
    Path(args.metadata_output).write_bytes(
        json.dumps(metadata, indent=2).encode("utf-8")
    )
    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
