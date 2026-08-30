from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).parents[1] / "audit-applied-residual-location-oof.py"
SPEC = importlib.util.spec_from_file_location("residual_location_oof", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_residual_features_remove_absolute_years_and_use_within_identity() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1:1", "run:1:1"],
        "event_type": ["missingRing", "missingRing"],
        "shift_years": [-1, -1],
        "year": [1900, 1901],
        "listwise_score": [0.2, 0.8],
        "pairwise_score": [0.4, 0.6],
        "residual_newerSide_afterTransition_strongestYear": [1910, 1905],
        "residual_newerSide_transitionDelta_strongestNormalizedSplitGain": [
            -0.2, -0.8,
        ],
        "residual_newerSide_transitionDelta_strongestYear": [2, -3],
        "residual_applied": [True, False],
    })
    values = MODULE.residual_features(frame)
    assert not any(column.endswith("strongestYear") for column in values)
    distance = (
        "residual_newerSide_afterTransition_strongestYear"
        "_signed_distance__rank"
    )
    assert distance in values
    assert (
        "residual_newerSide_transitionDelta_strongestYear__relative_value"
        in values
    )
    assert values.loc[0, "pairwise_score__rank"] < values.loc[
        1, "pairwise_score__rank"
    ]
    assert any(column.endswith("__relative_value") for column in values)


def test_residual_features_can_exclude_one_evidence_family() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1", "run:1"],
        "event_type": ["missingRing", "missingRing"],
        "shift_years": [-1, -1],
        "year": [1900, 1901],
        "listwise_score": [0.2, 0.8],
        "pairwise_score": [0.4, 0.6],
        "residual_mode_mass": [0.1, 0.9],
        "residual_perReference_gain": [0.3, 0.7],
    })
    values = MODULE.residual_features(
        frame, ("residual_mode_",)
    )
    assert not any("residual_mode_" in column for column in values)
    assert any("residual_perReference_" in column for column in values)


def test_operation_top_accepts_workflow_identity_label() -> None:
    normalized = MODULE.normalize_operation_top(pd.DataFrame({
        "attempt_id": ["a"],
        "identity_workflow_oracle": [1],
    }))
    assert normalized.iloc[0]["operation_correct"] == 1


def test_physical_mode_features_aggregate_only_nearby_years() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1"] * 3,
        "event_type": ["missingRing"] * 3,
        "shift_years": [-1] * 3,
        "year": [1900, 1901, 1910],
        "listwise_score": [0.2, 0.8, 0.1],
        "pairwise_score": [0.1, 0.9, 0.0],
        "location_typed_score": [0.3, 0.7, 0.1],
        "location_global_score": [0.4, 0.6, 0.2],
        "residual_frontierConsistency_afterPathPresenceFraction": [
            0.2, 0.8, 0.1,
        ],
    })
    values = MODULE.residual_features(
        frame, include_all_frozen_views=True
    )
    mean_column = "listwise_score__physical_mode5_mean"
    margin_column = "listwise_score__adjacent_year_margin"
    assert values.loc[0, mean_column] == values.loc[1, mean_column]
    assert values.loc[2, mean_column] != values.loc[0, mean_column]
    assert values.loc[0, margin_column] < 0
    assert values.loc[1, margin_column] > 0
    assert values.loc[2, margin_column] == 0
    assert "location_typed_score__rank" in values
    assert "location_global_score__physical_mode13_mean" in values


def test_extra_frozen_location_views_are_opt_in() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1"] * 2,
        "event_type": ["missingRing"] * 2,
        "shift_years": [-1] * 2,
        "year": [1900, 1901],
        "listwise_score": [0.2, 0.8],
        "pairwise_score": [0.1, 0.9],
        "location_typed_score": [0.3, 0.7],
    })
    values = MODULE.residual_features(frame)
    assert not any("location_typed_score" in column for column in values)


def test_bottom_location_evidence_is_ranked_only_when_enabled() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["a", "a"],
        "event_type": ["missingRing", "missingRing"],
        "shift_years": [-1, -1],
        "year": [1900, 1901],
        "listwise_score": [0.5, 0.5],
        "pairwise_score": [0.5, 0.5],
        "evidence_perReference_peakKernel5": [0.2, 0.9],
        "evidence_boundaryLocal_stepMean5": [0.1, 0.8],
        "evidence_cofechaTransition_normalizedSplitGain": [0.0, 1.0],
    })
    plain = MODULE.residual_features(frame)
    enabled = MODULE.residual_features(
        frame, include_bottom_evidence=True
    )
    assert not any("evidence_perReference" in name for name in plain)
    assert enabled.loc[
        1, "evidence_perReference_peakKernel5__rank"
    ] > enabled.loc[
        0, "evidence_perReference_peakKernel5__rank"
    ]
    assert "evidence_boundaryLocal_stepMean5__z" in enabled
    assert not any("cofechaTransition" in name for name in enabled)


def test_anchor_oof_evidence_is_explicitly_opt_in() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["a", "a"],
        "event_type": ["missingRing", "missingRing"],
        "shift_years": [-1, -1],
        "year": [1900, 1901],
        "listwise_score": [0.5, 0.5],
        "pairwise_score": [0.5, 0.5],
        "anchor_location_oof_score": [0.1, 0.9],
    })
    plain = MODULE.residual_features(frame)
    enabled = MODULE.residual_features(
        frame, include_anchor_oof_evidence=True
    )
    assert not any("anchor_location" in name for name in plain)
    assert enabled.loc[
        1, "anchor_location_oof_score__rank"
    ] > enabled.loc[
        0, "anchor_location_oof_score__rank"
    ]


def test_physical_residual_modes_prefer_smaller_unresolved_evidence() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1"] * 2,
        "event_type": ["missingRing"] * 2,
        "shift_years": [-1] * 2,
        "year": [1900, 1901],
        "listwise_score": [0.5, 0.5],
        "pairwise_score": [0.5, 0.5],
        "residual_frontierConsistency_afterPathPresenceFraction": [
            0.8, 0.2,
        ],
        "residual_operationSpecific_afterRegionalLagStep": [-2, 0],
    })
    values = MODULE.residual_features(
        frame, orient_physical_residuals=True
    )
    assert values.loc[
        1,
        "residual_frontierConsistency_afterPathPresenceFraction__physical_rank",
    ] > values.loc[
        0,
        "residual_frontierConsistency_afterPathPresenceFraction__physical_rank",
    ]
    assert values.loc[
        1,
        "residual_operationSpecific_afterRegionalLagStep__physical_rank",
    ] > values.loc[
        0,
        "residual_operationSpecific_afterRegionalLagStep__physical_rank",
    ]


def test_typed_physical_modes_are_identity_specific_and_opt_in() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["a", "a", "b", "b"],
        "event_type": ["missingRing", "missingRing", "partialMove", "partialMove"],
        "shift_years": [-1, -1, -6, -6],
        "year": [1900, 1901, 1900, 1901],
        "listwise_score": [0.2, 0.8, 0.3, 0.7],
        "pairwise_score": [0.1, 0.9, 0.4, 0.6],
    })
    plain = MODULE.residual_features(frame)
    typed = MODULE.residual_features(
        frame, include_typed_physical_modes=True
    )
    name = "pairwise_score__physical_mode13_mean__for_partialMove"
    assert name not in plain
    assert typed.loc[0, name] == 0
    assert typed.loc[2, name] > 0


def test_physical_mode_features_can_be_disabled_for_ablation() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1"] * 2,
        "event_type": ["missingRing"] * 2,
        "shift_years": [-1] * 2,
        "year": [1900, 1901],
        "listwise_score": [0.2, 0.8],
        "pairwise_score": [0.1, 0.9],
    })
    values = MODULE.residual_features(
        frame, include_physical_modes=False
    )
    assert not any("physical_mode" in column for column in values)
    assert not any("adjacent_year_margin" in column for column in values)


def test_failure_layer_separates_window_and_candidate_failures() -> None:
    base = {
        "final_correct": 0,
        "candidate_has_response": 1,
        "operation_correct": 1,
        "full_candidate_oracle": 1,
        "event_type": "missingRing",
    }
    assert MODULE.failure_layer(pd.Series(base)) == "window"
    assert MODULE.failure_layer(pd.Series({
        **base,
        "operation_correct": 0,
        "full_candidate_oracle": 0,
    })) == "candidate_oracle_missing"
    assert MODULE.failure_layer(pd.Series({
        **base,
        "candidate_has_response": 0,
    })) == "refusal"


def test_listwise_pairwise_fusion_uses_within_identity_ranks() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["a", "a", "b", "b"],
    })
    fused = MODULE.fuse_listwise_pairwise_scores(
        frame,
        [100.0, 10.0, 0.02, 0.01],
        [0.1, 0.9, 0.8, 0.2],
    )
    assert fused[0] == fused[1]
    assert fused[2] > fused[3]
