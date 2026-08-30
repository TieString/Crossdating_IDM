from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).parents[1] / "audit-applied-residual-operation-oof.py"
SPEC = importlib.util.spec_from_file_location("residual_operation", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_operation_features_drop_calendar_years_and_use_attempt_relative_scores() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1", "run:1"],
        "event_type": ["missingRing", "wholeSeriesMove"],
        "shift_years": [-1, -4],
        "selection_oof_score": [0.2, 0.8],
        "meta_oof_score": [0.3, 0.7],
        "pair_oof_score": [0.4, 0.6],
        "residual_afterPath_newestEventYear": [1930, 1900],
        "residual_coreDelta_meanSegmentR0": [0.1, 0.4],
        "residual_pathEventReduction": [1, 0],
    })
    features = MODULE.residual_operation_features(frame)
    assert not any(
        column.startswith("residual_") and "year" in column.lower()
        for column in features.columns
    )
    assert "residual_coreDelta_meanSegmentR0__rank" in features
    assert "residual_coreDelta_meanSegmentR0__relative_value" in features
    assert "event_type__missingRing" in features
    assert list(features["shift_magnitude"]) == [1, 4]


def test_operation_features_can_exclude_one_evidence_family() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1", "run:1"],
        "event_type": ["missingRing", "wholeSeriesMove"],
        "shift_years": [-1, -1],
        "selection_oof_score": [0.6, 0.4],
        "residual_operationSpecific_baselineAgreement": [0, 1],
        "residual_coreDelta_meanSegmentR0": [0.1, 0.2],
    })
    features = MODULE.residual_operation_features(
        frame, ("residual_operationSpecific_",)
    )
    assert not any("operationSpecific" in column for column in features)
    assert "residual_coreDelta_meanSegmentR0__rank" in features


def test_operation_features_keep_raw_values_only_for_relative_improvements() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["run:1", "run:1"],
        "event_type": ["missingRing", "wholeSeriesMove"],
        "shift_years": [-1, -1],
        "residual_beforeCore_globalCurrentR": [0.2, 0.8],
        "residual_coreDelta_globalCurrentR": [0.1, 0.3],
        "residual_pathEventReduction": [1, 0],
    })
    features = MODULE.residual_operation_features(frame)
    assert "residual_beforeCore_globalCurrentR__relative_value" not in features
    assert "residual_coreDelta_globalCurrentR__relative_value" in features
    assert "residual_pathEventReduction__relative_value" in features


def test_baseline_identity_fit_separates_local_and_whole_expectations() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["a", "a", "a"],
        "event_type": ["missingRing", "wholeSeriesMove", "partialMove"],
        "shift_years": [-1, -3, -6],
        "residual_operationSpecific_beforeNewestLag": [-2, -2, -2],
        "residual_operationSpecific_beforeNewerLagMode": [-2, -2, -2],
        "residual_operationSpecific_beforeThreeNewerLagMode": [-2, -2, -2],
        "residual_operationSpecific_beforeGlobalLag": [-3, -3, -3],
        "residual_operationSpecific_beforeLagMode": [-3, -3, -3],
        "residual_operationSpecific_afterNewestLag": [-2, 0, -4],
        "residual_operationSpecific_afterNewerLagMode": [-2, 0, -4],
        "residual_operationSpecific_afterOlderLagMode": [-2, 0, -1],
        "residual_operationSpecific_afterGlobalLag": [-2, 0, -2],
        "residual_operationSpecific_afterLagMode": [-2, 0, -2],
        "residual_operationSpecific_afterRegionalLagStep": [0, 0, 3],
        "residual_operationSpecific_beforeRegionalLagStep": [-1, 0, -1],
        "residual_operationSpecific_beforeNearestBoundaryStep": [-1, 0, -1],
        "residual_operationSpecific_beforeThreeBoundaryStep": [-1, 0, -1],
    })
    derived = MODULE.add_baseline_identity_fit_evidence(frame)
    assert derived.loc[0, "derived_identityFit_localJoint"] == 0
    assert derived.loc[1, "derived_identityFit_wholeJoint"] == 0
    assert derived.loc[2, "derived_identityFit_localJoint"] < 0
    plain = MODULE.residual_operation_features(frame)
    enabled = MODULE.residual_operation_features(
        frame, include_baseline_identity_fit=True
    )
    assert not any("derived_identityFit" in name for name in plain)
    assert "derived_identityFit_localJoint__rank" in enabled
    compact = MODULE.residual_operation_features(
        frame,
        include_baseline_identity_fit=True,
        baseline_identity_fit_local_shift_only=True,
    )
    assert "derived_identityFit_localShift__rank" in compact
    assert not any("localJoint" in name for name in compact)


def test_compact_per_reference_fit_uses_residual_not_raw_trace() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["a", "a"],
        "event_type": ["partialMove", "partialMove"],
        "shift_years": [-6, -6],
        "residual_perReference_before_localFixedLagStepWeighted": [-6, -2],
        "residual_perReference_after_localFixedLagStepWeighted": [0, -3],
        "residual_perReference_before_localFixedLagStepPositiveFraction": [
            0.9, 0.4,
        ],
        "residual_perReference_before_localReferenceCount": [8, 8],
        "residual_perReference_after_localReferenceCount": [8, 4],
        "residual_perReference_before_localWhitenedGainMean": [0.7, 0.4],
        "residual_perReference_after_localWhitenedGainMean": [0.1, 0.3],
        "residual_perReference_after_newerStrongestCombinedGain": [0.0, 0.5],
    })
    derived = MODULE.add_compact_per_reference_fit_evidence(frame)
    assert derived.loc[0, "derived_perReference_shiftFit"] == 0
    assert derived.loc[0, "derived_perReference_stepResidual"] == 0
    assert derived.loc[0, "derived_perReference_stepReduction"] > (
        derived.loc[1, "derived_perReference_stepReduction"]
    )
    values = MODULE.residual_operation_features(
        frame,
        ("residual_perReference_",),
        include_compact_per_reference_fit=True,
    )
    assert "derived_perReference_shiftFit__rank" in values
    assert not any(name.startswith("residual_perReference") for name in values)


def test_operation_summary_counts_repairs_and_regressions() -> None:
    baseline = pd.DataFrame({
        "attempt_id": ["a", "b", "clean"],
        "file_id": ["file-a", "file-b", "file-clean"],
        "family": ["A", "D", "Clean"],
        "event_type": ["missingRing", "falseRing", "noEvent"],
        "identity_workflow_oracle": [0, 1, 1],
        "identity_operation_correct": [0, 1, 1],
    })
    selected = baseline.copy()
    selected["event_type"] = ["missingRing", "partialMove", "noEvent"]
    selected["identity_workflow_oracle"] = [1, 0, 1]
    selected["identity_operation_correct"] = [1, 0, 1]
    summary = MODULE.summarize(selected, baseline)
    assert summary["repairs"] == 1
    assert summary["regressions"] == 1
    assert summary["cleanFalsePositives"] == 0


def test_file_cluster_lower_is_deterministic_and_below_point_estimate() -> None:
    frame = pd.DataFrame({
        "file_id": ["a", "a", "b", "b"],
        "correct": [1, 1, 1, 0],
    })
    first = MODULE.file_cluster_lower(
        frame, "correct", repetitions=2_000, seed="fixed"
    )
    second = MODULE.file_cluster_lower(
        frame, "correct", repetitions=2_000, seed="fixed"
    )
    assert first == second
    assert first <= frame["correct"].mean()


def test_read_residual_frame_accepts_sharded_directory(tmp_path: Path) -> None:
    rows = [
        {"proposal_id": "a", "residual_applied": True},
        {"proposal_id": "b", "residual_applied": False},
    ]
    for index, row in enumerate(rows):
        (tmp_path / f"part-{index}.ndjson").write_text(
            json.dumps(row) + "\n", encoding="utf8"
        )
    output = MODULE.read_residual_frame(tmp_path)
    assert output["proposal_id"].tolist() == ["a", "b"]


def test_winner_margin_is_computed_within_each_attempt() -> None:
    frame = pd.DataFrame({
        "attempt_id": ["a", "a", "b"],
        "selection_oof_score": [0.3, 0.2, 0.1],
    })
    margin = MODULE.winner_margin_by_attempt(
        frame, pd.Series([0.9, 0.4, 0.7])
    )
    assert margin["a"] == 0.5
    assert margin["b"] == float("inf")
