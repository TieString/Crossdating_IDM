#!/usr/bin/env python3
"""File-OOF same-identity reranking with post-correction residual evidence."""

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
    "immutable_residual_pair",
    SCRIPT_DIR / "immutable_two_stage_adjudicator.py",
)

LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
IDENTITY_KEYS = ("attempt_id", "event_type", "shift_years")


def proposal_id(frame: pd.DataFrame) -> pd.Series:
    return (
        frame["attempt_id"].astype(str)
        + "|"
        + frame["event_type"].astype(str)
        + "|"
        + frame["shift_years"].astype(int).astype(str)
        + "|"
        + frame["year"].astype(int).astype(str)
    )


def add_relative_year_distances(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    year_columns = [
        column
        for column in output.columns
        if column.startswith("residual_")
        and (column.endswith("Year") or column.endswith("_firstYear"))
        and "Delta_" not in column
    ]
    distance_columns: dict[str, pd.Series] = {}
    for column in year_columns:
        values = pd.to_numeric(output[column], errors="coerce")
        valid = values.notna() & values.ne(0)
        distance = values.sub(output["year"]).where(valid)
        distance_columns[f"{column}_signed_distance"] = distance
        distance_columns[f"{column}_absolute_distance"] = distance.abs()
        distance_columns[f"{column}_present"] = valid.astype(np.int8)
    return pd.concat([
        output.drop(columns=year_columns),
        pd.DataFrame(distance_columns, index=output.index),
    ], axis=1)


def residual_features(
    frame: pd.DataFrame,
    excluded_prefixes: tuple[str, ...] = (),
) -> pd.DataFrame:
    """Use only diagnosis-relative values plus within-identity rank/z/margin."""

    source = add_relative_year_distances(frame)
    numeric_columns = []
    for column in source.columns:
        if any(column.startswith(prefix) for prefix in excluded_prefixes):
            continue
        if column in {"listwise_score", "pairwise_score"} or column.startswith(
            "residual_"
        ):
            values = pd.to_numeric(source[column], errors="coerce")
            if values.notna().any():
                source[column] = values.astype(np.float64)
                numeric_columns.append(column)
    group = source.groupby(list(IDENTITY_KEYS), sort=False)
    features: dict[str, pd.Series] = {}
    for column in numeric_columns:
        values = source[column]
        grouped = group[column]
        ranks = grouped.rank(pct=True, method="average")
        means = grouped.transform("mean")
        standard = grouped.transform("std").replace(0, np.nan)
        maximum = grouped.transform("max")
        features[f"{column}__rank"] = ranks
        features[f"{column}__z"] = values.sub(means).div(standard).fillna(0)
        features[f"{column}__winner_margin"] = values.sub(maximum)
        if "Delta" in column or column.endswith("pathEventReduction"):
            features[f"{column}__relative_value"] = values
    output = pd.DataFrame(features, index=source.index)
    return output.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)


def select_top(frame: pd.DataFrame, scores: pd.Series) -> pd.DataFrame:
    return (
        frame.assign(_score=scores)
        .sort_values(
            [*IDENTITY_KEYS, "_score", "pairwise_score"],
            ascending=[True, True, True, False, False],
            kind="mergesort",
        )
        .drop_duplicates(list(IDENTITY_KEYS))
    )


def project_final(operation_top: pd.DataFrame, location_top: pd.DataFrame) -> pd.DataFrame:
    selected = operation_top.copy()
    local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    location = location_top.set_index("attempt_id")
    selected["final_correct"] = selected["operation_correct"].astype(np.int8)
    selected.loc[local, "final_correct"] = (
        selected.loc[local, "operation_correct"].astype(bool)
        & selected.loc[local, "attempt_id"]
        .map(location["window_correct"])
        .fillna(0)
        .astype(bool)
    ).astype(np.int8)
    selected.loc[local, "selected_candidate_year"] = selected.loc[
        local, "attempt_id"
    ].map(location["year"])
    selected["candidate_has_response"] = selected["event_type"].ne(
        "noEvent"
    ).astype(np.int8)
    selected["final_strict_correct"] = selected["final_correct"]
    return selected


def summarize(selected: pd.DataFrame, baseline: pd.DataFrame) -> dict:
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    comparison = event[["attempt_id", "final_correct"]].merge(
        baseline[["attempt_id", "final_correct"]].rename(
            columns={"final_correct": "baseline_correct"}
        ),
        on="attempt_id",
        validate="one_to_one",
    )
    return {
        "correct": int(event["final_correct"].sum()),
        "events": int(len(event)),
        "accuracy": float(event["final_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "repairs": int(
            (comparison["baseline_correct"].eq(0)
             & comparison["final_correct"].eq(1)).sum()
        ),
        "regressions": int(
            (comparison["baseline_correct"].eq(1)
             & comparison["final_correct"].eq(0)).sum()
        ),
        "byFamily": {
            str(family): {
                "correct": int(group["final_correct"].sum()),
                "events": int(len(group)),
                "accuracy": float(group["final_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--residual-evidence", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--outer-splits", type=int, default=5)
    parser.add_argument("--exclude-feature-prefix", action="append", default=[])
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    location = pd.read_pickle(Path(args.location_scores).resolve())
    location["proposal_id"] = proposal_id(location)
    residual_payload = json.loads(
        Path(args.residual_evidence).resolve().read_text(encoding="utf8")
    )
    residual = pd.DataFrame(residual_payload["rows"])
    residual_columns = [
        column
        for column in residual.columns
        if column == "proposal_id" or column.startswith("residual_")
    ]
    rows = location.merge(
        residual[residual_columns],
        on="proposal_id",
        how="inner",
        validate="one_to_one",
    )
    operation_top = pd.read_csv(Path(args.operation_top).resolve())
    operation_correct = operation_top.set_index("attempt_id")["operation_correct"]
    rows["selected_operation_correct"] = (
        rows["attempt_id"].map(operation_correct).fillna(0).astype(np.int8)
    )
    excluded_prefixes = tuple(args.exclude_feature_prefix)
    values = residual_features(rows, excluded_prefixes)
    predictions = np.full(len(rows), np.nan, dtype=np.float32)
    splitter = GroupKFold(
        n_splits=min(args.outer_splits, rows["file_id"].nunique())
    )
    for fold, (train_index, test_index) in enumerate(
        splitter.split(rows, groups=rows["file_id"])
    ):
        train_index = np.asarray(train_index, dtype=int)
        test_index = np.asarray(test_index, dtype=int)
        train_index = train_index[
            rows.loc[train_index, "selected_operation_correct"].eq(1).to_numpy()
        ]
        train_frame = rows.loc[train_index].reset_index(drop=True)
        train_values = values.loc[train_index].reset_index(drop=True)
        pair_values, pair_labels = pair.build_pair_training(
            train_frame,
            train_values,
            label="window_correct",
            group="attempt_id",
            seed_score=train_frame["pairwise_score"],
            maximum_positives=3,
            maximum_negatives=12,
        )
        estimator = pair.pair_classifier(830000 + fold)
        estimator.fit(pair_values, pair_labels)
        test_frame = rows.loc[test_index].reset_index(drop=True)
        test_values = values.loc[test_index].reset_index(drop=True)
        predictions[test_index] = pair.pair_tournament_scores(
            test_frame,
            test_values,
            estimator,
            group="attempt_id",
            shortlist_score=test_frame["pairwise_score"],
            shortlist_size=16,
        )
        print(json.dumps({"completedOuterFold": fold}), flush=True)
    if np.isnan(predictions).any():
        raise RuntimeError("residual location OOF left candidates without scores")

    baseline_location = select_top(location, location["pairwise_score"])
    residual_location = select_top(
        rows, pd.Series(predictions, index=rows.index)
    )
    baseline = project_final(operation_top, baseline_location)
    selected = project_final(operation_top, residual_location)
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "strictFileOof": True,
        "truthBlindResidualGeneration": True,
        "operationIdentityImmutable": True,
        "candidateWindowsImmutable": True,
        "excludedFeaturePrefixes": list(excluded_prefixes),
        "featureCount": int(values.shape[1]),
        "attemptsWithResidual": int(rows["attempt_id"].nunique()),
        "residualCandidates": int(len(rows)),
        "baseline": summarize(baseline, baseline),
        "residualPairwise": summarize(selected, baseline),
    }
    selected.to_csv(output_dir / "residual-location-top.csv", index=False)
    rows[[
        "proposal_id", "attempt_id", "file_id", "family", "event_type",
        "shift_years", "year", "window_correct", "listwise_score",
        "pairwise_score",
    ]].assign(residual_oof_score=predictions).to_pickle(
        output_dir / "residual-location-oof-scores.pkl"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
