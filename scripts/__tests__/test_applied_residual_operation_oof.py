from __future__ import annotations

import importlib.util
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


def test_operation_summary_counts_repairs_and_regressions() -> None:
    baseline = pd.DataFrame({
        "attempt_id": ["a", "b", "clean"],
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
