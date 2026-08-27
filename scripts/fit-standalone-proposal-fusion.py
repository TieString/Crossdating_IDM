#!/usr/bin/env python3
"""Fit the frozen direct proposal scorer and predict a target set."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parent
FUSION = load_module(
    "fit_proposal_fusion_trainer",
    ROOT / "train-standalone-proposal-fusion.py",
)


def target_feature_frame(
    proposals: pd.DataFrame,
    base_location_path: Path,
    pair_location_path: Path,
    profile_location_path: Path,
    base_weights: dict[str, float],
) -> pd.DataFrame:
    locations = pd.read_pickle(base_location_path)
    locations = locations[
        locations["event_type"].isin(FUSION.LOCAL_EVENT_TYPES)
    ].copy()
    locations["frozen_base_score"] = FUSION.base_location_score(
        locations, base_weights
    )
    location_columns = FUSION.location_feature_columns(locations)
    matched = FUSION.match_location_rows(
        proposals,
        locations[FUSION.unique_columns([
            "identity_group", "candidate_source", "candidate_year",
            "frozen_base_score", *location_columns,
        ])],
    )
    matched_columns = [f"base_{column}" for column in location_columns]
    matched = matched.rename(columns={
        column: f"base_{column}" for column in location_columns
    })
    pair_features = FUSION.attach_pair_scores(
        proposals, pd.read_pickle(pair_location_path)
    )
    profile_features = FUSION.attach_profile_scores(
        proposals, pd.read_pickle(profile_location_path)
    )
    return pd.concat([
        proposals[[
            "proposal_role", "event_type", "shift_years", "proposal_count",
            "proposal_unique_year_count",
            "proposal_signed_distance_from_median",
            "proposal_absolute_distance_from_median",
            "proposal_distance_from_oldest", "proposal_distance_from_newest",
            "proposal_recency_rank", "proposal_support_within_0",
            "proposal_support_within_1", "proposal_support_within_2",
            "proposal_support_within_4", "proposal_support_within_6",
        ]].reset_index(drop=True),
        matched[matched_columns + [
            "matched_base_exact_source", "matched_base_exact_year",
            "matched_base_year_distance",
        ]].reset_index(drop=True),
        pair_features.reset_index(drop=True),
        profile_features.reset_index(drop=True),
    ], axis=1)


def proposal_margins(proposals: pd.DataFrame) -> pd.Series:
    ordered = proposals.sort_values(
        ["attempt_id", "proposal_score"], ascending=[True, False]
    )
    rank = ordered.groupby("attempt_id", sort=False).cumcount()
    first = ordered[rank.eq(0)].set_index("attempt_id")["proposal_score"]
    second = ordered[rank.eq(1)].set_index("attempt_id")["proposal_score"]
    return first - second.reindex(first.index).fillna(0)


def apply_top(base: pd.DataFrame, top: pd.DataFrame) -> pd.DataFrame:
    selected = base.copy().set_index("attempt_id")
    if "final_strict_correct" not in selected:
        selected["final_strict_correct"] = (
            selected["strict_correct"]
            if "strict_correct" in selected
            else selected["final_correct"]
        )
    top = top.set_index("attempt_id")
    attempts = selected.index.intersection(top.index)
    selected.loc[attempts, "final_correct"] = top.loc[
        attempts, "proposal_correct"
    ].astype(int)
    selected.loc[attempts, "final_strict_correct"] = top.loc[
        attempts, "proposal_strict_correct"
    ].astype(int)
    selected.loc[attempts, "operation_correct"] = top.loc[
        attempts, "operation_correct"
    ].astype(int)
    selected.loc[attempts, "selected_candidate_year"] = top.loc[
        attempts, "candidate_year"
    ]
    selected.loc[attempts, "selected_candidate_source"] = top.loc[
        attempts, "proposal_role"
    ].map({
        "base": "unifiedBaseProposal",
        "pair": "unifiedPairProposal",
        "profile": "unifiedFullYearProposal",
    })
    selected.loc[attempts, "selected_proposal_role"] = top.loc[
        attempts, "proposal_role"
    ]
    selected.loc[attempts, "proposal_probability"] = top.loc[
        attempts, "proposal_score"
    ]
    return selected.reset_index()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-feature-table", required=True)
    parser.add_argument("--development-model-dir", required=True)
    parser.add_argument("--base-top", required=True)
    parser.add_argument("--pair-top", required=True)
    parser.add_argument("--profile-top", required=True)
    parser.add_argument("--base-location-scores", required=True)
    parser.add_argument("--pair-location-scores", required=True)
    parser.add_argument("--profile-location-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development_model_dir = Path(args.development_model_dir).resolve()
    frozen = json.loads(
        (development_model_dir / "summary.json").read_text(encoding="utf8")
    )
    if frozen["modelType"] != "classifier":
        raise RuntimeError("frozen proposal fusion is not a classifier")
    feature_names = json.loads(
        (development_model_dir / "feature-names.json").read_text(encoding="utf8")
    )
    development = pd.read_pickle(Path(args.development_feature_table).resolve())
    training_values = development[
        [f"feature__{column}" for column in feature_names]
    ].copy()
    training_values.columns = feature_names

    base_path = Path(args.base_top).resolve()
    base = pd.read_csv(base_path)
    pair = pd.read_csv(Path(args.pair_top).resolve())
    profile = pd.read_csv(Path(args.profile_top).resolve())
    proposals = FUSION.append_agreement_features(
        FUSION.proposal_rows(base, pair, profile)
    )
    base_summary = json.loads(
        (base_path.parent / "summary.json").read_text(encoding="utf8")
    )
    raw_target = target_feature_frame(
        proposals,
        Path(args.base_location_scores).resolve(),
        Path(args.pair_location_scores).resolve(),
        Path(args.profile_location_scores).resolve(),
        base_summary["weights"],
    )
    target_values, _ = FUSION.encode(raw_target)
    target_values = target_values.reindex(columns=feature_names, fill_value=0)
    target_values = target_values.replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0).astype(np.float32)

    model = FUSION.classifier(int(frozen["seedBase"]))
    model.fit(
        training_values,
        development["proposal_correct"],
        sample_weight=FUSION.proposal_sample_weights(development),
    )
    proposals["proposal_score"] = model.predict_proba(target_values)[:, 1]
    margins = proposal_margins(proposals)
    top = proposals.sort_values(
        ["attempt_id", "proposal_score"], ascending=[True, False]
    ).groupby("attempt_id", sort=False).head(1).copy()
    top["proposal_margin"] = top["attempt_id"].map(margins)
    selected = apply_top(base, top)
    event = selected[selected["family"].ne("Clean")].copy()
    clean = selected[selected["family"].eq("Clean")].copy()
    baseline = base[base["family"].ne("Clean")].set_index("attempt_id")
    final = event.set_index("attempt_id")
    local_oracle = int(
        proposals.groupby("attempt_id")["proposal_correct"].max().sum()
    )
    nonlocal_correct = int(event[
        ~event["event_type"].isin(FUSION.LOCAL_EVENT_TYPES)
    ]["final_correct"].sum())
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictAccuracy": float(group["final_strict_correct"].mean()),
            "operationAccuracy": float(group["operation_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": FUSION.clustered_lower(
                group, 139000 + ord(family[0]), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family", sort=True)
    }
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "standalone_unified_proposal_fit_predict",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "targetFiles": int(proposals["cluster_id"].nunique()),
        "eventAttempts": len(event),
        "proposalRows": len(proposals),
        "features": len(feature_names),
        "modelType": "classifier",
        "seedBase": int(frozen["seedBase"]),
        "candidateOracleCorrect": local_oracle + nonlocal_correct,
        "baselineCorrect": int(baseline["final_correct"].sum()),
        "workflowCorrect": int(event["final_correct"].sum()),
        "workflowAccuracy": float(event["final_correct"].mean()),
        "strictAccuracy": float(event["final_strict_correct"].mean()),
        "operationAccuracy": float(event["operation_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "overallOneSided95FileClusterLower": FUSION.clustered_lower(
            event, 139999, args.bootstrap_repetitions
        ),
        "wrongToCorrect": int((
            baseline["final_correct"].eq(0) & final["final_correct"].eq(1)
        ).sum()),
        "correctToWrong": int((
            baseline["final_correct"].eq(1) & final["final_correct"].eq(0)
        ).sum()),
        "selectedRoles": top["proposal_role"].value_counts().to_dict(),
        "byFamily": by_family,
    }
    (output_dir / "proposal-classifier.txt").write_text(
        model.booster_.model_to_string(), encoding="utf8"
    )
    proposals.to_pickle(output_dir / "target-proposal-fusion-scores.pkl")
    top.to_csv(output_dir / "target-proposal-top.csv", index=False)
    selected.to_csv(output_dir / "target-standalone-proposal-top.csv", index=False)
    event.to_csv(output_dir / "target-event-evaluation.csv", index=False)
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
