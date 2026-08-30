#!/usr/bin/env python3
"""Validate the checked-in applied-residual unified shadow model pack."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib

from applied_residual_unified_shadow import (
    MODEL_VERSION,
    assert_truth_blind_features,
    sha256,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODEL_DIR = (
    REPO_ROOT / "models" / "shadow" / "applied-residual-unified-v12"
)


def validate_model_pack(model_dir: Path) -> dict[str, object]:
    manifest_path = model_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    if manifest.get("modelVersion") != MODEL_VERSION:
        raise RuntimeError("unified shadow manifest version mismatch")
    if manifest.get("truthBlind") is not True:
        raise RuntimeError("unified shadow manifest is not truth-blind")
    if manifest.get("operationIdentityImmutable") is not True:
        raise RuntimeError("operation identity is not immutable")
    if manifest.get("sameIdentityLocationImmutable") is not True:
        raise RuntimeError("location head is not identity-bound")

    model_path = model_dir / str(manifest["modelFile"])
    actual_hash = sha256(model_path)
    if actual_hash != manifest.get("modelSha256"):
        raise RuntimeError("unified shadow model hash mismatch")
    pack = joblib.load(model_path)
    if pack.get("modelVersion") != MODEL_VERSION:
        raise RuntimeError("serialized unified shadow version mismatch")
    operation_features = list(pack.get("operationFeatures", []))
    location_features = list(pack.get("locationFeatures", []))
    if not operation_features or not location_features:
        raise RuntimeError("unified shadow feature contract is empty")
    assert_truth_blind_features(operation_features)
    assert_truth_blind_features(location_features)
    if int(pack.get("operationShortlistSize", 0)) != 4:
        raise RuntimeError("operation shortlist contract changed")
    if int(pack.get("locationShortlistSize", 0)) != 16:
        raise RuntimeError("location shortlist contract changed")
    return {
        "schemaVersion": 1,
        "modelVersion": MODEL_VERSION,
        "modelSha256": actual_hash,
        "operationFeatures": len(operation_features),
        "locationFeatures": len(location_features),
        "truthBlind": True,
        "operationIdentityImmutable": True,
        "sameIdentityLocationImmutable": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    args = parser.parse_args()
    result = validate_model_pack(Path(args.model_dir).resolve())
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
