#!/usr/bin/env python3
"""File-OOF pairwise reranking audit for the top two operation identities."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
TRAINER_SPEC = importlib.util.spec_from_file_location(
    "immutable_two_stage_trainer",
    SCRIPT_DIR / "train-immutable-two-stage-adjudicator.py",
)
trainer = importlib.util.module_from_spec(TRAINER_SPEC)
TRAINER_SPEC.loader.exec_module(trainer)


def top_two(frame: pd.DataFrame) -> pd.DataFrame:
    return (
        frame.sort_values(
            ["attempt_id", "rank_oof_score"],
            ascending=[True, False],
            kind="stable",
        )
        .groupby("attempt_id", sort=False)
        .head(2)
        .assign(_position=lambda value: value.groupby("attempt_id").cumcount())
    )


def pair_rows(
    top: pd.DataFrame,
    values: pd.DataFrame,
    allowed_files: set[str],
    *,
    required_pair_key: str | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    matrix = values.to_numpy(dtype=np.float32, copy=False)
    differences: list[np.ndarray] = []
    labels: list[int] = []
    selected = top[top["file_id"].isin(allowed_files)]
    for _, rows in selected.groupby("attempt_id", sort=False):
        if len(rows) != 2:
            continue
        pair_key = "|".join(sorted(rows["event_type"].astype(str)))
        if required_pair_key is not None and pair_key != required_pair_key:
            continue
        first, second = rows.index.to_numpy(dtype=int)
        first_correct = int(top.at[first, "operation_correct"])
        second_correct = int(top.at[second, "operation_correct"])
        if first_correct == second_correct:
            continue
        delta = matrix[first] - matrix[second]
        differences.extend((delta, -delta))
        labels.extend((first_correct, second_correct))
    if not differences:
        raise RuntimeError("no unequal top-two operation pairs were available")
    return np.asarray(differences, dtype=np.float32), np.asarray(labels, dtype=np.int8)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--ranking-oof-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-features", type=int, default=512)
    parser.add_argument("--specialize-event-pair", action="store_true")
    args = parser.parse_args()

    operation_path = Path(args.operation_scores).resolve()
    ranking_path = Path(args.ranking_oof_scores).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = trainer.prepare_operation(pd.read_pickle(operation_path))
    ranking = pd.read_pickle(ranking_path).reset_index(drop=True)
    if not operations["identity_group"].equals(ranking["identity_group"]):
        raise RuntimeError("ranking OOF rows do not match operation identities")
    operations["rank_oof_score"] = ranking["rank_oof_score"].to_numpy()

    spec = trainer.make_feature_spec(
        operations,
        group_column="attempt_id",
        maximum_numeric=args.maximum_features,
        categorical_columns=("event_type",),
        preferred_numeric=trainer.OPERATION_PREFERRED,
    )
    values = trainer.project_relative_features(operations, spec)
    top = top_two(operations)
    probability = pd.Series(np.nan, index=operations.index, dtype=float)
    splitter = GroupKFold(n_splits=min(5, operations["file_id"].nunique()))
    file_frame = pd.DataFrame({"file_id": sorted(operations["file_id"].unique())})
    specialized_models = 0
    for fold, (train_files_index, test_files_index) in enumerate(
        splitter.split(file_frame, groups=file_frame["file_id"])
    ):
        train_files = set(file_frame.iloc[train_files_index]["file_id"])
        test_files = set(file_frame.iloc[test_files_index]["file_id"])
        pair_values, pair_labels = pair_rows(top, values, train_files)
        estimator = trainer.pair_classifier(99000 + fold)
        estimator.fit(pair_values, pair_labels)
        estimators: dict[str, object] = {}
        if args.specialize_event_pair:
            train_top = top[top["file_id"].isin(train_files)]
            pair_keys = {
                "|".join(sorted(rows["event_type"].astype(str)))
                for _, rows in train_top.groupby("attempt_id", sort=False)
                if len(rows) == 2
            }
            for pair_key in sorted(pair_keys):
                try:
                    specialized_values, specialized_labels = pair_rows(
                        top,
                        values,
                        train_files,
                        required_pair_key=pair_key,
                    )
                except RuntimeError:
                    continue
                if len(specialized_labels) < 80 or len(np.unique(specialized_labels)) < 2:
                    continue
                seed_offset = int(
                    hashlib.sha256(pair_key.encode("utf-8")).hexdigest()[:6], 16
                )
                specialized = trainer.pair_classifier(
                    100000 + fold + seed_offset
                )
                specialized.fit(specialized_values, specialized_labels)
                estimators[pair_key] = specialized
                specialized_models += 1
        test = top[top["file_id"].isin(test_files)]
        for _, rows in test.groupby("attempt_id", sort=False):
            if len(rows) != 2:
                continue
            first, second = rows.index.to_numpy(dtype=int)
            delta = (
                values.loc[first].to_numpy(dtype=np.float32)
                - values.loc[second].to_numpy(dtype=np.float32)
            ).reshape(1, -1)
            pair_key = "|".join(sorted(rows["event_type"].astype(str)))
            selected_estimator = estimators.get(pair_key, estimator)
            booster = getattr(selected_estimator, "booster_", None)
            probability.at[first] = float(
                booster.predict(delta)[0]
                if booster is not None
                else selected_estimator.predict_proba(delta)[0, 1]
            )
    if probability.loc[top[top["_position"].eq(0)].index].isna().any():
        raise RuntimeError("top-two reranker left diagnoses without OOF probability")

    first = top[top["_position"].eq(0)].copy()
    second = top[top["_position"].eq(1)].set_index("attempt_id")
    first["top1_probability"] = probability.loc[first.index].to_numpy()
    rows: list[dict] = []
    selections: dict[float, pd.DataFrame] = {}
    for threshold in np.linspace(0.05, 0.5, 19):
        selected = first.copy()
        flip = selected["top1_probability"].lt(threshold)
        replacement = selected.loc[flip, "attempt_id"].map(
            second["identity_group"]
        )
        by_identity = operations.set_index("identity_group")
        replacement_rows = by_identity.loc[replacement].reset_index()
        common = selected.columns.intersection(replacement_rows.columns)
        selected.loc[flip, common] = replacement_rows[common].to_numpy()
        event = selected[selected["family"].ne("Clean")]
        clean = selected[selected["family"].eq("Clean")]
        rows.append({
            "threshold": float(threshold),
            "correct": int(event["operation_correct"].sum()),
            "events": len(event),
            "accuracy": float(event["operation_correct"].mean()),
            "flips": int(flip.sum()),
            "cleanFalsePositives": int(clean["event_type"].ne("noEvent").sum()),
        })
        selections[float(threshold)] = selected
    grid = pd.DataFrame(rows)
    eligible = grid[grid["cleanFalsePositives"].le(1)]
    best = (eligible if not eligible.empty else grid).sort_values(
        ["correct", "flips"], ascending=[False, True]
    ).iloc[0]
    selected = selections[float(best["threshold"])]
    event = selected[selected["family"].ne("Clean")]
    by_family = {
        str(family): {
            "correct": int(group["operation_correct"].sum()),
            "events": len(group),
            "accuracy": float(group["operation_correct"].mean()),
        }
        for family, group in event.groupby("family", sort=True)
    }
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "stackingCaveat": (
            "Base OOF scores are file-held-out, but this diagnostic reranker is "
            "not yet nested cross-fitted."
        ),
        "candidateGeneratorFrozen": True,
        "operationScoresSha256": trainer.sha256(operation_path),
        "rankingScoresSha256": trainer.sha256(ranking_path),
        "inputFeatures": len(spec.numeric_columns),
        "projectedFeatures": values.shape[1],
        "specializeEventPair": bool(args.specialize_event_pair),
        "specializedModels": specialized_models,
        "best": best.to_dict(),
        "byFamily": by_family,
    }
    grid.to_csv(output_dir / "threshold-grid.csv", index=False)
    selected.to_csv(output_dir / "best-top.csv", index=False)
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
