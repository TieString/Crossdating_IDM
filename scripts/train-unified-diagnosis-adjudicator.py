#!/usr/bin/env python3
"""Train and evaluate one candidate-ranking + reject model on diagnosis audits."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold


EVENT_TYPES = {"missingRing", "falseRing", "partialMove", "wholeSeriesMove"}
STAGES = (
    ("candidate", "candidateProjectedEvents"),
    ("detected", "detectedBeforeFusion"),
    ("fused", "detectedAfterFusion"),
    ("retained", "retainedAfterEndpointGuard"),
    ("displayed", "displayedBeforeLocator"),
    ("final", "finalEvents"),
)
SKIP_RECURSION = {"rows", "lagResults", "notes", "rankedYears", "ledger"}
SOURCE_FLAGS = (
    "product",
    "product_primary",
    "product_alternative",
    "stage_final",
    "stage_displayed",
    "stage_early",
    "joint",
    "counterfactual",
    "bounded_raw",
    "bounded_cofecha",
    "raw_path",
    "candidate",
    "stable",
    "sequential",
    "reference",
    "whole",
    "positive",
    "unit_pulse",
    "operation_grid",
    "dynamic_selection",
    "unit_selection",
    "review_location",
    "raw_path_events",
    "cofecha_path_events",
    "bounded_near",
    "zero_terminal",
    "path_frontier",
    "path_second",
    "path_later",
)

NUMERIC_EVIDENCE_FIELDS = (
    "dynamic_score",
    "best_raw_gain",
    "best_difference_gain",
    "best_combined_gain",
    "top_three_difference_gain",
    "remote_difference_margin",
    "shift_score_margin",
    "baseline_correlation",
    "corrected_correlation",
    "claim_count",
    "location_evidence_count",
)


def number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def integer(value: Any) -> int | None:
    parsed = number(value)
    return int(parsed) if parsed is not None and float(parsed).is_integer() else None


def boolean(value: Any) -> bool:
    return value is True or str(value).lower() == "true"


def implied_shift(event_type: str, shift: Any) -> int | None:
    if event_type == "missingRing":
        return -1
    if event_type == "falseRing":
        return 1
    return integer(shift)


def ranked_year(value: dict[str, Any]) -> int | None:
    ranked = value.get("rankedYears") or []
    return integer(
        value.get("topYear")
        or value.get("bestYear")
        or value.get("reviewTopYear")
        or value.get("selectedYear")
        or (ranked[0].get("year") if ranked else None)
    )


def source_flags(source: str, algorithms: Iterable[str]) -> set[str]:
    text = f"{source} {' '.join(algorithms)}".lower()
    flags: set[str] = set()
    if "product" in text:
        flags.add("product")
    if "product.primary" in text:
        flags.add("product_primary")
    if "product.alternative" in text:
        flags.add("product_alternative")
    if "stage.final" in text:
        flags.add("stage_final")
    if "stage.displayed" in text:
        flags.add("stage_displayed")
    if any(token in text for token in ("stage.candidate", "stage.detected", "stage.fused", "stage.retained")):
        flags.add("stage_early")
    if "joint" in text:
        flags.add("joint")
    if any(token in text for token in ("counterfactual", ".operations", "dynamicselection", "unitselection")):
        flags.add("counterfactual")
    if "boundedcofecha" in text or "reference_view=cofecha" in text:
        flags.add("bounded_cofecha")
    if "boundedraw" in text or "bounded_complete_lag_path" in text:
        flags.add("bounded_raw")
    if "rawpath" in text or "piecewise_lag_path" in text:
        flags.add("raw_path")
    if "candidate" in text:
        flags.add("candidate")
    if "stable" in text:
        flags.add("stable")
    if "sequential" in text or "staircase" in text:
        flags.add("sequential")
    if "reference" in text or "paired" in text:
        flags.add("reference")
    if "whole" in text:
        flags.add("whole")
    if "positive" in text or "false_ring" in text:
        flags.add("positive")
    if "unitpulse" in text or "unit_pulse" in text:
        flags.add("unit_pulse")
    if ".operations[" in text:
        flags.add("operation_grid")
    if ".dynamicselection" in text:
        flags.add("dynamic_selection")
    if ".unitselection" in text:
        flags.add("unit_selection")
    if ".reviewlocationprofiles" in text:
        flags.add("review_location")
    if ".rawpathevents[" in text:
        flags.add("raw_path_events")
    if ".cofechapathevents[" in text:
        flags.add("cofecha_path_events")
    if "boundedrawnear" in text:
        flags.add("bounded_near")
    if "zeroterminal" in text:
        flags.add("zero_terminal")
    if re.search(r"\.events\[0\]", text) or re.search(r"pathevents\[0\]", text):
        flags.add("path_frontier")
    elif re.search(r"\.events\[1\]", text) or re.search(r"pathevents\[1\]", text):
        flags.add("path_second")
    elif re.search(r"\.events\[(?:[2-9]|\d{2,})\]", text) or re.search(r"pathevents\[(?:[2-9]|\d{2,})\]", text):
        flags.add("path_later")
    return flags


@dataclass(frozen=True)
class Candidate:
    event_type: str
    shift_years: int | None
    start_year: int | None
    end_year: int | None
    top_year: int | None
    score: float | None
    score_margin: float | None
    correlation_gain: float | None
    sample_pairs: float | None
    dynamic_score: float | None
    best_raw_gain: float | None
    best_difference_gain: float | None
    best_combined_gain: float | None
    top_three_difference_gain: float | None
    remote_difference_margin: float | None
    shift_score_margin: float | None
    baseline_correlation: float | None
    corrected_correlation: float | None
    claim_count: float | None
    location_evidence_count: float | None
    confidence: str
    lag_before: float | None
    lag_after: float | None
    source: str
    flags: frozenset[str]
    hard_gate: bool

    @property
    def center(self) -> int | None:
        if self.top_year is not None:
            return self.top_year
        if self.start_year is not None and self.end_year is not None:
            return round((self.start_year + self.end_year) / 2)
        return None

    @property
    def signature(self) -> tuple[Any, ...]:
        if self.event_type == "wholeSeriesMove":
            return (self.event_type, self.shift_years)
        return (
            self.event_type,
            self.shift_years,
            self.start_year,
            self.end_year,
            self.top_year,
        )


def normalize_candidate(value: Any, source: str) -> Candidate | None:
    if not isinstance(value, dict) or value.get("eventType") not in EVENT_TYPES:
        return None
    event_type = value["eventType"]
    top_year = ranked_year(value)
    start_year = integer(value.get("startYear"))
    end_year = integer(value.get("endYear"))
    if event_type != "wholeSeriesMove" and (start_year is None or end_year is None) and top_year is not None:
        start_year, end_year = top_year - 6, top_year + 6
    evidence = value.get("evidence") if isinstance(value.get("evidence"), dict) else {}
    algorithms = list(value.get("algorithmSources") or evidence.get("algorithmSources") or value.get("sources") or [])
    notes = list(value.get("notes") or evidence.get("notes") or [])
    return Candidate(
        event_type=event_type,
        shift_years=implied_shift(event_type, value.get("shiftYears")),
        start_year=start_year,
        end_year=end_year,
        top_year=top_year,
        score=number(
            value.get("score")
            or value.get("dynamicScore")
            or value.get("topThreeDifferenceGain")
            or value.get("bestCombinedGain")
            or evidence.get("score")
        ),
        score_margin=number(value.get("scoreMargin") or value.get("remoteDifferenceMargin") or evidence.get("scoreMargin")),
        correlation_gain=number(value.get("correlationGain") or value.get("bestCombinedGain") or evidence.get("correlationGain")),
        sample_pairs=number(value.get("samplePairs") or evidence.get("samplePairs")),
        dynamic_score=number(value.get("dynamicScore")),
        best_raw_gain=number(value.get("bestRawGain")),
        best_difference_gain=number(value.get("bestDifferenceGain")),
        best_combined_gain=number(value.get("bestCombinedGain")),
        top_three_difference_gain=number(value.get("topThreeDifferenceGain")),
        remote_difference_margin=number(value.get("remoteDifferenceMargin")),
        shift_score_margin=number(value.get("shiftScoreMargin")),
        baseline_correlation=number(value.get("baselineCorrelation")),
        corrected_correlation=number(value.get("correctedCorrelation")),
        claim_count=number(value.get("claimCount")),
        location_evidence_count=number(value.get("locationEvidenceCount")),
        confidence=str(value.get("confidence") or value.get("confidenceLevel") or ""),
        lag_before=number(value.get("lagBefore") or evidence.get("lagBefore")),
        lag_after=number(value.get("lagAfter") or evidence.get("lagAfter")),
        source=source,
        flags=frozenset(source_flags(source, algorithms)),
        hard_gate="candidate_hard_gate_passed" in notes,
    )


def collect_recursive(root: Any, source: str = "grid") -> list[Candidate]:
    candidates: list[Candidate] = []
    visited: set[int] = set()

    def visit(value: Any, path: str, depth: int) -> None:
        if not isinstance(value, (dict, list)) or depth > 10 or id(value) in visited:
            return
        visited.add(id(value))
        if isinstance(value, list):
            for index, nested in enumerate(value):
                visit(nested, f"{path}[{index}]", depth + 1)
            return
        candidate = normalize_candidate(value, path)
        if candidate is not None:
            candidates.append(candidate)
        for key, nested in value.items():
            if key not in SKIP_RECURSION:
                visit(nested, f"{path}.{key}", depth + 1)

    visit(root, source, 0)
    return dedupe_raw(candidates)


def dedupe_raw(candidates: Iterable[Candidate]) -> list[Candidate]:
    seen: set[tuple[Any, ...]] = set()
    result: list[Candidate] = []
    for candidate in candidates:
        key = (*candidate.signature, candidate.source)
        if key not in seen:
            seen.add(key)
            result.append(candidate)
    return result


def truth_for(step: dict[str, Any]) -> dict[str, Any] | None:
    event_type = step.get("diagnosedTruthType") or step.get("acceptedTruthType")
    if event_type not in EVENT_TYPES:
        return None
    return {
        "event_type": event_type,
        "year": integer(step.get("diagnosedTruthYear") or step.get("acceptedTruthYear")),
        "shift_years": implied_shift(
            event_type,
            step.get("diagnosedTruthShiftYears") or step.get("acceptedTruthShiftYears"),
        ),
    }


def operation_matches(candidate: Candidate, truth: dict[str, Any], relaxed: bool = False) -> bool:
    if candidate.event_type == truth["event_type"]:
        if truth["event_type"] in {"partialMove", "wholeSeriesMove"}:
            return candidate.shift_years == truth["shift_years"]
        return True
    return (
        relaxed
        and truth["event_type"] == "missingRing"
        and candidate.event_type == "partialMove"
        and (candidate.shift_years or 0) < -1
    )


def location_matches(candidate: Candidate, truth: dict[str, Any]) -> bool:
    if truth["event_type"] == "wholeSeriesMove":
        return True
    year = truth["year"]
    if year is None:
        return False
    if candidate.start_year is not None and candidate.end_year is not None:
        return candidate.start_year <= year <= candidate.end_year
    return candidate.top_year is not None and abs(candidate.top_year - year) <= 6


def load_audits(run_dir: Path) -> dict[str, dict[str, Any]]:
    audits: dict[str, dict[str, Any]] = {}
    for path in (run_dir / "workers").rglob("diagnosis-audit.json"):
        match = re.search(r"case-(\d+)-step-(\d+)$", path.parent.name)
        if match:
            audits[f"{match.group(1)}:{match.group(2)}"] = json.loads(path.read_text(encoding="utf8"))
    return audits


def snapshot_for(audit_file: dict[str, Any] | None) -> dict[str, Any] | None:
    if not audit_file:
        return None
    if audit_file.get("after", {}).get("audit"):
        return audit_file["after"]
    if audit_file.get("before", {}).get("audit"):
        return audit_file["before"]
    return audit_file.get("after") or audit_file.get("before")


def exact_groups(candidates: list[Candidate]) -> dict[tuple[Any, ...], list[Candidate]]:
    groups: dict[tuple[Any, ...], list[Candidate]] = defaultdict(list)
    for candidate in candidates:
        groups[candidate.signature].append(candidate)
    return groups


def compatible(left: Candidate, right: Candidate) -> bool:
    if left.event_type != right.event_type or left.shift_years != right.shift_years:
        return False
    if left.event_type == "wholeSeriesMove":
        return True
    return left.center is not None and right.center is not None and abs(left.center - right.center) <= 4


def make_candidate_rows(
    run_dir: Path,
    run_tag: str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    tag = run_tag or run_dir.name
    steps = json.loads((run_dir / "steps.json").read_text(encoding="utf8"))
    audits = load_audits(run_dir)
    rows: list[dict[str, Any]] = []
    attempts: list[dict[str, Any]] = []
    for step in steps:
        attempt_id = f"{tag}:{step['caseIndex']}:{step['step']}"
        truth = truth_for(step)
        is_clean = step.get("family") == "Clean"
        audit_id = f"{step['caseIndex']}:{step['step']}"
        snapshot = snapshot_for(audits.get(audit_id))
        audit = (snapshot or {}).get("audit") or {}
        raw: list[Candidate] = []
        for stage, field in STAGES:
            raw.extend(filter(None, (
                normalize_candidate(value, f"stage.{stage}")
                for value in audit.get(field, [])
            )))
        raw.extend(filter(None, (
            normalize_candidate(value, "joint.hypothesis")
            for value in (((snapshot or {}).get("operationGrid") or {}).get("jointDecision") or {}).get("hypotheses", [])
        )))
        raw.extend(collect_recursive({
            "operationGrid": (snapshot or {}).get("operationGrid"),
            "stableBoundedPathEvidence": audit.get("stableBoundedPathEvidence"),
            "positiveUnitChainEvidence": audit.get("positiveUnitChainEvidence"),
            "localLagTransitionEvidence": audit.get("localLagTransitionEvidence"),
            "terminalUnitStaircaseEvidence": audit.get("terminalUnitStaircaseEvidence"),
        }))
        primary = step.get("primary")
        product: Candidate | None = None
        if isinstance(primary, dict):
            product = normalize_candidate(primary, "product.primary")
            if product:
                raw.append(product)
        alternative = step.get("alternative")
        product_alt: Candidate | None = None
        if isinstance(alternative, dict):
            product_alt = normalize_candidate(alternative, "product.alternative")
            if product_alt:
                raw.append(product_alt)
        raw = dedupe_raw(raw)
        source_scores: dict[str, list[float]] = defaultdict(list)
        for candidate in raw:
            if candidate.score is not None:
                source_scores[candidate.source].append(candidate.score)
        source_percentile: dict[tuple[str, tuple[Any, ...]], float] = {}
        for source, scores in source_scores.items():
            ordered = sorted(scores)
            for candidate in (item for item in raw if item.source == source and item.score is not None):
                rank = np.searchsorted(ordered, candidate.score, side="right")
                source_percentile[(source, candidate.signature)] = rank / len(ordered)
        groups = exact_groups(raw)
        target_range = audit.get("targetRange") or {}
        target_start = integer(target_range.get("startYear"))
        target_end = integer(target_range.get("endYear"))
        target_length = (target_end - target_start + 1) if target_start is not None and target_end is not None else None
        primary_type = primary.get("eventType") if isinstance(primary, dict) else "none"
        primary_shift = implied_shift(primary_type, primary.get("shiftYears")) if isinstance(primary, dict) else None
        primary_top = ranked_year(primary) if isinstance(primary, dict) else None
        primary_start = integer(primary.get("startYear")) if isinstance(primary, dict) else None
        primary_end = integer(primary.get("endYear")) if isinstance(primary, dict) else None
        package_alternative_type = product_alt.event_type if product_alt else "none"
        package_alternative_shift = product_alt.shift_years if product_alt else 0
        package_alternative_top = product_alt.center if product_alt else None
        package_alternative_start = product_alt.start_year if product_alt else None
        package_alternative_end = product_alt.end_year if product_alt else None
        context_counts = Counter(candidate.event_type for candidate in raw)
        operation_candidates = [
            candidate for candidate in raw if "operation_grid" in candidate.flags
        ]
        attempts.append({
            "attempt_id": attempt_id,
            "case_index": step["caseIndex"],
            "case_id": step["caseId"],
            "step": step["step"],
            "file_id": step["fileId"],
            "family": step["family"],
            "target_id": step["targetId"],
            "is_clean": is_clean,
            "truth_type": truth["event_type"] if truth else "",
            "truth_year": truth["year"] if truth else None,
            "truth_shift_years": truth["shift_years"] if truth else None,
            "product_correct": boolean(step.get("workflowSuggestionCorrect")),
            "product_response": boolean(step.get("response")),
        })
        for signature, exact in groups.items():
            representative = max(
                exact,
                key=lambda candidate: (
                    "product" in candidate.flags,
                    "stage_final" in candidate.flags,
                    candidate.score if candidate.score is not None else -math.inf,
                ),
            )
            support = [candidate for candidate in raw if compatible(representative, candidate)]
            scores = [candidate.score for candidate in support if candidate.score is not None]
            margins = [candidate.score_margin for candidate in support if candidate.score_margin is not None]
            gains = [candidate.correlation_gain for candidate in support if candidate.correlation_gain is not None]
            pairs = [candidate.sample_pairs for candidate in support if candidate.sample_pairs is not None]
            centers = [candidate.center for candidate in support if candidate.center is not None]
            flags = Counter(flag for candidate in support for flag in candidate.flags)
            exact_flags = Counter(flag for candidate in exact for flag in candidate.flags)
            center = representative.center
            width = (
                representative.end_year - representative.start_year + 1
                if representative.start_year is not None and representative.end_year is not None
                else 0
            )
            operation_ok = operation_matches(representative, truth) if truth else False
            location_ok = location_matches(representative, truth) if truth else False
            row = {
                "attempt_id": attempt_id,
                "case_index": step["caseIndex"],
                "case_id": step["caseId"],
                "step": step["step"],
                "file_id": step["fileId"],
                "family": step["family"],
                "target_id": step["targetId"],
                "is_clean": int(is_clean),
                "truth_type": truth["event_type"] if truth else "",
                "truth_year": truth["year"] if truth else None,
                "truth_shift_years": truth["shift_years"] if truth else None,
                "product_correct": int(boolean(step.get("workflowSuggestionCorrect"))),
                "candidate_event_type": representative.event_type,
                "candidate_shift_years": representative.shift_years or 0,
                "candidate_shift_abs": abs(representative.shift_years or 0),
                "candidate_start_year": representative.start_year,
                "candidate_end_year": representative.end_year,
                "candidate_top_year": representative.top_year,
                "candidate_width": width,
                "label_strict": int(bool(truth and operation_ok and location_ok)),
                "label_relaxed": int(bool(truth and operation_matches(representative, truth, True) and location_ok)),
                "operation_correct": int(operation_ok),
                "location_correct": int(location_ok),
                "primary_event_type": primary_type,
                "primary_shift_years": primary_shift or 0,
                "same_primary_type": int(representative.event_type == primary_type),
                "same_primary_shift": int(representative.event_type == primary_type and representative.shift_years == primary_shift),
                "primary_top_distance": abs(center - primary_top) if center is not None and primary_top is not None else -1,
                "primary_window_overlap": max(
                    0,
                    min(representative.end_year, primary_end) - max(representative.start_year, primary_start) + 1,
                ) if None not in (representative.start_year, representative.end_year, primary_start, primary_end) else 0,
                "package_has_alternative": int(product_alt is not None),
                "package_identity_count": len({
                    (candidate.event_type, candidate.shift_years)
                    for candidate in (product, product_alt)
                    if candidate is not None
                }),
                "package_alternative_event_type": package_alternative_type,
                "package_alternative_shift_years": package_alternative_shift or 0,
                "package_alternative_shift_abs": abs(package_alternative_shift or 0),
                "package_alternative_confidence": product_alt.confidence if product_alt else "none",
                "package_alternative_score": product_alt.score or 0 if product_alt else 0,
                "package_alternative_score_margin": product_alt.score_margin or 0 if product_alt else 0,
                "package_alternative_correlation_gain": product_alt.correlation_gain or 0 if product_alt else 0,
                "package_alternative_sample_pairs": product_alt.sample_pairs or 0 if product_alt else 0,
                "package_alternative_lag_before": product_alt.lag_before or 0 if product_alt else 0,
                "package_alternative_lag_after": product_alt.lag_after or 0 if product_alt else 0,
                "same_package_alternative_type": int(
                    representative.event_type == package_alternative_type
                ),
                "same_package_alternative_shift": int(
                    representative.event_type == package_alternative_type
                    and representative.shift_years == package_alternative_shift
                ),
                "package_alternative_top_distance": (
                    abs(center - package_alternative_top)
                    if center is not None and package_alternative_top is not None
                    else -1
                ),
                "package_alternative_window_overlap": max(
                    0,
                    min(representative.end_year, package_alternative_end)
                    - max(representative.start_year, package_alternative_start)
                    + 1,
                ) if None not in (
                    representative.start_year,
                    representative.end_year,
                    package_alternative_start,
                    package_alternative_end,
                ) else 0,
                "package_primary_alternative_top_distance": (
                    abs(primary_top - package_alternative_top)
                    if primary_top is not None and package_alternative_top is not None
                    else -1
                ),
                "package_primary_alternative_window_overlap": max(
                    0,
                    min(primary_end, package_alternative_end)
                    - max(primary_start, package_alternative_start)
                    + 1,
                ) if None not in (
                    primary_start,
                    primary_end,
                    package_alternative_start,
                    package_alternative_end,
                ) else 0,
                "target_length": target_length or 0,
                "center_from_start": center - target_start if center is not None and target_start is not None else -1,
                "center_to_end": target_end - center if center is not None and target_end is not None else -1,
                "center_fraction": (center - target_start) / max(1, target_length - 1) if center is not None and target_start is not None and target_length else -1,
                "cofecha_flagged": int(bool(audit.get("cofechaFlagged"))),
                "reference_source_count": integer(audit.get("referenceSourceCount")) or 0,
                "minimum_reference_depth": number(audit.get("minimumReferenceDepth")) or 0,
                "median_reference_depth": number(audit.get("medianReferenceDepth")) or 0,
                "candidate_count": integer(audit.get("candidateCount")) or 0,
                "candidate_mode_count": integer(audit.get("candidateModeCount")) or 0,
                "automatic_semantics_rejected": integer(audit.get("automaticSemanticsRejectedCount")) or 0,
                "final_reason": str(audit.get("finalReason") or "none"),
                "raw_candidate_count": len(raw),
                "hypothesis_count": len(groups),
                "raw_missing_count": context_counts["missingRing"],
                "raw_false_count": context_counts["falseRing"],
                "raw_partial_count": context_counts["partialMove"],
                "raw_whole_count": context_counts["wholeSeriesMove"],
                "exact_support": len(exact),
                "near_support": len(support),
                "exact_source_count": len({candidate.source for candidate in exact}),
                "near_source_count": len({candidate.source for candidate in support}),
                "center_span": max(centers) - min(centers) if centers else 0,
                "center_std": float(np.std(centers)) if centers else 0,
                "score_max": max(scores) if scores else 0,
                "score_mean": float(np.mean(scores)) if scores else 0,
                "score_std": float(np.std(scores)) if scores else 0,
                "score_margin_max": max(margins) if margins else 0,
                "score_margin_mean": float(np.mean(margins)) if margins else 0,
                "correlation_gain_max": max(gains) if gains else 0,
                "correlation_gain_mean": float(np.mean(gains)) if gains else 0,
                "sample_pairs_max": max(pairs) if pairs else 0,
                "source_percentile_max": max(
                    (source_percentile.get((candidate.source, candidate.signature), 0) for candidate in support),
                    default=0,
                ),
                "hard_gate_support": sum(candidate.hard_gate for candidate in support),
                "confidence": representative.confidence or "none",
                "lag_before": representative.lag_before or 0,
                "lag_after": representative.lag_after or 0,
            }
            for field in NUMERIC_EVIDENCE_FIELDS:
                exact_values = [
                    value
                    for candidate in exact
                    if (value := getattr(candidate, field)) is not None
                ]
                near_values = [
                    value
                    for candidate in support
                    if (value := getattr(candidate, field)) is not None
                ]
                operation_exact_values = [
                    value
                    for candidate in exact
                    if "operation_grid" in candidate.flags
                    and (value := getattr(candidate, field)) is not None
                ]
                operation_near_values = [
                    value
                    for candidate in support
                    if "operation_grid" in candidate.flags
                    and (value := getattr(candidate, field)) is not None
                ]
                operation_type_values = sorted(
                    value
                    for candidate in operation_candidates
                    if candidate.event_type == representative.event_type
                    and (value := getattr(candidate, field)) is not None
                )
                operation_value = (
                    max(operation_exact_values)
                    if operation_exact_values
                    else None
                )
                row[f"representative_{field}"] = getattr(representative, field) or 0
                row[f"exact_{field}_max"] = max(exact_values) if exact_values else 0
                row[f"exact_{field}_mean"] = float(np.mean(exact_values)) if exact_values else 0
                row[f"near_{field}_max"] = max(near_values) if near_values else 0
                row[f"near_{field}_mean"] = float(np.mean(near_values)) if near_values else 0
                row[f"operation_{field}_max"] = operation_value or 0
                row[f"operation_near_{field}_max"] = (
                    max(operation_near_values) if operation_near_values else 0
                )
                row[f"operation_type_{field}_percentile"] = (
                    np.searchsorted(operation_type_values, operation_value, side="right")
                    / len(operation_type_values)
                    if operation_value is not None and operation_type_values
                    else 0
                )
            for flag in SOURCE_FLAGS:
                row[f"source_{flag}"] = flags[flag]
                row[f"exact_{flag}"] = exact_flags[flag]
                row[f"package_alternative_{flag}"] = int(
                    product_alt is not None and flag in product_alt.flags
                )
            row["label_workflow"] = int(
                row["label_relaxed"] == 1
                or (
                    exact_flags["product_primary"] > 0
                    and boolean(step.get("workflowSuggestionCorrect"))
                )
            )
            rows.append(row)
    return pd.DataFrame(rows), pd.DataFrame(attempts)


EXCLUDED_FEATURES = {
    "attempt_id",
    "case_index",
    "case_id",
    "step",
    "file_id",
    "family",
    "target_id",
    "dataset_role",
    "is_clean",
    "truth_type",
    "truth_year",
    "truth_shift_years",
    "product_correct",
    "label_strict",
    "label_relaxed",
    "label_workflow",
    "operation_correct",
    "location_correct",
    "candidate_start_year",
    "candidate_end_year",
    "candidate_top_year",
}
CATEGORICAL_FEATURES = {
    "candidate_event_type",
    "primary_event_type",
    "final_reason",
    "confidence",
    "package_alternative_event_type",
    "package_alternative_confidence",
}


def encoded_features(candidates: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    feature_columns = [column for column in candidates.columns if column not in EXCLUDED_FEATURES]
    values = candidates[feature_columns].copy()
    categorical = [column for column in feature_columns if column in CATEGORICAL_FEATURES]
    values = pd.get_dummies(values, columns=categorical, dtype=float)
    values = values.replace([np.inf, -np.inf], np.nan).fillna(0).astype(float)
    return values, list(values.columns)


def model_for(train_labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(train_labels.sum()))
    negatives = max(1, len(train_labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=350,
        learning_rate=0.03,
        num_leaves=15,
        max_depth=-1,
        min_child_samples=25,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=0.5,
        reg_lambda=2.0,
        scale_pos_weight=min(30.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def ranker_for(seed: int) -> lgb.LGBMRanker:
    return lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=[0, 1],
        n_estimators=300,
        learning_rate=0.03,
        num_leaves=15,
        min_child_samples=30,
        subsample=0.85,
        colsample_bytree=0.8,
        reg_alpha=0.5,
        reg_lambda=2.0,
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def fit_ranker(
    candidates: pd.DataFrame,
    features: pd.DataFrame,
    indices: np.ndarray,
    seed: int,
) -> lgb.LGBMRanker:
    ordered = candidates.iloc[indices].sort_values("attempt_id").index.to_numpy(dtype=int)
    groups = candidates.loc[ordered].groupby("attempt_id", sort=False).size().to_numpy()
    estimator = ranker_for(seed)
    estimator.fit(
        features.loc[ordered],
        candidates.loc[ordered, "label_relaxed"],
        group=groups,
    )
    return estimator


def ranker_cross_validated_predictions(
    candidates: pd.DataFrame,
    features: pd.DataFrame,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    evaluation_mask = candidates["dataset_role"].to_numpy() == "evaluation"
    evaluation_files = np.array(sorted(
        candidates.loc[evaluation_mask, "file_id"].unique()
    ))
    predictions = np.full(len(candidates), np.nan)
    folds = []
    splitter = GroupKFold(n_splits=5)
    for fold, (_, test_file_indices) in enumerate(splitter.split(
        np.zeros(len(evaluation_files)),
        groups=evaluation_files,
    )):
        test_files = set(evaluation_files[test_file_indices])
        train_indices = np.flatnonzero(
            ~candidates["file_id"].isin(test_files).to_numpy()
        )
        test_indices = np.flatnonzero(
            evaluation_mask & candidates["file_id"].isin(test_files).to_numpy()
        )
        estimator = fit_ranker(
            candidates,
            features,
            train_indices,
            12000 + fold,
        )
        predictions[test_indices] = estimator.predict(features.iloc[test_indices])
        folds.append({
            "fold": fold,
            "testFiles": sorted(test_files),
            "trainingCandidates": len(train_indices),
        })
    if np.isnan(predictions[evaluation_mask]).any():
        raise RuntimeError("missing ranker out-of-fold predictions")
    return predictions, folds


def summarize_ranker(
    candidates: pd.DataFrame,
    pairs: pd.DataFrame,
    ranker_predictions: np.ndarray,
) -> tuple[dict[str, Any], pd.DataFrame]:
    evaluation_pairs = pairs[pairs["dataset_role"] == "evaluation"].copy()
    evaluation_pairs["ranker_score"] = ranker_predictions[
        evaluation_pairs["alternative_candidate_index"].to_numpy(dtype=int)
    ]
    operation_pairs = evaluation_pairs[
        evaluation_pairs["same_operation_identity"] == 0
    ]
    ranked = operation_pairs.sort_values(
        ["attempt_id", "ranker_score"],
        ascending=[True, False],
    )
    top = ranked.groupby("attempt_id", sort=False).head(1).copy()
    positive = operation_pairs[operation_pairs["pair_label"] == 1]
    recoverable_attempts = set(positive["attempt_id"])
    top_correct_attempts = set(top.loc[top["pair_label"] == 1, "attempt_id"])
    product_failures = set(top.loc[~top["product_workflow"], "attempt_id"])
    ranks = []
    for attempt_id, group in ranked.groupby("attempt_id", sort=False):
        if attempt_id not in recoverable_attempts:
            continue
        correct_positions = np.flatnonzero(group["pair_label"].to_numpy() == 1)
        ranks.append(int(correct_positions[0] + 1))
    failure_top = top[top["attempt_id"].isin(product_failures)]
    by_family = {}
    for family in ("A", "B", "C", "D"):
        selected = failure_top[failure_top["family"] == family]
        by_family[family] = {
            "productFailures": len(selected),
            "topCorrect": int(selected["pair_label"].sum()),
        }
    summary = {
        "productFailures": len(product_failures),
        "recoverableFailures": len(recoverable_attempts & product_failures),
        "topCorrectFailures": len(top_correct_attempts & product_failures),
        "topCorrectRateAmongRecoverable": rate(
            len(top_correct_attempts & product_failures),
            len(recoverable_attempts & product_failures),
        ),
        "correctCandidateMedianRank": float(np.median(ranks)) if ranks else None,
        "correctCandidateP90Rank": float(np.quantile(ranks, 0.9)) if ranks else None,
        "byFamily": by_family,
    }
    return summary, top


def top_recovery_predictions(
    candidates: pd.DataFrame,
    probabilities: np.ndarray,
) -> pd.DataFrame:
    selected = candidates.copy()
    selected["recovery_probability"] = probabilities[selected.index.to_numpy(dtype=int)]
    product_attempts = set(
        selected.loc[selected["exact_product_primary"] > 0, "attempt_id"]
    )
    selected = selected[~selected["attempt_id"].isin(product_attempts)]
    return selected.sort_values(
        ["attempt_id", "recovery_probability", "near_source_count"],
        ascending=[True, False, False],
    ).groupby("attempt_id", sort=False).head(1).copy()


def evaluate_recovery_threshold(
    top: pd.DataFrame,
    threshold: float,
) -> tuple[dict[str, float], pd.DataFrame]:
    result = top.copy()
    result["selected"] = result["recovery_probability"] >= threshold
    result["model_workflow_correct"] = (
        result["selected"] & result["label_workflow"].astype(bool)
    )
    result["model_strict_correct"] = (
        result["selected"] & result["label_strict"].astype(bool)
    )
    result["model_relaxed_correct"] = (
        result["selected"] & result["label_relaxed"].astype(bool)
    )
    result["model_operation_correct"] = (
        result["selected"] & result["operation_correct"].astype(bool)
    )
    result["model_location_correct"] = (
        result["selected"] & result["location_correct"].astype(bool)
    )
    event = result["is_clean"] == 0
    wrong_event = event & result["selected"] & ~result["label_workflow"].astype(bool)
    clean_false_positive = (
        (result["is_clean"] == 1) & result["selected"]
    )
    metrics = {
        "correctRecoveries": int((event & result["model_workflow_correct"]).sum()),
        "wrongEventRecoveries": int(wrong_event.sum()),
        "cleanFalsePositives": int(clean_false_positive.sum()),
        "responses": int(result["selected"].sum()),
    }
    return metrics, result


def choose_recovery_threshold(
    top: pd.DataFrame,
) -> tuple[float, dict[str, float]]:
    thresholds = sorted(set(
        np.linspace(0.5, 0.995, 100).tolist()
        + top["recovery_probability"].quantile(np.linspace(0.5, 0.999, 80)).tolist()
        + [1.01]
    ))
    options = []
    for threshold in thresholds:
        metrics, _ = evaluate_recovery_threshold(top, float(threshold))
        if metrics["wrongEventRecoveries"] or metrics["cleanFalsePositives"]:
            continue
        key = (
            metrics["correctRecoveries"],
            -metrics["responses"],
            threshold,
        )
        options.append((key, float(threshold), metrics))
    _, threshold, metrics = max(options, key=lambda option: option[0])
    return threshold, metrics


def attempt_predictions(candidates: pd.DataFrame, probabilities: np.ndarray) -> pd.DataFrame:
    scored = candidates[[
        "attempt_id",
        "file_id",
        "family",
        "is_clean",
        "label_strict",
        "label_relaxed",
        "label_workflow",
        "operation_correct",
        "location_correct",
        "candidate_event_type",
        "candidate_shift_years",
        "candidate_start_year",
        "candidate_end_year",
        "candidate_top_year",
    ]].copy()
    scored["probability"] = probabilities
    ordered = scored.sort_values(["attempt_id", "probability"], ascending=[True, False])
    ordered["candidate_rank"] = ordered.groupby("attempt_id", sort=False).cumcount() + 1
    top = ordered[ordered["candidate_rank"] == 1].copy()
    second = ordered[ordered["candidate_rank"] == 2].set_index("attempt_id")["probability"]
    top["second_probability"] = top["attempt_id"].map(second)
    top["second_probability"] = top["second_probability"].fillna(0)
    top["probability_margin"] = top["probability"] - top["second_probability"]
    return top


def evaluate_threshold(top: pd.DataFrame, threshold: float, margin: float) -> dict[str, float]:
    selected = (top["probability"] >= threshold) & (top["probability_margin"] >= margin)
    events = top["is_clean"] == 0
    clean = ~events
    correct = selected & (top["label_workflow"] == 1)
    return {
        "event_accuracy": float(correct[events].mean()) if events.any() else 0,
        "event_response": float(selected[events].mean()) if events.any() else 0,
        "clean_false_positive": float(selected[clean].mean()) if clean.any() else 0,
    }


def choose_gate(top: pd.DataFrame) -> tuple[float, float, dict[str, float]]:
    thresholds = sorted(set(np.linspace(0.05, 0.95, 91).tolist() + top["probability"].quantile(
        np.linspace(0.1, 0.99, 30)
    ).tolist()))
    margins = [0.0, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3]
    candidates: list[tuple[tuple[float, ...], float, float, dict[str, float]]] = []
    for threshold in thresholds:
        for margin in margins:
            metrics = evaluate_threshold(top, float(threshold), margin)
            clean_ok = metrics["clean_false_positive"] <= 0.015
            response_ok = metrics["event_response"] >= 0.94
            key = (
                float(clean_ok and response_ok),
                metrics["event_accuracy"],
                -metrics["clean_false_positive"],
                metrics["event_response"],
                -threshold,
                -margin,
            )
            candidates.append((key, float(threshold), margin, metrics))
    _, threshold, margin, metrics = max(candidates, key=lambda entry: entry[0])
    return threshold, margin, metrics


def residual_attempt_predictions(candidates: pd.DataFrame, probabilities: np.ndarray) -> pd.DataFrame:
    scored = candidates.reset_index(drop=True).copy()
    scored["probability"] = probabilities
    output: list[dict[str, Any]] = []
    for attempt_id, group in scored.groupby("attempt_id", sort=False):
        group = group.sort_values("probability", ascending=False)
        product_rows = group[group["exact_product_primary"] > 0]
        product = product_rows.iloc[0] if not product_rows.empty else None
        alternatives = group.drop(index=product.name) if product is not None else group
        alternative = alternatives.iloc[0] if not alternatives.empty else None
        second = alternatives.iloc[1] if len(alternatives) > 1 else None

        def candidate_fields(prefix: str, row: pd.Series | None) -> dict[str, Any]:
            if row is None:
                return {
                    f"{prefix}_present": False,
                    f"{prefix}_probability": 0.0,
                    f"{prefix}_strict": False,
                    f"{prefix}_relaxed": False,
                    f"{prefix}_workflow": False,
                    f"{prefix}_operation": False,
                    f"{prefix}_location": False,
                    f"{prefix}_event_type": "",
                    f"{prefix}_shift_years": 0,
                    f"{prefix}_start_year": None,
                    f"{prefix}_end_year": None,
                    f"{prefix}_top_year": None,
                }
            return {
                f"{prefix}_present": True,
                f"{prefix}_probability": float(row["probability"]),
                f"{prefix}_strict": bool(row["label_strict"]),
                f"{prefix}_relaxed": bool(row["label_relaxed"]),
                f"{prefix}_workflow": bool(row["label_workflow"]),
                f"{prefix}_operation": bool(row["operation_correct"]),
                f"{prefix}_location": bool(row["location_correct"]),
                f"{prefix}_event_type": row["candidate_event_type"],
                f"{prefix}_shift_years": row["candidate_shift_years"],
                f"{prefix}_start_year": row["candidate_start_year"],
                f"{prefix}_end_year": row["candidate_end_year"],
                f"{prefix}_top_year": row["candidate_top_year"],
            }

        first = group.iloc[0]
        output.append({
            "attempt_id": attempt_id,
            "file_id": first["file_id"],
            "family": first["family"],
            "is_clean": int(first["is_clean"]),
            **candidate_fields("product", product),
            **candidate_fields("alternative", alternative),
            "alternative_second_probability": float(second["probability"]) if second is not None else 0.0,
        })
    table = pd.DataFrame(output)
    table["alternative_margin"] = (
        table["alternative_probability"] - table["alternative_second_probability"]
    )
    table["alternative_advantage"] = (
        table["alternative_probability"] - table["product_probability"]
    )
    return table


def evaluate_residual_gate(
    table: pd.DataFrame,
    recovery_threshold: float,
    recovery_margin: float,
    override_threshold: float,
    override_advantage: float,
) -> tuple[dict[str, float], pd.DataFrame]:
    result = table.copy()
    result["recovered"] = (
        ~result["product_present"]
        & result["alternative_present"]
        & (result["alternative_probability"] >= recovery_threshold)
        & (result["alternative_margin"] >= recovery_margin)
    )
    result["overridden"] = (
        result["product_present"]
        & result["alternative_present"]
        & (result["alternative_probability"] >= override_threshold)
        & (result["alternative_advantage"] >= override_advantage)
    )
    result["selected"] = result["product_present"] | result["recovered"]
    use_alternative = result["recovered"] | result["overridden"]
    for label in ("strict", "relaxed", "workflow", "operation", "location"):
        result[f"model_{label}_correct"] = result["selected"] & np.where(
            use_alternative,
            result[f"alternative_{label}"],
            result[f"product_{label}"],
        )
    for field in ("event_type", "shift_years", "start_year", "end_year", "top_year"):
        result[f"selected_{field}"] = np.where(
            use_alternative,
            result[f"alternative_{field}"],
            result[f"product_{field}"],
        )
    events = result["is_clean"] == 0
    clean = ~events
    metrics = {
        "event_accuracy": float(result.loc[events, "model_workflow_correct"].mean()) if events.any() else 0,
        "event_response": float(result.loc[events, "selected"].mean()) if events.any() else 0,
        "clean_false_positive": float(result.loc[clean, "selected"].mean()) if clean.any() else 0,
        "overrides": int(result["overridden"].sum()),
        "recoveries": int(result["recovered"].sum()),
    }
    return metrics, result


def choose_residual_gate(table: pd.DataFrame) -> tuple[dict[str, float], dict[str, float]]:
    recovery_thresholds = [0.3, 0.5, 0.7, 0.85, 0.95]
    recovery_margins = [0.0, 0.02, 0.05, 0.1, 0.2]
    override_thresholds = [0.5, 0.7, 0.85, 0.95]
    override_advantages = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5]
    clean = table["is_clean"] == 1
    baseline_clean_rate = float(table.loc[clean, "product_present"].mean()) if clean.any() else 0
    options: list[tuple[tuple[float, ...], dict[str, float], dict[str, float]]] = []
    for recovery_threshold in recovery_thresholds:
        for recovery_margin in recovery_margins:
            for override_threshold in override_thresholds:
                for override_advantage in override_advantages:
                    gate = {
                        "recovery_threshold": recovery_threshold,
                        "recovery_margin": recovery_margin,
                        "override_threshold": override_threshold,
                        "override_advantage": override_advantage,
                    }
                    metrics, _ = evaluate_residual_gate(table, **gate)
                    clean_ok = metrics["clean_false_positive"] <= max(0.015, baseline_clean_rate)
                    response_ok = metrics["event_response"] >= 0.94
                    key = (
                        float(clean_ok and response_ok),
                        metrics["event_accuracy"],
                        -metrics["clean_false_positive"],
                        -metrics["overrides"],
                        -metrics["recoveries"],
                    )
                    options.append((key, gate, metrics))
    _, gate, metrics = max(options, key=lambda option: option[0])
    return gate, metrics


def cross_validated_predictions(
    candidates: pd.DataFrame,
    features: pd.DataFrame,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    groups = candidates["file_id"].to_numpy()
    outer = GroupKFold(n_splits=5)
    predictions = np.full(len(candidates), np.nan)
    fold_gates: list[dict[str, Any]] = []
    for fold, (train_index, test_index) in enumerate(outer.split(features, candidates["label_workflow"], groups)):
        train_groups = groups[train_index]
        inner_predictions = np.full(len(train_index), np.nan)
        inner = GroupKFold(n_splits=4)
        for inner_fold, (inner_train, inner_test) in enumerate(inner.split(
            features.iloc[train_index],
            candidates.iloc[train_index]["label_workflow"],
            train_groups,
        )):
            model = model_for(candidates.iloc[train_index[inner_train]]["label_workflow"], 1000 + fold * 10 + inner_fold)
            model.fit(
                features.iloc[train_index[inner_train]],
                candidates.iloc[train_index[inner_train]]["label_workflow"],
            )
            inner_predictions[inner_test] = model.predict_proba(features.iloc[train_index[inner_test]])[:, 1]
        inner_table = residual_attempt_predictions(
            candidates.iloc[train_index].reset_index(drop=True),
            inner_predictions,
        )
        gate, inner_metrics = choose_residual_gate(inner_table)
        model = model_for(candidates.iloc[train_index]["label_workflow"], 2000 + fold)
        model.fit(features.iloc[train_index], candidates.iloc[train_index]["label_workflow"])
        predictions[test_index] = model.predict_proba(features.iloc[test_index])[:, 1]
        fold_gates.append({
            "fold": fold,
            "testFiles": sorted(set(groups[test_index])),
            **gate,
            "innerMetrics": inner_metrics,
        })
    if np.isnan(predictions).any():
        raise RuntimeError("missing out-of-fold predictions")
    return predictions, fold_gates


def apply_fold_gates(
    candidates: pd.DataFrame,
    probabilities: np.ndarray,
    fold_gates: list[dict[str, Any]],
) -> pd.DataFrame:
    table = residual_attempt_predictions(candidates, probabilities)
    file_to_gate = {
        file_id: gate
        for gate in fold_gates
        for file_id in gate["testFiles"]
    }
    decided: list[pd.DataFrame] = []
    for file_id, selected in table.groupby("file_id", sort=False):
        _, result = evaluate_residual_gate(selected, **{
            key: file_to_gate[file_id][key]
            for key in (
                "recovery_threshold",
                "recovery_margin",
                "override_threshold",
                "override_advantage",
            )
        })
        decided.append(result)
    return pd.concat(decided, ignore_index=True)


def rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def summarize_decisions(decisions: pd.DataFrame, attempts: pd.DataFrame) -> dict[str, Any]:
    merged = attempts.merge(decisions, on=["attempt_id", "file_id", "family", "is_clean"], how="left")
    merged["selected"] = merged["selected"].fillna(False).astype(bool)
    merged["model_strict_correct"] = merged["model_strict_correct"].fillna(False).astype(bool)
    merged["model_relaxed_correct"] = merged["model_relaxed_correct"].fillna(False).astype(bool)
    merged["model_workflow_correct"] = merged["model_workflow_correct"].fillna(False).astype(bool)
    event = merged[merged["is_clean"] == 0]
    clean = merged[merged["is_clean"] == 1]

    def subset_summary(selected: pd.DataFrame) -> dict[str, Any]:
        return {
            "attempts": len(selected),
            "productCorrect": int(selected["product_correct"].sum()),
            "productAccuracy": rate(int(selected["product_correct"].sum()), len(selected)),
            "modelStrictCorrect": int(selected["model_strict_correct"].sum()),
            "modelStrictAccuracy": rate(int(selected["model_strict_correct"].sum()), len(selected)),
            "modelRelaxedCorrect": int(selected["model_relaxed_correct"].sum()),
            "modelRelaxedAccuracy": rate(int(selected["model_relaxed_correct"].sum()), len(selected)),
            "modelWorkflowCorrect": int(selected["model_workflow_correct"].sum()),
            "modelWorkflowAccuracy": rate(int(selected["model_workflow_correct"].sum()), len(selected)),
            "responseRate": rate(int(selected["selected"].sum()), len(selected)),
        }

    return {
        "event": subset_summary(event),
        "byFamily": {
            family: subset_summary(event[event["family"] == family])
            for family in ("A", "B", "C", "D")
        },
        "clean": {
            "attempts": len(clean),
            "productFalsePositives": int(clean["product_response"].sum()),
            "modelFalsePositives": int(clean["selected"].sum()),
            "modelFalsePositiveRate": rate(int(clean["selected"].sum()), len(clean)),
        },
    }


def make_pairwise_table(
    candidates: pd.DataFrame,
    features: pd.DataFrame,
    feature_names: list[str],
) -> tuple[pd.DataFrame, np.ndarray, list[str]]:
    metadata: list[dict[str, Any]] = []
    alternative_indices: list[int] = []
    product_indices: list[int] = []
    for attempt_id, group in candidates.groupby("attempt_id", sort=False):
        product_rows = group[group["exact_product_primary"] > 0]
        if product_rows.empty:
            continue
        product_alternative_rows = group[group["exact_product_alternative"] > 0]
        product_index = int(product_rows.sort_values(
            ["exact_source_count", "near_source_count"],
            ascending=False,
        ).index[0])
        product = candidates.loc[product_index]
        package_members = pd.concat([
            candidates.loc[[product_index]],
            product_alternative_rows,
        ]).drop_duplicates()
        package_identities = {
            (
                product["candidate_event_type"],
                product["candidate_shift_years"],
            ),
            *(
                (
                    alternative["candidate_event_type"],
                    alternative["candidate_shift_years"],
                )
                for _, alternative in product_alternative_rows.iterrows()
            ),
        }
        for alternative_index, alternative in group.drop(index=product_index).iterrows():
            matching_package = package_members[
                (package_members["candidate_event_type"] == alternative["candidate_event_type"])
                & (package_members["candidate_shift_years"] == alternative["candidate_shift_years"])
            ]
            identity_product_index = product_index
            if not matching_package.empty:
                alternative_center = alternative["candidate_top_year"]
                if pd.isna(alternative_center):
                    alternative_center = (
                        alternative["candidate_start_year"]
                        + alternative["candidate_end_year"]
                    ) / 2
                identity_product_index = int(min(
                    matching_package.index,
                    key=lambda index: abs(
                        (
                            candidates.loc[index, "candidate_top_year"]
                            if not pd.isna(candidates.loc[index, "candidate_top_year"])
                            else (
                                candidates.loc[index, "candidate_start_year"]
                                + candidates.loc[index, "candidate_end_year"]
                            ) / 2
                        )
                        - alternative_center
                    ),
                ))
            alternative_indices.append(int(alternative_index))
            product_indices.append(product_index)
            metadata.append({
                "attempt_id": attempt_id,
                "file_id": product["file_id"],
                "family": product["family"],
                "dataset_role": product["dataset_role"],
                "is_clean": int(product["is_clean"]),
                "product_workflow": bool(product["label_workflow"]),
                "product_strict": bool(product["label_strict"]),
                "product_relaxed": bool(product["label_relaxed"]),
                "product_operation": bool(product["operation_correct"]),
                "product_location": bool(product["location_correct"]),
                "alternative_workflow": bool(alternative["label_workflow"]),
                "alternative_strict": bool(alternative["label_strict"]),
                "alternative_relaxed": bool(alternative["label_relaxed"]),
                "alternative_operation": bool(alternative["operation_correct"]),
                "alternative_location": bool(alternative["location_correct"]),
                "alternative_event_type": alternative["candidate_event_type"],
                "alternative_shift_years": alternative["candidate_shift_years"],
                "alternative_start_year": alternative["candidate_start_year"],
                "alternative_end_year": alternative["candidate_end_year"],
                "alternative_top_year": alternative["candidate_top_year"],
                "alternative_candidate_index": int(alternative_index),
                "product_candidate_index": product_index,
                "identity_product_candidate_index": identity_product_index,
                "is_product_package_member": int(
                    alternative["exact_product_primary"] > 0
                    or alternative["exact_product_alternative"] > 0
                ),
                "same_operation_identity": int(
                    (
                        alternative["candidate_event_type"],
                        alternative["candidate_shift_years"],
                    )
                    in package_identities
                ),
                "pair_label": int(
                    not bool(product["label_workflow"])
                    and bool(alternative["label_workflow"])
                ),
                "pair_harm": int(
                    bool(product["label_workflow"])
                    and not bool(alternative["label_workflow"])
                ),
            })
    alternative_values = features.loc[alternative_indices].to_numpy(dtype=np.float32)
    product_values = features.loc[product_indices].to_numpy(dtype=np.float32)
    pair_values = np.concatenate(
        [alternative_values, product_values, alternative_values - product_values],
        axis=1,
    )
    pair_names = (
        [f"alternative_{name}" for name in feature_names]
        + [f"product_{name}" for name in feature_names]
        + [f"difference_{name}" for name in feature_names]
    )
    return pd.DataFrame(metadata), pair_values, pair_names


def make_location_pair_table(
    pairs: pd.DataFrame,
    features: pd.DataFrame,
    feature_names: list[str],
) -> tuple[pd.DataFrame, np.ndarray, list[str]]:
    location_pairs = pairs[
        (pairs["same_operation_identity"] == 1)
        & (pairs["is_product_package_member"] == 0)
    ].copy().reset_index(drop=True)
    location_pairs["product_candidate_index"] = location_pairs[
        "identity_product_candidate_index"
    ].astype(int)
    alternative_indices = location_pairs["alternative_candidate_index"].to_numpy(dtype=int)
    product_indices = location_pairs["product_candidate_index"].to_numpy(dtype=int)
    alternative_values = features.loc[alternative_indices].to_numpy(dtype=np.float32)
    product_values = features.loc[product_indices].to_numpy(dtype=np.float32)
    pair_values = np.concatenate(
        [alternative_values, product_values, alternative_values - product_values],
        axis=1,
    )
    pair_names = (
        [f"alternative_{name}" for name in feature_names]
        + [f"product_{name}" for name in feature_names]
        + [f"difference_{name}" for name in feature_names]
    )
    return location_pairs, pair_values, pair_names


def pair_model(labels: pd.Series, seed: int) -> lgb.LGBMClassifier:
    positives = max(1, int(labels.sum()))
    negatives = max(1, len(labels) - positives)
    return lgb.LGBMClassifier(
        objective="binary",
        n_estimators=400,
        learning_rate=0.025,
        num_leaves=15,
        min_child_samples=40,
        subsample=0.85,
        colsample_bytree=0.75,
        reg_alpha=1.0,
        reg_lambda=3.0,
        scale_pos_weight=min(50.0, negatives / positives),
        random_state=seed,
        n_jobs=8,
        verbosity=-1,
        deterministic=True,
        force_col_wise=True,
    )


def top_pair_predictions(pairs: pd.DataFrame, probabilities: np.ndarray) -> pd.DataFrame:
    scored = pairs.copy()
    scored["override_probability"] = probabilities
    return scored.sort_values(
        ["attempt_id", "override_probability"],
        ascending=[True, False],
    ).groupby("attempt_id", sort=False).head(1).copy()


def evaluate_pair_threshold(top: pd.DataFrame, threshold: float) -> tuple[dict[str, float], pd.DataFrame]:
    result = top.copy()
    result["overridden"] = result["override_probability"] >= threshold
    for label in ("workflow", "strict", "relaxed", "operation", "location"):
        result[f"model_{label}_correct"] = np.where(
            result["overridden"],
            result[f"alternative_{label}"],
            result[f"product_{label}"],
        )
    result["selected"] = True
    for field in ("event_type", "shift_years", "start_year", "end_year", "top_year"):
        result[f"selected_{field}"] = result[f"alternative_{field}"]
    events = result["is_clean"] == 0
    metrics = {
        "event_accuracy": float(result.loc[events, "model_workflow_correct"].mean()),
        "overrides": int(result["overridden"].sum()),
        "beneficialOverrides": int((result["overridden"] & (result["pair_label"] == 1)).sum()),
        "harmfulOverrides": int((result["overridden"] & (result["pair_harm"] == 1)).sum()),
    }
    return metrics, result


def choose_pair_threshold(
    top: pd.DataFrame,
    require_zero_harm: bool = False,
) -> tuple[float, dict[str, float]]:
    thresholds = sorted(set(
        np.linspace(0.05, 0.99, 95).tolist()
        + top["override_probability"].quantile(np.linspace(0.5, 0.995, 60)).tolist()
        + [1.01]
    ))
    options = []
    for threshold in thresholds:
        metrics, _ = evaluate_pair_threshold(top, float(threshold))
        if require_zero_harm and metrics["harmfulOverrides"] > 0:
            continue
        key = (
            metrics["event_accuracy"],
            -metrics["harmfulOverrides"],
            -metrics["overrides"],
            threshold,
        )
        options.append((key, float(threshold), metrics))
    _, threshold, metrics = max(options, key=lambda option: option[0])
    return threshold, metrics


def evaluate_operation_thresholds(
    top: pd.DataFrame,
    thresholds: dict[str, float],
) -> tuple[dict[str, float], pd.DataFrame]:
    result = top.copy()
    selected_thresholds = result["alternative_event_type"].map(thresholds).fillna(1.01)
    result["overridden"] = result["override_probability"] >= selected_thresholds
    for label in ("workflow", "strict", "relaxed", "operation", "location"):
        result[f"model_{label}_correct"] = np.where(
            result["overridden"],
            result[f"alternative_{label}"],
            result[f"product_{label}"],
        )
    result["selected"] = True
    for field in ("event_type", "shift_years", "start_year", "end_year", "top_year"):
        result[f"selected_{field}"] = result[f"alternative_{field}"]
    events = result["is_clean"] == 0
    metrics = {
        "event_accuracy": float(result.loc[events, "model_workflow_correct"].mean()),
        "overrides": int(result["overridden"].sum()),
        "beneficialOverrides": int((result["overridden"] & (result["pair_label"] == 1)).sum()),
        "harmfulOverrides": int((result["overridden"] & (result["pair_harm"] == 1)).sum()),
    }
    return metrics, result


def pairwise_cross_validated_predictions(
    pairs: pd.DataFrame,
    pair_values: np.ndarray,
) -> tuple[np.ndarray, list[dict[str, Any]]]:
    groups = pairs["file_id"].to_numpy()
    outer = GroupKFold(n_splits=5)
    predictions = np.full(len(pairs), np.nan)
    fold_gates = []
    for fold, (train_index, test_index) in enumerate(outer.split(pair_values, pairs["pair_label"], groups)):
        inner_predictions = np.full(len(train_index), np.nan)
        inner_groups = groups[train_index]
        inner = GroupKFold(n_splits=4)
        for inner_fold, (inner_train, inner_test) in enumerate(inner.split(
            pair_values[train_index],
            pairs.iloc[train_index]["pair_label"],
            inner_groups,
        )):
            labels = pairs.iloc[train_index[inner_train]]["pair_label"]
            model = pair_model(labels, 3000 + fold * 10 + inner_fold)
            model.fit(pair_values[train_index[inner_train]], labels)
            inner_predictions[inner_test] = model.predict_proba(
                pair_values[train_index[inner_test]]
            )[:, 1]
        inner_top = top_pair_predictions(
            pairs.iloc[train_index].reset_index(drop=True),
            inner_predictions,
        )
        threshold, inner_metrics = choose_pair_threshold(inner_top)
        labels = pairs.iloc[train_index]["pair_label"]
        model = pair_model(labels, 4000 + fold)
        model.fit(pair_values[train_index], labels)
        predictions[test_index] = model.predict_proba(pair_values[test_index])[:, 1]
        fold_gates.append({
            "fold": fold,
            "testFiles": sorted(set(groups[test_index])),
            "threshold": threshold,
            "innerMetrics": inner_metrics,
        })
    return predictions, fold_gates


def augmented_pairwise_cross_validated_predictions(
    pairs: pd.DataFrame,
    pair_values: np.ndarray,
    require_zero_harm: bool = False,
) -> tuple[np.ndarray, list[dict[str, Any]], np.ndarray]:
    evaluation_indices = np.flatnonzero(pairs["dataset_role"].to_numpy() == "evaluation")
    evaluation_pairs = pairs.iloc[evaluation_indices].reset_index(drop=True)
    evaluation_groups = evaluation_pairs["file_id"].to_numpy()
    predictions = np.full(len(evaluation_pairs), np.nan)
    fold_gates: list[dict[str, Any]] = []
    outer = GroupKFold(n_splits=5)
    for fold, (outer_train_local, outer_test_local) in enumerate(outer.split(
        np.zeros(len(evaluation_pairs)),
        evaluation_pairs["pair_label"],
        evaluation_groups,
    )):
        test_files = set(evaluation_groups[outer_test_local])
        outer_train_files = sorted(set(evaluation_groups[outer_train_local]))
        global_train = np.flatnonzero(~pairs["file_id"].isin(test_files).to_numpy())
        global_test = evaluation_indices[outer_test_local]

        inner_eval = evaluation_pairs.iloc[outer_train_local].reset_index(drop=True)
        inner_groups = inner_eval["file_id"].to_numpy()
        calibration_frames: list[pd.DataFrame] = []
        calibration_predictions: list[np.ndarray] = []
        inner = GroupKFold(n_splits=4)
        for inner_fold, (_, inner_test_local) in enumerate(inner.split(
            np.zeros(len(inner_eval)),
            inner_eval["pair_label"],
            inner_groups,
        )):
            inner_test_files = set(inner_groups[inner_test_local])
            excluded_files = test_files | inner_test_files
            inner_train_global = np.flatnonzero(
                ~pairs["file_id"].isin(excluded_files).to_numpy()
            )
            inner_test_global = np.flatnonzero(
                pairs["file_id"].isin(inner_test_files).to_numpy()
            )
            labels = pairs.iloc[inner_train_global]["pair_label"]
            model = pair_model(labels, 5000 + fold * 10 + inner_fold)
            model.fit(pair_values[inner_train_global], labels)
            selected_predictions = model.predict_proba(
                pair_values[inner_test_global]
            )[:, 1]
            calibration_frames.append(pairs.iloc[inner_test_global].copy())
            calibration_predictions.append(selected_predictions)
        calibration_pairs = pd.concat(calibration_frames, ignore_index=True)
        inner_top = top_pair_predictions(
            calibration_pairs,
            np.concatenate(calibration_predictions),
        )
        threshold, inner_metrics = choose_pair_threshold(
            inner_top,
            require_zero_harm,
        )
        labels = pairs.iloc[global_train]["pair_label"]
        model = pair_model(labels, 6000 + fold)
        model.fit(pair_values[global_train], labels)
        predictions[outer_test_local] = model.predict_proba(pair_values[global_test])[:, 1]
        fold_gates.append({
            "fold": fold,
            "testFiles": sorted(test_files),
            "trainingFiles": outer_train_files,
            "trainingPairs": len(global_train),
            "threshold": threshold,
            "requireZeroHarm": require_zero_harm,
            "innerMetrics": inner_metrics,
        })
    if np.isnan(predictions).any():
        raise RuntimeError("missing augmented out-of-fold predictions")
    return predictions, fold_gates, evaluation_indices


STACKED_SCORE_NAMES = (
    "pair",
    "alternative_failure",
    "pair_alternative",
    "pair_failure",
    "all_geometric",
    "all_product",
    "all_minimum",
)
PAIR_PROBABILITY_FLOORS = (0.001, 0.01, 0.1, 0.25, 0.4)


def stacked_override_scores(
    pairs: pd.DataFrame,
    pair_probabilities: np.ndarray,
    candidate_probabilities: np.ndarray,
    score_name: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    alternative = np.clip(
        candidate_probabilities[pairs["alternative_candidate_index"].to_numpy(dtype=int)],
        1e-6,
        1 - 1e-6,
    )
    product = np.clip(
        candidate_probabilities[pairs["product_candidate_index"].to_numpy(dtype=int)],
        1e-6,
        1 - 1e-6,
    )
    pair = np.clip(pair_probabilities, 1e-6, 1 - 1e-6)
    failure = 1 - product
    if score_name == "pair":
        score = pair
    elif score_name == "alternative_failure":
        score = np.sqrt(alternative * failure)
    elif score_name == "pair_alternative":
        score = np.sqrt(pair * alternative)
    elif score_name == "pair_failure":
        score = np.sqrt(pair * failure)
    elif score_name == "all_geometric":
        score = np.cbrt(pair * alternative * failure)
    elif score_name == "all_product":
        score = pair * np.sqrt(alternative * failure)
    elif score_name == "all_minimum":
        score = np.minimum(np.minimum(pair, alternative), failure)
    else:
        raise ValueError(f"unknown stacked score: {score_name}")
    return score, alternative, product


def top_stacked_predictions(
    pairs: pd.DataFrame,
    pair_probabilities: np.ndarray,
    candidate_probabilities: np.ndarray,
    score_name: str,
    pair_scope: str,
    pair_floor: float,
) -> pd.DataFrame:
    score, alternative, product = stacked_override_scores(
        pairs,
        pair_probabilities,
        candidate_probabilities,
        score_name,
    )
    scored = pairs.copy()
    scored["override_probability"] = score
    scored["pair_probability"] = pair_probabilities
    scored["alternative_probability"] = alternative
    scored["product_probability"] = product
    scored["score_name"] = score_name
    scored.loc[scored["pair_probability"] < pair_floor, "override_probability"] = -1
    if pair_scope == "operation":
        scored.loc[scored["same_operation_identity"] == 1, "override_probability"] = -1
    return scored.sort_values(
        ["attempt_id", "override_probability", "pair_probability"],
        ascending=[True, False, False],
    ).groupby("attempt_id", sort=False).head(1).copy()


def choose_stacked_gate(
    pairs: pd.DataFrame,
    pair_probabilities: np.ndarray,
    candidate_probabilities: np.ndarray,
    risk_policy: str,
    pair_scope: str,
    selector_policy: str,
) -> tuple[dict[str, Any], dict[str, float]]:
    options: list[tuple[tuple[Any, ...], dict[str, Any], dict[str, float]]] = []
    score_names = ("pair",) if selector_policy == "direct_pair" else STACKED_SCORE_NAMES
    pair_floors = (0.0,) if selector_policy == "direct_pair" else PAIR_PROBABILITY_FLOORS
    for score_name in score_names:
        for pair_floor in pair_floors:
            top = top_stacked_predictions(
                pairs,
                pair_probabilities,
                candidate_probabilities,
                score_name,
                pair_scope,
                pair_floor,
            )
            for require_zero_harm in (False, True):
                threshold, metrics = choose_pair_threshold(top, require_zero_harm)
                key = (
                    (
                        -metrics["harmfulOverrides"],
                        metrics["event_accuracy"],
                    )
                    if risk_policy == "preserve"
                    else (
                        metrics["event_accuracy"],
                        -metrics["harmfulOverrides"],
                    )
                ) + (
                    metrics["beneficialOverrides"],
                    -metrics["overrides"],
                )
                options.append((
                    key,
                    {
                        "scoreName": score_name,
                        "pairFloor": pair_floor,
                        "gateMode": "global_zero_harm" if require_zero_harm else "global",
                        "threshold": threshold,
                    },
                    metrics,
                ))
            for require_zero_harm in (False, True):
                thresholds = {}
                for event_type in sorted(EVENT_TYPES):
                    selected = top[top["alternative_event_type"] == event_type]
                    if selected.empty:
                        thresholds[event_type] = 1.01
                        continue
                    threshold, _ = choose_pair_threshold(selected, require_zero_harm)
                    thresholds[event_type] = threshold
                metrics, _ = evaluate_operation_thresholds(top, thresholds)
                key = (
                    (
                        -metrics["harmfulOverrides"],
                        metrics["event_accuracy"],
                    )
                    if risk_policy == "preserve"
                    else (
                        metrics["event_accuracy"],
                        -metrics["harmfulOverrides"],
                    )
                ) + (
                    metrics["beneficialOverrides"],
                    -metrics["overrides"],
                )
                options.append((
                    key,
                    {
                        "scoreName": score_name,
                        "pairFloor": pair_floor,
                        "gateMode": (
                            "operation_zero_harm"
                            if require_zero_harm
                            else "operation"
                        ),
                        "thresholds": thresholds,
                    },
                    metrics,
                ))
    _, gate, metrics = max(options, key=lambda option: option[0])
    return gate, metrics


def augmented_stacked_cross_validated_predictions(
    pairs: pd.DataFrame,
    pair_values: np.ndarray,
    candidates: pd.DataFrame,
    candidate_features: pd.DataFrame,
    risk_policy: str,
    pair_scope: str,
    selector_policy: str,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]], np.ndarray]:
    evaluation_pair_indices = np.flatnonzero(
        pairs["dataset_role"].to_numpy() == "evaluation"
    )
    evaluation_pairs = pairs.iloc[evaluation_pair_indices].reset_index(drop=True)
    evaluation_groups = evaluation_pairs["file_id"].to_numpy()
    pair_predictions = np.full(len(evaluation_pairs), np.nan)
    candidate_predictions = np.full(len(candidates), np.nan)
    fold_gates: list[dict[str, Any]] = []
    outer = GroupKFold(n_splits=5)
    for fold, (outer_train_local, outer_test_local) in enumerate(outer.split(
        np.zeros(len(evaluation_pairs)),
        evaluation_pairs["pair_label"],
        evaluation_groups,
    )):
        test_files = set(evaluation_groups[outer_test_local])
        outer_train_files = sorted(set(evaluation_groups[outer_train_local]))
        global_pair_train = np.flatnonzero(
            ~pairs["file_id"].isin(test_files).to_numpy()
            & (
                (pairs["same_operation_identity"].to_numpy() == 0)
                if pair_scope == "operation"
                else np.ones(len(pairs), dtype=bool)
            )
        )
        global_pair_test = evaluation_pair_indices[outer_test_local]
        global_candidate_train = np.flatnonzero(
            ~candidates["file_id"].isin(test_files).to_numpy()
        )
        global_candidate_test = np.flatnonzero(
            (candidates["dataset_role"].to_numpy() == "evaluation")
            & candidates["file_id"].isin(test_files).to_numpy()
        )

        inner_candidate_predictions = np.full(len(candidates), np.nan)
        inner_eval = evaluation_pairs.iloc[outer_train_local].reset_index(drop=True)
        inner_groups = inner_eval["file_id"].to_numpy()
        calibration_pair_frames: list[pd.DataFrame] = []
        calibration_pair_predictions: list[np.ndarray] = []
        inner = GroupKFold(n_splits=4)
        for inner_fold, (_, inner_test_local) in enumerate(inner.split(
            np.zeros(len(inner_eval)),
            inner_eval["pair_label"],
            inner_groups,
        )):
            inner_test_files = set(inner_groups[inner_test_local])
            excluded_files = test_files | inner_test_files
            inner_pair_train = np.flatnonzero(
                ~pairs["file_id"].isin(excluded_files).to_numpy()
                & (
                    (pairs["same_operation_identity"].to_numpy() == 0)
                    if pair_scope == "operation"
                    else np.ones(len(pairs), dtype=bool)
                )
            )
            inner_pair_test_global = np.flatnonzero(
                pairs["file_id"].isin(inner_test_files).to_numpy()
            )
            pair_labels = pairs.iloc[inner_pair_train]["pair_label"]
            pair_estimator = pair_model(
                pair_labels,
                7000 + fold * 20 + inner_fold,
            )
            pair_estimator.fit(pair_values[inner_pair_train], pair_labels)
            selected_pair_predictions = pair_estimator.predict_proba(
                pair_values[inner_pair_test_global]
            )[:, 1]
            calibration_pair_frames.append(
                pairs.iloc[inner_pair_test_global].copy()
            )
            calibration_pair_predictions.append(selected_pair_predictions)

            inner_candidate_train = np.flatnonzero(
                ~candidates["file_id"].isin(excluded_files).to_numpy()
            )
            inner_candidate_test = np.flatnonzero(
                candidates["file_id"].isin(inner_test_files).to_numpy()
            )
            candidate_labels = candidates.iloc[inner_candidate_train]["label_workflow"]
            candidate_estimator = model_for(
                candidate_labels,
                8000 + fold * 20 + inner_fold,
            )
            candidate_estimator.fit(
                candidate_features.iloc[inner_candidate_train],
                candidate_labels,
            )
            inner_candidate_predictions[inner_candidate_test] = (
                candidate_estimator.predict_proba(
                    candidate_features.iloc[inner_candidate_test]
                )[:, 1]
            )

        calibration_pairs = pd.concat(
            calibration_pair_frames,
            ignore_index=True,
        )
        calibration_predictions = np.concatenate(calibration_pair_predictions)
        gate, inner_metrics = choose_stacked_gate(
            calibration_pairs,
            calibration_predictions,
            inner_candidate_predictions,
            risk_policy,
            pair_scope,
            selector_policy,
        )
        inner_recovery_candidates = candidates[
            candidates["file_id"].isin(outer_train_files)
        ]
        recovery_top = top_recovery_predictions(
            inner_recovery_candidates,
            inner_candidate_predictions,
        )
        recovery_threshold, recovery_metrics = choose_recovery_threshold(
            recovery_top,
        )

        pair_labels = pairs.iloc[global_pair_train]["pair_label"]
        pair_estimator = pair_model(pair_labels, 9000 + fold)
        pair_estimator.fit(pair_values[global_pair_train], pair_labels)
        pair_predictions[outer_test_local] = pair_estimator.predict_proba(
            pair_values[global_pair_test]
        )[:, 1]

        candidate_labels = candidates.iloc[global_candidate_train]["label_workflow"]
        candidate_estimator = model_for(candidate_labels, 10000 + fold)
        candidate_estimator.fit(
            candidate_features.iloc[global_candidate_train],
            candidate_labels,
        )
        candidate_predictions[global_candidate_test] = candidate_estimator.predict_proba(
            candidate_features.iloc[global_candidate_test]
        )[:, 1]
        fold_gates.append({
            "fold": fold,
            "testFiles": sorted(test_files),
            "trainingFiles": outer_train_files,
            "trainingPairs": len(global_pair_train),
            "trainingCandidates": len(global_candidate_train),
            **gate,
            "innerMetrics": inner_metrics,
            "recoveryThreshold": recovery_threshold,
            "recoveryInnerMetrics": recovery_metrics,
        })
    if np.isnan(pair_predictions).any():
        raise RuntimeError("missing stacked pair predictions")
    evaluation_candidate_mask = candidates["dataset_role"].to_numpy() == "evaluation"
    if np.isnan(candidate_predictions[evaluation_candidate_mask]).any():
        raise RuntimeError("missing stacked candidate predictions")
    return (
        pair_predictions,
        candidate_predictions,
        fold_gates,
        evaluation_pair_indices,
    )


def apply_stacked_gates(
    pairs: pd.DataFrame,
    pair_probabilities: np.ndarray,
    candidate_probabilities: np.ndarray,
    fold_gates: list[dict[str, Any]],
    pair_scope: str,
) -> pd.DataFrame:
    file_to_gate = {
        file_id: gate
        for gate in fold_gates
        for file_id in gate["testFiles"]
    }
    output = []
    for file_id, selected in pairs.groupby("file_id", sort=False):
        selected_indices = selected.index.to_numpy(dtype=int)
        gate = file_to_gate[file_id]
        top = top_stacked_predictions(
            selected,
            pair_probabilities[selected_indices],
            candidate_probabilities,
            gate["scoreName"],
            pair_scope,
            gate.get("pairFloor", 0.0),
        )
        if gate["gateMode"].startswith("operation"):
            _, decisions = evaluate_operation_thresholds(top, gate["thresholds"])
        else:
            _, decisions = evaluate_pair_threshold(top, gate["threshold"])
        output.append(decisions)
    return pd.concat(output, ignore_index=True)


def combine_structured_decisions(
    operation_decisions: pd.DataFrame,
    location_decisions: pd.DataFrame,
) -> pd.DataFrame:
    result = operation_decisions.copy()
    result["operation_overridden"] = result["overridden"].astype(bool)
    result["location_overridden"] = False
    result["decision_head"] = np.where(
        result["operation_overridden"],
        "operation",
        "product",
    )
    location_by_attempt = location_decisions.set_index("attempt_id", drop=False)
    protected = {"attempt_id", "file_id", "family", "dataset_role", "is_clean"}
    replaceable = [
        column for column in location_decisions.columns
        if column in result.columns and column not in protected
    ]
    for index, row in result.iterrows():
        if row["operation_overridden"] or row["attempt_id"] not in location_by_attempt.index:
            continue
        location = location_by_attempt.loc[row["attempt_id"]]
        if isinstance(location, pd.DataFrame):
            location = location.iloc[0]
        if not bool(location["overridden"]):
            continue
        for column in replaceable:
            result.at[index, column] = location[column]
        result.at[index, "location_overridden"] = True
        result.at[index, "decision_head"] = "location"
    return result


def apply_recovery_gates(
    candidates: pd.DataFrame,
    candidate_probabilities: np.ndarray,
    fold_gates: list[dict[str, Any]],
) -> pd.DataFrame:
    evaluation = candidates[candidates["dataset_role"] == "evaluation"]
    top = top_recovery_predictions(evaluation, candidate_probabilities)
    file_to_gate = {
        file_id: gate
        for gate in fold_gates
        for file_id in gate["testFiles"]
    }
    output = []
    for file_id, selected in top.groupby("file_id", sort=False):
        _, decided = evaluate_recovery_threshold(
            selected,
            file_to_gate[file_id]["recoveryThreshold"],
        )
        output.append(decided)
    recovered = pd.concat(output, ignore_index=True)
    result = pd.DataFrame({
        "attempt_id": recovered["attempt_id"],
        "file_id": recovered["file_id"],
        "family": recovered["family"],
        "dataset_role": recovered["dataset_role"],
        "is_clean": recovered["is_clean"],
        "product_workflow": False,
        "product_strict": False,
        "product_relaxed": False,
        "product_operation": False,
        "product_location": False,
        "alternative_workflow": recovered["label_workflow"].astype(bool),
        "alternative_strict": recovered["label_strict"].astype(bool),
        "alternative_relaxed": recovered["label_relaxed"].astype(bool),
        "alternative_operation": recovered["operation_correct"].astype(bool),
        "alternative_location": recovered["location_correct"].astype(bool),
        "alternative_event_type": recovered["candidate_event_type"],
        "alternative_shift_years": recovered["candidate_shift_years"],
        "alternative_start_year": recovered["candidate_start_year"],
        "alternative_end_year": recovered["candidate_end_year"],
        "alternative_top_year": recovered["candidate_top_year"],
        "pair_label": recovered["label_workflow"].astype(int),
        "pair_harm": 0,
        "override_probability": recovered["recovery_probability"],
        "overridden": recovered["selected"].astype(bool),
        "model_workflow_correct": recovered["model_workflow_correct"].astype(bool),
        "model_strict_correct": recovered["model_strict_correct"].astype(bool),
        "model_relaxed_correct": recovered["model_relaxed_correct"].astype(bool),
        "model_operation_correct": recovered["model_operation_correct"].astype(bool),
        "model_location_correct": recovered["model_location_correct"].astype(bool),
        "selected": recovered["selected"].astype(bool),
        "selected_event_type": recovered["candidate_event_type"],
        "selected_shift_years": recovered["candidate_shift_years"],
        "selected_start_year": recovered["candidate_start_year"],
        "selected_end_year": recovered["candidate_end_year"],
        "selected_top_year": recovered["candidate_top_year"],
        "same_operation_identity": 0,
        "operation_overridden": False,
        "location_overridden": False,
        "decision_head": np.where(recovered["selected"], "recovery", "refused"),
    })
    return result


def apply_pair_gates(
    pairs: pd.DataFrame,
    probabilities: np.ndarray,
    fold_gates: list[dict[str, Any]],
) -> pd.DataFrame:
    top = top_pair_predictions(pairs, probabilities)
    file_to_gate = {
        file_id: gate
        for gate in fold_gates
        for file_id in gate["testFiles"]
    }
    output = []
    for file_id, selected in top.groupby("file_id", sort=False):
        _, decisions = evaluate_pair_threshold(
            selected,
            file_to_gate[file_id]["threshold"],
        )
        output.append(decisions)
    return pd.concat(output, ignore_index=True)


def summarize_pair_decisions(
    decisions: pd.DataFrame,
    attempts: pd.DataFrame,
) -> dict[str, Any]:
    merged = attempts.merge(
        decisions,
        on=["attempt_id", "file_id", "family", "is_clean"],
        how="left",
    )
    for label in ("workflow", "strict", "relaxed", "operation", "location"):
        merged[f"model_{label}_correct"] = (
            merged[f"model_{label}_correct"].fillna(False).astype(bool)
        )
    merged["selected"] = merged["selected"].fillna(False).astype(bool)
    event = merged[merged["is_clean"] == 0]
    clean = merged[merged["is_clean"] == 1]

    def subset_summary(selected: pd.DataFrame) -> dict[str, Any]:
        return {
            "attempts": len(selected),
            "productCorrect": int(selected["product_correct"].sum()),
            "productAccuracy": rate(int(selected["product_correct"].sum()), len(selected)),
            "modelWorkflowCorrect": int(selected["model_workflow_correct"].sum()),
            "modelWorkflowAccuracy": rate(int(selected["model_workflow_correct"].sum()), len(selected)),
            "modelStrictCorrect": int(selected["model_strict_correct"].sum()),
            "modelStrictAccuracy": rate(int(selected["model_strict_correct"].sum()), len(selected)),
            "modelRelaxedCorrect": int(selected["model_relaxed_correct"].sum()),
            "modelRelaxedAccuracy": rate(int(selected["model_relaxed_correct"].sum()), len(selected)),
            "responseRate": rate(int(selected["selected"].sum()), len(selected)),
        }

    return {
        "event": subset_summary(event),
        "byFamily": {
            family: subset_summary(event[event["family"] == family])
            for family in ("A", "B", "C", "D")
        },
        "clean": {
            "attempts": len(clean),
            "productFalsePositives": int(clean["product_response"].sum()),
            "modelFalsePositives": int(clean["selected"].sum()),
            "modelFalsePositiveRate": rate(int(clean["selected"].sum()), len(clean)),
        },
        "overrides": int(decisions["overridden"].sum()),
        "beneficialOverrides": int((decisions["overridden"] & (decisions["pair_label"] == 1)).sum()),
        "harmfulOverrides": int((decisions["overridden"] & (decisions["pair_harm"] == 1)).sum()),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--candidate-cache")
    parser.add_argument(
        "--development-run-dir",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--strategy",
        choices=("candidate", "pairwise", "stacked", "structured", "ranker"),
        default="pairwise",
    )
    parser.add_argument(
        "--risk-policy",
        choices=("accuracy", "preserve"),
        default="accuracy",
    )
    parser.add_argument(
        "--pair-scope",
        choices=("all", "operation"),
        default="all",
    )
    parser.add_argument(
        "--operation-selector",
        choices=("adaptive", "direct_pair"),
        default="adaptive",
    )
    parser.add_argument(
        "--location-head",
        choices=("enabled", "stacked", "disabled"),
        default="enabled",
    )
    args = parser.parse_args()
    run_dir = Path(args.run_dir).resolve()
    development_run_dirs = [Path(path).resolve() for path in args.development_run_dir]
    output_dir = Path(args.output_dir).resolve() if args.output_dir else run_dir / "unified-adjudicator"
    output_dir.mkdir(parents=True, exist_ok=True)
    cache_path = Path(args.candidate_cache).resolve() if args.candidate_cache else None
    cache_metadata_path = cache_path.with_suffix(".json") if cache_path else None
    cache_attempts_path = cache_path.with_name(f"{cache_path.stem}-attempts.pkl") if cache_path else None
    cache_identity = {
        "schemaVersion": 3,
        "runDirectories": [str(run_dir), *map(str, development_run_dirs)],
    }
    use_cache = bool(
        cache_path
        and cache_metadata_path
        and cache_attempts_path
        and cache_path.exists()
        and cache_attempts_path.exists()
        and cache_metadata_path.exists()
        and json.loads(cache_metadata_path.read_text(encoding="utf8")).get("identity")
        == cache_identity
    )
    if use_cache:
        candidates = pd.read_pickle(cache_path)
        attempts = pd.read_pickle(cache_attempts_path)
        cache_metadata = json.loads(cache_metadata_path.read_text(encoding="utf8"))
        development_attempts = int(cache_metadata["developmentAttempts"])
    else:
        evaluation_candidates, attempts = make_candidate_rows(run_dir, "evaluation")
        evaluation_candidates["dataset_role"] = "evaluation"
        development_candidates = []
        development_attempts = 0
        for index, path in enumerate(development_run_dirs):
            selected_candidates, selected_attempts = make_candidate_rows(
                path,
                f"development-{index}",
            )
            selected_candidates["dataset_role"] = "development"
            development_candidates.append(selected_candidates)
            development_attempts += len(selected_attempts)
        candidates = pd.concat(
            [evaluation_candidates, *development_candidates],
            ignore_index=True,
        )
        if cache_path and cache_metadata_path and cache_attempts_path:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            candidates.to_pickle(cache_path)
            attempts.to_pickle(cache_attempts_path)
            cache_metadata_path.write_text(json.dumps({
                "identity": cache_identity,
                "developmentAttempts": development_attempts,
            }, indent=2) + "\n", encoding="utf8")
    evaluation_candidates = candidates[candidates["dataset_role"] == "evaluation"]
    development_candidates = candidates[candidates["dataset_role"] == "development"]
    features, feature_names = encoded_features(candidates)
    if args.strategy == "ranker":
        pairs, _, pair_feature_names = make_pairwise_table(
            candidates,
            features,
            feature_names,
        )
        ranker_predictions, fold_gates = ranker_cross_validated_predictions(
            candidates,
            features,
        )
        ranker_summary, top = summarize_ranker(
            candidates,
            pairs,
            ranker_predictions,
        )
        top.to_csv(output_dir / "ranker-top.csv", index=False)
        (output_dir / "feature-names.json").write_text(
            json.dumps(pair_feature_names, indent=2) + "\n",
            encoding="utf8",
        )
        summary = {
            "schemaVersion": 1,
            "strategy": args.strategy,
            "runDir": str(run_dir),
            "candidateRows": len(candidates),
            "evaluationCandidateRows": len(evaluation_candidates),
            "developmentCandidateRows": len(development_candidates),
            "developmentAttempts": development_attempts,
            "attempts": len(attempts),
            "features": len(feature_names),
            "foldGates": fold_gates,
            **ranker_summary,
        }
        (output_dir / "summary.json").write_text(
            json.dumps(summary, indent=2) + "\n",
            encoding="utf8",
        )
        print(json.dumps({"outputDir": str(output_dir), **ranker_summary}))
        return
    if args.strategy in {"pairwise", "stacked", "structured"}:
        pairs, pair_values, pair_feature_names = make_pairwise_table(
            candidates,
            features,
            feature_names,
        )
        if args.strategy == "structured":
            (
                operation_predictions,
                candidate_predictions,
                operation_fold_gates,
                evaluation_pair_indices,
            ) = augmented_stacked_cross_validated_predictions(
                pairs,
                pair_values,
                candidates,
                features,
                args.risk_policy,
                "operation",
                args.operation_selector,
            )
            evaluation_pairs = pairs.iloc[evaluation_pair_indices].reset_index(drop=True)
            operation_decisions = apply_stacked_gates(
                evaluation_pairs,
                operation_predictions,
                candidate_predictions,
                operation_fold_gates,
                "operation",
            )
            location_feature_names = pair_feature_names
            if args.location_head in {"enabled", "stacked"}:
                location_pairs, location_values, location_feature_names = make_location_pair_table(
                    pairs,
                    features,
                    feature_names,
                )
                if args.location_head == "stacked":
                    (
                        location_predictions,
                        location_candidate_predictions,
                        location_fold_gates,
                        evaluation_location_indices,
                    ) = augmented_stacked_cross_validated_predictions(
                        location_pairs,
                        location_values,
                        candidates,
                        features,
                        args.risk_policy,
                        "all",
                        "adaptive",
                    )
                else:
                    (
                        location_predictions,
                        location_fold_gates,
                        evaluation_location_indices,
                    ) = augmented_pairwise_cross_validated_predictions(
                        location_pairs,
                        location_values,
                        require_zero_harm=True,
                    )
                evaluation_location_pairs = location_pairs.iloc[
                    evaluation_location_indices
                ].reset_index(drop=True)
                if args.location_head == "stacked":
                    location_decisions = apply_stacked_gates(
                        evaluation_location_pairs,
                        location_predictions,
                        location_candidate_predictions,
                        location_fold_gates,
                        "all",
                    )
                else:
                    location_decisions = apply_pair_gates(
                        evaluation_location_pairs,
                        location_predictions,
                        location_fold_gates,
                    )
                product_decisions = combine_structured_decisions(
                    operation_decisions,
                    location_decisions,
                )
                evaluation_location_pairs.assign(
                    oof_pair_probability=location_predictions,
                ).to_csv(output_dir / "location-pairs.csv", index=False)
                location_decisions.to_csv(
                    output_dir / "location-decisions.csv",
                    index=False,
                )
            else:
                location_fold_gates = []
                product_decisions = operation_decisions.copy()
                product_decisions["operation_overridden"] = (
                    product_decisions["overridden"].astype(bool)
                )
                product_decisions["location_overridden"] = False
                product_decisions["decision_head"] = np.where(
                    product_decisions["operation_overridden"],
                    "operation",
                    "product",
                )
            recovery_decisions = apply_recovery_gates(
                candidates,
                candidate_predictions,
                operation_fold_gates,
            )
            decisions = pd.concat(
                [product_decisions, recovery_decisions],
                ignore_index=True,
            )
            evaluation_pairs.assign(
                oof_pair_probability=operation_predictions,
            ).to_csv(output_dir / "operation-pairs.csv", index=False)
            operation_decisions.to_csv(
                output_dir / "operation-decisions.csv",
                index=False,
            )
            recovery_decisions.to_csv(
                output_dir / "recovery-decisions.csv",
                index=False,
            )
            fold_gates = {
                "operation": operation_fold_gates,
                "location": location_fold_gates,
            }
            summary = summarize_pair_decisions(decisions, attempts)
            (output_dir / "feature-names.json").write_text(
                json.dumps({
                    "operation": pair_feature_names,
                    "location": location_feature_names,
                }, indent=2) + "\n",
                encoding="utf8",
            )
        elif args.strategy == "stacked":
            (
                predictions,
                candidate_predictions,
                fold_gates,
                evaluation_pair_indices,
            ) = augmented_stacked_cross_validated_predictions(
                pairs,
                pair_values,
                candidates,
                features,
                args.risk_policy,
                args.pair_scope,
                args.operation_selector,
            )
            evaluation_pairs = pairs.iloc[evaluation_pair_indices].reset_index(drop=True)
            decisions = apply_stacked_gates(
                evaluation_pairs,
                predictions,
                candidate_predictions,
                fold_gates,
                args.pair_scope,
            )
            _, alternative_probability, product_probability = stacked_override_scores(
                evaluation_pairs,
                predictions,
                candidate_predictions,
                "pair",
            )
            evaluation_pairs.assign(
                oof_pair_probability=predictions,
                oof_alternative_probability=alternative_probability,
                oof_product_probability=product_probability,
            ).to_csv(output_dir / "pairs.csv", index=False)
        elif not development_candidates.empty:
            predictions, fold_gates, evaluation_pair_indices = (
                augmented_pairwise_cross_validated_predictions(
                    pairs,
                    pair_values,
                )
            )
            evaluation_pairs = pairs.iloc[evaluation_pair_indices].reset_index(drop=True)
            decisions = apply_pair_gates(
                evaluation_pairs,
                predictions,
                fold_gates,
            )
            evaluation_pairs.assign(oof_probability=predictions).to_csv(
                output_dir / "pairs.csv",
                index=False,
            )
        else:
            predictions, fold_gates = pairwise_cross_validated_predictions(
                pairs,
                pair_values,
            )
            decisions = apply_pair_gates(pairs, predictions, fold_gates)
            pairs.assign(oof_probability=predictions).to_csv(
                output_dir / "pairs.csv",
                index=False,
            )
        if args.strategy != "structured":
            summary = summarize_pair_decisions(decisions, attempts)
            (output_dir / "feature-names.json").write_text(
                json.dumps(pair_feature_names, indent=2) + "\n",
                encoding="utf8",
            )
    else:
        predictions, fold_gates = cross_validated_predictions(candidates, features)
        decisions = apply_fold_gates(candidates, predictions, fold_gates)
        summary = summarize_decisions(decisions, attempts)
        candidates.assign(oof_probability=predictions).to_csv(
            output_dir / "candidates.csv",
            index=False,
        )
        (output_dir / "feature-names.json").write_text(
            json.dumps(feature_names, indent=2) + "\n",
            encoding="utf8",
        )
    summary.update({
        "schemaVersion": 1,
        "strategy": args.strategy,
        "riskPolicy": args.risk_policy,
        "pairScope": args.pair_scope,
        "operationSelector": args.operation_selector,
        "locationHead": args.location_head,
        "runDir": str(run_dir),
        "candidateRows": len(candidates),
        "evaluationCandidateRows": len(evaluation_candidates),
        "developmentCandidateRows": len(candidates) - len(evaluation_candidates),
        "developmentAttempts": development_attempts,
        "attempts": len(attempts),
        "features": len(feature_names),
        "positiveCandidateRows": int(candidates["label_workflow"].sum()),
        "foldGates": fold_gates,
    })
    decisions.to_csv(output_dir / "decisions.csv", index=False)
    attempts.to_csv(output_dir / "attempts.csv", index=False)
    (output_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "outputDir": str(output_dir),
        **summary["event"],
        "clean": summary["clean"],
        "overrides": summary.get("overrides"),
        "beneficialOverrides": summary.get("beneficialOverrides"),
        "harmfulOverrides": summary.get("harmfulOverrides"),
    }))


if __name__ == "__main__":
    main()
