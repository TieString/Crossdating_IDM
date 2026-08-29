#!/usr/bin/env python3
"""Fuse frozen and OOF location views inside an immutable operation identity."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


LOCAL_EVENT_TYPES = {"missingRing", "falseRing", "partialMove"}
FROZEN_VIEWS = (
    "location_global_score",
    "location_typed_score",
    "location_global_classifier_probability",
    "location_typed_classifier_probability",
    "location_meta_score",
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


def select_final(
    operation_top: pd.DataFrame,
    packages: pd.DataFrame,
    score: pd.Series,
) -> pd.DataFrame:
    location_top = (
        packages.assign(_score=score)
        .sort_values(["identity_group", "_score"], ascending=[True, False])
        .groupby("identity_group", sort=False)
        .head(1)
        .set_index("identity_group")
    )
    selected = operation_top.copy()
    local = selected["event_type"].isin(LOCAL_EVENT_TYPES)
    selected["final_correct"] = selected["identity_workflow_correct"].astype(
        np.int8
    )
    selected["final_strict_correct"] = selected["operation_correct"].astype(
        np.int8
    )
    selected.loc[local, "final_correct"] = selected.loc[
        local, "identity_group"
    ].map(location_top["workflow_correct"]).fillna(0).astype(np.int8)
    selected.loc[local, "final_strict_correct"] = selected.loc[
        local, "identity_group"
    ].map(location_top["strict_correct"]).fillna(0).astype(np.int8)
    selected.loc[local, "selected_candidate_year"] = selected.loc[
        local, "identity_group"
    ].map(location_top["candidate_year"])
    return selected


def select_mode_final(
    operation_top: pd.DataFrame,
    packages: pd.DataFrame,
    ranks: pd.DataFrame,
    *,
    aggregation: str,
    support_weight: float,
) -> pd.DataFrame:
    valid = packages["candidate_year"].notna()
    ranked = packages.loc[valid, [
        "identity_group",
        "candidate_year",
        "candidate_source",
    ]].copy()
    view_columns = [f"_view_{index}" for index in range(ranks.shape[1])]
    ranked[view_columns] = ranks.loc[valid].to_numpy(dtype=np.float32)
    mode = ranked.groupby(
        ["identity_group", "candidate_year"], sort=False
    ).agg(
        **{
            column: (column, aggregation)
            for column in view_columns
        },
        source_count=("candidate_source", "nunique"),
    ).reset_index()
    mode["view_consensus"] = mode[view_columns].mean(axis=1)
    mode["support_percentile"] = mode.groupby(
        "identity_group", sort=False
    )["source_count"].rank(pct=True)
    mode["mode_score"] = mode["view_consensus"].mul(1 - support_weight).add(
        mode["support_percentile"].mul(support_weight)
    )
    selected_mode = (
        mode.sort_values(
            ["identity_group", "mode_score"], ascending=[True, False]
        )
        .groupby("identity_group", sort=False)
        .head(1)
        .set_index("identity_group")["candidate_year"]
    )
    chosen_year = packages["identity_group"].map(selected_mode)
    in_mode = packages["candidate_year"].eq(chosen_year)
    package_consensus = ranks.mean(axis=1).where(in_mode, -np.inf)
    return select_final(operation_top, packages, package_consensus)


def summarize(selected: pd.DataFrame) -> dict:
    event = selected[selected["family"].ne("Clean")]
    return {
        "correct": int(event["final_correct"].sum()),
        "events": len(event),
        "accuracy": float(event["final_correct"].mean()),
        "strictCorrect": int(event["final_strict_correct"].sum()),
        "identityOracleCorrect": int(event["identity_workflow_correct"].sum()),
        "byFamily": {
            str(family): {
                "correct": int(group["final_correct"].sum()),
                "events": len(group),
                "accuracy": float(group["final_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--location-packages", required=True)
    parser.add_argument("--operation-top", required=True)
    parser.add_argument("--oof-scores", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    operation_top = ensure_identity_group(pd.read_csv(args.operation_top))
    packages = ensure_identity_group(pd.read_pickle(args.location_packages))
    packages = packages[packages["event_type"].isin(LOCAL_EVENT_TYPES)].copy()
    identity_oracle = packages.groupby("identity_group", sort=False)[
        "workflow_correct"
    ].transform("max")
    selected_identities = set(
        operation_top.loc[
            operation_top["event_type"].isin(LOCAL_EVENT_TYPES), "identity_group"
        ]
    )
    packages = packages.loc[
        identity_oracle.eq(1) | packages["identity_group"].isin(selected_identities)
    ].reset_index(drop=True)
    oof = pd.read_pickle(args.oof_scores).reset_index(drop=True)
    if len(oof) != len(packages) or not oof["identity_group"].equals(
        packages["identity_group"]
    ):
        raise RuntimeError("location OOF rows do not match frozen packages")
    packages["oof_listwise"] = oof["listwise_oof_score"].to_numpy()
    packages["oof_pair"] = oof["pair_oof_score"].to_numpy()
    available = [column for column in FROZEN_VIEWS if column in packages]
    available.extend(("oof_listwise", "oof_pair"))
    ranks = pd.concat(
        [
            pd.to_numeric(packages[column], errors="coerce")
            .groupby(packages["identity_group"], sort=False)
            .rank(pct=True, method="average")
            .rename(column)
            for column in available
        ],
        axis=1,
    ).fillna(0.0)
    top_votes = ranks.eq(1.0).mean(axis=1)
    scores = {
        "view_mean": ranks.mean(axis=1),
        "view_median": ranks.median(axis=1),
        "mean_vote25": ranks.mean(axis=1).mul(0.75).add(top_votes.mul(0.25)),
        "median_vote25": ranks.median(axis=1).mul(0.75).add(top_votes.mul(0.25)),
    }
    selected_packages = packages[packages["identity_group"].isin(selected_identities)]
    grid_rows = []
    selections = {}
    for name, score in scores.items():
        selected = select_final(
            operation_top,
            selected_packages,
            score.loc[selected_packages.index],
        )
        result = summarize(selected)
        grid_rows.append({
            "view": name,
            "correct": result["correct"],
            "strictCorrect": result["strictCorrect"],
            "minimumFamilyAccuracy": min(
                value["accuracy"] for value in result["byFamily"].values()
            ),
        })
        selections[name] = selected
    for aggregation in ("max", "mean"):
        for support_weight in (0.0, 0.1, 0.2):
            name = f"mode_{aggregation}_support{int(support_weight * 100)}"
            selected = select_mode_final(
                operation_top,
                selected_packages,
                ranks.loc[selected_packages.index],
                aggregation=aggregation,
                support_weight=support_weight,
            )
            result = summarize(selected)
            grid_rows.append({
                "view": name,
                "correct": result["correct"],
                "strictCorrect": result["strictCorrect"],
                "minimumFamilyAccuracy": min(
                    value["accuracy"] for value in result["byFamily"].values()
                ),
            })
            selections[name] = selected
    grid = pd.DataFrame(grid_rows).sort_values(
        ["correct", "minimumFamilyAccuracy", "strictCorrect"],
        ascending=[False, False, False],
    )
    best_view = str(grid.iloc[0]["view"])
    best = selections[best_view]
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "candidateGeneratorFrozen": True,
        "operationIdentityImmutable": True,
        "trainingCalls": 0,
        "views": available,
        "bestView": best_view,
        "best": summarize(best),
    }
    grid.to_csv(output / "consensus-grid.csv", index=False)
    best.to_csv(output / "best-top.csv", index=False)
    (output / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"outputDir": str(output), **payload}, ensure_ascii=False))


if __name__ == "__main__":
    main()
