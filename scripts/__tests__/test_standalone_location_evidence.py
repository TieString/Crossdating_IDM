from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from standalone_location_evidence import (  # noqa: E402
    append_frontier_competition_features,
    append_local_year_shape_features,
    append_physical_year_posterior,
    append_year_evidence_consensus,
    is_candidate_relative_evidence,
)


class StandaloneLocationEvidenceTest(unittest.TestCase):
    def test_consensus_append_is_idempotent(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "identity_group": ["g", "g"],
            "candidate_year": [1900, 1901],
            "evidence_identity_rawGain_percentile": [0.25, 0.75],
        })

        first = append_year_evidence_consensus(frame)
        second = append_year_evidence_consensus(first)

        self.assertFalse(second.columns.duplicated().any())
        pd.testing.assert_frame_equal(first, second)

    def test_keeps_year_relative_percentiles_but_not_operation_aggregates(self) -> None:
        self.assertTrue(
            is_candidate_relative_evidence(
                "evidence_identity_rawTransition_splitGain_percentile"
            )
        )
        self.assertTrue(
            is_candidate_relative_evidence(
                "evidence_identity_referenceChange_weightedSupport_deficit"
            )
        )
        self.assertFalse(
            is_candidate_relative_evidence(
                "evidence_identity_operation_rawGain_percentile"
            )
        )

    def test_consensus_uses_only_candidate_relative_channels(self) -> None:
        frame = pd.DataFrame({
            "evidence_identity_rawGain_percentile": [1.0, 0.25],
            "evidence_identity_referenceChange_weightedSupport_percentile": [
                0.75,
                0.5,
            ],
            "evidence_identity_operation_rawGain_percentile": [0.0, 1.0],
        })
        output = append_year_evidence_consensus(frame)
        self.assertAlmostEqual(output.loc[0, "evidence_consensus_all_mean"], 0.875)
        self.assertAlmostEqual(output.loc[1, "evidence_consensus_all_mean"], 0.375)
        self.assertEqual(output.loc[0, "evidence_consensus_all_count"], 2)

    def test_physical_posterior_balances_independent_families(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a"] * 5,
            "event_type": ["missingRing"] * 5,
            "shift_years": [-1] * 5,
            "year": [1900, 1905, 1910, 1915, 1920],
            "identity_rawTransition_splitGain_percentile": [0.1, 0.2, 1.0, 0.2, 0.1],
            "identity_cumulative_combinedCusum_percentile": [0.2, 0.3, 1.0, 0.3, 0.2],
            "identity_piecewise_combinedGain_percentile": [0.1, 0.4, 1.0, 0.4, 0.1],
            "identity_referenceChange_positiveGainFraction_percentile": [0.2, 0.4, 1.0, 0.4, 0.2],
            "identity_boundaryLocal_stepMean5_percentile": [0.1, 0.3, 1.0, 0.3, 0.1],
            "identity_operation_rawGain_percentile": [1.0, 1.0, 0.0, 1.0, 1.0],
        })

        output = append_physical_year_posterior(frame)

        self.assertEqual(
            int(output["physical_consensus_score"].idxmax()), 2
        )
        self.assertEqual(output.loc[2, "physical_consensus_family_count"], 5)
        self.assertGreater(output.loc[2, "physical_consensus_support_09"], 0.9)

    def test_frontier_features_detect_a_stronger_newer_mode(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a"] * 3,
            "event_type": ["missingRing"] * 3,
            "shift_years": [-1] * 3,
            "candidate_year": [1900, 1910, 1920],
            "evidence_identity_rawTransition_splitGain_percentile": [0.6, 1.0, 0.2],
            "evidence_identity_referenceChange_weightedSupport_percentile": [
                0.5,
                0.9,
                0.3,
            ],
        })

        output = append_frontier_competition_features(frame)

        self.assertEqual(output.loc[0, "geometry_newer_mode_count"], 2)
        self.assertEqual(
            output.loc[0, "geometry_newer_stronger_channel_fraction"], 1
        )
        self.assertEqual(
            output.loc[1, "geometry_newer_stronger_channel_fraction"], 0
        )
        self.assertEqual(
            output.loc[2, "geometry_older_stronger_channel_fraction"], 1
        )

    def test_local_shape_marks_a_shared_sharp_boundary(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a"] * 7,
            "event_type": ["missingRing"] * 7,
            "shift_years": [-1] * 7,
            "year": list(range(1900, 1907)),
            "identity_rawGain_percentile": [0.1, 0.2, 0.4, 1.0, 0.35, 0.2, 0.1],
            "identity_referenceChange_weightedSupport_percentile": [
                0.2, 0.3, 0.5, 0.95, 0.4, 0.25, 0.1,
            ],
        })

        output = append_local_year_shape_features(frame)

        self.assertEqual(int(output["shape_consensus_score"].idxmax()), 3)
        self.assertEqual(output.loc[3, "shape_consensus_peak_fraction"], 1)
        self.assertGreater(
            output.loc[3, "shape_counterfactual_minimum_side_advantage"], 0
        )


if __name__ == "__main__":
    unittest.main()
