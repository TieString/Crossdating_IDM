from __future__ import annotations

import sys
import unittest
from pathlib import Path

import pandas as pd


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from standalone_location_evidence import (  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
