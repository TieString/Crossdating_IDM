"""Verify the packaged current-event model, schema order and reference scores."""
from __future__ import annotations

import argparse
import hashlib
import json
import warnings
from pathlib import Path
from typing import Any

import joblib
import numpy as np

warnings.filterwarnings("ignore", category=UserWarning, module=r"(sklearn|lightgbm).*")

EXPECTED_RELIABILITY_FEATURE_NAMES = [
    "log_candidate_count",
    "round_index",
    "top1_score",
    "top2_score",
    "top1_top2_margin",
    "score_mean",
    "score_std",
    "top1_z",
    "top2_z",
    "margin_z",
]


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(bundle: Path) -> dict[str, Any]:
    manifest = load_json(bundle / "bundle_manifest.json")
    for label, record in manifest["files"].items():
        path = bundle / str(record["path"])
        if not path.is_file():
            raise ValueError(f"manifest file is missing: {label}")
        if path.stat().st_size != int(record["bytes"]):
            raise ValueError(f"manifest byte count mismatch: {label}")
        if sha256(path) != str(record["sha256"]):
            raise ValueError(f"manifest hash mismatch: {label}")

    schema = load_json(bundle / "feature_schema.json")
    feature_rows = list(schema["feature_names"])
    feature_names = [str(row["name"]) for row in feature_rows]
    if (
        schema.get("feature_count") != 251
        or schema.get("dtype") != "float64"
        or len(feature_names) != 251
        or any(int(row["index"]) != index for index, row in enumerate(feature_rows))
        or any(row.get("dtype") != "float64" for row in feature_rows)
    ):
        raise ValueError("feature schema must be an ordered 251-column float64 contract")

    ranker_payload = joblib.load(bundle / "current_event_ranker.joblib")
    selector_payload = joblib.load(bundle / "reliability_selector.joblib")
    if list(ranker_payload["feature_names"]) != feature_names:
        raise ValueError("joblib feature order does not match feature_schema.json")
    reliability_schema = load_json(bundle / "reliability_schema.json")
    reliability_rows = list(reliability_schema.get("feature_names", []))
    reliability_names = [str(row["name"]) for row in reliability_rows]
    if (
        reliability_names != EXPECTED_RELIABILITY_FEATURE_NAMES
        or any(int(row["index"]) != index for index, row in enumerate(reliability_rows))
        or list(selector_payload.get("feature_names", [])) != reliability_names
    ):
        raise ValueError("reliability selector must match the ordered 10-column float64 runtime contract")
    selector_model = selector_payload.get("model")
    if int(getattr(selector_model, "n_features_in_", 0)) != len(reliability_names):
        raise ValueError("reliability selector model feature count does not match reliability_schema.json")

    reference = load_json(bundle / "prediction_reference.json")
    rows = list(reference.get("rows", []))
    if len(rows) != 256:
        raise ValueError(f"expected 256 prediction reference rows, got {len(rows)}")
    matrix = np.asarray([row["feature_values"] for row in rows], dtype=np.float64)
    expected = np.asarray([float(row["score"]) for row in rows], dtype=np.float64)
    if matrix.shape != (256, 251) or matrix.dtype != np.float64:
        raise ValueError(f"unexpected prediction reference shape/dtype: {matrix.shape}/{matrix.dtype}")

    predicted_first = np.asarray(ranker_payload["model"].predict(matrix), dtype=np.float64)
    predicted_second = np.asarray(ranker_payload["model"].predict(matrix), dtype=np.float64)
    max_abs_delta = float(np.max(np.abs(predicted_first - expected)))
    if not np.allclose(predicted_first, expected, rtol=0.0, atol=1e-12):
        raise ValueError(f"prediction reference mismatch: max_abs_delta={max_abs_delta}")
    if not np.array_equal(predicted_first, predicted_second):
        raise ValueError("two identical predictions are not exactly deterministic")

    range_result: dict[str, Any] | None = None
    range_gate_result: dict[str, Any] | None = None
    range_model_path = bundle / "current_event_range_localizer.joblib"
    if range_model_path.is_file():
        runtime_config = load_json(bundle / "runtime_config.json")
        range_runtime = runtime_config.get("single_event_range", {})
        range_schema = load_json(bundle / "current_event_range_feature_schema.json")
        range_feature_rows = list(range_schema["feature_names"])
        range_feature_names = [str(row["name"]) for row in range_feature_rows]
        if (
            range_schema.get("feature_count") != 70
            or range_schema.get("dtype") != "float32"
            or len(range_feature_names) != 70
            or any(int(row["index"]) != index for index, row in enumerate(range_feature_rows))
            or any(row.get("dtype") != "float32" for row in range_feature_rows)
        ):
            raise ValueError("range feature schema must be an ordered 70-column float32 contract")
        range_payload = joblib.load(range_model_path)
        if list(range_payload["feature_names"]) != range_feature_names:
            raise ValueError("range joblib feature order does not match range schema")
        if int(range_payload["max_width"]) > 15 or int(range_payload["radius"]) != 7:
            raise ValueError("single event range exceeds the frozen width contract")
        if (
            int(range_runtime.get("count", 0)) != 1
            or int(range_runtime.get("feature_count", 0)) != 70
            or int(range_runtime.get("radius", 0)) != 7
            or int(range_runtime.get("max_width", 0)) != 15
            or int(range_runtime.get("max_centers", 0)) != 120
            or not isinstance(range_runtime.get("adaptive_window"), dict)
        ):
            raise ValueError("runtime_config.json does not expose the frozen adaptive range contract")

        range_reference = load_json(bundle / "range_prediction_reference.json")
        range_rows = list(range_reference.get("rows", []))
        if len(range_rows) != 8 or list(range_reference.get("feature_names", [])) != range_feature_names:
            raise ValueError("range prediction reference must contain 8 ordered schema groups")
        max_learned_delta = 0.0
        max_blended_delta = 0.0
        mass_column = range_feature_names.index("profile_interval_softmax_mass_t10")
        alpha = float(range_payload["blend_alpha"])

        def standardize(values: np.ndarray) -> np.ndarray:
            std = float(np.std(values))
            if std <= 1e-12:
                return np.zeros_like(values, dtype=float)
            return (values - float(np.mean(values))) / std

        for row in range_rows:
            range_matrix = np.asarray(row["featureRows"], dtype=np.float32)
            if range_matrix.ndim != 2 or range_matrix.shape[1] != 70:
                raise ValueError("range prediction reference has an invalid matrix shape")
            learned_first = np.asarray(range_payload["model"].predict(range_matrix), dtype=float)
            learned_second = np.asarray(range_payload["model"].predict(range_matrix), dtype=float)
            if not np.array_equal(learned_first, learned_second):
                raise ValueError("range predictions are not exactly deterministic")
            expected_learned = np.asarray(row["expectedLearnedScores"], dtype=float)
            learned_delta = float(np.max(np.abs(learned_first - expected_learned)))
            max_learned_delta = max(max_learned_delta, learned_delta)
            mass = np.asarray(range_matrix[:, mass_column], dtype=float)
            blended = alpha * standardize(learned_first) + (1.0 - alpha) * standardize(mass)
            expected_blended = np.asarray(row["expectedBlendedScores"], dtype=float)
            blended_delta = float(np.max(np.abs(blended - expected_blended)))
            max_blended_delta = max(max_blended_delta, blended_delta)
            expected_range = row["expected"]
            if int(expected_range["width"]) > 15:
                raise ValueError("range prediction reference contains a width above 15")
        if max_learned_delta > 1e-12 or max_blended_delta > 1e-12:
            raise ValueError(
                "range prediction reference mismatch: "
                f"learned={max_learned_delta}, blended={max_blended_delta}"
            )
        range_result = {
            "featureCount": len(range_feature_names),
            "featureDtype": "float32",
            "predictionReferenceGroups": len(range_rows),
            "predictionMaxLearnedAbsDelta": max_learned_delta,
            "predictionMaxBlendedAbsDelta": max_blended_delta,
            "maxWidth": int(range_payload["max_width"]),
            "deterministic": True,
        }

        range_gate_model_path = bundle / "current_event_range_reliability_selector.joblib"
        if range_gate_model_path.is_file():
            range_gate_schema = load_json(
                bundle / "current_event_range_reliability_feature_schema.json"
            )
            range_gate_rows = list(range_gate_schema.get("feature_names", []))
            range_gate_names = [str(row["name"]) for row in range_gate_rows]
            if (
                range_gate_schema.get("feature_count") != 109
                or range_gate_schema.get("dtype") != "float64"
                or len(range_gate_names) != 109
                or any(int(row["index"]) != index for index, row in enumerate(range_gate_rows))
                or any(row.get("dtype") != "float64" for row in range_gate_rows)
            ):
                raise ValueError(
                    "range reliability schema must be an ordered 109-column float64 contract"
                )
            range_gate_payload = joblib.load(range_gate_model_path)
            if list(range_gate_payload.get("feature_names", [])) != range_gate_names:
                raise ValueError("range reliability joblib feature order does not match schema")
            range_gate_runtime = range_runtime.get("reliability_gates", {}).get("range", {})
            if (
                int(range_gate_runtime.get("feature_count", 0)) != 109
                or range_gate_runtime.get("independent_from_year_gate") is not True
                or abs(
                    float(range_gate_runtime.get("threshold", 0.0))
                    - 0.33853178198144895
                )
                > 1e-15
            ):
                raise ValueError("runtime_config.json does not expose the frozen range gate")
            range_gate_reference = load_json(
                bundle / "current_event_range_reliability_prediction_reference.json"
            )
            range_gate_reference_rows = list(range_gate_reference.get("rows", []))
            if (
                len(range_gate_reference_rows) != 64
                or list(range_gate_reference.get("feature_names", [])) != range_gate_names
            ):
                raise ValueError("range reliability reference must contain 64 ordered rows")
            range_gate_matrix = np.asarray(
                [row["feature_values"] for row in range_gate_reference_rows],
                dtype=np.float64,
            )
            range_gate_first = np.asarray(
                range_gate_payload["model"].predict_proba(range_gate_matrix)[:, 1],
                dtype=np.float64,
            )
            range_gate_second = np.asarray(
                range_gate_payload["model"].predict_proba(range_gate_matrix)[:, 1],
                dtype=np.float64,
            )
            range_gate_expected = np.asarray(
                [float(row["expected_score"]) for row in range_gate_reference_rows],
                dtype=np.float64,
            )
            range_gate_max_delta = float(
                np.max(np.abs(range_gate_first - range_gate_expected))
            )
            if (
                not np.array_equal(range_gate_first, range_gate_second)
                or range_gate_max_delta > 1e-12
            ):
                raise ValueError("range reliability reference or determinism check failed")
            threshold = float(range_gate_payload["threshold"])
            accepted = [bool(score >= threshold) for score in range_gate_first]
            expected_accepted = [
                bool(row["expected_accepted"]) for row in range_gate_reference_rows
            ]
            if accepted != expected_accepted:
                raise ValueError("range reliability threshold reference mismatch")
            dual_gate_reference = load_json(bundle / "dual_gate_raw_prediction_reference.json")
            dual_states = {
                row["caseId"]: row["expectedResult"]
                for row in dual_gate_reference.get("rows", [])
            }
            if (
                len(dual_states) != 3
                or dual_states.get("full_advice", {}).get("status") != "advice"
                or len(dual_states.get("full_advice", {}).get("suggestions", [])) != 5
                or dual_states.get("range_only", {}).get("status") != "range_advice"
                or dual_states.get("range_only", {}).get("eventRange") is None
                or dual_states.get("range_only", {}).get("suggestions") != []
                or dual_states.get("range_rejected", {}).get("status")
                != "evidence_insufficient"
                or dual_states.get("range_rejected", {}).get("eventRange") is not None
            ):
                raise ValueError("dual gate reference does not contain the three frozen states")
            range_gate_result = {
                "featureCount": len(range_gate_names),
                "featureDtype": str(range_gate_matrix.dtype),
                "predictionReferenceRows": len(range_gate_reference_rows),
                "predictionMaxAbsDelta": range_gate_max_delta,
                "threshold": threshold,
                "deterministic": True,
                "dualGateStates": sorted(dual_states),
            }

    return {
        "ok": True,
        "bundleVersion": manifest["bundle_version"],
        "featureCount": len(feature_names),
        "featureDtype": str(matrix.dtype),
        "featureOrderMatchesJoblib": True,
        "predictionReferenceRows": len(rows),
        "predictionMaxAbsDelta": max_abs_delta,
        "deterministic": True,
        "selectorLoaded": True,
        "reliabilityFeatureCount": len(reliability_names),
        "reliabilityFeatureDtype": "float64",
        "reliabilityOrderMatchesJoblib": True,
        "singleEventRange": range_result,
        "rangeReliabilityGate": range_gate_result,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.bundle.resolve()), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
