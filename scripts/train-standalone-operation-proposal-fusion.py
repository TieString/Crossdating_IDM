#!/usr/bin/env python3
"""Select one operation identity from equal-footing standalone proposals."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
TRAINER = load_module(
    "standalone_operation_fusion_hierarchy",
    ROOT / "train-standalone-hierarchical-package.py",
)


SCORE_ROLES = {
    "meta": "operation_meta_score",
    "globalRank": "operation_rank_score",
    "globalClassifier": "operation_classifier_probability",
    "typedRank": "typed_operation_rank_percentile",
    "typedClassifier": "typed_operation_classifier_percentile",
}
SOURCE_ROLES = {
    "productPrimary": "source_count_productPrimary",
    "productAlternative": "source_count_productAlternative",
    "enriched": "source_count_enrichedProposal",
    "wholeProjection": "source_count_wholeProjection",
}
SCORE_COLUMNS = list(dict.fromkeys([
    *SCORE_ROLES.values(),
    "operation_meta_percentile",
    "operation_rank_percentile",
    "operation_classifier_percentile",
    "shift_rank_score",
    "shift_classifier_probability",
    "shift_rank_percentile",
    "shift_classifier_percentile",
    "typed_operation_rank_percentile",
    "typed_operation_classifier_percentile",
]))
FORBIDDEN_FEATURE_TERMS = {
    "attempt_id", "cluster_id", "file_id", "family", "is_clean",
    "operation_correct", "truth_year", "workflow_correct", "strict_correct",
    "location_correct", "location_relevance", "location_error_years",
}


def top_indices(
    frame: pd.DataFrame,
    score: str,
    mask: pd.Series | None = None,
) -> pd.Index:
    subset = frame if mask is None else frame.loc[mask]
    if subset.empty or score not in subset:
        return pd.Index([])
    return (
        subset.sort_values(["attempt_id", score], ascending=[True, False])
        .groupby("attempt_id", sort=False)
        .head(1)
        .index
    )


def proposal_rows(
    operations: pd.DataFrame,
    base: pd.DataFrame,
) -> pd.DataFrame:
    roles: list[pd.DataFrame] = []
    base_keys = base[["attempt_id", "identity_group"]].copy()
    base_keys["proposal_role"] = "base"
    roles.append(base_keys)
    for role, score in SCORE_ROLES.items():
        indices = top_indices(operations, score)
        selected = operations.loc[indices, ["attempt_id", "identity_group"]].copy()
        selected["proposal_role"] = role
        roles.append(selected)
    type_best = (
        operations.sort_values(
            ["attempt_id", "event_type", "operation_meta_score"],
            ascending=[True, True, False],
        )
        .groupby(["attempt_id", "event_type"], sort=False)
        .head(1)[["attempt_id", "identity_group"]]
        .copy()
    )
    type_best["proposal_role"] = "typeBest"
    roles.append(type_best)
    for role, source in SOURCE_ROLES.items():
        if source not in operations:
            continue
        indices = top_indices(
            operations,
            "operation_meta_score",
            operations[source].fillna(0).gt(0),
        )
        selected = operations.loc[indices, ["attempt_id", "identity_group"]].copy()
        selected["proposal_role"] = role
        roles.append(selected)
    role_rows = pd.concat(roles, ignore_index=True)
    role_flags = pd.crosstab(
        [role_rows["attempt_id"], role_rows["identity_group"]],
        role_rows["proposal_role"],
    ).add_prefix("proposal_role__").reset_index()
    role_columns = [
        column for column in role_flags if column.startswith("proposal_role__")
    ]
    role_flags["proposal_count"] = role_flags[role_columns].sum(axis=1)
    proposals = role_flags.merge(
        operations,
        on=["attempt_id", "identity_group"],
        how="left",
        validate="one_to_one",
    )
    proposals["proposal_unique_identity_count"] = proposals.groupby(
        "attempt_id", sort=False
    )["identity_group"].transform("size")
    for score in SCORE_COLUMNS:
        if score not in proposals:
            continue
        maximum = proposals.groupby("attempt_id", sort=False)[score].transform("max")
        proposals[f"proposal_{score}_deficit"] = maximum - proposals[score]
    return proposals


def feature_columns(frame: pd.DataFrame) -> list[str]:
    columns = list(TRAINER.operation_meta_columns(frame))
    columns.extend([
        column for column in frame
        if column in SCORE_COLUMNS
        or column.startswith("proposal_role__")
        or column.startswith("proposal_operation_")
        or column in {"proposal_count", "proposal_unique_identity_count"}
    ])
    output = list(dict.fromkeys(columns))
    forbidden = [column for column in output if column in FORBIDDEN_FEATURE_TERMS]
    if forbidden:
        raise RuntimeError(f"forbidden operation proposal features: {forbidden}")
    return output


def encode(
    frame: pd.DataFrame,
    columns: list[str] | None = None,
) -> tuple[pd.DataFrame, list[str]]:
    selected = columns or feature_columns(frame)
    raw = frame.reindex(columns=selected).copy()
    categorical = [column for column in selected if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=np.float32)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def encode_train_target(
    training: pd.DataFrame,
    target: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, list[str]]:
    columns = feature_columns(training)
    train_raw = training.reindex(columns=columns).copy()
    target_raw = target.reindex(columns=columns).copy()
    categorical = [
        column for column in columns if train_raw[column].dtype == object
    ]
    train_values = pd.get_dummies(
        train_raw, columns=categorical, dtype=np.float32
    ).replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    target_values = pd.get_dummies(
        target_raw, columns=categorical, dtype=np.float32
    ).reindex(columns=train_values.columns, fill_value=0)
    target_values = target_values.replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0).astype(np.float32)
    return train_values, target_values, list(train_values.columns)


def ranker(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="rank_xendcg",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=600,
        learning_rate=0.02,
        num_leaves=9,
        min_child_samples=24,
        subsample=0.9,
        colsample_bytree=0.85,
        reg_alpha=2.0,
        reg_lambda=9.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def classifier(seed: int) -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(
        objective="binary",
        metric="binary_logloss",
        n_estimators=550,
        learning_rate=0.02,
        num_leaves=9,
        min_child_samples=24,
        subsample=0.9,
        colsample_bytree=0.85,
        reg_alpha=2.0,
        reg_lambda=9.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def sample_weights(frame: pd.DataFrame) -> np.ndarray:
    sizes = frame.groupby("attempt_id")["attempt_id"].transform("size")
    return (1 / sizes).to_numpy(dtype=float)


def select_top(
    proposals: pd.DataFrame,
    scores: np.ndarray,
) -> pd.DataFrame:
    scored = proposals.copy()
    scored["proposal_score"] = scores
    return (
        scored.sort_values(
            ["attempt_id", "proposal_score"], ascending=[True, False]
        )
        .groupby("attempt_id", sort=False)
        .head(1)
        .copy()
    )


def clustered_lower(
    selected: pd.DataFrame, seed: int, repetitions: int
) -> float:
    files = np.array(sorted(selected["cluster_id"].astype(str).unique()))
    grouped = {
        file_id: selected.loc[
            selected["cluster_id"].astype(str).eq(file_id), "operation_correct"
        ].to_numpy(dtype=float)
        for file_id in files
    }
    rng = np.random.default_rng(seed)
    values = np.empty(repetitions, dtype=float)
    for index in range(repetitions):
        sampled = rng.choice(files, size=len(files), replace=True)
        values[index] = np.concatenate(
            [grouped[file_id] for file_id in sampled]
        ).mean()
    return float(np.quantile(values, 0.05, method="lower"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--base-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-type", choices=("ranker", "classifier"), default="classifier")
    parser.add_argument("--ensemble-members", type=int, default=1)
    parser.add_argument("--seed-base", type=int, default=153000)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()
    if args.ensemble_members < 1:
        raise ValueError("ensemble members must be positive")
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    operations = pd.read_pickle(Path(args.operation_scores).resolve())
    base = pd.read_csv(Path(args.base_top).resolve())
    proposals = proposal_rows(operations, base)
    values, names = encode(proposals)
    files = np.array(sorted(proposals["cluster_id"].astype(str).unique()))
    splitter = GroupKFold(n_splits=5)
    predictions = np.full(len(proposals), np.nan)
    for fold, (_, test_file_indices) in enumerate(
        splitter.split(np.zeros(len(files)), groups=files)
    ):
        held = set(files[test_file_indices])
        train = proposals.index[
            ~proposals["cluster_id"].astype(str).isin(held)
        ].to_numpy(dtype=int)
        test = proposals.index[
            proposals["cluster_id"].astype(str).isin(held)
        ].to_numpy(dtype=int)
        ordered = proposals.loc[train].sort_values("attempt_id").index.to_numpy(dtype=int)
        groups = proposals.loc[ordered].groupby(
            "attempt_id", sort=False
        ).size().to_numpy()
        fold_scores = np.zeros(len(test), dtype=float)
        for member in range(args.ensemble_members):
            seed = args.seed_base + fold + member * 1009
            if args.model_type == "classifier":
                model = classifier(seed)
                model.fit(
                    values.loc[train],
                    proposals.loc[train, "operation_correct"],
                    sample_weight=sample_weights(proposals.loc[train]),
                )
                fold_scores += model.predict_proba(values.loc[test])[:, 1]
            else:
                model = ranker(seed)
                model.fit(
                    values.loc[ordered],
                    proposals.loc[ordered, "operation_correct"],
                    group=groups,
                )
                fold_scores += model.predict(values.loc[test])
        predictions[test] = fold_scores / args.ensemble_members
    if np.isnan(predictions).any():
        raise RuntimeError("missing operation proposal OOF scores")
    top = select_top(proposals, predictions)
    base_operation = base.set_index("attempt_id")["operation_correct"].astype(bool)
    before = top["attempt_id"].map(base_operation).fillna(False).astype(bool)
    after = top["operation_correct"].astype(bool)
    event = top.loc[~top["is_clean"].astype(bool)].copy()
    clean = top.loc[top["is_clean"].astype(bool)].copy()
    event_before = event["attempt_id"].map(base_operation).fillna(False).astype(bool)
    event_after = event["operation_correct"].astype(bool)
    by_family = {
        str(family): {
            "correct": int(group["operation_correct"].sum()),
            "events": len(group),
            "operationAccuracy": float(group["operation_correct"].mean()),
            "oneSided95FileClusterLower": clustered_lower(
                group, 153000 + ord(str(family)[0]), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family", sort=True)
    }
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": f"standalone_operation_proposal_{args.model_type}",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "files": int(top["cluster_id"].nunique()),
        "eventAttempts": len(event),
        "proposalRows": len(proposals),
        "features": len(names),
        "modelType": args.model_type,
        "ensembleMembers": args.ensemble_members,
        "operationCorrect": int(event_after.sum()),
        "operationAccuracy": float(event_after.mean()),
        "candidateOracleCorrect": int(
            proposals.loc[~proposals["is_clean"].astype(bool)]
            .groupby("attempt_id")["operation_correct"].max().sum()
        ),
        "correctToWrong": int((event_before & ~event_after).sum()),
        "wrongToCorrect": int((~event_before & event_after).sum()),
        "cleanFalsePositives": int(clean["event_type"].ne("noEvent").sum()),
        "overallOneSided95FileClusterLower": clustered_lower(
            event, 153999, args.bootstrap_repetitions
        ),
        "byFamily": by_family,
    }
    proposals.assign(proposal_score=predictions).to_pickle(
        output_dir / "operation-proposal-oof-scores.pkl"
    )
    top.to_csv(output_dir / "operation-proposal-top.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
