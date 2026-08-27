from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "train-standalone-pairwise-adjudicator.py"
)
SPEC = importlib.util.spec_from_file_location("standalone_pairwise", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StandalonePairwiseContractTest(unittest.TestCase):
    def test_truth_and_corpus_identity_are_never_features(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a"],
            "cluster_id": ["file"],
            "file_id": ["file"],
            "family": ["D"],
            "truth_year": [1900],
            "workflow_correct": [1],
            "operation_correct": [1],
            "event_type": ["missingRing"],
            "shift_years": [-1],
            "operation_meta_percentile": [0.8],
            "candidate_source": ["productPrimary"],
            "location_meta_percentile": [0.7],
        })

        operation = MODULE.operation_feature_columns(frame)
        location = MODULE.location_feature_columns(frame)

        for forbidden in MODULE.FORBIDDEN_FEATURE_COLUMNS:
            self.assertNotIn(forbidden, operation)
            self.assertNotIn(forbidden, location)

    def test_final_choice_does_not_consult_correctness_labels(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "final_score": [0.2, 0.9],
            "workflow_correct": [1, 0],
            "operation_correct": [1, 0],
        })
        first = MODULE.choose_top(
            frame,
            group_column="attempt_id",
            score=frame["final_score"],
        ).index.tolist()
        mutated = frame.copy()
        mutated["workflow_correct"] = 1 - mutated["workflow_correct"]
        mutated["operation_correct"] = 1 - mutated["operation_correct"]
        second = MODULE.choose_top(
            mutated,
            group_column="attempt_id",
            score=mutated["final_score"],
        ).index.tolist()

        self.assertEqual(first, [1])
        self.assertEqual(second, first)

    def test_location_training_pairs_keep_directional_year_delta(self) -> None:
        frame = pd.DataFrame({
            "identity_group": ["g", "g"],
            "cluster_id": ["f", "f"],
            "event_type": ["missingRing", "missingRing"],
            "candidate_year": [1900, 1907],
            "workflow_correct": [1, 0],
            "base_score": [0.4, 0.9],
        })
        pairs = MODULE.training_pairs(
            frame,
            group_column="identity_group",
            label_column="workflow_correct",
            score_columns=["base_score"],
            hard_negatives=1,
            positive_limit=1,
        )

        self.assertEqual(pairs["year_delta"].tolist(), [-7.0, 7.0])
        self.assertEqual(pairs["left_better"].tolist(), [1, 0])

    def test_base_location_score_replays_frozen_head_weights(self) -> None:
        frame = pd.DataFrame({
            "location_global_percentile": [0.2],
            "location_typed_percentile": [0.6],
            "location_global_classifier_percentile": [0.4],
            "location_typed_classifier_percentile": [0.8],
            "location_meta_percentile": [0.99],
        })
        score = MODULE.base_location_score(frame, {
            "typedLocation": 0.25,
            "locationClassifier": 0.5,
        })

        self.assertAlmostEqual(float(score.iloc[0]), 0.4)

    def test_operation_consensus_is_attempt_relative_and_truth_blind(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a", "b", "b"],
            "operation_correct": [1, 0, 0, 1],
            "max_evidence_rawGain": [1.0, 2.0, 100.0, 200.0],
            "max_evidence_referenceChange_weightedSupport": [0.2, 0.8, 2.0, 8.0],
        })
        result = MODULE.append_operation_evidence_consensus(frame)

        self.assertEqual(
            result["operation_family_counterfactual_mean"].tolist(),
            [0.5, 1.0, 0.5, 1.0],
        )
        self.assertNotIn(
            "operation_correct", MODULE.operation_feature_columns(result)
        )


if __name__ == "__main__":
    unittest.main()
