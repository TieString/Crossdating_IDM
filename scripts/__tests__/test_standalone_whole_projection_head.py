from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import standalone_whole_projection_head as HEAD  # noqa: E402


class StandaloneWholeProjectionHeadTest(unittest.TestCase):
    def fixtures(self) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        base = pd.DataFrame({
            "attempt_id": ["a", "b"],
            "cluster_id": ["f1", "f2"],
            "file_id": ["f1", "f2"],
            "family": ["D", "A"],
            "is_clean": [0, 0],
            "identity_group": ["a|partialMove|-4", "b|missingRing|-1"],
            "event_type": ["partialMove", "missingRing"],
            "shift_years": [-4, -1],
            "operation_correct": [0, 1],
            "location_correct": [0, 1],
            "selected_package_correct": [0, 1],
            "final_correct": [0, 1],
            "final_strict_correct": [0, 1],
            "candidate_has_response": [1, 1],
            "selected_candidate_source": ["base", "base"],
            "selected_candidate_year": [1900, 1901],
            "selected_proposal_role": ["base", "base"],
        })
        operations = pd.DataFrame({
            "attempt_id": ["a", "a", "b", "b"],
            "identity_group": [
                "a|partialMove|-4", "a|wholeSeriesMove|-4",
                "b|missingRing|-1", "b|wholeSeriesMove|-4",
            ],
            "event_type": [
                "partialMove", "wholeSeriesMove",
                "missingRing", "wholeSeriesMove",
            ],
            "shift_years": [-4, -4, -1, -4],
            "operation_correct": [0, 1, 1, 0],
            "operation_meta_score": [0.0, 2.0, 0.5, 1.0],
            "source_count_wholeProjection": [0, 1, 0, 1],
        })
        labels = pd.DataFrame({
            "attempt_id": ["a", "b"],
            "identity_group": [
                "a|wholeSeriesMove|-4", "b|wholeSeriesMove|-4",
            ],
            "whole_workflow_correct": [1, 0],
            "whole_strict_correct": [1, 0],
            "whole_candidate_has_response": [1, 1],
        })
        return base, operations, labels

    def test_frozen_gate_uses_score_margin(self) -> None:
        base, operations, labels = self.fixtures()
        competition = HEAD.build_competition(base, operations, labels)
        selected = HEAD.apply_threshold(base, competition, 1.5)

        self.assertEqual(
            selected["event_type"].tolist(),
            ["wholeSeriesMove", "missingRing"],
        )
        self.assertEqual(selected["whole_projection_switched"].tolist(), [1, 0])
        self.assertEqual(selected["final_correct"].tolist(), [1, 1])

    def test_runtime_choice_is_independent_of_correctness_labels(self) -> None:
        base, operations, labels = self.fixtures()
        first = HEAD.apply_threshold(
            base,
            HEAD.build_competition(base, operations, labels),
            1.5,
        )
        mutated_base = base.copy()
        mutated_base[[
            "operation_correct", "location_correct",
            "selected_package_correct", "final_correct",
            "final_strict_correct",
        ]] = 1 - mutated_base[[
            "operation_correct", "location_correct",
            "selected_package_correct", "final_correct",
            "final_strict_correct",
        ]]
        mutated_operations = operations.copy()
        mutated_operations["operation_correct"] = (
            1 - mutated_operations["operation_correct"]
        )
        mutated_labels = labels.copy()
        mutated_labels[[
            "whole_workflow_correct", "whole_strict_correct",
        ]] = 1 - mutated_labels[[
            "whole_workflow_correct", "whole_strict_correct",
        ]]
        second = HEAD.apply_threshold(
            mutated_base,
            HEAD.build_competition(
                mutated_base, mutated_operations, mutated_labels
            ),
            1.5,
        )

        self.assertEqual(
            first["identity_group"].tolist(), second["identity_group"].tolist()
        )
        self.assertEqual(
            first["whole_projection_switched"].tolist(),
            second["whole_projection_switched"].tolist(),
        )

    def test_clean_mask_falls_back_to_family(self) -> None:
        frame = pd.DataFrame({"family": ["Clean", "A"]})

        self.assertEqual(HEAD.clean_mask(frame).tolist(), [True, False])


if __name__ == "__main__":
    unittest.main()
