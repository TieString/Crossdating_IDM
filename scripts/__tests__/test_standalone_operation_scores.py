from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = Path(__file__).resolve().parents[1] / "fit-standalone-operation-scores.py"
SPEC = importlib.util.spec_from_file_location("standalone_operation_scores", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class StandaloneOperationScoresTest(unittest.TestCase):
    def test_prepare_operations_uses_operation_identity_only(self) -> None:
        packages = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "file_id": ["f", "f"],
            "family": ["D", "D"],
            "is_clean": [0, 0],
            "event_type": ["partialMove", "wholeSeriesMove"],
            "shift_years": [-4, -4],
            "operation_correct": [0, 1],
            "candidate_source": ["enrichedProposal", "wholeProjection"],
            "candidate_has_response": [1, 1],
            "candidate_year_present": [1, 0],
            "candidate_year": [1900, float("nan")],
        })

        operations, operation_types = MODULE.prepare_operations(packages)

        self.assertEqual(set(operations["identity_group"]), {
            "a|partialMove|-4", "a|wholeSeriesMove|-4",
        })
        self.assertEqual(int(operations["operation_correct"].sum()), 1)
        self.assertEqual(set(operation_types["event_type"]), {
            "partialMove", "wholeSeriesMove",
        })


if __name__ == "__main__":
    unittest.main()
