#!/usr/bin/env python3
"""Merge compatible immutable nested-view caches without retraining."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", action="append", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    caches = [Path(path).resolve() for path in args.cache]
    manifests = [
        json.loads((path / "manifest.json").read_text(encoding="utf-8"))
        for path in caches
    ]
    common = ("operationScoresSha256", "outerSplits", "innerSplits")
    for key in common:
        values = {manifest.get(key) for manifest in manifests}
        if len(values) != 1:
            raise RuntimeError(f"nested cache mismatch for {key}: {values}")

    variants: list[str] = []
    for manifest in manifests:
        for variant in manifest["variants"]:
            if variant in variants:
                raise RuntimeError(f"duplicate nested view {variant}")
            variants.append(variant)
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    merged_manifest = {
        "schemaVersion": 1,
        "operationScoresSha256": manifests[0]["operationScoresSha256"],
        "variants": variants,
        "outerSplits": manifests[0]["outerSplits"],
        "innerSplits": manifests[0]["innerSplits"],
    }
    identity_hashes = {
        manifest.get("identityLabelsSha256")
        for manifest in manifests
        if manifest.get("identityLabelsSha256")
    }
    if len(identity_hashes) > 1:
        raise RuntimeError("nested caches use different identity labels")
    if identity_hashes:
        merged_manifest["identityLabelsSha256"] = next(iter(identity_hashes))
    (output / "manifest.json").write_text(
        json.dumps(merged_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    for fold in range(int(merged_manifest["outerSplits"])):
        merged = None
        for cache in caches:
            frame = pd.read_pickle(cache / f"outer-fold-{fold}.pkl")
            if merged is None:
                merged = frame
                continue
            if not merged["identity_group"].equals(frame["identity_group"]):
                raise RuntimeError(f"candidate identity mismatch in outer fold {fold}")
            additions = [
                column for column in frame if column != "identity_group"
            ]
            merged = pd.concat(
                [merged, frame[additions].reset_index(drop=True)], axis=1
            )
        merged.to_pickle(output / f"outer-fold-{fold}.pkl")
    print(json.dumps({"outputDir": str(output), **merged_manifest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
