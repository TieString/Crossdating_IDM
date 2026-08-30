from __future__ import annotations

import importlib.util
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).parents[1] / "prepare-applied-residual-shortlist.py"
SPEC = importlib.util.spec_from_file_location("residual_shortlist", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_shortlist_is_score_only_and_deduplicated() -> None:
    rows = []
    for attempt in ("run:1:1", "run:2:1"):
        for year, listwise, pairwise in (
            (1900, 0.9, 0.1),
            (1901, 0.8, 0.9),
            (1902, 0.7, 0.8),
        ):
            rows.append({
                "attempt_id": attempt,
                "file_id": "site",
                "family": "A",
                "event_type": "missingRing",
                "shift_years": -1,
                "year": year,
                "listwise_score": listwise,
                "pairwise_score": pairwise,
                "window_correct": year == 1902,
            })
    output = MODULE.build_shortlist(pd.DataFrame(rows), 1, 1)
    assert len(output) == 4
    assert set(output["year"]) == {1900, 1901}
    assert "window_correct" not in output.columns
    assert output["proposal_id"].is_unique


def test_shortlist_attempt_limit_is_deterministic() -> None:
    table = pd.DataFrame([
        {
            "attempt_id": attempt,
            "file_id": "site",
            "family": "A",
            "event_type": "falseRing",
            "shift_years": 1,
            "year": 1900,
            "listwise_score": 1,
            "pairwise_score": 1,
        }
        for attempt in ("run:3:1", "run:1:1", "run:2:1")
    ])
    output = MODULE.build_shortlist(table, 1, 1, maximum_attempts=2)
    assert set(output["attempt_id"]) == {"run:1:1", "run:2:1"}
