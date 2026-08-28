#!/usr/bin/env python3
"""Shared helpers for truth-blind inference with frozen LightGBM text models."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Iterable

import lightgbm as lgb
import numpy as np
import pandas as pd


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_runtime_manifest(runtime_dir: Path, manifest_path: Path) -> dict[str, object]:
    entries = json.loads(manifest_path.read_text(encoding="utf8"))
    mismatches: list[dict[str, object]] = []
    for entry in entries:
        relative_path = Path(str(entry["relativePath"]))
        path = runtime_dir / relative_path
        actual_bytes = path.stat().st_size if path.exists() else None
        actual_sha256 = sha256_file(path) if path.exists() else None
        if (
            actual_bytes != int(entry["bytes"])
            or actual_sha256 != str(entry["sha256"])
        ):
            mismatches.append({
                "relativePath": str(relative_path),
                "expectedBytes": int(entry["bytes"]),
                "actualBytes": actual_bytes,
                "expectedSha256": str(entry["sha256"]),
                "actualSha256": actual_sha256,
            })
    if mismatches:
        raise RuntimeError(
            "frozen runtime manifest verification failed: "
            + json.dumps(mismatches[:5], ensure_ascii=False)
        )
    return {
        "files": len(entries),
        "manifestSha256": sha256_file(manifest_path),
        "mismatches": 0,
    }


def load_feature_names(path: Path) -> list[str]:
    values = json.loads(path.read_text(encoding="utf8"))
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise ValueError(f"invalid feature list: {path}")
    return values


def load_model(path: Path) -> lgb.Booster:
    # LightGBM's Windows C API cannot reliably open non-ASCII paths. Reading the
    # model text in Python preserves the immutable artifact bytes during loading.
    return lgb.Booster(model_str=path.read_text(encoding="utf8"))


def load_model_feature_names(path: Path) -> list[str]:
    return list(load_model(path).feature_name())


def encode_frame(
    frame: pd.DataFrame,
    columns: Iterable[str],
    feature_names: list[str],
    *,
    categorical_columns: Iterable[str] | None = None,
) -> pd.DataFrame:
    raw_columns = list(columns)
    raw = frame.reindex(columns=raw_columns).copy()
    if categorical_columns is None:
        categorical = [
            column for column in raw_columns if raw[column].dtype == object
        ]
    else:
        categorical = [
            column for column in categorical_columns if column in raw.columns
        ]
    values = pd.get_dummies(raw, columns=categorical, dtype=np.float32)
    values = values.reindex(columns=feature_names, fill_value=0)
    return values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)


def predict(model_path: Path, values: pd.DataFrame | np.ndarray) -> np.ndarray:
    model = load_model(model_path)
    return np.asarray(model.predict(values), dtype=float)
