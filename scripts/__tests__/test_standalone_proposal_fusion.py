from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "train-standalone-proposal-fusion.py"
)
SPEC = importlib.util.spec_from_file_location("proposal_fusion", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class StandaloneProposalFusionTest(unittest.TestCase):
    def test_each_attempt_has_equal_total_classifier_weight(self) -> None:
        proposals = pd.DataFrame({
            "attempt_id": ["a", "a", "b", "b", "b"],
        })

        weights = MODULE.proposal_sample_weights(proposals)

        totals = weights.groupby(proposals["attempt_id"]).sum()
        np.testing.assert_allclose(totals.to_numpy(), [1.0, 1.0])

    def test_join_keys_are_not_duplicated_when_they_are_features(self) -> None:
        columns = MODULE.unique_columns([
            "identity_group",
            "candidate_source",
            "candidate_year",
            "candidate_source",
            "runtime_score",
        ])

        self.assertEqual(columns.count("candidate_source"), 1)
        self.assertEqual(columns, [
            "identity_group",
            "candidate_source",
            "candidate_year",
            "runtime_score",
        ])

    def test_duplicate_feature_names_fail_with_a_clear_contract_error(self) -> None:
        frame = pd.concat([
            pd.DataFrame({"score": [0.2]}),
            pd.DataFrame({"score": [0.3]}),
        ], axis=1)

        with self.assertRaisesRegex(RuntimeError, "duplicate proposal features: score"):
            MODULE.encode(frame)

    def test_agreement_uses_relative_years_only(self) -> None:
        proposals = pd.DataFrame({
            "attempt_id": ["a", "a", "a"],
            "proposal_role": ["base", "pair", "profile"],
            "candidate_year": [1900.0, 1901.0, 1910.0],
        })
        result = MODULE.append_agreement_features(proposals)

        self.assertEqual(result["proposal_unique_year_count"].tolist(), [3, 3, 3])
        np.testing.assert_allclose(
            result["proposal_support_within_1"].to_numpy(),
            [2 / 3, 2 / 3, 1 / 3],
            rtol=0,
            atol=1e-7,
        )
        self.assertNotIn("candidate_year", MODULE.encode(
            result.drop(columns=["attempt_id"])
        )[1])

    def test_labels_and_file_identity_are_excluded(self) -> None:
        frame = pd.DataFrame({
            "cluster_id": ["f"],
            "file_id": ["f"],
            "family": ["C"],
            "proposal_correct": [1],
            "truth_year": [1900],
            "proposal_role": ["pair"],
            "relative_support": [0.75],
        })
        _, features = MODULE.encode(frame)

        self.assertIn("relative_support", features)
        for forbidden in ("cluster_id", "file_id", "family", "proposal_correct", "truth_year"):
            self.assertNotIn(forbidden, features)


if __name__ == "__main__":
    unittest.main()
