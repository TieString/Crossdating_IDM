#!/usr/bin/env python3
"""Select one location from base, pairwise, and listwise OOF proposals."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from standalone_location_evidence import is_candidate_relative_evidence


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
LABEL_COLUMNS = {
    "attempt_id",
    "cluster_id",
    "file_id",
    "family",
    "is_clean",
    "identity_group",
    "candidate_year",
    "operation_correct",
    "identity_operation_correct",
    "location_correct",
    "location_relevance",
    "location_error_years",
    "workflow_correct",
    "strict_correct",
}


def model(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="rank_xendcg",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=650,
        learning_rate=0.02,
        num_leaves=7,
        min_child_samples=24,
        subsample=0.9,
        colsample_bytree=0.75,
        reg_alpha=2.0,
        reg_lambda=10.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def candidate_features(frame: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    evidence_terms = (
        "score",
        "percentile",
        "margin",
        "gain",
        "concentration",
        "mode_rank",
        "probability",
        "support",
    )
    columns = [
        column for column in frame.columns
        if column not in LABEL_COLUMNS
        and not column.startswith("runtime_note__")
        and (
            column in {
                "candidate_source",
                "event_type",
                "shift_years",
                "shift_abs",
                "candidate_has_response",
                "candidate_year_present",
                "context_reference_mode",
                "runtime_confidence",
                "proposal_is_base",
                "proposal_is_pair",
                "proposal_is_meta",
                "proposal_year_delta_from_base",
                "proposal_year_absolute_delta_from_base",
                "pair_alternative_probability",
                "operation_rank_percentile",
                "operation_classifier_percentile",
                "operation_score_margin",
            }
            or column.startswith("context_")
            or column.startswith("runtime_source__")
            or column.startswith("geometry_")
            or column.startswith("bundle_")
            or column.startswith("location_")
            or (
                is_candidate_relative_evidence(column)
                and (
                    column.startswith("evidence_consensus_")
                    or any(term in column.lower() for term in evidence_terms)
                )
            )
        )
    ]
    raw = frame[columns].copy()
    categorical = [column for column in raw if raw[column].dtype == object]
    values = pd.get_dummies(raw, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(np.float32)
    return values, list(values.columns)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-scores", required=True)
    parser.add_argument("--operation-scores", required=True)
    parser.add_argument("--base-top", required=True)
    parser.add_argument("--pair-scores", required=True)
    parser.add_argument("--pair-top", required=True)
    parser.add_argument("--meta-scores", required=True)
    parser.add_argument("--meta-top", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    locations = pd.read_pickle(Path(args.location_scores).resolve())
    locations = locations[
        locations["event_type"].isin(LOCAL_EVENT_TYPES)
    ].copy().reset_index(drop=True)
    meta_locations = pd.read_pickle(Path(args.meta_scores).resolve())
    meta_locations = meta_locations.set_index([
        "identity_group", "candidate_source", "candidate_year"
    ])
    for column in ("location_meta_score", "location_meta_percentile"):
        locations[column] = pd.MultiIndex.from_frame(locations[[
            "identity_group", "candidate_source", "candidate_year"
        ]]).map(meta_locations[column])

    operation_scores = pd.read_pickle(Path(args.operation_scores).resolve())
    operation_scores = operation_scores.set_index("identity_group")
    base = pd.read_csv(Path(args.base_top).resolve())
    pair_top = pd.read_csv(Path(args.pair_top).resolve()).set_index("attempt_id")
    meta_top = pd.read_csv(Path(args.meta_top).resolve()).set_index("attempt_id")
    pair_scores = pd.read_pickle(Path(args.pair_scores).resolve())
    pair_best = pair_scores.sort_values(
        ["identity_group", "alternative_better_probability"],
        ascending=[True, False],
    ).groupby("identity_group", sort=False).head(1).set_index("identity_group")

    proposal_rows: list[pd.Series] = []
    proposal_metadata: list[dict[str, object]] = []
    for _, selected in base.iterrows():
        if selected["event_type"] not in LOCAL_EVENT_TYPES:
            continue
        identity = str(selected["identity_group"])
        group = locations[locations["identity_group"].eq(identity)]
        if group.empty:
            continue
        base_year = selected.get("selected_candidate_year")
        base_candidates = group[group["candidate_year"].eq(base_year)]
        base_index = int((
            base_candidates if not base_candidates.empty else group
        )["location_global_percentile"].idxmax())
        indices: dict[int, set[str]] = {base_index: {"base"}}

        pair_row = pair_top.loc[selected["attempt_id"]]
        pair_index = base_index
        pair_probability = np.nan
        if identity in pair_best.index:
            pair_record = pair_best.loc[identity]
            pair_probability = float(
                pair_record["alternative_better_probability"]
            )
            if bool(pair_row.get("pair_location_override", False)):
                pair_index = int(pair_record["alternative_index"])
        indices.setdefault(pair_index, set()).add("pair")

        meta_year = meta_top.loc[
            selected["attempt_id"], "selected_candidate_year"
        ]
        meta_candidates = group[group["candidate_year"].eq(meta_year)]
        meta_index = int((
            meta_candidates if not meta_candidates.empty else group
        )["location_meta_percentile"].idxmax())
        indices.setdefault(meta_index, set()).add("meta")

        operation = operation_scores.loc[identity]
        sorted_operation = operation_scores[
            operation_scores["attempt_id"].eq(selected["attempt_id"])
        ]["operation_rank_percentile"].sort_values(ascending=False)
        operation_margin = (
            float(sorted_operation.iloc[0] - sorted_operation.iloc[1])
            if len(sorted_operation) > 1 else 1.0
        )
        for index, roles in indices.items():
            row = locations.loc[index].copy()
            candidate_year = float(row["candidate_year"])
            row["proposal_is_base"] = int("base" in roles)
            row["proposal_is_pair"] = int("pair" in roles)
            row["proposal_is_meta"] = int("meta" in roles)
            row["proposal_year_delta_from_base"] = candidate_year - float(base_year)
            row["proposal_year_absolute_delta_from_base"] = abs(
                candidate_year - float(base_year)
            )
            row["pair_alternative_probability"] = pair_probability
            row["operation_rank_percentile"] = operation[
                "operation_rank_percentile"
            ]
            row["operation_classifier_percentile"] = operation[
                "operation_classifier_percentile"
            ]
            row["operation_score_margin"] = operation_margin
            proposal_rows.append(row)
            proposal_metadata.append({
                "attempt_id": selected["attempt_id"],
                "identity_group": identity,
                "cluster_id": selected["cluster_id"],
                "file_id": selected["file_id"],
                "family": selected["family"],
                "event_type": selected["event_type"],
                "shift_years": int(selected["shift_years"]),
                "candidate_index": index,
                "candidate_year": candidate_year,
                "operation_correct": int(selected["operation_correct"]),
                "location_correct": int(row["location_correct"]),
                "final_correct": int(
                    bool(selected["operation_correct"])
                    and bool(row["location_correct"])
                ),
            })

    proposals = pd.DataFrame(proposal_rows).reset_index(drop=True)
    metadata = pd.DataFrame(proposal_metadata).reset_index(drop=True)
    values, feature_names = candidate_features(proposals)
    files = np.array(sorted(metadata["cluster_id"].unique()))
    splitter = GroupKFold(n_splits=5)
    predictions = np.full(len(metadata), np.nan)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(files)), groups=files
    )):
        held_files = set(files[test_file_indices])
        train = metadata.index[
            ~metadata["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        test = metadata.index[
            metadata["cluster_id"].isin(held_files)
        ].to_numpy(dtype=int)
        ordered = metadata.loc[train].sort_values(
            "attempt_id"
        ).index.to_numpy(dtype=int)
        groups = metadata.loc[ordered].groupby(
            "attempt_id", sort=False
        ).size().to_numpy()
        estimator = model(94000 + fold)
        estimator.fit(
            values.loc[ordered],
            metadata.loc[ordered, "final_correct"],
            group=groups,
        )
        predictions[test] = estimator.predict(values.loc[test])
    if np.isnan(predictions).any():
        raise RuntimeError("missing proposal selector OOF predictions")
    metadata["proposal_score"] = predictions
    top = metadata.sort_values(
        ["attempt_id", "proposal_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).set_index("attempt_id")

    selected = base.copy().set_index("attempt_id")
    local_attempts = selected.index.intersection(top.index)
    selected.loc[local_attempts, "final_correct"] = top.loc[
        local_attempts, "final_correct"
    ].astype(int)
    selected.loc[local_attempts, "selected_candidate_year"] = top.loc[
        local_attempts, "candidate_year"
    ]
    selected = selected.reset_index()
    event = selected[selected["family"] != "Clean"]
    clean = selected[selected["family"] == "Clean"]
    baseline = base[base["family"] != "Clean"].set_index("attempt_id")
    final = event.set_index("attempt_id")
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "accuracy": float(group["final_correct"].mean()),
        }
        for family, group in event.groupby("family")
    }
    summary = {
        "schemaVersion": 1,
        "files": int(metadata["cluster_id"].nunique()),
        "proposalRows": len(metadata),
        "features": len(feature_names),
        "candidateOracleCorrect": int(
            metadata.groupby("attempt_id")["final_correct"].max().sum()
        ) + int(event[~event["event_type"].isin(LOCAL_EVENT_TYPES)][
            "final_correct"
        ].sum()),
        "baselineCorrect": int(baseline["final_correct"].sum()),
        "standaloneCorrect": int(event["final_correct"].sum()),
        "standaloneAccuracy": float(event["final_correct"].mean()),
        "wrongToCorrect": int((
            baseline["final_correct"].eq(0) & final["final_correct"].eq(1)
        ).sum()),
        "correctToWrong": int((
            baseline["final_correct"].eq(1) & final["final_correct"].eq(0)
        ).sum()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "byFamily": by_family,
    }
    metadata.to_pickle(output_dir / "proposal-selector-oof-scores.pkl")
    selected.to_csv(output_dir / "standalone-proposal-selector-top.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
