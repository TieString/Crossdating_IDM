from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "append-whole-projection-packages.py"
)
SPEC = importlib.util.spec_from_file_location("append_whole_projection", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def package_row(
    attempt_id: str,
    event_type: str,
    shift_years: int,
    score: float,
) -> dict[str, object]:
    return {
        "attempt_id": attempt_id,
        "candidate_source": "enrichedProposal",
        "event_type": event_type,
        "shift_years": shift_years,
        "shift_abs": abs(shift_years),
        "candidate_has_response": 1,
        "candidate_year_present": 1,
        "candidate_year": 1900,
        "operation_correct": 0,
        "location_correct": 0,
        "location_relevance": 0,
        "location_error_years": 10,
        "workflow_correct": 0,
        "strict_correct": 0,
        "bundle_has_alternative": 0,
        "evidence_operation_probability": score,
    }


class AppendWholeProjectionPackagesTest(unittest.TestCase):
    def test_projects_only_strongest_negative_partial_identity(self) -> None:
        table = pd.DataFrame([
            package_row("a", "partialMove", -4, 0.4),
            package_row("a", "partialMove", -4, 0.8),
            package_row("a", "partialMove", 4, 0.9),
            package_row("a", "missingRing", -1, 1.0),
        ])
        steps = {
            "a": pd.Series({
                "diagnosedTruthType": "wholeSeriesMove",
                "diagnosedTruthShiftYears": -4,
            })
        }

        result = MODULE.append_whole_projections(table, steps)
        projected = result[result["candidate_source"].eq("wholeProjection")]

        self.assertEqual(len(projected), 1)
        row = projected.iloc[0]
        self.assertEqual(row["event_type"], "wholeSeriesMove")
        self.assertEqual(int(row["shift_years"]), -4)
        self.assertEqual(float(row["evidence_operation_probability"]), 0.8)
        self.assertEqual(int(row["candidate_has_response"]), 1)
        self.assertEqual(int(row["candidate_year_present"]), 0)
        self.assertTrue(pd.isna(row["candidate_year"]))
        self.assertEqual(int(row["workflow_correct"]), 1)

    def test_projection_is_idempotent(self) -> None:
        table = pd.DataFrame([
            package_row("a", "partialMove", -11, 0.7),
        ])
        steps = {
            "a": pd.Series({
                "diagnosedTruthType": "wholeSeriesMove",
                "diagnosedTruthShiftYears": -11,
            })
        }

        first = MODULE.append_whole_projections(table, steps)
        second = MODULE.append_whole_projections(first, steps)

        self.assertEqual(
            int(first["candidate_source"].eq("wholeProjection").sum()), 1
        )
        pd.testing.assert_frame_equal(first, second)


if __name__ == "__main__":
    unittest.main()
