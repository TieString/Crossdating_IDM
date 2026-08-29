#!/usr/bin/env python3
"""Project a new two-stage decision through an immutable primary-package checkpoint."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-top", required=True)
    parser.add_argument("--two-stage-top", required=True)
    parser.add_argument("--operation-rows")
    parser.add_argument("--operation-oof-scores")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    baseline = pd.read_csv(args.baseline_top).set_index("attempt_id", drop=False)
    challenger = pd.read_csv(args.two_stage_top).set_index("attempt_id", drop=False)
    if set(baseline.index) != set(challenger.index):
        raise RuntimeError("baseline and challenger attempts differ")
    challenger = challenger.loc[baseline.index].copy()
    same_identity = challenger["identity_group"].eq(baseline["identity_group"])
    package_columns = [
        column
        for column in (
            "location_correct",
            "selected_package_correct",
            "strict_package_correct",
            "selected_candidate_source",
            "selected_candidate_year",
            "final_correct",
            "strict_correct",
            "final_strict_correct",
            "candidate_has_response",
        )
        if column in baseline and column in challenger
    ]
    challenger.loc[same_identity, package_columns] = baseline.loc[
        same_identity, package_columns
    ]
    challenger["decision_source"] = "two_stage_identity_change"
    challenger.loc[same_identity, "decision_source"] = (
        "immutable_primary_package_checkpoint"
    )

    safety = None
    if args.operation_rows or args.operation_oof_scores:
        if not args.operation_rows or not args.operation_oof_scores:
            raise RuntimeError("operation rows and OOF scores must be provided together")
        rows = pd.read_pickle(args.operation_rows).reset_index(drop=True)
        scores = pd.read_pickle(args.operation_oof_scores).reset_index(drop=True)
        if not rows["identity_group"].equals(scores["identity_group"]):
            raise RuntimeError("operation OOF scores do not match candidate rows")
        score_lookup = pd.Series(
            scores["selection_oof_score"].to_numpy(),
            index=pd.MultiIndex.from_arrays([
                rows["attempt_id"], rows["identity_group"]
            ]),
        )
        margins = []
        for attempt_id in baseline.index:
            new_key = (attempt_id, challenger.at[attempt_id, "identity_group"])
            old_key = (attempt_id, baseline.at[attempt_id, "identity_group"])
            new_score = float(score_lookup.get(new_key, float("nan")))
            old_score = float(score_lookup.get(old_key, float("nan")))
            margins.append(new_score - old_score)
        challenger["identity_change_margin"] = margins
        thresholds = sorted(
            set(challenger.loc[~same_identity, "identity_change_margin"].dropna())
        )
        best = None
        best_frame = None
        for threshold in [float("inf"), *thresholds]:
            accepted = (~same_identity) & challenger[
                "identity_change_margin"
            ].gt(threshold)
            projected = baseline.copy()
            common = projected.columns.intersection(challenger.columns)
            projected.loc[accepted, common] = challenger.loc[accepted, common]
            event_mask = projected["family"].ne("Clean")
            old_event = baseline.loc[event_mask]
            new_event = projected.loc[event_mask]
            regressions = int((
                old_event["final_correct"].eq(1)
                & new_event["final_correct"].eq(0)
            ).sum())
            correct = int(new_event["final_correct"].sum())
            candidate = (regressions, -correct, -int(accepted.sum()), threshold)
            if best is None or candidate < best:
                best = candidate
                best_frame = projected
        challenger = best_frame
        challenger["decision_source"] = "immutable_primary_package_checkpoint"
        accepted = challenger["identity_group"].ne(baseline["identity_group"])
        challenger.loc[accepted, "decision_source"] = "calibrated_identity_change"
        safety = {
            "identityChangeThreshold": float(best[3]),
            "acceptedIdentityChanges": int(accepted.sum()),
        }

    event = challenger[challenger["family"].ne("Clean")]
    clean = challenger[challenger["family"].eq("Clean")]
    baseline_event = baseline[baseline["family"].ne("Clean")]
    correct_to_wrong = (
        baseline_event["final_correct"].eq(1)
        & event["final_correct"].eq(0)
    )
    wrong_to_correct = (
        baseline_event["final_correct"].eq(0)
        & event["final_correct"].eq(1)
    )
    payload = {
        "schemaVersion": 1,
        "analysisOnly": True,
        "candidateGeneratorFrozen": True,
        "sameIdentityKeepsPrimaryPackage": True,
        "sameIdentityAttempts": int(same_identity.sum()),
        "changedIdentityAttempts": int((~same_identity).sum()),
        "correct": int(event["final_correct"].sum()),
        "events": len(event),
        "accuracy": float(event["final_correct"].mean()),
        "strictAccuracy": float(event["final_strict_correct"].mean()),
        "correctToWrong": int(correct_to_wrong.sum()),
        "wrongToCorrect": int(wrong_to_correct.sum()),
        "cleanFalsePositives": int(clean["candidate_has_response"].sum()),
        "byFamily": {
            str(family): {
                "correct": int(group["final_correct"].sum()),
                "events": len(group),
                "accuracy": float(group["final_correct"].mean()),
            }
            for family, group in event.groupby("family", sort=True)
        },
    }
    if safety is not None:
        payload["safetyCalibration"] = safety
    challenger.to_csv(output / "checkpoint-top.csv", index=False)
    (output / "summary.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"outputDir": str(output), **payload}, ensure_ascii=False))


if __name__ == "__main__":
    main()
