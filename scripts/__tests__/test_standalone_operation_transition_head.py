from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import standalone_operation_transition_head as HEAD  # noqa: E402


class StandaloneOperationTransitionHeadTest(unittest.TestCase):
    def fixtures(self) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        base = pd.DataFrame({
            "attempt_id": ["a", "b"],
            "cluster_id": ["f1", "f2"],
            "file_id": ["f1", "f2"],
            "family": ["D", "C"],
            "is_clean": [0, 0],
            "identity_group": ["a|wholeSeriesMove|-6", "b|falseRing|1"],
            "event_type": ["wholeSeriesMove", "falseRing"],
            "shift_years": [-6, 1],
            "operation_correct": [0, 1],
            "final_correct": [0, 1],
            "final_strict_correct": [0, 1],
            "candidate_has_response": [1, 1],
            "selected_candidate_source": ["base", "base"],
            "selected_candidate_year": [float("nan"), 1900],
            "selected_proposal_role": ["base", "base"],
        })
        operations = pd.DataFrame({
            "attempt_id": ["a", "a", "b", "b"],
            "identity_group": [
                "a|wholeSeriesMove|-6", "a|partialMove|-6",
                "b|falseRing|1", "b|partialMove|-4",
            ],
            "event_type": [
                "wholeSeriesMove", "partialMove", "falseRing", "partialMove",
            ],
            "shift_years": [-6, -6, 1, -4],
            "operation_correct": [0, 1, 1, 0],
            "operation_meta_score": [0.0, 1.0, 0.5, 0.4],
        })
        locations = pd.DataFrame({
            "identity_group": ["a|partialMove|-6", "b|partialMove|-4"],
            "candidate_source": ["location", "location"],
            "candidate_year": [1901, 1902],
            "candidate_has_response": [1, 1],
            "workflow_correct": [1, 0],
            "strict_correct": [1, 0],
            "identity_location_score": [0.9, 0.8],
        })
        return base, operations, locations

    def test_calibration_keeps_only_zero_harm_transition(self) -> None:
        base, operations, locations = self.fixtures()
        competition = HEAD.build_competition(base, operations, locations)

        policies, _ = HEAD.calibrate_policies(base, competition)
        selected = HEAD.apply_policies(base, competition, policies)

        self.assertEqual(len(policies), 1)
        self.assertEqual(policies[0]["operationTransition"], "wholeSeriesMove>partialMove")
        self.assertEqual(selected["final_correct"].tolist(), [1, 1])

    def test_runtime_choice_ignores_correctness_labels(self) -> None:
        base, operations, locations = self.fixtures()
        policies = [{
            "operationTransition": "wholeSeriesMove>partialMove",
            "minimumScoreMargin": 0.5,
        }]
        first = HEAD.apply_policies(
            base,
            HEAD.build_competition(base, operations, locations),
            policies,
        )
        mutated_base = base.copy()
        mutated_base[["operation_correct", "final_correct", "final_strict_correct"]] = (
            1 - mutated_base[["operation_correct", "final_correct", "final_strict_correct"]]
        )
        mutated_operations = operations.copy()
        mutated_operations["operation_correct"] = 1 - mutated_operations["operation_correct"]
        mutated_locations = locations.copy()
        mutated_locations[["workflow_correct", "strict_correct"]] = (
            1 - mutated_locations[["workflow_correct", "strict_correct"]]
        )
        second = HEAD.apply_policies(
            mutated_base,
            HEAD.build_competition(
                mutated_base, mutated_operations, mutated_locations
            ),
            policies,
        )

        self.assertEqual(first["identity_group"].tolist(), second["identity_group"].tolist())
        self.assertEqual(
            first["operation_transition_switched"].tolist(),
            second["operation_transition_switched"].tolist(),
        )


if __name__ == "__main__":
    unittest.main()
