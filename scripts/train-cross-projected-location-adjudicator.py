#!/usr/bin/env python3
"""Rank cross-projected location evidence after a file-OOF operation identity decision."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


TRAINER_PATH = Path(__file__).with_name("train-unified-diagnosis-adjudicator.py")
SPEC = importlib.util.spec_from_file_location("unified_adjudicator", TRAINER_PATH)
assert SPEC and SPEC.loader
TRAINER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = TRAINER
SPEC.loader.exec_module(TRAINER)


def direction(event_type: str) -> int:
    if event_type == "falseRing":
        return 1
    if event_type in {"missingRing", "partialMove"}:
        return -1
    return 0


def representative(group: pd.DataFrame) -> int:
    return int(group.sort_values(
        ["exact_source_count", "near_source_count", "score_max"],
        ascending=False,
    ).index[0])


def window_representatives(attempt: pd.DataFrame, required_direction: int) -> list[int]:
    local = attempt[
        attempt["candidate_event_type"].ne("wholeSeriesMove")
        & attempt["candidate_start_year"].notna()
        & attempt["candidate_end_year"].notna()
        & attempt["candidate_event_type"].map(direction).eq(required_direction)
    ]
    return [
        representative(group)
        for _, group in local.groupby(
            ["candidate_start_year", "candidate_end_year", "candidate_top_year"],
            dropna=False,
            sort=False,
        )
    ]


def identity_representative(
    attempt: pd.DataFrame,
    event_type: str,
    shift_years: int,
) -> int | None:
    selected = attempt[
        attempt["candidate_event_type"].eq(event_type)
        & attempt["candidate_shift_years"].eq(shift_years)
    ]
    if selected.empty:
        return None
    return int(selected.sort_values(
        [
            "operation_dynamic_score_max",
            "exact_source_count",
            "near_source_count",
            "score_max",
        ],
        ascending=False,
    ).index[0])


def proposal_vector(
    features: pd.DataFrame,
    operation_index: int,
    location_index: int,
) -> np.ndarray:
    operation = features.loc[operation_index].to_numpy(dtype=np.float32)
    location = features.loc[location_index].to_numpy(dtype=np.float32)
    return np.concatenate([operation, location, location - operation])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-cache", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    candidates = pd.read_pickle(Path(args.candidate_cache).resolve())
    features, feature_names = TRAINER.encoded_features(candidates)
    operation_top = pd.read_csv(Path(args.operation_top).resolve())

    train_metadata = []
    train_values = []
    for attempt_id, attempt in candidates.groupby("attempt_id", sort=False):
        strict_identities = attempt[attempt["operation_correct"].eq(1)].groupby(
            ["candidate_event_type", "candidate_shift_years"],
            sort=False,
        )
        for (event_type, shift_years), identity in strict_identities:
            operation_index = representative(identity)
            locations = window_representatives(attempt, direction(str(event_type)))
            query = f"{attempt_id}|{event_type}|{int(shift_years)}"
            for location_index in locations:
                row = candidates.loc[location_index]
                train_metadata.append({
                    "query": query,
                    "attempt_id": attempt_id,
                    "file_id": row["file_id"],
                    "dataset_role": row["dataset_role"],
                    "label": int(row["location_correct"]),
                    "location_index": location_index,
                })
                train_values.append(proposal_vector(
                    features,
                    operation_index,
                    location_index,
                ))
    train_metadata = pd.DataFrame(train_metadata)
    train_values = np.stack(train_values)

    test_metadata = []
    test_values = []
    whole_rows = []
    for _, identity in operation_top.iterrows():
        if identity["family"] == "Clean":
            continue
        attempt = candidates[candidates["attempt_id"].eq(identity["attempt_id"])]
        event_type = str(identity["event_type"])
        shift_years = int(identity["shift_years"])
        if event_type == "wholeSeriesMove":
            whole_rows.append({
                **identity.to_dict(),
                "cross_projected_location_exists": True,
                "cross_projected_workflow_correct": int(identity["operation_correct"]),
                "cross_projected_strict_correct": int(identity["strict_operation_correct"]),
                "selected_location_index": None,
                "selected_start_year": None,
                "selected_end_year": None,
                "selected_top_year": None,
                "location_score": None,
            })
            continue
        operation_index = identity_representative(attempt, event_type, shift_years)
        if operation_index is None:
            continue
        locations = window_representatives(attempt, direction(event_type))
        query = f"{identity['attempt_id']}|{event_type}|{shift_years}"
        for location_index in locations:
            row = candidates.loc[location_index]
            test_metadata.append({
                "query": query,
                "attempt_id": identity["attempt_id"],
                "file_id": identity["file_id"],
                "family": identity["family"],
                "product_correct": int(identity["product_correct"]),
                "operation_correct": int(identity["operation_correct"]),
                "strict_operation_correct": int(identity["strict_operation_correct"]),
                "event_type": event_type,
                "shift_years": shift_years,
                "operation_probability": identity["operation_probability"],
                "location_index": location_index,
                "location_correct": int(row["location_correct"]),
                "strict_location_correct": int(row["location_correct"]),
            })
            test_values.append(proposal_vector(
                features,
                operation_index,
                location_index,
            ))
    test_metadata = pd.DataFrame(test_metadata)
    test_values = np.stack(test_values)

    test_files = np.array(sorted(test_metadata["file_id"].unique()))
    predictions = np.full(len(test_metadata), np.nan)
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(test_files)),
        groups=test_files,
    )):
        held_files = set(test_files[test_file_indices])
        train = np.flatnonzero(~train_metadata["file_id"].isin(held_files).to_numpy())
        test = np.flatnonzero(test_metadata["file_id"].isin(held_files).to_numpy())
        ordered = train_metadata.iloc[train].sort_values("query").index.to_numpy(dtype=int)
        groups = train_metadata.loc[ordered].groupby("query", sort=False).size().to_numpy()
        model = TRAINER.ranker_for(25000 + fold)
        model.fit(
            train_values[ordered],
            train_metadata.loc[ordered, "label"],
            group=groups,
        )
        predictions[test] = model.predict(test_values[test])
    if np.isnan(predictions).any():
        raise RuntimeError("missing cross-projected location OOF predictions")
    test_metadata["location_score"] = predictions
    top_location = test_metadata.sort_values(
        ["query", "location_score"],
        ascending=[True, False],
    ).groupby("query", sort=False).head(1).copy()
    rows = []
    for _, selected in top_location.iterrows():
        location = candidates.loc[int(selected["location_index"])]
        rows.append({
            **selected.to_dict(),
            "cross_projected_location_exists": bool(selected["location_correct"]),
            "cross_projected_workflow_correct": int(
                selected["operation_correct"] and selected["location_correct"]
            ),
            "cross_projected_strict_correct": int(
                selected["strict_operation_correct"]
                and selected["strict_location_correct"]
            ),
            "selected_location_index": int(selected["location_index"]),
            "selected_start_year": location["candidate_start_year"],
            "selected_end_year": location["candidate_end_year"],
            "selected_top_year": location["candidate_top_year"],
        })
    output = pd.concat([pd.DataFrame(rows), pd.DataFrame(whole_rows)], ignore_index=True)
    failures = output[output["product_correct"].eq(0)]
    operation_correct = failures[failures["operation_correct"].eq(1)]
    summary = {
        "schemaVersion": 1,
        "trainingProposals": len(train_metadata),
        "evaluationProposals": len(test_metadata),
        "productFailures": len(failures),
        "operationTopCorrect": len(operation_correct),
        "crossProjectedEndToEndCorrect": int(
            failures["cross_projected_workflow_correct"].sum()
        ),
        "crossProjectedEndToEndRateAmongOperationCorrect": TRAINER.rate(
            int(failures["cross_projected_workflow_correct"].sum()),
            len(operation_correct),
        ),
        "strictEndToEndCorrect": int(
            failures["cross_projected_strict_correct"].sum()
        ),
        "byFamily": {
            family: {
                "productFailures": len(failures[failures["family"] == family]),
                "operationTopCorrect": len(operation_correct[
                    operation_correct["family"] == family
                ]),
                "endToEndCorrect": int(failures.loc[
                    failures["family"] == family,
                    "cross_projected_workflow_correct",
                ].sum()),
            }
            for family in ("A", "B", "C", "D")
        },
    }
    output.to_csv(output_dir / "cross-projected-top.csv", index=False)
    top_location.to_csv(output_dir / "location-proposal-top.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(
            [
                *[f"operation_{name}" for name in feature_names],
                *[f"location_{name}" for name in feature_names],
                *[f"difference_{name}" for name in feature_names],
            ],
            indent=2,
        ) + "\n",
        encoding="utf8",
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
