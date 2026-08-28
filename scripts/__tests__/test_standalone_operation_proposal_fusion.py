from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "train-standalone-operation-proposal-fusion.py"
)
SPEC = importlib.util.spec_from_file_location("operation_proposal_fusion", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class StandaloneOperationProposalFusionTest(unittest.TestCase):
    def test_feature_contract_excludes_split_and_truth_fields(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a"],
            "cluster_id": ["f"],
            "file_id": ["f"],
            "family": ["D"],
            "is_clean": [0],
            "operation_correct": [1],
            "event_type": ["missingRing"],
            "shift_years": [-1],
            "shift_abs": [1],
            "operation_meta_score": [0.5],
            "operation_meta_percentile": [1.0],
            "proposal_role__base": [1],
            "proposal_count": [1],
            "proposal_unique_identity_count": [1],
        })

        columns = MODULE.feature_columns(frame)

        self.assertIn("event_type", columns)
        self.assertIn("operation_meta_score", columns)
        self.assertNotIn("attempt_id", columns)
        self.assertNotIn("cluster_id", columns)
        self.assertNotIn("file_id", columns)
        self.assertNotIn("family", columns)
        self.assertNotIn("operation_correct", columns)

    def test_proposals_deduplicate_identity_and_record_agreement(self) -> None:
        operations = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "identity_group": ["a|missingRing|-1", "a|falseRing|1"],
            "event_type": ["missingRing", "falseRing"],
            "shift_years": [-1, 1],
            "operation_meta_score": [2.0, 1.0],
            "operation_rank_score": [2.0, 1.0],
            "operation_classifier_probability": [0.8, 0.2],
            "typed_operation_rank_percentile": [1.0, 1.0],
            "typed_operation_classifier_percentile": [1.0, 1.0],
            "operation_correct": [1, 0],
            "source_count_productPrimary": [1, 0],
        })
        base = pd.DataFrame({
            "attempt_id": ["a"],
            "identity_group": ["a|missingRing|-1"],
        })

        proposals = MODULE.proposal_rows(operations, base)

        self.assertEqual(len(proposals), 2)
        missing = proposals.loc[
            proposals["event_type"].eq("missingRing")
        ].iloc[0]
        self.assertGreater(int(missing["proposal_count"]), 1)
        self.assertEqual(int(missing["proposal_role__base"]), 1)

    def test_target_categories_do_not_expand_training_schema(self) -> None:
        training = pd.DataFrame({
            "event_type": ["missingRing"],
            "operation_meta_score": [1.0],
        })
        target = pd.DataFrame({
            "event_type": ["futureOperation"],
            "operation_meta_score": [2.0],
        })

        train_values, target_values, names = MODULE.encode_train_target(
            training, target
        )

        self.assertIn("event_type_missingRing", names)
        self.assertNotIn("event_type_futureOperation", names)
        self.assertEqual(train_values.columns.tolist(), target_values.columns.tolist())


if __name__ == "__main__":
    unittest.main()
