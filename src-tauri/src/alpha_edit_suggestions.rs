use rayon::prelude::*;
use serde::{Deserialize, Serialize};

const INF: f64 = f64::INFINITY;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetWenkPoint {
    pub ring_index: usize,
    #[allow(dead_code)]
    pub year: i32,
    #[allow(dead_code)]
    pub raw_value: f64,
    pub standardized_value: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceWenkPoint {
    pub year: i32,
    pub standardized_value: f64,
    #[allow(dead_code)]
    pub replication: Option<f64>,
    #[allow(dead_code)]
    pub weight: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEditSuggestionInput {
    pub series_id: String,
    pub target: Vec<TargetWenkPoint>,
    pub reference: Vec<ReferenceWenkPoint>,
    pub alpha_max: Option<usize>,
    pub min_overlap: Option<usize>,
    pub top_k: Option<usize>,
    pub scan_outer_year_min: Option<i32>,
    pub scan_outer_year_max: Option<i32>,
    pub opposite_edit_min_gap: Option<usize>,
    pub redundancy_ratio: Option<f64>,
    pub sort_by: Option<String>,
    pub cost_mode: Option<String>,
    pub include_redundant: Option<bool>,
    pub include_heuristic_rejected: Option<bool>,
    pub allow_leading_insert: Option<bool>,
    pub allow_trailing_insert: Option<bool>,
    pub allow_bark_merge: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEditSuggestionResult {
    pub series_id: String,
    pub candidate_count: usize,
    pub returned_count: usize,
    pub reference_outer_year: Option<i32>,
    pub reference_inner_year: Option<i32>,
    pub target_length: usize,
    pub alpha_max: usize,
    pub min_overlap: usize,
    pub cost_mode: String,
    pub candidates: Vec<AlphaEditCandidate>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEditCandidate {
    pub id: String,
    pub rank: usize,
    pub suggested_outer_year: i32,
    pub suggested_inner_year: i32,
    pub reference_outer_year: i32,
    pub reference_inner_year: i32,
    pub alpha: usize,
    pub edit_count: usize,
    pub insert_count: usize,
    pub merge_count: usize,
    pub overlap: usize,
    pub sum_squared_error: f64,
    pub normalized_edit_distance: f64,
    pub correlation: Option<f64>,
    pub t_value: Option<f64>,
    pub operations: Vec<AlphaEditOperation>,
    pub warnings: Vec<String>,
    pub is_redundant: bool,
    pub redundancy_reason: Option<String>,
    pub raw_transformation: Vec<RawTransformationStep>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaEditOperation {
    pub operation_type: String,
    pub target_boundary_index: Option<usize>,
    pub target_ring_index: Option<usize>,
    pub target_ring_index2: Option<usize>,
    pub recommended_delete_index: Option<usize>,
    pub merge_into: Option<String>,
    pub reference_year: i32,
    pub cost_contribution: f64,
    pub operation_order: usize,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTransformationStep {
    pub op: String,
    pub target_ring_index: Option<usize>,
    pub target_ring_index2: Option<usize>,
    pub reference_year: i32,
    pub transformed_value: f64,
    pub reference_value: f64,
    pub cost_contribution: f64,
}

#[derive(Debug, Clone)]
struct EffectiveInput {
    series_id: String,
    target: Vec<TargetWenkPoint>,
    reference: Vec<ReferenceWenkPoint>,
    alpha_max: usize,
    min_overlap: usize,
    top_k: usize,
    scan_outer_year_min: Option<i32>,
    scan_outer_year_max: Option<i32>,
    opposite_edit_min_gap: usize,
    redundancy_ratio: f64,
    sort_by: String,
    cost_mode: String,
    include_redundant: bool,
    include_heuristic_rejected: bool,
    allow_leading_insert: bool,
    allow_trailing_insert: bool,
    allow_bark_merge: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawOpKind {
    None,
    N,
    I,
    M,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GapBlockKind {
    None = 0,
    InsertBlocksMerge = 1,
    MergeBlocksInsert = 2,
}

#[derive(Debug, Clone, Copy)]
struct DpCell {
    cost: f64,
    prev_i: usize,
    prev_j: usize,
    prev_k: usize,
    prev_kind: GapBlockKind,
    prev_remaining: usize,
    op: RawOpKind,
    contribution: f64,
    transformed_value: f64,
    reference_value: f64,
}

impl Default for DpCell {
    fn default() -> Self {
        Self {
            cost: INF,
            prev_i: 0,
            prev_j: 0,
            prev_k: 0,
            prev_kind: GapBlockKind::None,
            prev_remaining: 0,
            op: RawOpKind::None,
            contribution: 0.0,
            transformed_value: 0.0,
            reference_value: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
struct TraceStep {
    op: RawOpKind,
    target_ring_index: Option<usize>,
    target_ring_index2: Option<usize>,
    reference_index: usize,
    transformed_value: f64,
    reference_value: f64,
    contribution: f64,
}

#[derive(Debug, Clone)]
struct DpCandidateDraft {
    final_i: usize,
    final_j: usize,
    final_k: usize,
    final_kind: GapBlockKind,
    final_remaining: usize,
    sum_squared_error: f64,
    normalized_edit_distance: f64,
}

#[tauri::command]
pub async fn suggest_insert_delete_years_alpha_edit(
    input: AlphaEditSuggestionInput,
) -> Result<AlphaEditSuggestionResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_alpha_edit_suggestions(input))
        .await
        .map_err(|error| format!("alpha-edit suggestion worker failed: {}", error))?
}

pub fn run_alpha_edit_suggestions(
    input: AlphaEditSuggestionInput,
) -> Result<AlphaEditSuggestionResult, String> {
    let effective = normalize_input(input)?;
    let mut warnings = Vec::new();
    if effective.cost_mode != "wenk_2003_standardized" {
        warnings.push(
            "Input signal is z-scored or processed; strict Wenk 2003 merge formula may not preserve physical width semantics.".to_string(),
        );
    }
    if effective.sort_by != "t_value" {
        warnings.push("Unsupported sortBy was replaced by t_value.".to_string());
    }
    if effective.include_heuristic_rejected {
        warnings.push("includeHeuristicRejected is reserved; DP-stage opposite edit gap is always enforced.".to_string());
    }

    let offsets: Vec<usize> = effective
        .reference
        .iter()
        .enumerate()
        .filter_map(|(index, point)| {
            if effective.scan_outer_year_min.is_some_and(|min| point.year < min) {
                return None;
            }
            if effective.scan_outer_year_max.is_some_and(|max| point.year > max) {
                return None;
            }
            Some(index)
        })
        .collect();

    let mut candidates: Vec<AlphaEditCandidate> = offsets
        .into_par_iter()
        .flat_map(|offset| run_offset_box(&effective, offset).unwrap_or_default())
        .collect();

    mark_path_redundancy(&mut candidates, effective.redundancy_ratio);
    mark_inter_box_redundancy(&mut candidates, effective.redundancy_ratio);

    let candidate_count = candidates.len();
    if !effective.include_redundant {
        candidates.retain(|candidate| !candidate.is_redundant);
    }

    sort_candidates(&mut candidates);
    candidates.truncate(effective.top_k);
    for (index, candidate) in candidates.iter_mut().enumerate() {
        candidate.rank = index + 1;
    }

    let reference_outer_year = effective.reference.first().map(|point| point.year);
    let reference_inner_year = effective.reference.last().map(|point| point.year);
    let returned_count = candidates.len();

    Ok(AlphaEditSuggestionResult {
        series_id: effective.series_id,
        candidate_count,
        returned_count,
        reference_outer_year,
        reference_inner_year,
        target_length: effective.target.len(),
        alpha_max: effective.alpha_max,
        min_overlap: effective.min_overlap,
        cost_mode: effective.cost_mode,
        candidates,
        warnings,
    })
}

fn normalize_input(input: AlphaEditSuggestionInput) -> Result<EffectiveInput, String> {
    let mut target = input.target;
    target.retain(|point| point.standardized_value.is_finite());
    target.sort_by_key(|point| point.ring_index);
    if target.is_empty() {
        return Err("target is empty after filtering finite standardized values".to_string());
    }

    let mut reference = input.reference;
    reference.retain(|point| point.standardized_value.is_finite());
    reference.sort_by(|a, b| b.year.cmp(&a.year));
    if reference.is_empty() {
        return Err("reference is empty after filtering finite standardized values".to_string());
    }

    let alpha_max = input.alpha_max.unwrap_or(3).min(8);
    let min_overlap = input.min_overlap.unwrap_or(50).max(1);
    let top_k = input.top_k.unwrap_or(20).max(1).min(200);
    let redundancy_ratio = input.redundancy_ratio.unwrap_or(0.9).clamp(0.0, 1.0);
    let sort_by = input.sort_by.unwrap_or_else(|| "t_value".to_string());
    let cost_mode = input.cost_mode.unwrap_or_else(|| "wenk_2003_standardized".to_string());

    Ok(EffectiveInput {
        series_id: input.series_id,
        target,
        reference,
        alpha_max,
        min_overlap,
        top_k,
        scan_outer_year_min: input.scan_outer_year_min,
        scan_outer_year_max: input.scan_outer_year_max,
        opposite_edit_min_gap: input.opposite_edit_min_gap.unwrap_or(10).min(50),
        redundancy_ratio,
        sort_by,
        cost_mode,
        include_redundant: input.include_redundant.unwrap_or(false),
        include_heuristic_rejected: input.include_heuristic_rejected.unwrap_or(false),
        allow_leading_insert: input.allow_leading_insert.unwrap_or(false),
        allow_trailing_insert: input.allow_trailing_insert.unwrap_or(false),
        allow_bark_merge: input.allow_bark_merge.unwrap_or(false),
    })
}

fn run_offset_box(effective: &EffectiveInput, offset: usize) -> Result<Vec<AlphaEditCandidate>, String> {
    let n = effective.target.len();
    let max_columns = effective.reference.len().saturating_sub(offset).min(n + effective.alpha_max);
    if max_columns < effective.min_overlap {
        return Ok(Vec::new());
    }

    let state_shape = StateShape {
        n,
        columns: max_columns,
        alpha_max: effective.alpha_max,
        max_gap_remaining: effective.opposite_edit_min_gap,
    };
    let mut cells = vec![DpCell::default(); state_shape.len()];
    let start_index = state_shape.index(0, 0, 0, GapBlockKind::None, 0);
    cells[start_index].cost = 0.0;

    for i in 0..=n {
        for j in 0..=max_columns {
            for k in 0..=effective.alpha_max {
                for kind in [GapBlockKind::None, GapBlockKind::InsertBlocksMerge, GapBlockKind::MergeBlocksInsert] {
                    for remaining in 0..=effective.opposite_edit_min_gap {
                        let from_index = state_shape.index(i, j, k, kind, remaining);
                        let from = cells[from_index];
                        if !from.cost.is_finite() {
                            continue;
                        }

                        if i < n && j < max_columns {
                            let target_value = effective.target[i].standardized_value;
                            let reference_value = effective.reference[offset + j].standardized_value;
                            let contribution = squared(target_value - reference_value);
                            let (next_kind, next_remaining) = advance_gap(kind, remaining);
                            relax(
                                &mut cells,
                                &state_shape,
                                i + 1,
                                j + 1,
                                k,
                                next_kind,
                                next_remaining,
                                from.cost + contribution,
                                i,
                                j,
                                k,
                                kind,
                                remaining,
                                RawOpKind::N,
                                contribution,
                                target_value,
                                reference_value,
                            );
                        }

                        if j < max_columns && k < effective.alpha_max && can_insert(effective, i, n) {
                            if !(kind == GapBlockKind::MergeBlocksInsert && remaining > 0) {
                                let target_value = (effective.target[i - 1].standardized_value
                                    + effective.target[i].standardized_value)
                                    / 2.0;
                                let reference_value = effective.reference[offset + j].standardized_value;
                                let contribution = squared(target_value - reference_value);
                                relax(
                                    &mut cells,
                                    &state_shape,
                                    i,
                                    j + 1,
                                    k + 1,
                                    GapBlockKind::InsertBlocksMerge,
                                    effective.opposite_edit_min_gap,
                                    from.cost + contribution,
                                    i,
                                    j,
                                    k,
                                    kind,
                                    remaining,
                                    RawOpKind::I,
                                    contribution,
                                    target_value,
                                    reference_value,
                                );
                            }
                        }

                        if i + 1 < n && j < max_columns && k < effective.alpha_max {
                            if !(i == 0 && !effective.allow_bark_merge)
                                && !(kind == GapBlockKind::InsertBlocksMerge && remaining > 0)
                            {
                                let target_value = effective.target[i].standardized_value
                                    + effective.target[i + 1].standardized_value;
                                let reference_value = effective.reference[offset + j].standardized_value;
                                let contribution = squared(target_value - reference_value);
                                relax(
                                    &mut cells,
                                    &state_shape,
                                    i + 2,
                                    j + 1,
                                    k + 1,
                                    GapBlockKind::MergeBlocksInsert,
                                    effective.opposite_edit_min_gap,
                                    from.cost + contribution,
                                    i,
                                    j,
                                    k,
                                    kind,
                                    remaining,
                                    RawOpKind::M,
                                    contribution,
                                    target_value,
                                    reference_value,
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    let mut drafts = Vec::new();
    for k in 0..=effective.alpha_max {
        for j in effective.min_overlap..=max_columns {
            collect_best_state_for_cell(&cells, &state_shape, n, j, k, &mut drafts);
        }
        for i in effective.min_overlap..=n {
            if i != n {
                collect_best_state_for_cell(&cells, &state_shape, i, max_columns, k, &mut drafts);
            }
        }
    }

    let mut candidates = Vec::new();
    for draft in drafts {
        if let Some(candidate) = build_candidate(effective, offset, &cells, &state_shape, draft) {
            candidates.push(candidate);
        }
    }
    Ok(candidates)
}

struct StateShape {
    n: usize,
    columns: usize,
    alpha_max: usize,
    max_gap_remaining: usize,
}

impl StateShape {
    fn len(&self) -> usize {
        (self.n + 1) * (self.columns + 1) * (self.alpha_max + 1) * 3 * (self.max_gap_remaining + 1)
    }

    fn index(
        &self,
        i: usize,
        j: usize,
        k: usize,
        kind: GapBlockKind,
        remaining: usize,
    ) -> usize {
        ((((i * (self.columns + 1) + j) * (self.alpha_max + 1) + k) * 3 + kind as usize)
            * (self.max_gap_remaining + 1))
            + remaining
    }
}

#[allow(clippy::too_many_arguments)]
fn relax(
    cells: &mut [DpCell],
    shape: &StateShape,
    i: usize,
    j: usize,
    k: usize,
    kind: GapBlockKind,
    remaining: usize,
    cost: f64,
    prev_i: usize,
    prev_j: usize,
    prev_k: usize,
    prev_kind: GapBlockKind,
    prev_remaining: usize,
    op: RawOpKind,
    contribution: f64,
    transformed_value: f64,
    reference_value: f64,
) {
    let index = shape.index(i, j, k, kind, remaining);
    if cost < cells[index].cost {
        cells[index] = DpCell {
            cost,
            prev_i,
            prev_j,
            prev_k,
            prev_kind,
            prev_remaining,
            op,
            contribution,
            transformed_value,
            reference_value,
        };
    }
}

fn collect_best_state_for_cell(
    cells: &[DpCell],
    shape: &StateShape,
    i: usize,
    j: usize,
    k: usize,
    drafts: &mut Vec<DpCandidateDraft>,
) {
    let mut best: Option<(GapBlockKind, usize, DpCell)> = None;
    for kind in [GapBlockKind::None, GapBlockKind::InsertBlocksMerge, GapBlockKind::MergeBlocksInsert] {
        for remaining in 0..=shape.max_gap_remaining {
            let cell = cells[shape.index(i, j, k, kind, remaining)];
            if !cell.cost.is_finite() {
                continue;
            }
            if best.map(|(_, _, current)| cell.cost < current.cost).unwrap_or(true) {
                best = Some((kind, remaining, cell));
            }
        }
    }

    if let Some((kind, remaining, cell)) = best {
        let overlap = j.max(1);
        drafts.push(DpCandidateDraft {
            final_i: i,
            final_j: j,
            final_k: k,
            final_kind: kind,
            final_remaining: remaining,
            sum_squared_error: cell.cost,
            normalized_edit_distance: cell.cost / overlap as f64,
        });
    }
}

fn build_candidate(
    effective: &EffectiveInput,
    offset: usize,
    cells: &[DpCell],
    shape: &StateShape,
    draft: DpCandidateDraft,
) -> Option<AlphaEditCandidate> {
    let trace = traceback(cells, shape, &draft)?;
    let transformed: Vec<f64> = trace.iter().map(|step| step.transformed_value).collect();
    let reference_values: Vec<f64> = trace.iter().map(|step| step.reference_value).collect();
    let correlation = pearson(&transformed, &reference_values);
    let t_value = correlation.and_then(|r| t_value_from_r(r, draft.final_j));
    let mut warnings = Vec::new();
    if correlation.is_none() {
        warnings.push("correlation unavailable because overlap is too small or variance is zero".to_string());
    }

    let operations: Vec<AlphaEditOperation> = trace
        .iter()
        .enumerate()
        .filter_map(|(order, step)| match step.op {
            RawOpKind::I => Some(AlphaEditOperation {
                operation_type: "insert_missing_ring_suggestion".to_string(),
                target_boundary_index: step.target_ring_index.map(|index| index.saturating_sub(1)),
                target_ring_index: None,
                target_ring_index2: None,
                recommended_delete_index: None,
                merge_into: None,
                reference_year: effective.reference[offset + step.reference_index].year,
                cost_contribution: step.contribution,
                operation_order: order,
                direction: "bark_to_pith".to_string(),
            }),
            RawOpKind::M => Some(AlphaEditOperation {
                operation_type: "merge_double_ring_suggestion".to_string(),
                target_boundary_index: None,
                target_ring_index: step.target_ring_index,
                target_ring_index2: step.target_ring_index2,
                recommended_delete_index: step.target_ring_index2,
                merge_into: Some("bark_side_neighbor".to_string()),
                reference_year: effective.reference[offset + step.reference_index].year,
                cost_contribution: step.contribution,
                operation_order: order,
                direction: "bark_to_pith".to_string(),
            }),
            _ => None,
        })
        .collect();

    let raw_transformation: Vec<RawTransformationStep> = trace
        .iter()
        .map(|step| RawTransformationStep {
            op: raw_op_label(step.op).to_string(),
            target_ring_index: step.target_ring_index,
            target_ring_index2: step.target_ring_index2,
            reference_year: effective.reference[offset + step.reference_index].year,
            transformed_value: step.transformed_value,
            reference_value: step.reference_value,
            cost_contribution: step.contribution,
        })
        .collect();

    let insert_count = operations
        .iter()
        .filter(|operation| operation.operation_type == "insert_missing_ring_suggestion")
        .count();
    let merge_count = operations
        .iter()
        .filter(|operation| operation.operation_type == "merge_double_ring_suggestion")
        .count();
    let suggested_outer_year = effective.reference[offset].year;
    let suggested_inner_year = effective.reference[offset + draft.final_j - 1].year;
    let id = format!(
        "{}:{}:{}:{}:{}",
        effective.series_id, suggested_outer_year, suggested_inner_year, draft.final_k, draft.final_i
    );

    Some(AlphaEditCandidate {
        id,
        rank: 0,
        suggested_outer_year,
        suggested_inner_year,
        reference_outer_year: suggested_outer_year,
        reference_inner_year: suggested_inner_year,
        alpha: draft.final_k,
        edit_count: operations.len(),
        insert_count,
        merge_count,
        overlap: draft.final_j,
        sum_squared_error: draft.sum_squared_error,
        normalized_edit_distance: draft.normalized_edit_distance,
        correlation,
        t_value,
        operations,
        warnings,
        is_redundant: false,
        redundancy_reason: None,
        raw_transformation,
    })
}

fn traceback(cells: &[DpCell], shape: &StateShape, draft: &DpCandidateDraft) -> Option<Vec<TraceStep>> {
    let mut i = draft.final_i;
    let mut j = draft.final_j;
    let mut k = draft.final_k;
    let mut kind = draft.final_kind;
    let mut remaining = draft.final_remaining;
    let mut steps = Vec::new();

    while !(i == 0 && j == 0 && k == 0) {
        let cell = cells[shape.index(i, j, k, kind, remaining)];
        if !cell.cost.is_finite() || cell.op == RawOpKind::None {
            return None;
        }
        let reference_index = j.checked_sub(1)?;
        let (target_ring_index, target_ring_index2) = match cell.op {
            RawOpKind::N => (i.checked_sub(1), None),
            RawOpKind::I => (Some(i), None),
            RawOpKind::M => (i.checked_sub(2), i.checked_sub(1)),
            RawOpKind::None => (None, None),
        };
        steps.push(TraceStep {
            op: cell.op,
            target_ring_index,
            target_ring_index2,
            reference_index,
            transformed_value: cell.transformed_value,
            reference_value: cell.reference_value,
            contribution: cell.contribution,
        });
        i = cell.prev_i;
        j = cell.prev_j;
        k = cell.prev_k;
        kind = cell.prev_kind;
        remaining = cell.prev_remaining;
    }

    steps.reverse();
    Some(steps)
}

fn can_insert(effective: &EffectiveInput, i: usize, n: usize) -> bool {
    if i == 0 {
        return effective.allow_leading_insert && n > 0;
    }
    if i >= n {
        return effective.allow_trailing_insert && n > 0;
    }
    true
}

fn advance_gap(kind: GapBlockKind, remaining: usize) -> (GapBlockKind, usize) {
    if remaining <= 1 {
        (GapBlockKind::None, 0)
    } else {
        (kind, remaining - 1)
    }
}

fn squared(value: f64) -> f64 {
    value * value
}

fn raw_op_label(kind: RawOpKind) -> &'static str {
    match kind {
        RawOpKind::None => "?",
        RawOpKind::N => "N",
        RawOpKind::I => "I",
        RawOpKind::M => "M",
    }
}

fn sort_candidates(candidates: &mut [AlphaEditCandidate]) {
    candidates.sort_by(|a, b| {
        option_desc(b.t_value, a.t_value)
            .then_with(|| option_desc(b.correlation, a.correlation))
            .then_with(|| a.normalized_edit_distance.total_cmp(&b.normalized_edit_distance))
            .then_with(|| a.edit_count.cmp(&b.edit_count))
            .then_with(|| b.overlap.cmp(&a.overlap))
            .then_with(|| b.suggested_outer_year.cmp(&a.suggested_outer_year))
    });
}

fn option_desc(left: Option<f64>, right: Option<f64>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(a), Some(b)) => a.total_cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn pearson(x: &[f64], y: &[f64]) -> Option<f64> {
    if x.len() != y.len() || x.len() < 3 {
        return None;
    }
    let n = x.len() as f64;
    let sum_x = x.iter().sum::<f64>();
    let sum_y = y.iter().sum::<f64>();
    let sum_xy = x.iter().zip(y).map(|(a, b)| a * b).sum::<f64>();
    let sum_x2 = x.iter().map(|value| value * value).sum::<f64>();
    let sum_y2 = y.iter().map(|value| value * value).sum::<f64>();
    let numerator = n * sum_xy - sum_x * sum_y;
    let denominator = ((n * sum_x2 - sum_x * sum_x) * (n * sum_y2 - sum_y * sum_y)).sqrt();
    if denominator <= 0.0 {
        None
    } else {
        Some((numerator / denominator).clamp(-0.999_999, 0.999_999))
    }
}

fn t_value_from_r(r: f64, overlap: usize) -> Option<f64> {
    if overlap <= 2 {
        return None;
    }
    let clamped = r.clamp(-0.999_999, 0.999_999);
    Some(clamped * (((overlap - 2) as f64) / (1.0 - clamped * clamped)).sqrt())
}

fn mark_path_redundancy(candidates: &mut [AlphaEditCandidate], redundancy_ratio: f64) {
    let snapshot: Vec<(i32, i32, usize, f64)> = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.suggested_outer_year,
                candidate.suggested_inner_year,
                candidate.edit_count,
                candidate.normalized_edit_distance,
            )
        })
        .collect();

    for candidate in candidates.iter_mut() {
        if candidate.edit_count == 0 || candidate.is_redundant {
            continue;
        }
        let comparison = snapshot
            .iter()
            .filter(|(outer, inner, edit_count, _)| {
                *outer == candidate.suggested_outer_year
                    && *inner == candidate.suggested_inner_year
                    && *edit_count < candidate.edit_count
            })
            .map(|(_, _, _, distance)| *distance)
            .min_by(|a, b| a.total_cmp(b));
        if comparison.is_some_and(|distance| {
            distance > 0.0 && candidate.normalized_edit_distance / distance >= redundancy_ratio
        }) {
            candidate.is_redundant = true;
            candidate.redundancy_reason = Some("path_redundancy_check_failed".to_string());
        }
    }
}

fn mark_inter_box_redundancy(candidates: &mut [AlphaEditCandidate], redundancy_ratio: f64) {
    let snapshot: Vec<(i32, String, f64)> = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.suggested_outer_year,
                edit_sequence(candidate),
                candidate.normalized_edit_distance,
            )
        })
        .collect();

    for candidate in candidates.iter_mut() {
        if candidate.edit_count == 0 || candidate.is_redundant {
            continue;
        }
        let sequence = edit_sequence(candidate);
        if sequence.len() <= 1 {
            continue;
        }
        for prefix_len in 1..sequence.len() {
            let prefix = &sequence[..prefix_len];
            let suffix = &sequence[prefix_len..];
            let transposition = prefix.chars().fold(0, |sum, op| match op {
                'I' => sum + 1,
                'M' => sum - 1,
                _ => sum,
            });
            let comparison_outer = candidate.suggested_outer_year + transposition;
            let comparison = snapshot
                .iter()
                .find(|(outer, edits, _)| *outer == comparison_outer && edits == suffix)
                .map(|(_, _, distance)| *distance);
            if comparison.is_some_and(|distance| {
                distance > 0.0 && candidate.normalized_edit_distance / distance >= redundancy_ratio
            }) {
                candidate.is_redundant = true;
                candidate.redundancy_reason = Some("inter_box_edit_prefix_redundancy".to_string());
                break;
            }
        }
    }
}

fn edit_sequence(candidate: &AlphaEditCandidate) -> String {
    candidate
        .operations
        .iter()
        .map(|operation| {
            if operation.operation_type == "insert_missing_ring_suggestion" {
                'I'
            } else {
                'M'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(values: &[f64]) -> Vec<TargetWenkPoint> {
        values
            .iter()
            .enumerate()
            .map(|(index, value)| TargetWenkPoint {
                ring_index: index,
                year: 2000 - index as i32,
                raw_value: *value,
                standardized_value: *value,
            })
            .collect()
    }

    fn reference(values: &[f64]) -> Vec<ReferenceWenkPoint> {
        values
            .iter()
            .enumerate()
            .map(|(index, value)| ReferenceWenkPoint {
                year: 2000 - index as i32,
                standardized_value: *value,
                replication: Some(10.0),
                weight: Some(1.0),
            })
            .collect()
    }

    fn input(values: &[f64], ref_values: &[f64], alpha_max: usize) -> AlphaEditSuggestionInput {
        AlphaEditSuggestionInput {
            series_id: "T1".to_string(),
            target: target(values),
            reference: reference(ref_values),
            alpha_max: Some(alpha_max),
            min_overlap: Some(3),
            top_k: Some(20),
            scan_outer_year_min: Some(2000),
            scan_outer_year_max: Some(2000),
            opposite_edit_min_gap: Some(10),
            redundancy_ratio: Some(0.9),
            sort_by: Some("t_value".to_string()),
            cost_mode: Some("wenk_2003_standardized".to_string()),
            include_redundant: Some(true),
            include_heuristic_rejected: Some(false),
            allow_leading_insert: Some(false),
            allow_trailing_insert: Some(false),
            allow_bark_merge: Some(true),
        }
    }

    #[test]
    fn alpha_zero_returns_identity_baseline_only() {
        let result = run_alpha_edit_suggestions(input(&[1.0, 2.0, 3.0, 4.0], &[1.0, 2.0, 3.0, 4.0], 0)).unwrap();
        let best = result.candidates.first().unwrap();
        assert_eq!(best.alpha, 0);
        assert!(best.operations.is_empty());
        assert_eq!(best.raw_transformation.iter().map(|step| step.op.as_str()).collect::<Vec<_>>(), vec!["N", "N", "N", "N"]);
    }

    #[test]
    fn missing_ring_uses_insert_average() {
        let result = run_alpha_edit_suggestions(input(&[1.0, 2.0, 4.0, 5.0], &[1.0, 2.0, 3.0, 4.0, 5.0], 1)).unwrap();
        let candidate = result
            .candidates
            .iter()
            .find(|candidate| candidate.insert_count == 1)
            .unwrap();
        let operation = candidate.operations.first().unwrap();
        assert_eq!(operation.operation_type, "insert_missing_ring_suggestion");
        assert_eq!(operation.target_boundary_index, Some(1));
        assert_eq!(operation.reference_year, 1998);
        let inserted = candidate
            .raw_transformation
            .iter()
            .find(|step| step.op == "I")
            .unwrap();
        assert_eq!(inserted.transformed_value, 3.0);
        assert_eq!(candidate.sum_squared_error, 0.0);
    }

    #[test]
    fn double_ring_uses_wenk_sum_merge_not_average() {
        let result = run_alpha_edit_suggestions(input(&[1.0, 2.0, 3.0, 4.0, 5.0], &[1.0, 2.0, 7.0, 5.0], 1)).unwrap();
        let candidate = result
            .candidates
            .iter()
            .find(|candidate| candidate.merge_count == 1)
            .unwrap();
        let operation = candidate.operations.first().unwrap();
        assert_eq!(operation.operation_type, "merge_double_ring_suggestion");
        assert_eq!(operation.target_ring_index, Some(2));
        assert_eq!(operation.target_ring_index2, Some(3));
        assert_eq!(operation.recommended_delete_index, Some(3));
        let merged = candidate
            .raw_transformation
            .iter()
            .find(|step| step.op == "M")
            .unwrap();
        assert_eq!(merged.transformed_value, 7.0);
        assert_eq!(candidate.sum_squared_error, 0.0);
    }

    #[test]
    fn min_overlap_filters_short_matches() {
        let mut request = input(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0], 0);
        request.min_overlap = Some(4);
        let result = run_alpha_edit_suggestions(request).unwrap();
        assert!(result.candidates.is_empty());
    }

    #[test]
    fn last_column_returns_target_prefix_when_reference_ends() {
        let mut request = input(&[1.0, 2.0, 3.0, 4.0, 9.0], &[1.0, 2.0, 3.0, 4.0], 0);
        request.min_overlap = Some(4);
        let result = run_alpha_edit_suggestions(request).unwrap();
        let best = result.candidates.first().unwrap();
        assert_eq!(best.overlap, 4);
        assert_eq!(best.raw_transformation.len(), 4);
        assert_eq!(best.suggested_inner_year, 1997);
    }

    #[test]
    fn opposite_edit_gap_is_enforced_during_dp() {
        let mut request = input(&[1.0, 2.0, 4.0, 2.0, 3.0], &[1.0, 2.0, 3.0, 6.0, 3.0], 2);
        request.opposite_edit_min_gap = Some(10);
        let result = run_alpha_edit_suggestions(request).unwrap();
        assert!(result
            .candidates
            .iter()
            .all(|candidate| edit_sequence(candidate) != "IM" && edit_sequence(candidate) != "MI"));
    }
}
