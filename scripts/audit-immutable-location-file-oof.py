#!/usr/bin/env python3
"""File-OOF same-identity location adjudication over frozen window packages."""

from __future__ import annotations

import argparse
import gc
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from immutable_two_stage_adjudicator import (  # noqa: E402
    build_pair_training,
    fit_ranker,
    make_feature_spec,
    pair_classifier,
    pair_tournament_scores,
    project_relative_features,
    ranker,
    select_top,
    sha256,
    within_group_percentile,
)


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
LOCATION_PREFERRED = (
    "location_meta_percentile",
    "location_global_percentile",
    "location_typed_percentile",
    "location_global_classifier_percentile",
    "location_typed_classifier_percentile",
    "location_global_score",
    "location_typed_score",
    "location_global_classifier_probability",
    "location_typed_classifier_probability",
    "geometry_rank_from_oldest",
    "geometry_rank_from_newest",
    "geometry_relative_recency",
    "geometry_gap_to_older_mode",
    "geometry_gap_to_newer_mode",
    "evidence_referenceChange_supportFraction",
    "evidence_referenceTransition_weightedWindowVote25",
    "evidence_perReference_positiveDifferenceGainFraction",
    "evidence_perReference_positiveWhitenedGainFraction",
)
LOCATION_SEED = (
    "location_meta_percentile",
    "location_global_percentile",
    "location_typed_percentile",
    "location_global_classifier_percentile",
    "location_typed_classifier_percentile",
)


def ensure_identity_group(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    if "identity_group" not in output:
        output["identity_group"] = (
            output["attempt_id"].astype(str)
            + "|"
            + output["event_type"].astype(str)
            + "|"
            + output["shift_years"].astype(int).astype(str)
        )
    return output


def normalize_attempt(value: object) -> str:
    text = str(value)
    marker = "evaluation:"
    index = text.find(marker)
    return text[index:] if index >= 0 else text


def seed_percentile(frame: pd.DataFrame) -> pd.Series:
    available = [column for column in LOCATION_SEED if column in frame]
    ranks = [
        pd.to_numeric(frame[column], errors="coerce")
        .groupby(frame["identity_group"], sort=False)
        .rank(pct=True)
        for column in available
    ]
    if not ranks:
        return frame.groupby("identity_group", sort=False).cumcount().mul(0.0)
    return pd.concat(ranks, axis=1).mean(axis=1).fillna(0.0)


def project_final(
    operation_top: pd.DataFrame,
    packages: pd.DataFrame,
    package_score: pd.Series,
) -> pd.DataFrame:
    selected = operation_top.copy()
    location_top = select_top(packages, package_score, "identity_group")
    lookup = location_top.set_index("identity_group")
    local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    selected["final_correct"] = selected["identity_workflow_correct"].astype(
        np.int8
    )
    selected["final_strict_correct"] = selected["operation_correct"].astype(
        np.int8
    )
    selected["location_correct"] = np.nan
    selected.loc[local, "location_correct"] = selected.loc[
        local, "identity_group"
    ].map(lookup["location_correct"])
    selected.loc[local, "final_correct"] = selected.loc[
        local, "identity_group"
    ].map(lookup["workflow_correct"]).fillna(0).astype(np.int8)
    selected.loc[local, "final_strict_correct"] = selected.loc[
        local, "identity_group"
    ].map(lookup["strict_correct"]).fillna(0).astype(np.int8)
    selected.loc[local, "selected_candidate_year"] = selected.loc[
        local, "identity_group"
    ].map(lookup["candidate_year"])
    selected.loc[local, "selected_candidate_source"] = selected.loc[
        local, "identity_group"
    ].map(lookup["candidate_source"])
    return selected


def summarize(selected: pd.DataFrame) -> dict:
    event = selected[selected["family"].ne("Clean")]
    clean = selected[selected["family"].eq("Clean")]
    return {
        "correct": int(event["final_correct"].sum()),
        "events": len(event),
        "accuracy": float(event["final_correct"].mean()),
        "strictCorrect": int(event["final_strict_correct"].sum()),
        "strictAccuracy": float(event["final_strict_correct"].mean()),
        "identityOracleCorrect": int(event["identity_workflow_correct"].sum()),
        "locationFailuresAfterCorrectIdentity": int(
            event["identity_workflow_correct"].sum()
            - event["final_correct"].sum()
        ),
        "cleanFalsePositives": int(clean["event_type"].ne("noEvent").sum()),
        "byFamily": {
            str(family): {
                "correct": int(group["final_correct"].sum()),
                "events": len(group),
                "accuracy": float(group["final_correct"].mean()),
                "strictAccuracy": float(group["final_strict_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-packages", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--maximum-numeric", type=int, default=192)
    parser.add_argument("--outer-splits", type=int, default=5)
    parser.add_argument("--per-operation-type", action="store_true")
    parser.add_argument("--event-attempts")
    parser.add_argument("--condition-correlation", action="store_true")
    parser.add_argument("--graded-location", action="store_true")
    args = parser.parse_args()

    package_path = Path(args.location_packages).resolve()
    operation_path = Path(args.operation_top).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    operation_top = ensure_identity_group(pd.read_csv(operation_path))
    packages = ensure_identity_group(pd.read_pickle(package_path))
    packages = packages[packages["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    identity_oracle = packages.groupby("identity_group", sort=False)[
        "workflow_correct"
    ].transform("max").astype(np.int8)
    packages["identity_workflow_oracle"] = identity_oracle
    selected_identities = set(
        operation_top.loc[
            operation_top["event_type"].isin(LOCAL_EVENT_TYPES), "identity_group"
        ]
    )
    packages = packages.loc[
        identity_oracle.eq(1) | packages["identity_group"].isin(selected_identities)
    ].reset_index(drop=True)
    if args.condition_correlation:
        if not args.event_attempts:
            raise RuntimeError("--condition-correlation requires --event-attempts")
        metadata = pd.read_csv(args.event_attempts, usecols=[
            "attempt_id", "target_correlation_bin"
        ])
        correlation_by_attempt = metadata.set_index(
            metadata["attempt_id"].map(normalize_attempt)
        )["target_correlation_bin"]
        packages["correlation_band"] = packages["attempt_id"].map(
            lambda value: correlation_by_attempt.get(normalize_attempt(value), "missing")
        )
        if packages["correlation_band"].eq("missing").any():
            raise RuntimeError("target correlation metadata is incomplete")
    gc.collect()

    if "identity_workflow_correct" not in operation_top:
        oracle_by_identity = packages.groupby("identity_group", sort=False)[
            "workflow_correct"
        ].max()
        operation_top["identity_workflow_correct"] = operation_top[
            "identity_group"
        ].map(oracle_by_identity).fillna(operation_top["operation_correct"]).astype(
            np.int8
        )

    listwise_predictions = np.full(len(packages), np.nan, dtype=np.float32)
    pair_predictions = np.full(len(packages), np.nan, dtype=np.float32)
    selected_mask = packages["identity_group"].isin(selected_identities)
    splitter = GroupKFold(
        n_splits=min(args.outer_splits, packages["file_id"].nunique())
    )
    feature_counts: list[int] = []
    for fold, (outer_train_index, outer_test_index) in enumerate(
        splitter.split(packages, groups=packages["file_id"])
    ):
        outer_train_index = np.asarray(outer_train_index, dtype=int)
        outer_test_index = np.asarray(outer_test_index, dtype=int)
        event_types = (
            sorted(LOCAL_EVENT_TYPES)
            if args.per_operation_type
            else [None]
        )
        correlation_bands = (
            sorted(packages["correlation_band"].unique())
            if args.condition_correlation
            else [None]
        )
        conditions = [
            (event_type, correlation_band)
            for event_type in event_types
            for correlation_band in correlation_bands
        ]
        for type_offset, (event_type, correlation_band) in enumerate(conditions):
            train_index = outer_train_index[
                packages.loc[outer_train_index, "identity_workflow_oracle"]
                .eq(1)
                .to_numpy()
            ]
            test_index = outer_test_index
            if event_type is not None:
                train_index = train_index[
                    packages.loc[train_index, "event_type"].eq(event_type).to_numpy()
                ]
                test_index = test_index[
                    packages.loc[test_index, "event_type"].eq(event_type).to_numpy()
                ]
            if correlation_band is not None:
                train_index = train_index[
                    packages.loc[train_index, "correlation_band"]
                    .eq(correlation_band)
                    .to_numpy()
                ]
                test_index = test_index[
                    packages.loc[test_index, "correlation_band"]
                    .eq(correlation_band)
                    .to_numpy()
                ]
            spec = make_feature_spec(
                packages.loc[train_index],
                group_column="identity_group",
                maximum_numeric=max(32, args.maximum_numeric),
                categorical_columns=("event_type", "candidate_source"),
                preferred_numeric=LOCATION_PREFERRED,
            )
            forbidden = (
                "truth",
                "correct",
                "relevance",
                "error_year",
                "family",
                "file_id",
                "series_id",
                "target_id",
                "case_id",
            )
            forbidden_columns = [
                column
                for column in spec.numeric_columns
                if any(token in column.lower() for token in forbidden)
            ]
            if forbidden_columns:
                raise RuntimeError(
                    "location feature contract admitted forbidden fields: "
                    + ", ".join(forbidden_columns)
                )
            if any(
                column.lower() in {"year", "candidate_year"}
                or column.lower().endswith("_calendar_year")
                for column in spec.numeric_columns
            ):
                raise RuntimeError("location feature contract admitted a calendar year")
            values = project_relative_features(packages, spec)
            feature_counts.append(values.shape[1])
            estimator = fit_ranker(
                ranker(
                    210000 + fold * 10 + type_offset,
                    graded=args.graded_location,
                ),
                packages.loc[train_index].reset_index(drop=True),
                values.loc[train_index].reset_index(drop=True),
                label=(
                    "location_relevance"
                    if args.graded_location
                    else "workflow_correct"
                ),
                group="identity_group",
            )
            listwise_predictions[test_index] = estimator.predict(
                values.loc[test_index]
            )

            train_frame = packages.loc[train_index].reset_index(drop=True)
            train_values = values.loc[train_index].reset_index(drop=True)
            train_seed = seed_percentile(train_frame)
            pair_values, pair_labels = build_pair_training(
                train_frame,
                train_values,
                label="workflow_correct",
                group="identity_group",
                seed_score=train_seed,
                maximum_positives=4,
                maximum_negatives=12,
            )
            pair_estimator = pair_classifier(215000 + fold * 10 + type_offset)
            pair_estimator.fit(pair_values, pair_labels)
            test_frame = packages.loc[test_index].reset_index(drop=True)
            test_values = values.loc[test_index].reset_index(drop=True)
            listwise_percentile = within_group_percentile(
                test_frame,
                listwise_predictions[test_index],
                "identity_group",
            )
            shortlist = listwise_percentile.mul(0.7).add(
                seed_percentile(test_frame).mul(0.3)
            )
            pair_predictions[test_index] = pair_tournament_scores(
                test_frame,
                test_values,
                pair_estimator,
                group="identity_group",
                shortlist_score=shortlist,
                shortlist_size=12,
            )
            del values, estimator, pair_values, pair_labels, pair_estimator
            gc.collect()
        print(json.dumps({"completedOuterFold": fold}), flush=True)

    if np.isnan(listwise_predictions).any() or np.isnan(pair_predictions).any():
        raise RuntimeError("location OOF predictions are incomplete")
    listwise_percentile = within_group_percentile(
        packages, listwise_predictions, "identity_group"
    )
    pair_percentile = within_group_percentile(
        packages, pair_predictions, "identity_group"
    )
    seed = seed_percentile(packages)
    selections: dict[str, pd.DataFrame] = {}
    grid_rows = []
    score_views = {
        "seed": seed,
        "listwise": listwise_percentile,
        "listwise_pair25": listwise_percentile.mul(0.75).add(
            pair_percentile.mul(0.25)
        ),
        "listwise_pair50": listwise_percentile.mul(0.5).add(
            pair_percentile.mul(0.5)
        ),
    }
    selected_packages = packages[selected_mask].copy()
    for name, score in score_views.items():
        selected_score = score.loc[selected_packages.index]
        selected = project_final(operation_top, selected_packages, selected_score)
        result = summarize(selected)
        selections[name] = selected
        grid_rows.append({
            "view": name,
            "correct": result["correct"],
            "strictCorrect": result["strictCorrect"],
            "minimumFamilyAccuracy": min(
                value["accuracy"] for value in result["byFamily"].values()
            ),
            "cleanFalsePositives": result["cleanFalsePositives"],
        })
    grid = pd.DataFrame(grid_rows).sort_values(
        ["correct", "minimumFamilyAccuracy", "strictCorrect"],
        ascending=[False, False, False],
    )
    best_view = str(grid.iloc[0]["view"])
    best = selections[best_view]
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "strictFileOof": True,
        "candidateGeneratorFrozen": True,
        "operationIdentityImmutable": True,
        "locationPackagesSha256": sha256(package_path),
        "operationTopSha256": sha256(operation_path),
        "retainedPackages": len(packages),
        "selectedIdentities": len(selected_identities),
        "maximumNumeric": max(32, args.maximum_numeric),
        "perOperationType": bool(args.per_operation_type),
        "correlationConditioned": bool(args.condition_correlation),
        "gradedLocation": bool(args.graded_location),
        "projectedFeatureCounts": feature_counts,
        "bestView": best_view,
        "best": summarize(best),
    }
    grid.to_csv(output_dir / "location-oof-grid.csv", index=False)
    best.to_csv(output_dir / "best-top.csv", index=False)
    pd.DataFrame({
        "identity_group": packages["identity_group"],
        "listwise_oof_score": listwise_predictions,
        "pair_oof_score": pair_predictions,
    }).to_pickle(output_dir / "candidate-oof-scores.pkl")
    (output_dir / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"outputDir": str(output_dir), **payload}, ensure_ascii=False))


if __name__ == "__main__":
    main()
