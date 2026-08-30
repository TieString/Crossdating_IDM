from __future__ import annotations

import importlib.util
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).parents[1]
    / "prepare-selected-identity-location-shortlist.py"
)
SPEC = importlib.util.spec_from_file_location("selected_location", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_shortlist_only_uses_selected_identity_and_frozen_views() -> None:
    packages = pd.DataFrame({
        "attempt_id": ["a"] * 6 + ["a", "b"],
        "file_id": ["f"] * 8,
        "family": ["D"] * 8,
        "event_type": ["partialMove"] * 6 + ["missingRing", "falseRing"],
        "shift_years": [-6] * 6 + [-1, 1],
        "candidate_year": [1900, 1901, 1902, 1903, 1904, 1905, 1910, 1920],
        "location_score": [0.9, 0.8, 0.1, 0.2, 0.3, 0.4, 1.0, 0.7],
        "location_meta_score": [0.1, 0.2, 0.9, 0.8, 0.3, 0.4, 1.0, 0.7],
        "location_typed_score": [0.1, 0.2, 0.3, 0.4, 0.9, 0.8, 1.0, 0.7],
        "location_global_score": [0.1, 0.2, 0.3, 0.4, 0.8, 0.9, 1.0, 0.7],
        "window_correct": [0, 0, 1, 0, 0, 0, 1, 1],
    })
    operation_top = pd.DataFrame({
        "attempt_id": ["a", "b"],
        "event_type": ["partialMove", "wholeSeriesMove"],
        "shift_years": [-6, -4],
    })
    output = MODULE.build_shortlist(
        packages, operation_top, top_per_view=1
    )
    assert set(output["event_type"]) == {"partialMove"}
    assert set(output["year"]) == {1900, 1902, 1904, 1905}
    assert "window_correct" in output
    assert output["proposal_id"].is_unique


def test_shortlist_normalizes_location_correct_label() -> None:
    packages = pd.DataFrame({
        "attempt_id": ["a"],
        "file_id": ["f"],
        "family": ["A"],
        "event_type": ["missingRing"],
        "shift_years": [-1],
        "candidate_year": [1900],
        "location_score": [0.9],
        "location_correct": [1],
    })
    operation_top = pd.DataFrame({
        "attempt_id": ["a"],
        "event_type": ["missingRing"],
        "shift_years": [-1],
    })
    output = MODULE.build_shortlist(packages, operation_top)
    assert output.iloc[0]["window_correct"] == 1


def test_anchor_candidates_replace_only_their_selected_identity() -> None:
    packages = pd.DataFrame({
        "attempt_id": ["a", "a", "b"],
        "file_id": ["f", "f", "f"],
        "family": ["D", "D", "D"],
        "event_type": ["missingRing", "missingRing", "falseRing"],
        "shift_years": [-1, -1, 1],
        "candidate_year": [1900, 1901, 1920],
        "location_score": [0.9, 0.8, 0.7],
        "window_correct": [0, 1, 1],
    })
    operation_top = pd.DataFrame({
        "attempt_id": ["a", "b"],
        "event_type": ["missingRing", "falseRing"],
        "shift_years": [-1, 1],
    })
    anchors = pd.DataFrame({
        "attempt_id": ["a"],
        "file_id": ["f"],
        "family": ["D"],
        "event_type": ["missingRing"],
        "shift_years": [-1],
        "year": [1899],
        "listwise_score": [0.5],
        "pairwise_score": [0.6],
        "window_correct": [1],
    })
    output = MODULE.build_shortlist(
        packages,
        operation_top,
        top_per_view=1,
        anchor_scores=anchors,
        replace_anchored_identities=True,
    )
    assert set(output.loc[output["attempt_id"].eq("a"), "year"]) == {1899}
    assert set(output.loc[output["attempt_id"].eq("b"), "year"]) == {1920}
    assert "candidate_year" not in output


def test_anchor_candidate_year_is_normalized_before_merge() -> None:
    packages = pd.DataFrame({
        "attempt_id": ["a", "b"],
        "file_id": ["f", "f"],
        "family": ["A", "A"],
        "event_type": ["missingRing", "falseRing"],
        "shift_years": [-1, 1],
        "year": [1900, 1920],
        "location_score": [0.9, 0.8],
        "window_correct": [0, 1],
    })
    operation_top = packages[[
        "attempt_id", "event_type", "shift_years"
    ]]
    anchors = pd.DataFrame({
        "attempt_id": ["a"],
        "file_id": ["f"],
        "family": ["A"],
        "event_type": ["missingRing"],
        "shift_years": [-1],
        "candidate_year": [1901],
        "location_score": [0.7],
        "window_correct": [1],
    })
    output = MODULE.build_shortlist(
        packages,
        operation_top,
        anchor_scores=anchors,
        replace_anchored_identities=True,
    )
    assert set(output["year"]) == {1901, 1920}
    assert output["proposal_id"].is_unique


def test_anchor_candidates_extend_frozen_view_shortlist_by_default() -> None:
    packages = pd.DataFrame({
        "attempt_id": ["a", "a"],
        "file_id": ["f", "f"],
        "family": ["A", "A"],
        "event_type": ["missingRing", "missingRing"],
        "shift_years": [-1, -1],
        "candidate_year": [1900, 1901],
        "location_score": [0.9, 0.8],
        "window_correct": [0, 1],
    })
    operation_top = pd.DataFrame({
        "attempt_id": ["a"],
        "event_type": ["missingRing"],
        "shift_years": [-1],
    })
    anchors = pd.DataFrame({
        "attempt_id": ["a"],
        "file_id": ["f"],
        "family": ["A"],
        "event_type": ["missingRing"],
        "shift_years": [-1],
        "year": [1899],
        "location_score": [0.7],
        "residual_oof_score": [0.95],
        "window_correct": [1],
    })
    output = MODULE.build_shortlist(
        packages, operation_top, top_per_view=1, anchor_scores=anchors
    )
    assert set(output["year"]) == {1899, 1900}
    assert output.loc[
        output["year"].eq(1899), "anchor_location_oof_score"
    ].iloc[0] == 0.95


def test_anchor_oof_score_is_merged_into_richer_duplicate() -> None:
    packages = pd.DataFrame({
        "attempt_id": ["a"],
        "file_id": ["f"],
        "family": ["A"],
        "event_type": ["missingRing"],
        "shift_years": [-1],
        "year": [1900],
        "location_score": [0.8],
        "evidence_perReference_peakKernel5": [0.7],
    })
    operation_top = packages[[
        "attempt_id", "event_type", "shift_years"
    ]]
    anchors = packages.drop(
        columns=["evidence_perReference_peakKernel5"]
    ).assign(residual_oof_score=0.9)
    output = MODULE.build_shortlist(
        packages, operation_top, anchor_scores=anchors
    )
    assert output.iloc[0]["evidence_perReference_peakKernel5"] == 0.7
    assert output.iloc[0]["anchor_location_oof_score"] == 0.9
