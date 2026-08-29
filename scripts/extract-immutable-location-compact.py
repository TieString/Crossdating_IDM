#!/usr/bin/env python3
"""Extract a compact, immutable location package table from frozen candidates."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd


IDENTITY_AND_LABEL_COLUMNS = {
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "is_clean",
    "identity_group",
    "identity_key",
    "event_type",
    "shift_years",
    "shift_abs",
    "candidate_source",
    "candidate_year",
    "candidate_year_present",
    "candidate_has_response",
    "candidate_is_base",
    "window_start",
    "window_end",
    "window_width",
    "operation_correct",
    "identity_operation_correct",
    "location_correct",
    "window_correct",
    "workflow_correct",
    "strict_correct",
    "base_correct",
    "base_strict_correct",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(16 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_location_feature(column: str) -> bool:
    if column in {
        "runtime_score",
        "runtime_score_margin",
        "runtime_window_width",
        "runtime_source_count",
        "runtime_note_count",
        "runtime_review_only",
        "bundle_has_alternative",
        "bundle_alternative_window_width",
        "bundle_alternative_top_signed_distance",
        "bundle_alternative_top_absolute_distance",
        "context_reference_anchor_count",
        "context_reference_mode",
        "context_cofecha_flagged",
    }:
        return True
    return column.startswith(
        (
            "yearly_",
            "location_",
            "evidence_",
            "geometry_",
            "support_",
            "runtime_source__",
            "source_count_",
        )
    )


def compact_dtype(frame: pd.DataFrame) -> pd.DataFrame:
    for column in frame.select_dtypes(include=["float64"]).columns:
        frame[column] = frame[column].astype(np.float32)
    for column in frame.select_dtypes(include=["int64"]).columns:
        values = frame[column]
        if values.empty:
            continue
        minimum = values.min(skipna=True)
        maximum = values.max(skipna=True)
        if pd.notna(minimum) and pd.notna(maximum):
            if np.iinfo(np.int8).min <= minimum <= maximum <= np.iinfo(np.int8).max:
                frame[column] = values.astype(np.int8)
            elif np.iinfo(np.int32).min <= minimum <= maximum <= np.iinfo(np.int32).max:
                frame[column] = values.astype(np.int32)
    return frame


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-table", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = Path(args.package_table).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    source_hash = sha256(source)

    # The source pickle is intentionally read once.  Selecting columns before
    # any row copy keeps peak memory below the previous full-table .copy().
    raw = pd.read_pickle(source)
    selected_columns = [
        column
        for column in raw.columns
        if column in IDENTITY_AND_LABEL_COLUMNS or is_location_feature(column)
    ]
    compact = raw.loc[:, selected_columns].copy()
    source_rows = len(raw)
    source_columns = len(raw.columns)
    del raw
    gc.collect()

    if "identity_group" not in compact:
        compact["identity_group"] = (
            compact["attempt_id"].astype(str)
            + "|"
            + compact["event_type"].astype(str)
            + "|"
            + compact["shift_years"].astype(int).astype(str)
        )
    compact = compact_dtype(compact)
    compact.to_pickle(output)

    payload = {
        "schemaVersion": 1,
        "candidateGeneratorFrozen": True,
        "source": str(source),
        "sourceSha256": source_hash,
        "sourceRows": source_rows,
        "sourceColumns": source_columns,
        "compactRows": len(compact),
        "compactColumns": len(compact.columns),
        "attempts": int(compact["attempt_id"].nunique()),
        "identities": int(compact["identity_group"].nunique()),
        "outputBytes": output.stat().st_size,
    }
    output.with_suffix(".summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
