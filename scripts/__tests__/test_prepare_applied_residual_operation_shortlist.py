from __future__ import annotations

import importlib.util
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).parents[1] / "prepare-applied-residual-operation-shortlist.py"
SPEC = importlib.util.spec_from_file_location("operation_shortlist", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def fixture():
    attempt = "run:evaluation:1:1"
    scores = pd.DataFrame([
        {
            "identity_group": f"{attempt}|missingRing|-1",
            "meta_oof_score": 0.8,
            "pair_oof_score": 0.7,
            "selection_oof_score": 0.9,
        },
        {
            "identity_group": f"{attempt}|wholeSeriesMove|-4",
            "meta_oof_score": 0.6,
            "pair_oof_score": 0.8,
            "selection_oof_score": 0.8,
        },
        {
            "identity_group": f"{attempt}|falseRing|1",
            "meta_oof_score": 0.4,
            "pair_oof_score": 0.3,
            "selection_oof_score": 0.2,
        },
    ])
    locations = pd.DataFrame([{
        "attempt_id": attempt,
        "event_type": "missingRing",
        "shift_years": -1,
        "year": year,
        "listwise_score": listwise,
        "pairwise_score": pairwise,
    } for year, listwise, pairwise in (
        (1900, 0.9, 0.2), (1902, 0.5, 0.8)
    )])
    metadata = pd.DataFrame([{
        "identity_group": row.identity_group,
        "attempt_id": attempt,
        "file_id": "site",
        "family": "D",
        "event_type": row.identity_group.rsplit("|", 2)[1],
        "shift_years": int(row.identity_group.rsplit("|", 2)[2]),
        "truth_unused": 1,
    } for row in scores.itertuples()])
    return scores, locations, metadata


def test_operation_shortlist_uses_frozen_location_top1() -> None:
    scores, locations, metadata = fixture()
    output = MODULE.choose_operation_shortlist(
        scores, locations, metadata, top_count=2
    )
    assert list(output["event_type"]) == ["missingRing", "wholeSeriesMove"]
    assert list(output["year"]) == [1902, 0]
    assert not any("correct" in column for column in output.columns)
    assert "truth_unused" not in output.columns


def test_operation_shortlist_attempt_limit_is_deterministic() -> None:
    _, locations, _ = fixture()
    attempts = ("run:3:1", "run:1:1", "run:2:1")
    score_rows = []
    metadata_rows = []
    for attempt in attempts:
        identity = f"{attempt}|noEvent|0"
        score_rows.append({
            "identity_group": identity,
            "meta_oof_score": 1,
            "pair_oof_score": 1,
            "selection_oof_score": 1,
        })
        metadata_rows.append({
            "identity_group": identity,
            "attempt_id": attempt,
            "file_id": "site",
            "family": "Clean",
            "event_type": "noEvent",
            "shift_years": 0,
        })
    output = MODULE.choose_operation_shortlist(
        pd.DataFrame(score_rows),
        locations.iloc[0:0],
        pd.DataFrame(metadata_rows),
        1,
        maximum_attempts=2,
    )
    assert set(output["attempt_id"]) == {"run:1:1", "run:2:1"}
