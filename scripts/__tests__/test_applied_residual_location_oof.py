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
