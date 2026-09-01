from __future__ import annotations

import gzip
import importlib.util
import json
from pathlib import Path

import pytest
import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "train-online-unified-distillation.py"
SPEC = importlib.util.spec_from_file_location("train_online_unified", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_attempt(path: Path, attempt_id: str, file_id: str) -> None:
    payload = {
        "attemptId": attempt_id,
        "fileId": file_id,
        "family": "Clean",
        "targetIdentity": {"eventType": "noEvent", "shiftYears": 0},
        "workflowOracle": True,
        "operationRows": [{
            "packageId": f"package:{attempt_id}",
            "eventType": "noEvent",
            "shiftYears": 0,
            "label": 1,
            "features": {"clean_score": 1},
        }],
        "locationRows": [],
    }
    with gzip.open(path, "wt", encoding="utf8") as handle:
        handle.write(json.dumps(payload) + "\n")


def test_loads_multiple_frozen_input_shards(tmp_path: Path) -> None:
    first = tmp_path / "events.ndjson.gz"
    second = tmp_path / "clean.ndjson.gz"
    write_attempt(first, "events:1", "file-a")
    write_attempt(second, "clean:1", "file-b")

    rows, attempts = MODULE.load_operation_rows([first, second])

    assert len(rows) == 2
    assert set(attempts) == {"events:1", "clean:1"}


def test_rejects_duplicate_attempt_ids_across_shards(tmp_path: Path) -> None:
    first = tmp_path / "first.ndjson.gz"
    second = tmp_path / "second.ndjson.gz"
    write_attempt(first, "same:1", "file-a")
    write_attempt(second, "same:1", "file-b")

    with pytest.raises(ValueError, match="duplicate attempt id"):
        MODULE.load_operation_rows([first, second])


def test_prefers_exact_identity_over_workflow_equivalent_operation(tmp_path: Path) -> None:
    path = tmp_path / "graded.ndjson.gz"
    payload = {
        "attemptId": "event:1",
        "fileId": "file-a",
        "family": "A",
        "targetIdentity": {"eventType": "missingRing", "shiftYears": -1},
        "workflowOracle": True,
        "operationRows": [
            {
                "packageId": "exact",
                "eventType": "missingRing",
                "shiftYears": -1,
                "label": 1,
                "features": {"score": 1},
            },
            {
                "packageId": "equivalent",
                "eventType": "partialMove",
                "shiftYears": -4,
                "label": 1,
                "features": {"score": 1},
            },
            {
                "packageId": "wrong",
                "eventType": "falseRing",
                "shiftYears": 1,
                "label": 0,
                "features": {"score": 1},
            },
        ],
        "locationRows": [],
    }
    with gzip.open(path, "wt", encoding="utf8") as handle:
        handle.write(json.dumps(payload) + "\n")

    rows, _ = MODULE.load_operation_rows([path])
    relevance = dict(zip(rows["package_id"], rows["label"], strict=True))

    assert relevance == {"exact": 2, "equivalent": 1, "wrong": 0}


def test_adds_only_base_prediction_outputs_as_stacking_features(tmp_path: Path) -> None:
    path = tmp_path / "base.csv"
    path.write_text(
        "attempt_id,predicted_event_type,predicted_shift_years,"
        "predicted_start_year,predicted_end_year,predicted_top_year,"
        "target_event_type,target_year\n"
        "event:1,missingRing,-1,1847,1853,1850,falseRing,1900\n",
        encoding="utf8",
    )
    predictions = MODULE.load_base_predictions(path)
    frame = pd.DataFrame.from_records([
        {
            "attempt_id": "event:1",
            "event_type": "missingRing",
            "shift_years": -1,
        },
        {
            "attempt_id": "event:1",
            "event_type": "falseRing",
            "shift_years": 1,
        },
    ])

    MODULE.append_base_operation_features(frame, predictions)

    assert set(predictions["event:1"]) == {
        "event_type", "shift_years", "start_year", "end_year", "top_year",
    }
    assert frame.loc[0, "base_identity_match"] == 1
    assert frame.loc[1, "base_identity_match"] == 0
    assert frame.loc[1, "base_pair_falseRing_missingRing"] == 1
