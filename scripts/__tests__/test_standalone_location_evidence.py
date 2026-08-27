from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from standalone_location_evidence import (  # noqa: E402
    append_physical_year_posterior,
    append_year_evidence_consensus,
    is_candidate_relative_evidence,
)


class StandaloneLocationEvidenceTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
