#!/usr/bin/env python3
"""File-OOF operation reranking with post-correction residual evidence."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


pair = load_module(
    "immutable_operation_residual_pair",
    SCRIPT_DIR / "immutable_two_stage_adjudicator.py",
)


def residual_operation_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Project evidence to diagnosis-relative coordinates within each attempt."""

    source = frame.copy()
    numeric_columns: list[str] = []
    for column in source.columns:
        lowered = column.lower()
        if not (
            column in {"selection_oof_score", "meta_oof_score", "pair_oof_score"}
            or column.startswith("residual_")
        ):
            continue
        if "year" in lowered:
            continue
        values = pd.to_numeric(source[column], errors="coerce")
        if values.notna().any():
            source[column] = values.astype(np.float64)
            numeric_columns.append(column)

    groups = source.groupby("attempt_id", sort=False)
    features: dict[str, pd.Series] = {}
    for column in numeric_columns:
        values = source[column]
        grouped = groups[column]
        mean = grouped.transform("mean")
        standard = grouped.transform("std").replace(0, np.nan)
        maximum = grouped.transform("max")
        features[f"{column}__rank"] = grouped.rank(
            pct=True, method="average"
        )
        features[f"{column}__z"] = values.sub(mean).div(standard).clip(-8, 8)
        features[f"{column}__winner_margin"] = (
            values.sub(maximum).div(standard).clip(-12, 0)
        )
        if "delta" in lowered or lowered.endswith("reduction"):
            features[f"{column}__relative_value"] = values

    event_types = sorted(source["event_type"].astype(str).unique())
    for event_type in event_types:
        features[f"event_type__{event_type}"] = source["event_type"].eq(
            event_type
        ).astype(np.float32)
    shifts = pd.to_numeric(source["shift_years"], errors="coerce").fillna(0)
    features["shift_years"] = shifts
    features["shift_magnitude"] = shifts.abs()
    features["shift_negative"] = shifts.lt(0).astype(np.float32)

    return (
        pd.DataFrame(features, index=source.index)
        .replace([np.inf, -np.inf], np.nan)
        .fillna(0)
        .astype(np.float32)
    )


def select_top(frame: pd.DataFrame, scores: pd.Series) -> pd.DataFrame:
    return (
        frame.assign(_score=scores)
        .sort_values(
            ["attempt_id", "_score", "selection_oof_score"],
            ascending=[True, False, False],
            kind="mergesort",
        )
        .drop_duplicates("attempt_id")
    )


def summarize(selected: pd.DataFrame, baseline: pd.DataFrame) -> dict:
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    comparison = event[["attempt_id", "identity_workflow_oracle"]].merge(
        baseline[["attempt_id", "identity_workflow_oracle"]].rename(
            columns={"identity_workflow_oracle": "baseline_correct"}
        ),
        on="attempt_id",
        validate="one_to_one",
    )
    return {
        "correct": int(event["identity_workflow_oracle"].sum()),
        "events": int(len(event)),
        "accuracy": float(event["identity_workflow_oracle"].mean()),
        "exactCorrect": int(event["identity_operation_correct"].sum()),
        "exactAccuracy": float(event["identity_operation_correct"].mean()),
        "responseRate": float(event["event_type"].ne("noEvent").mean()),
        "cleanFalsePositives": int(clean["event_type"].ne("noEvent").sum()),
        "repairs": int((
            comparison["baseline_correct"].eq(0)
            & comparison["identity_workflow_oracle"].eq(1)
        ).sum()),
        "regressions": int((
            comparison["baseline_correct"].eq(1)
            & comparison["identity_workflow_oracle"].eq(0)
        ).sum()),
        "byFamily": {
            str(family): {
                "correct": int(group["identity_workflow_oracle"].sum()),
                "events": int(len(group)),
                "accuracy": float(group["identity_workflow_oracle"].mean()),
                "exactCorrect": int(group["identity_operation_correct"].sum()),
                "exactAccuracy": float(group["identity_operation_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--residual-evidence", required=True)
    parser.add_argument("--identity-labels", required=True)
    parser.add_argument("--packages", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--outer-splits", type=int, default=5)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    scores = pd.read_pickle(Path(args.operation_scores).resolve())
    local_labels = pd.read_pickle(Path(args.identity_labels).resolve())
    packages = pd.read_pickle(Path(args.packages).resolve())
    labels = packages.groupby("identity_group", sort=False).agg(
        attempt_id=("attempt_id", "first"),
        file_id=("file_id", "first"),
        family=("family", "first"),
        event_type=("event_type", "first"),
        shift_years=("shift_years", "first"),
        identity_operation_correct=("identity_operation_correct", "max"),
    ).reset_index()
    workflow_by_identity = local_labels.set_index("identity_group")[
        "identity_workflow_oracle"
    ]
    labels["identity_workflow_oracle"] = labels["identity_group"].map(
        workflow_by_identity
    ).fillna(labels["identity_operation_correct"]).astype(np.int8)
    payload = json.loads(
        Path(args.residual_evidence).resolve().read_text(encoding="utf8")
    )
    residual = pd.DataFrame(payload["rows"])
    residual_columns = [
        column
        for column in residual.columns
        if column == "proposal_id" or column.startswith("residual_")
    ]
    shortlist = residual[[
        "proposal_id", "attempt_id", "event_type", "shift_years",
    ]].copy()
    shortlist["identity_group"] = (
        shortlist["attempt_id"].astype(str)
        + "|" + shortlist["event_type"].astype(str)
        + "|" + shortlist["shift_years"].astype(int).astype(str)
    )
    shortlist = shortlist.merge(
        scores,
        on="identity_group",
        how="left",
        validate="one_to_one",
    )
    shortlist = shortlist.merge(
        residual[residual_columns],
        on="proposal_id",
        how="left",
        validate="one_to_one",
    ).merge(
        labels,
        on="identity_group",
        how="left",
        validate="one_to_one",
        suffixes=("", "_label"),
    )
    if shortlist["file_id"].isna().any():
        raise RuntimeError("operation residual shortlist misses identity labels")

    values = residual_operation_features(shortlist)
    predictions = np.full(len(shortlist), np.nan, dtype=np.float32)
    splitter = GroupKFold(
        n_splits=min(args.outer_splits, shortlist["file_id"].nunique())
    )
    for fold, (train_index, test_index) in enumerate(
        splitter.split(shortlist, groups=shortlist["file_id"])
    ):
        train_frame = shortlist.iloc[train_index].reset_index(drop=True)
        train_values = values.iloc[train_index].reset_index(drop=True)
        pair_values, pair_labels = pair.build_pair_training(
            train_frame,
            train_values,
            label="identity_workflow_oracle",
            group="attempt_id",
            seed_score=train_frame["selection_oof_score"],
            maximum_positives=1,
            maximum_negatives=1,
        )
        estimator = pair.pair_classifier(840000 + fold)
        estimator.fit(pair_values, pair_labels)
        test_frame = shortlist.iloc[test_index].reset_index(drop=True)
        test_values = values.iloc[test_index].reset_index(drop=True)
        predictions[test_index] = pair.pair_tournament_scores(
            test_frame,
            test_values,
            estimator,
            group="attempt_id",
            shortlist_score=test_frame["selection_oof_score"],
            shortlist_size=2,
        )
        print(json.dumps({"completedOuterFold": fold}), flush=True)
    if np.isnan(predictions).any():
        raise RuntimeError("operation residual OOF left candidates without scores")

    full = scores.merge(
        labels,
        on="identity_group",
        how="left",
        validate="one_to_one",
    )
    baseline = select_top(full, full["selection_oof_score"])
    shortlist = shortlist.assign(residual_oof_score=predictions)
    selected = select_top(shortlist, shortlist["residual_oof_score"])
    summary = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "strictFileOof": True,
        "truthBlindResidualGeneration": True,
        "candidateIdentitiesImmutable": True,
        "topOperationIdentities": 2,
        "featureCount": int(values.shape[1]),
        "baseline": summarize(baseline, baseline),
        "residualPairwise": summarize(selected, baseline),
    }
    selected.to_csv(
        output_dir / "residual-operation-top.csv", index=False
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
