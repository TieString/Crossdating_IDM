from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "applied_residual_unified_shadow.py"
SPEC = importlib.util.spec_from_file_location("applied_residual_shadow", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_truth_blind_contract_rejects_evaluation_fields() -> None:
    with pytest.raises(RuntimeError, match="evaluation-only"):
        MODULE.assert_truth_blind_features([
            "safe__rank",
            "candidate_truth_year__z",
        ])


def test_truth_blind_contract_accepts_relative_evidence() -> None:
    MODULE.assert_truth_blind_features([
        "residual_afterCore_meanBestR__rank",
        "residual_corrected_correlation__rank",
        "derived_perReferenceLocation_peakReduction__winner_margin",
    ])


def test_selected_window_uses_only_supported_widths() -> None:
    assert MODULE.selected_window(pd.Series({
        "year": 1904,
        "runtime_window_width": 7,
    })) == (1901, 1907)
    assert MODULE.selected_window(pd.Series({
        "year": 1904,
        "runtime_window_width": 0,
    })) == (1898, 1910)
    assert MODULE.selected_window(pd.Series({
        "year": 1904,
        "runtime_window_width": np.nan,
    })) == (1898, 1910)


def test_align_features_zero_fills_absent_event_type_only() -> None:
    values = pd.DataFrame({"known__rank": [0.75]})
    aligned = MODULE.align_features(
        values,
        ["known__rank", "event_type__partialMove"],
    )
    assert aligned.to_dict("records") == [{
        "known__rank": 0.75,
        "event_type__partialMove": 0.0,
    }]


def test_align_features_rejects_missing_runtime_evidence() -> None:
    with pytest.raises(RuntimeError, match="runtime evidence is incomplete"):
        MODULE.align_features(
            pd.DataFrame({"known__rank": [0.75]}),
            ["known__rank", "residual_afterCore_meanBestR__rank"],
        )


def test_sha256_supports_deterministic_directory_inputs(tmp_path: Path) -> None:
    first = tmp_path / "a.ndjson"
    second = tmp_path / "nested" / "b.ndjson"
    second.parent.mkdir()
    first.write_text("one\n", encoding="utf8")
    second.write_text("two\n", encoding="utf8")
    before = MODULE.sha256(tmp_path)
    assert before == MODULE.sha256(tmp_path)
    second.write_text("changed\n", encoding="utf8")
    assert MODULE.sha256(tmp_path) != before


def test_location_operation_label_normalizer_accepts_frozen_v6_output() -> None:
    normalized = MODULE.LOCATION.normalize_operation_top(pd.DataFrame({
        "attempt_id": ["a"],
        "identity_workflow_oracle": [1],
    }))
    assert normalized["operation_correct"].tolist() == [1]


def test_checked_in_model_pack_passes_integrity_contract() -> None:
    validator_path = SCRIPT.parent / "validate-applied-residual-unified-shadow.py"
    spec = importlib.util.spec_from_file_location(
        "validate_applied_residual_shadow", validator_path
    )
    validator = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(validator)
    result = validator.validate_model_pack(validator.DEFAULT_MODEL_DIR)
    assert result["modelVersion"] == MODULE.MODEL_VERSION
    assert result["operationFeatures"] == 1312
    assert result["locationFeatures"] == 2808
