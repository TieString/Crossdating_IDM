#!/usr/bin/env python3
"""Fit the frozen full-year transition-compatible head and predict a target set."""

from __future__ import annotations

import argparse
import gc
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
PROFILE = load_module(
    "fit_full_year_profile_trainer",
    ROOT / "train-standalone-full-year-location-head.py",
)
FIT = load_module(
    "fit_full_year_profile_encoder",
    ROOT / "fit-standalone-hierarchical-package.py",
)


def fit_ranker(
    rows: pd.DataFrame,
    values: pd.DataFrame,
    *,
    mask: pd.Series,
    label: str,
    seed: int,
    graded: bool,
):
    indices = rows.index[mask].to_numpy(dtype=int)
    ordered = rows.loc[indices].sort_values("identity_group").index.to_numpy(
        dtype=int
    )
    groups = rows.loc[ordered].groupby(
        "identity_group", sort=False
    ).size().to_numpy()
    model = PROFILE.ranker(seed, graded=graded)
    model.fit(values.loc[ordered], rows.loc[ordered, label], group=groups)
    return model


def fit_predict(
    development: pd.DataFrame,
    target: pd.DataFrame,
    output_dir: Path,
) -> tuple[pd.DataFrame, list[str]]:
    columns = [column for column in development if column not in PROFILE.LABEL_COLUMNS]
    train_values, target_values, feature_names = FIT.encode_train_target(
        development, target, columns
    )
    train_mask = development["selected_operation_correct"].eq(1)
    target["location_binary_global_score"] = np.nan
    target["location_binary_typed_score"] = np.nan
    target["location_graded_global_score"] = np.nan
    target["location_graded_typed_score"] = np.nan
    for graded_index, graded in enumerate((False, True)):
        label = "location_relevance" if graded else "window_correct"
        name = "graded" if graded else "binary"
        global_model = fit_ranker(
            development,
            train_values,
            mask=train_mask,
            label=label,
            seed=136000 + graded_index,
            graded=graded,
        )
        target[f"location_{name}_global_score"] = global_model.predict(
            target_values
        )
        (output_dir / f"location-{name}-global-ranker.txt").write_text(
            global_model.booster_.model_to_string(), encoding="utf8"
        )
        for event_index, event_type in enumerate(sorted(PROFILE.LOCAL_EVENT_TYPES)):
            typed_mask = train_mask & development["event_type"].eq(event_type)
            model = fit_ranker(
                development,
                train_values,
                mask=typed_mask,
                label=label,
                seed=136500 + graded_index * 10 + event_index,
                graded=graded,
            )
            target_indices = target.index[
                target["event_type"].eq(event_type)
            ].to_numpy(dtype=int)
            target.loc[
                target_indices, f"location_{name}_typed_score"
            ] = model.predict(target_values.loc[target_indices])
            (output_dir / f"location-{name}-{event_type}-ranker.txt").write_text(
                model.booster_.model_to_string(), encoding="utf8"
            )
    score_columns = [
        "location_binary_global_score",
        "location_binary_typed_score",
        "location_graded_global_score",
        "location_graded_typed_score",
    ]
    if target[score_columns].isna().any().any():
        raise RuntimeError("missing target full-year predictions")
    grouped = target.groupby("identity_group", sort=False)
    for column in score_columns:
        target[f"{column}_percentile"] = grouped[column].rank(pct=True)
    del train_values, target_values
    gc.collect()
    return target, feature_names


def select_target(
    operation_top: pd.DataFrame,
    rows: pd.DataFrame,
    weights: dict[str, float],
) -> pd.DataFrame:
    typed_weight = float(weights["typed"])
    graded_weight = float(weights["graded"])
    binary = (
        rows["location_binary_global_score_percentile"] * (1 - typed_weight)
        + rows["location_binary_typed_score_percentile"] * typed_weight
    )
    graded = (
        rows["location_graded_global_score_percentile"] * (1 - typed_weight)
        + rows["location_graded_typed_score_percentile"] * typed_weight
    )
    location_score = binary * (1 - graded_weight) + graded * graded_weight
    location_top = rows.assign(location_score=location_score).sort_values(
        ["identity_group", "location_score"], ascending=[True, False]
    ).groupby("identity_group", sort=False).head(1).set_index("identity_group")
    selected = operation_top.copy()
    local = selected["event_type"].isin(PROFILE.LOCAL_EVENT_TYPES)
    for output, source in (
        ("location_correct", "window_correct"),
        ("selected_candidate_year", "year"),
        ("selected_package_strict_correct", "strict_correct"),
    ):
        selected[output] = selected["identity_group"].map(location_top[source])
    selected.loc[local, "selected_candidate_source"] = "fullYearProfile"
    selected["final_correct"] = selected["operation_correct"].astype(int)
    selected.loc[local, "final_correct"] = (
        selected.loc[local, "operation_correct"].astype(bool)
        & selected.loc[local, "location_correct"].fillna(0).astype(bool)
    ).astype(int)
    selected["final_strict_correct"] = selected["operation_correct"].astype(int)
    selected.loc[local, "final_strict_correct"] = selected.loc[
        local, "selected_package_strict_correct"
    ].fillna(0).astype(int)
    selected["candidate_has_response"] = selected["event_type"].ne(
        "noEvent"
    ).astype(int)
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--development-row-cache", action="append", required=True)
    parser.add_argument("--development-candidate-table", action="append", required=True)
    parser.add_argument("--development-operation-top", required=True)
    parser.add_argument("--development-profile-dir", required=True)
    parser.add_argument("--target-row-cache", required=True)
    parser.add_argument("--target-candidate-table", required=True)
    parser.add_argument("--target-operation-top", required=True)
    parser.add_argument("--target-dataset-id", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--search-radius", type=int, default=20)
    parser.add_argument("--bootstrap-repetitions", type=int, default=5000)
    args = parser.parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    development_profile_dir = Path(args.development_profile_dir).resolve()
    frozen = json.loads(
        (development_profile_dir / "summary.json").read_text(encoding="utf8")
    )
    development_top = pd.read_csv(
        Path(args.development_operation_top).resolve()
    )
    development_modes = PROFILE.load_candidate_modes(
        args.development_candidate_table
    )
    development = PROFILE.add_shape_features(PROFILE.load_selected_rows(
        args.development_row_cache,
        development_top,
        development_modes,
        max(6, args.search_radius),
        True,
    ))
    target_top = pd.read_csv(Path(args.target_operation_top).resolve())
    target_modes = PROFILE.load_candidate_modes([args.target_candidate_table])
    target = PROFILE.add_shape_features(PROFILE.load_selected_rows(
        [f"{args.target_dataset_id}={Path(args.target_row_cache).resolve()}"],
        target_top,
        target_modes,
        max(6, args.search_radius),
        True,
    ))
    target, feature_names = fit_predict(development, target, output_dir)
    del development
    gc.collect()
    selected = select_target(target_top, target, frozen["weights"])
    event = selected[selected["family"].ne("Clean")].copy()
    clean = selected[selected["family"].eq("Clean")].copy()
    baseline = target_top.set_index("attempt_id")
    compared = event.set_index("attempt_id")
    shared = baseline.index.intersection(compared.index)
    before = baseline.loc[shared, "final_correct"].astype(int)
    after = compared.loc[shared, "final_correct"].astype(int)
    by_family = {
        family: {
            "correct": int(group["final_correct"].sum()),
            "events": len(group),
            "workflowAccuracy": float(group["final_correct"].mean()),
            "strictAccuracy": float(group["final_strict_correct"].mean()),
            "responseRate": float(group["candidate_has_response"].mean()),
            "oneSided95FileClusterLower": PROFILE.clustered_lower(
                group, 137000 + ord(family[0]), args.bootstrap_repetitions
            ),
        }
        for family, group in event.groupby("family", sort=True)
    }
    score_columns = [
        "location_binary_global_score",
        "location_binary_typed_score",
        "location_graded_global_score",
        "location_graded_typed_score",
    ]
    summary = {
        "schemaVersion": 1,
        "selectionPolicy": "standalone_full_year_fit_predict",
        "truthAwareRuntimeSwitches": 0,
        "legacyFallbacks": 0,
        "targetFiles": int(selected["cluster_id"].nunique()),
        "yearRows": len(target),
        "locationFeatures": len(feature_names),
        "searchRadius": max(6, args.search_radius),
        "weights": frozen["weights"],
        "eventAttempts": len(event),
        "cleanAttempts": len(clean),
        "workflowCorrect": int(event["final_correct"].sum()),
        "workflowAccuracy": float(event["final_correct"].mean()),
        "strictAccuracy": float(event["final_strict_correct"].mean()),
        "responseRate": float(event["candidate_has_response"].mean()),
        "refusalRate": float(1 - event["candidate_has_response"].mean()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "correctToWrong": int((before.eq(1) & after.eq(0)).sum()),
        "wrongToCorrect": int((before.eq(0) & after.eq(1)).sum()),
        "overallOneSided95FileClusterLower": PROFILE.clustered_lower(
            event, 137999, args.bootstrap_repetitions
        ),
        "byFamily": by_family,
    }
    target[[
        "attempt_id", "identity_group", "cluster_id", "file_id", "family",
        "event_type", "shift_years", "year", "window_correct", "strict_correct",
        "location_relevance", "location_error_years", *score_columns,
        *[f"{column}_percentile" for column in score_columns],
    ]].to_pickle(output_dir / "target-full-year-location-scores.pkl")
    selected.to_csv(output_dir / "target-standalone-full-year-top.csv", index=False)
    event.to_csv(output_dir / "target-event-evaluation.csv", index=False)
    (output_dir / "feature-names.json").write_text(
        json.dumps(feature_names, indent=2) + "\n", encoding="utf8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"outputDir": str(output_dir), **summary}))


if __name__ == "__main__":
    main()
