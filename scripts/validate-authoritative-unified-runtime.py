#!/usr/bin/env python3
"""Validate every frozen asset required by the authoritative runtime."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import joblib


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_DIR = REPO_ROOT / "scripts"
DEFAULT_MODEL_DIR = (
    REPO_ROOT / "models" / "authoritative" / "applied-residual-unified-v12"
)


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load validation module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


SHADOW = load_module(
    "authoritative_validation_shadow",
    SCRIPT_DIR / "applied_residual_unified_shadow.py",
)
FROZEN = load_module(
    "authoritative_validation_frozen",
    SCRIPT_DIR / "frozen_model_inference.py",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    args = parser.parse_args()
    model_dir = Path(args.model_dir).resolve()
    manifest = json.loads((model_dir / "manifest.json").read_text(encoding="utf8"))
    if manifest.get("truthBlind") is not True:
        raise RuntimeError("authoritative upstream is not truth-blind")
    if manifest.get("trainingProtocolFrozen") is not True:
        raise RuntimeError("authoritative upstream protocol is not frozen")
    for file_key, hash_key in (
        ("operationModel", "operationModelSha256"),
        ("locationAnchorModel", "locationAnchorModelSha256"),
    ):
        path = model_dir / str(manifest[file_key])
        if SHADOW.sha256(path) != manifest[hash_key]:
            raise RuntimeError(f"authoritative asset hash mismatch: {path.name}")
        joblib.load(path)

    v12_manifest = json.loads(
        (model_dir / "v12-manifest.json").read_text(encoding="utf8")
    )
    v12_model = model_dir / str(v12_manifest["modelFile"])
    if SHADOW.sha256(v12_model) != v12_manifest["modelSha256"]:
        raise RuntimeError("v12 model hash mismatch")
    pack = joblib.load(v12_model)
    SHADOW.assert_truth_blind_features(list(pack["operationFeatures"]))
    SHADOW.assert_truth_blind_features(list(pack["locationFeatures"]))
    runtime = FROZEN.verify_runtime_manifest(
        model_dir / "frozen-runtime-v34",
        model_dir / "frozen-runtime-v34-manifest.json",
    )
    initial = model_dir / "initial-operation-model"
    for name in ("operation-model.txt", "feature-names.json", "summary.json"):
        if not (initial / name).is_file():
            raise RuntimeError(f"initial operation model misses {name}")
    print(json.dumps({
        "schemaVersion": 1,
        "modelVersion": v12_manifest["modelVersion"],
        "authority": "authoritative",
        "truthBlind": True,
        "operationIdentityImmutable": True,
        "sameIdentityLocationImmutable": True,
        "operationUpstreamSha256": manifest["operationModelSha256"],
        "locationAnchorSha256": manifest["locationAnchorModelSha256"],
        "v12Sha256": v12_manifest["modelSha256"],
        "frozenRuntimeFiles": int(runtime.get("files", 0)),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
