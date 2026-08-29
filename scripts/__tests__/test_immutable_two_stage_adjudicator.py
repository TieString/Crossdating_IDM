from __future__ import annotations

import sys
import unittest
import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd


SCRIPT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPT_DIR))

import immutable_two_stage_adjudicator as adjudicator  # noqa: E402

TRAINER_SPEC = importlib.util.spec_from_file_location(
    "immutable_two_stage_trainer",
    SCRIPT_DIR / "train-immutable-two-stage-adjudicator.py",
)
trainer = importlib.util.module_from_spec(TRAINER_SPEC)
TRAINER_SPEC.loader.exec_module(trainer)

POINTWISE_SPEC = importlib.util.spec_from_file_location(
    "immutable_operation_pointwise",
    SCRIPT_DIR / "audit-immutable-operation-pointwise.py",
)
pointwise = importlib.util.module_from_spec(POINTWISE_SPEC)
POINTWISE_SPEC.loader.exec_module(pointwise)


class ImmutableTwoStageAdjudicatorTest(unittest.TestCase):
    def test_pointwise_weights_balance_each_diagnosis_and_label_side(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a", "a", "b", "b"],
            "operation_correct": [1, 0, 0, 1, 1],
        })

        weights = pointwise.diagnosis_balanced_weights(frame)

        self.assertAlmostEqual(weights[:3].sum(), 1.0)
        self.assertAlmostEqual(weights[3:].sum(), 1.0)
        self.assertAlmostEqual(weights[0], 0.5)
        self.assertAlmostEqual(weights[1:3].sum(), 0.5)

    def test_relative_projection_ignores_absolute_score_scale(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a", "a"],
            "event_type": ["missingRing", "falseRing", "partialMove"],
            "shift_years": [-1, 1, -4],
            "raw_score": [0.1, 0.2, 0.4],
        })
        spec = adjudicator.make_feature_spec(
            frame,
            group_column="attempt_id",
            maximum_numeric=10,
            categorical_columns=("event_type",),
        )

        original = adjudicator.project_relative_features(frame, spec)
        rescaled = frame.copy()
        rescaled["raw_score"] = rescaled["raw_score"].mul(10).add(50)
        transformed = adjudicator.project_relative_features(rescaled, spec)

        pd.testing.assert_frame_equal(original, transformed)

    def test_operation_hierarchy_separates_shift_and_operation_competition(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a", "a"],
            "event_type": ["missingRing", "missingRing", "partialMove"],
            "shift_years": [-1, -2, -2],
            "raw_score": [0.1, 0.3, 0.2],
        })
        spec = adjudicator.make_feature_spec(
            frame,
            group_column="attempt_id",
            maximum_numeric=10,
            categorical_columns=("event_type",),
        )

        projected = adjudicator.project_operation_hierarchy_features(frame, spec)
        rescaled = frame.copy()
        rescaled["raw_score"] = rescaled["raw_score"].mul(20).add(7)
        transformed = adjudicator.project_operation_hierarchy_features(
            rescaled, spec
        )

        self.assertLess(
            projected.loc[0, "raw_score__operation_rank"],
            projected.loc[1, "raw_score__operation_rank"],
        )
        self.assertGreater(
            projected.loc[1, "raw_score__operation_max_envelope_rank"],
            projected.loc[2, "raw_score__operation_max_envelope_rank"],
        )
        pd.testing.assert_frame_equal(projected, transformed)

    def test_location_projection_cannot_cross_operation_identity(self) -> None:
        operation = pd.DataFrame({
            "attempt_id": ["a"],
            "event_type": ["missingRing"],
            "shift_years": [-1],
        })
        operation = adjudicator.ensure_identity_group(operation)
        location = pd.DataFrame({
            "attempt_id": ["a"],
            "event_type": ["partialMove"],
            "shift_years": [-4],
        })
        location = adjudicator.ensure_identity_group(location)

        with self.assertRaisesRegex(RuntimeError, "crossed"):
            adjudicator.assert_same_identity_projection(operation, location)

    def test_truth_and_dataset_labels_are_never_model_features(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "file_id": ["co001", "co001"],
            "family": ["D", "D"],
            "truth_year": [1900, 1900],
            "operation_correct": [1, 0],
            "event_type": ["missingRing", "partialMove"],
            "shift_years": [-1, -4],
            "evidence_gain": [0.2, 0.1],
        })

        spec = adjudicator.make_feature_spec(
            frame,
            group_column="attempt_id",
            maximum_numeric=20,
            categorical_columns=("event_type",),
        )

        self.assertEqual(spec.numeric_columns, ("evidence_gain",))
        projected = adjudicator.project_relative_features(frame, spec)
        forbidden = ("file_id", "family", "truth", "correct")
        self.assertFalse(any(
            token in column
            for column in projected.columns
            for token in forbidden
        ))

    def test_identity_group_is_checked_instead_of_silently_rewritten(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a"],
            "event_type": ["missingRing"],
            "shift_years": [-1],
            "identity_group": ["a|partialMove|-4"],
        })

        with self.assertRaisesRegex(RuntimeError, "violates"):
            adjudicator.ensure_identity_group(frame)

    def test_proposal_anchors_add_only_relative_geometry(self) -> None:
        packages = pd.DataFrame({
            "attempt_id": ["a", "a", "a"],
            "event_type": ["missingRing"] * 3,
            "shift_years": [-1] * 3,
            "candidate_year": [1899, 1900, 1901],
        })
        anchors = {
            "pair": pd.DataFrame({
                "attempt_id": ["a"],
                "event_type": ["missingRing"],
                "shift_years": [-1],
                "selected_candidate_year": [1900],
                "truth_year": [1901],
            })
        }

        original, generated = adjudicator.add_location_proposal_anchors(
            packages, anchors
        )
        shifted_packages = packages.copy()
        shifted_packages["candidate_year"] += 100
        shifted_anchors = {"pair": anchors["pair"].copy()}
        shifted_anchors["pair"]["selected_candidate_year"] += 100
        shifted, shifted_generated = adjudicator.add_location_proposal_anchors(
            shifted_packages, shifted_anchors
        )

        self.assertEqual(generated, shifted_generated)
        self.assertFalse(any("year" in column for column in generated))
        pd.testing.assert_frame_equal(
            original[list(generated)], shifted[list(generated)]
        )

    def test_proposal_anchor_cannot_add_candidate_rows(self) -> None:
        packages = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "event_type": ["missingRing", "missingRing"],
            "shift_years": [-1, -1],
            "candidate_year": [1900, 1901],
        })
        anchors = {
            "profile": pd.DataFrame({
                "attempt_id": ["a"],
                "event_type": ["missingRing"],
                "shift_years": [-1],
                "selected_candidate_year": [1950],
            })
        }

        augmented, _ = adjudicator.add_location_proposal_anchors(packages, anchors)

        self.assertEqual(len(augmented), len(packages))
        pd.testing.assert_series_equal(
            augmented["candidate_year"], packages["candidate_year"]
        )

    def test_frozen_proposal_projection_preserves_its_year_and_identity(self) -> None:
        packages = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "file_id": ["f", "f"],
            "family": ["A", "A"],
            "event_type": ["missingRing", "missingRing"],
            "shift_years": [-1, -1],
            "candidate_year": [1899, 1901],
            "candidate_source": ["dense", "dense"],
            "identity_operation_correct": [1, 1],
            "workflow_correct": [0, 1],
            "location_correct": [0, 1],
            "location_relevance": [0, 3],
        })
        proposals = pd.DataFrame({
            "attempt_id": ["a"],
            "file_id": ["f"],
            "family": ["A"],
            "event_type": ["missingRing"],
            "shift_years": [-1],
            "candidate_year": [1900],
            "proposal_role": ["profile"],
            "proposal_score": [0.7],
            "proposal_correct": [1],
            "operation_correct": [1],
        })

        combined = adjudicator.append_frozen_proposal_packages(packages, proposals)
        projected = combined[combined["frozen_proposal_available"].eq(1)].iloc[0]

        self.assertEqual(len(combined), 3)
        self.assertEqual(projected["candidate_year"], 1900)
        self.assertEqual(projected["identity_group"], "a|missingRing|-1")
        self.assertEqual(projected["candidate_source"], "frozenProposal:profile")
        self.assertEqual(projected["workflow_correct"], 1)

    def test_dense_and_frozen_proposals_share_one_location_head(self) -> None:
        operation = adjudicator.ensure_identity_group(pd.DataFrame({
            "attempt_id": ["a"],
            "file_id": ["f"],
            "family": ["A"],
            "event_type": ["missingRing"],
            "shift_years": [-1],
            "operation_correct": [1],
        }))
        dense = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "file_id": ["f", "f"],
            "family": ["A", "A"],
            "event_type": ["missingRing", "missingRing"],
            "shift_years": [-1, -1],
            "candidate_year": [1900, 1901],
            "candidate_source": ["dense", "dense"],
            "identity_operation_correct": [1, 1],
            "workflow_correct": [0, 1],
            "location_correct": [0, 1],
            "location_relevance": [0, 3],
        })
        proposal = pd.DataFrame({
            "attempt_id": ["a"],
            "file_id": ["f"],
            "family": ["A"],
            "event_type": ["missingRing"],
            "shift_years": [-1],
            "candidate_year": [1899],
            "proposal_role": ["pair"],
            "proposal_score": [0.9],
            "proposal_correct": [0],
            "operation_correct": [1],
        })
        packages = adjudicator.append_frozen_proposal_packages(dense, proposal)
        score = pd.Series(
            [2.0 if source == "dense" and year == 1901 else 1.0
             for source, year in zip(
                 packages["candidate_source"], packages["candidate_year"]
             )],
            index=packages.index,
        )
        location_top = adjudicator.select_top(
            packages, score, "identity_group"
        )

        selected = trainer.project_locations_into_operations(
            operation, location_top
        )

        self.assertEqual(selected.iloc[0]["selected_candidate_year"], 1901)
        self.assertEqual(selected.iloc[0]["selected_candidate_source"], "dense")
        self.assertEqual(selected.iloc[0]["final_correct"], 1)

    def test_categorical_feature_names_are_lightgbm_safe(self) -> None:
        frame = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "event_type": ["missingRing", "missingRing"],
            "shift_years": [-1, -1],
            "candidate_source": ["frozenProposal:base", 'quoted"source'],
            "score": [0.2, 0.3],
        })
        spec = adjudicator.make_feature_spec(
            frame,
            group_column="attempt_id",
            maximum_numeric=10,
            categorical_columns=("candidate_source",),
        )

        projected = adjudicator.project_relative_features(frame, spec)

        self.assertFalse(any(
            character in column
            for column in projected.columns
            for character in (":", '"', "[", "]", "{", "}")
        ))

    def test_safety_threshold_protects_complete_package_not_only_operation(self) -> None:
        baseline = pd.DataFrame({
            "attempt_id": ["a", "b"],
            "operation_correct": [1, 1],
            "final_correct": [1, 0],
        })
        challenger = pd.DataFrame({
            "attempt_id": ["a", "b"],
            "operation_correct": [1, 1],
            "final_correct": [0, 1],
        })
        margin = pd.Series({"a": 0.5, "b": 0.9})

        threshold = trainer.calibrate_no_regression_threshold(
            baseline,
            challenger,
            margin,
            baseline_correct="final_correct",
            challenger_correct="final_correct",
            eligible=pd.Series([True, True]),
        )

        self.assertEqual(threshold, 0.5)
        self.assertFalse(margin["a"] > threshold)
        self.assertTrue(margin["b"] > threshold)

    def test_frozen_threshold_inference_does_not_read_correctness_labels(self) -> None:
        baseline = pd.DataFrame({
            "attempt_id": ["a"],
            "file_id": ["f"],
            "family": ["A"],
            "event_type": ["missingRing"],
            "shift_years": [-1],
            "operation_correct": [1],
            "final_correct": [1],
            "selected_package_correct": [1],
            "location_correct": [1],
            "selected_candidate_source": ["baseline"],
            "selected_candidate_year": [1900],
            "candidate_has_response": [1],
        })
        operations = pd.DataFrame({
            "attempt_id": ["a", "a"],
            "file_id": ["f", "f"],
            "family": ["A", "A"],
            "event_type": ["missingRing", "falseRing"],
            "shift_years": [-1, 1],
            "operation_correct": [0, 1],
        })
        operations = adjudicator.ensure_identity_group(operations)
        location_top = pd.DataFrame({
            "attempt_id": ["a"],
            "identity_group": ["a|falseRing|1"],
            "event_type": ["falseRing"],
            "shift_years": [1],
            "candidate_year": [1910],
            "candidate_source": ["frozenProposal:pair"],
            "proposal_role": ["pair"],
            "workflow_correct": [1],
            "location_correct": [1],
        })

        original, _ = trainer.safe_two_stage_projection(
            baseline=baseline,
            operations=operations,
            operation_score=pd.Series([0.0, 2.0]),
            location_top=location_top,
            location_identity_margin=pd.Series({"a|falseRing|1": 1.0}),
            operation_threshold=0.5,
            location_threshold=0.0,
        )
        changed_labels = baseline.copy()
        changed_labels[["operation_correct", "final_correct"]] = 0
        changed_operations = operations.copy()
        changed_operations["operation_correct"] = 1 - changed_operations[
            "operation_correct"
        ]
        changed_location = location_top.copy()
        changed_location[["workflow_correct", "location_correct"]] = 0
        relabeled, _ = trainer.safe_two_stage_projection(
            baseline=changed_labels,
            operations=changed_operations,
            operation_score=pd.Series([0.0, 2.0]),
            location_top=changed_location,
            location_identity_margin=pd.Series({"a|falseRing|1": 1.0}),
            operation_threshold=0.5,
            location_threshold=0.0,
        )

        columns = [
            "identity_group",
            "selected_candidate_year",
            "decision_source",
        ]
        pd.testing.assert_frame_equal(original[columns], relabeled[columns])


if __name__ == "__main__":
    unittest.main()
