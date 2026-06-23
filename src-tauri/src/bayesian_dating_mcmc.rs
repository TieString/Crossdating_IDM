use rand::prelude::*;
use rand_distr::{Distribution, Gamma, StandardNormal};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetPoint {
    pub index: usize,
    pub value: f64,
    #[allow(dead_code)]
    pub original_year: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencePoint {
    pub year: i32,
    pub value: f64,
    pub replication: Option<f64>,
    pub weight: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BayesianMcmcDatingInput {
    pub target_series_id: String,
    pub target: Vec<TargetPoint>,
    pub reference: Vec<ReferencePoint>,
    pub min_overlap: Option<usize>,
    pub prior_start_year: Option<i32>,
    pub prior_end_year: Option<i32>,
    pub iterations: Option<usize>,
    pub burn_in: Option<usize>,
    pub thin: Option<usize>,
    pub chains: Option<usize>,
    pub seed: Option<u64>,
    pub k_beta: Option<f64>,
    pub au: Option<f64>,
    pub bu: Option<f64>,
    pub ae: Option<f64>,
    pub be: Option<f64>,
    pub max_returned_candidates: Option<usize>,
    pub use_reference_replication_weight: Option<bool>,
    pub candidate_overlap_fraction_of_best: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BayesianDatingCandidate {
    pub start_year: i32,
    pub end_year: i32,
    pub posterior: f64,
    pub sample_count: usize,
    pub overlap: usize,
    pub correlation: Option<f64>,
    pub t_value: Option<f64>,
    pub mean_beta: f64,
    pub mean_sigma_u2: f64,
    pub mean_sigma_e2: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterStats {
    pub mean: f64,
    pub sd: f64,
    pub q025: f64,
    pub median: f64,
    pub q975: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterSummary {
    pub beta: ParameterStats,
    pub sigma_u2: ParameterStats,
    pub sigma_e2: ParameterStats,
    pub signal_to_noise: ParameterStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McmcSummary {
    pub iterations: usize,
    pub burn_in: usize,
    pub thin: usize,
    pub chains: usize,
    pub retained_samples: usize,
    pub retained_samples_per_chain: Vec<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainDeltaTop {
    pub start_year: i32,
    pub posterior: f64,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainDiagnostics {
    pub chain_index: usize,
    pub retained_samples: usize,
    pub best_start_year: Option<i32>,
    pub top_deltas: Vec<ChainDeltaTop>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhatSummary {
    pub beta: Option<f64>,
    pub sigma_u2: Option<f64>,
    pub sigma_e2: Option<f64>,
    pub signal_to_noise: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub chains: Vec<ChainDiagnostics>,
    pub combined_best_start_year: Option<i32>,
    pub chain_top_agreement: bool,
    pub discrete_delta_stable: bool,
    pub r_hat: RhatSummary,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BayesianMcmcDatingResult {
    pub target_series_id: String,
    pub target_length: usize,
    pub reference_start_year: i32,
    pub reference_end_year: i32,
    pub min_overlap: usize,
    pub candidate_count: usize,
    pub best: Option<BayesianDatingCandidate>,
    pub second_best: Option<BayesianDatingCandidate>,
    pub hpd95: Vec<BayesianDatingCandidate>,
    pub candidates: Vec<BayesianDatingCandidate>,
    pub mcmc_summary: McmcSummary,
    pub parameter_summary: ParameterSummary,
    pub diagnostics: Diagnostics,
    pub decision: Decision,
}

#[derive(Clone)]
struct Pair {
    year_index: usize,
    target_value: f64,
    reference_value: f64,
}

#[derive(Clone)]
struct RefObservation {
    year_index: usize,
    value: f64,
    weight: f64,
}

#[derive(Clone)]
struct CandidateAlignment {
    start_year: i32,
    end_year: i32,
    pairs: Vec<Pair>,
    correlation: Option<f64>,
    t_value: Option<f64>,
}

#[derive(Default)]
struct ChainSamples {
    deltas: Vec<usize>,
    beta: Vec<f64>,
    sigma_u2: Vec<f64>,
    sigma_e2: Vec<f64>,
    signal_to_noise: Vec<f64>,
}

#[derive(Default)]
struct ChainTiming {
    total: Duration,
    beta: Duration,
    target_alignment: Duration,
    latent_year_effects: Duration,
    sigma_u: Duration,
    sigma_e: Duration,
    delta_likelihood: Duration,
    delta_sample: Duration,
    retention: Duration,
}

struct PreparedInput {
    reference_start_year: i32,
    reference_end_year: i32,
    target_length: usize,
    year_count: usize,
    ref_obs: Vec<RefObservation>,
    ref_value_by_year: Vec<f64>,
    ref_weight_by_year: Vec<f64>,
    candidates: Vec<CandidateAlignment>,
    best_correlation_index: usize,
}

#[tauri::command]
pub async fn bayesian_date_series_mcmc(
    input: BayesianMcmcDatingInput,
) -> Result<BayesianMcmcDatingResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_bayesian_date_series_mcmc(input))
        .await
        .map_err(|error| format!("Bayesian dating worker failed: {}", error))?
}

pub fn run_bayesian_date_series_mcmc(
    input: BayesianMcmcDatingInput,
) -> Result<BayesianMcmcDatingResult, String> {
    let total_started = Instant::now();
    let min_overlap = input.min_overlap.unwrap_or(50).max(1);
    let iterations = input.iterations.unwrap_or(50_000).max(1);
    let burn_in = input.burn_in.unwrap_or(10_000).min(iterations);
    let thin = input.thin.unwrap_or(10).max(1);
    let chains = input.chains.unwrap_or(3).max(1);
    let k_beta = positive_or(input.k_beta, 1000.0, "kBeta")?;
    let au = positive_or(input.au, 0.01, "au")?;
    let bu = positive_or(input.bu, 0.01, "bu")?;
    let ae = positive_or(input.ae, 0.01, "ae")?;
    let be = positive_or(input.be, 0.01, "be")?;
    let max_returned = input.max_returned_candidates.unwrap_or(30).max(1);
    let use_reference_replication_weight = input.use_reference_replication_weight.unwrap_or(false);

    let candidate_overlap_fraction_of_best = input
        .candidate_overlap_fraction_of_best
        .unwrap_or(0.9)
        .clamp(0.0, 1.0);
    let prepare_started = Instant::now();
    let prepared = prepare_input(
        &input,
        min_overlap,
        use_reference_replication_weight,
        candidate_overlap_fraction_of_best,
    )?;
    let prepare_elapsed = prepare_started.elapsed();
    let retained_per_chain = retained_count(iterations, burn_in, thin);
    let total_pair_count: usize = prepared
        .candidates
        .iter()
        .map(|candidate| candidate.pairs.len())
        .sum();

    println!(
        "[Bayesian dating][{}] start targetPoints={} referencePoints={} targetLength={} candidates={} candidatePairs={} yearCount={} iterations={} burnIn={} thin={} chains={} minOverlap={}",
        input.target_series_id,
        input.target.len(),
        input.reference.len(),
        prepared.target_length,
        prepared.candidates.len(),
        total_pair_count,
        prepared.year_count,
        iterations,
        burn_in,
        thin,
        chains,
        min_overlap,
    );
    println!(
        "[Bayesian dating][{}] prepareInput={}",
        input.target_series_id,
        format_duration_ms(prepare_elapsed),
    );

    let mut chain_results: Vec<(usize, ChainSamples, ChainTiming)> = (0..chains)
        .into_par_iter()
        .map(|chain_index| {
            let seed = input
                .seed
                .unwrap_or_else(|| 0xA6D7_9C31_5EED_u64)
                .wrapping_add((chain_index as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let mut rng = StdRng::seed_from_u64(seed);
            let (samples, timing) = run_chain(
                &prepared,
                iterations,
                burn_in,
                thin,
                chain_index,
                k_beta,
                au,
                bu,
                ae,
                be,
                &mut rng,
            )?;
            Ok::<_, String>((chain_index, samples, timing))
        })
        .collect::<Result<Vec<_>, _>>()?;
    chain_results.sort_by_key(|(chain_index, _, _)| *chain_index);

    let mut chain_samples = Vec::with_capacity(chains);
    let mut chain_timings = Vec::with_capacity(chains);
    for (chain_index, samples, timing) in chain_results {
        log_chain_timing(&input.target_series_id, chain_index, chains, &timing);
        chain_samples.push(samples);
        chain_timings.push(timing);
    }

    let aggregation_started = Instant::now();
    let retained_samples: usize = chain_samples
        .iter()
        .map(|samples| samples.deltas.len())
        .sum();
    if retained_samples == 0 {
        return Err("MCMC retained no samples; reduce burnIn or thin".to_string());
    }

    let mut posterior_counts = vec![0usize; prepared.candidates.len()];
    let mut beta_all = Vec::with_capacity(retained_samples);
    let mut sigma_u2_all = Vec::with_capacity(retained_samples);
    let mut sigma_e2_all = Vec::with_capacity(retained_samples);
    let mut signal_to_noise_all = Vec::with_capacity(retained_samples);

    for samples in &chain_samples {
        for &delta_index in &samples.deltas {
            posterior_counts[delta_index] += 1;
        }
        beta_all.extend_from_slice(&samples.beta);
        sigma_u2_all.extend_from_slice(&samples.sigma_u2);
        sigma_e2_all.extend_from_slice(&samples.sigma_e2);
        signal_to_noise_all.extend_from_slice(&samples.signal_to_noise);
    }

    let beta_mean = mean(&beta_all);
    let sigma_u2_mean = mean(&sigma_u2_all);
    let sigma_e2_mean = mean(&sigma_e2_all);

    let mut all_candidates: Vec<BayesianDatingCandidate> = prepared
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let sample_count = posterior_counts[index];
            BayesianDatingCandidate {
                start_year: candidate.start_year,
                end_year: candidate.end_year,
                posterior: sample_count as f64 / retained_samples as f64,
                sample_count,
                overlap: candidate.pairs.len(),
                correlation: candidate.correlation,
                t_value: candidate.t_value,
                mean_beta: beta_mean,
                mean_sigma_u2: sigma_u2_mean,
                mean_sigma_e2: sigma_e2_mean,
            }
        })
        .collect();

    // Posterior-ordered view: drives the 95% HPD interval and identifies the MCMC
    // posterior mode (used only to gauge confidence, not as the point estimate).
    let mut by_posterior = all_candidates.clone();
    by_posterior.sort_by(|a, b| {
        b.posterior
            .total_cmp(&a.posterior)
            .then_with(|| {
                b.t_value
                    .unwrap_or(f64::NEG_INFINITY)
                    .total_cmp(&a.t_value.unwrap_or(f64::NEG_INFINITY))
            })
            .then_with(|| a.start_year.cmp(&b.start_year))
    });
    let hpd95 = build_hpd95(&by_posterior);
    let posterior_top = by_posterior.first().cloned();

    // Headline ordering: rank by deterministic fit (t-value), which stays robust when the
    // MCMC posterior is multimodal (e.g. an internal false/missing ring spreads the mass
    // across offsets). Divergence between this t-top and the posterior-top is itself a
    // signal that the series is not a clean rigid match.
    all_candidates.sort_by(|a, b| {
        b.t_value
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&a.t_value.unwrap_or(f64::NEG_INFINITY))
            .then_with(|| b.posterior.total_cmp(&a.posterior))
            .then_with(|| a.start_year.cmp(&b.start_year))
    });

    let best = all_candidates.first().cloned();
    let second_best = all_candidates.get(1).cloned();
    let diagnostics = build_diagnostics(
        &chain_samples,
        &prepared.candidates,
        best.as_ref(),
        hpd95.len(),
        iterations,
        retained_samples,
        retained_per_chain,
    );
    let decision = build_decision(best.as_ref(), posterior_top.as_ref(), &diagnostics);
    let aggregation_elapsed = aggregation_started.elapsed();

    let result = BayesianMcmcDatingResult {
        target_series_id: input.target_series_id,
        target_length: prepared.target_length,
        reference_start_year: prepared.reference_start_year,
        reference_end_year: prepared.reference_end_year,
        min_overlap,
        candidate_count: prepared.candidates.len(),
        best,
        second_best,
        hpd95,
        candidates: all_candidates.into_iter().take(max_returned).collect(),
        mcmc_summary: McmcSummary {
            iterations,
            burn_in,
            thin,
            chains,
            retained_samples,
            retained_samples_per_chain: chain_samples
                .iter()
                .map(|samples| samples.deltas.len())
                .collect(),
        },
        parameter_summary: ParameterSummary {
            beta: summarize(&beta_all),
            sigma_u2: summarize(&sigma_u2_all),
            sigma_e2: summarize(&sigma_e2_all),
            signal_to_noise: summarize(&signal_to_noise_all),
        },
        diagnostics,
        decision,
    };
    let chain_total = chain_timings
        .iter()
        .fold(Duration::from_secs(0), |total, timing| total + timing.total);
    println!(
        "[Bayesian dating][{}] aggregate={} chainsTotal={} total={} bestStart={:?} bestPosterior={:.3}",
        result.target_series_id,
        format_duration_ms(aggregation_elapsed),
        format_duration_ms(chain_total),
        format_duration_ms(total_started.elapsed()),
        result.best.as_ref().map(|candidate| candidate.start_year),
        result.best.as_ref().map(|candidate| candidate.posterior).unwrap_or(0.0),
    );

    Ok(result)
}

fn positive_or(value: Option<f64>, fallback: f64, name: &str) -> Result<f64, String> {
    let next = value.unwrap_or(fallback);
    if next.is_finite() && next > 0.0 {
        Ok(next)
    } else {
        Err(format!("{} must be a positive finite number", name))
    }
}

fn prepare_input(
    input: &BayesianMcmcDatingInput,
    min_overlap: usize,
    use_reference_replication_weight: bool,
    candidate_overlap_fraction_of_best: f64,
) -> Result<PreparedInput, String> {
    if input.target.is_empty() {
        return Err("target series is empty after standardization".to_string());
    }
    if input.reference.is_empty() {
        return Err("COFECHA-pass reference is empty".to_string());
    }

    let mut target = input.target.clone();
    target.sort_by_key(|point| point.index);
    let target_length = target.iter().map(|point| point.index).max().unwrap_or(0) + 1;
    if target_length < min_overlap {
        return Err(format!(
            "target length {} is shorter than minOverlap {}",
            target_length, min_overlap
        ));
    }

    let mut reference_by_year: HashMap<i32, &ReferencePoint> = HashMap::new();
    for point in &input.reference {
        if !point.value.is_finite() {
            continue;
        }
        reference_by_year.insert(point.year, point);
    }
    if reference_by_year.is_empty() {
        return Err("COFECHA-pass reference has no finite points".to_string());
    }

    let reference_start_year = *reference_by_year.keys().min().unwrap();
    let reference_end_year = *reference_by_year.keys().max().unwrap();
    let theoretical_min_start = reference_start_year - target_length as i32 + min_overlap as i32;
    let theoretical_max_start = reference_end_year - min_overlap as i32 + 1;
    let candidate_min = input
        .prior_start_year
        .unwrap_or(theoretical_min_start)
        .max(theoretical_min_start);
    let candidate_max = input
        .prior_end_year
        .unwrap_or(theoretical_max_start)
        .min(theoretical_max_start);
    if candidate_min > candidate_max {
        return Err("candidate start-year range is empty after applying prior range".to_string());
    }

    let mut years: Vec<i32> = reference_by_year.keys().copied().collect();
    let mut raw_candidates: Vec<(i32, Vec<(i32, f64, f64)>)> = Vec::new();
    for start_year in candidate_min..=candidate_max {
        let mut pairs = Vec::new();
        for point in &target {
            if !point.value.is_finite() {
                continue;
            }
            let year = start_year + point.index as i32;
            if let Some(reference_point) = reference_by_year.get(&year) {
                pairs.push((year, point.value, reference_point.value));
                years.push(year);
            }
        }
        if pairs.len() >= min_overlap {
            raw_candidates.push((start_year, pairs));
        }
    }

    if raw_candidates.is_empty() {
        return Err("no candidate start years meet minOverlap".to_string());
    }
    let max_overlap = raw_candidates
        .iter()
        .map(|(_, pairs)| pairs.len())
        .max()
        .unwrap_or(0);
    let overlap_threshold = min_overlap.max(
        (max_overlap as f64 * candidate_overlap_fraction_of_best)
            .ceil()
            .max(1.0) as usize,
    );
    raw_candidates.retain(|(_, pairs)| pairs.len() >= overlap_threshold);

    if raw_candidates.is_empty() {
        return Err("no candidate start years meet the overlap fraction threshold".to_string());
    }

    years.sort_unstable();
    years.dedup();
    let year_index_by_year: HashMap<i32, usize> = years
        .iter()
        .enumerate()
        .map(|(index, year)| (*year, index))
        .collect();

    let mut ref_obs = Vec::new();
    let mut ref_value_by_year = vec![0.0; years.len()];
    let mut ref_weight_by_year = vec![0.0; years.len()];
    for reference_point in reference_by_year.values() {
        let weight = if use_reference_replication_weight {
            reference_point
                .replication
                .or(reference_point.weight)
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(1.0)
        } else {
            1.0
        };
        ref_obs.push(RefObservation {
            year_index: year_index_by_year[&reference_point.year],
            value: reference_point.value,
            weight,
        });
        let year_index = year_index_by_year[&reference_point.year];
        ref_value_by_year[year_index] = reference_point.value;
        ref_weight_by_year[year_index] = weight;
    }

    let mut candidates = Vec::new();
    for (start_year, raw_pairs) in raw_candidates {
        let mut pairs: Vec<Pair> = raw_pairs
            .into_iter()
            .map(|(year, target_value, reference_value)| Pair {
                year_index: year_index_by_year[&year],
                target_value,
                reference_value,
            })
            .collect();
        pairs.sort_unstable_by_key(|pair| pair.year_index);
        let correlation = pearson_from_pairs(&pairs);
        let t_value = correlation.and_then(|r| t_value_from_r(r, pairs.len()));
        candidates.push(CandidateAlignment {
            start_year,
            end_year: start_year + target_length as i32 - 1,
            pairs,
            correlation,
            t_value,
        });
    }

    let best_correlation_index = candidates
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| {
            a.correlation
                .unwrap_or(f64::NEG_INFINITY)
                .total_cmp(&b.correlation.unwrap_or(f64::NEG_INFINITY))
        })
        .map(|(index, _)| index)
        .unwrap_or(0);

    Ok(PreparedInput {
        reference_start_year,
        reference_end_year,
        target_length,
        year_count: years.len(),
        ref_obs,
        ref_value_by_year,
        ref_weight_by_year,
        candidates,
        best_correlation_index,
    })
}

fn run_chain(
    prepared: &PreparedInput,
    iterations: usize,
    burn_in: usize,
    thin: usize,
    chain_index: usize,
    k_beta: f64,
    au: f64,
    bu: f64,
    ae: f64,
    be: f64,
    rng: &mut StdRng,
) -> Result<(ChainSamples, ChainTiming), String> {
    let chain_started = Instant::now();
    let mut timing = ChainTiming::default();
    let mut beta: f64 = 0.0;
    let mut sigma_u2: f64 = 0.2;
    let mut sigma_e2: f64 = 0.8;
    // Seed the alignment so each chain starts in a plausible basin (chain 0 at the
    // highest-correlation candidate). Delta is resampled from iteration 1 on; the seed
    // only gives the signal mode a foothold so the hierarchical variances do not
    // collapse into a spurious "no signal" basin before any good alignment is visited.
    let mut current_delta = initial_delta_index(prepared, chain_index, rng);
    let mut u = vec![0.0; prepared.year_count];
    let mut ref_count_by_year = vec![0usize; prepared.year_count];
    for obs in &prepared.ref_obs {
        u[obs.year_index] += obs.value;
        ref_count_by_year[obs.year_index] += 1;
    }
    for (index, count) in ref_count_by_year.iter().enumerate() {
        if *count > 0 {
            u[index] /= *count as f64;
        }
    }

    let mut samples = ChainSamples::default();
    let mut log_probs = vec![0.0; prepared.candidates.len()];
    let mut categorical_weights = vec![0.0; prepared.candidates.len()];
    // Reference-informed predictive of the target, recomputed each iteration so the
    // alignment delta can be scored with the latent year effects u integrated out.
    let mut pred_mean = vec![0.0; prepared.year_count];
    let mut inv_pred_var = vec![0.0; prepared.year_count];
    let mut half_ln_pred_var = vec![0.0; prepared.year_count];

    for iteration in 0..iterations {
        // === 1. Sample the alignment delta with u analytically integrated out, so the
        //        score is the reference-informed predictive density of the target and
        //        does not depend on where the chain currently sits (no self-reinforcing
        //        freeze). Iteration 0 keeps the seed so the variances are first
        //        estimated in a signalled basin. ===
        if iteration > 0 {
            let section_started = Instant::now();
            for year_index in 0..prepared.year_count {
                let ref_weight = prepared.ref_weight_by_year[year_index];
                let precision_u_ref = (1.0 / sigma_u2) + ref_weight / sigma_e2;
                let tau2 = 1.0 / precision_u_ref.max(1e-12);
                let mu_u_ref =
                    tau2 * ref_weight * (prepared.ref_value_by_year[year_index] - beta) / sigma_e2;
                let predictive_var = (tau2 + sigma_e2).max(1e-12);
                pred_mean[year_index] = beta + mu_u_ref;
                inv_pred_var[year_index] = 1.0 / predictive_var;
                half_ln_pred_var[year_index] = 0.5 * predictive_var.ln();
            }
            timing.delta_likelihood += section_started.elapsed();

            let section_started = Instant::now();
            if prepared.candidates.len() >= 64 {
                log_probs
                    .par_iter_mut()
                    .enumerate()
                    .for_each(|(index, log_prob)| {
                        *log_prob = marginal_delta_log_likelihood(
                            &prepared.candidates[index],
                            &pred_mean,
                            &inv_pred_var,
                            &half_ln_pred_var,
                        );
                    });
            } else {
                for (index, candidate) in prepared.candidates.iter().enumerate() {
                    log_probs[index] = marginal_delta_log_likelihood(
                        candidate,
                        &pred_mean,
                        &inv_pred_var,
                        &half_ln_pred_var,
                    );
                }
            }
            current_delta =
                sample_categorical_log_probs(&log_probs, &mut categorical_weights, rng)?;
            timing.delta_sample += section_started.elapsed();
        }

        let current_pairs = &prepared.candidates[current_delta].pairs;

        // === 2. Resample u given the (new) delta — completes the (delta, u) block draw. ===
        let section_started = Instant::now();
        let mut pair_index = 0usize;
        for year_index in 0..prepared.year_count {
            let ref_weight = prepared.ref_weight_by_year[year_index];
            let mut weight_sum = ref_weight;
            let mut weighted_residual_sum =
                ref_weight * (prepared.ref_value_by_year[year_index] - beta);

            while pair_index < current_pairs.len()
                && current_pairs[pair_index].year_index < year_index
            {
                pair_index += 1;
            }
            if pair_index < current_pairs.len()
                && current_pairs[pair_index].year_index == year_index
            {
                weight_sum += 1.0;
                weighted_residual_sum += current_pairs[pair_index].target_value - beta;
            }
            let numerator = weighted_residual_sum / sigma_e2;
            let precision = (1.0 / sigma_u2) + weight_sum / sigma_e2;
            let var_u = 1.0 / precision.max(1e-12);
            let mean_u = var_u * numerator;
            u[year_index] = sample_normal(mean_u, var_u.sqrt(), rng);
        }
        timing.latent_year_effects += section_started.elapsed();

        // === 3. Sample the global mean beta given u and the new delta. ===
        let section_started = Instant::now();
        let mut precision = 1.0 / k_beta;
        let mut numerator = 0.0;
        for obs in &prepared.ref_obs {
            let w = obs.weight;
            precision += w / sigma_e2;
            numerator += w * (obs.value - u[obs.year_index]) / sigma_e2;
        }
        for pair in current_pairs {
            precision += 1.0 / sigma_e2;
            numerator += (pair.target_value - u[pair.year_index]) / sigma_e2;
        }
        let var_beta = 1.0 / precision.max(1e-12);
        let mean_beta = var_beta * numerator;
        beta = sample_normal(mean_beta, var_beta.sqrt(), rng);
        timing.beta += section_started.elapsed();

        // === 4. Sample sigma_u2. ===
        let section_started = Instant::now();
        let u_ss = u.iter().map(|value| value * value).sum::<f64>();
        let precision_u =
            sample_gamma_precision(au + prepared.year_count as f64 / 2.0, bu + 0.5 * u_ss, rng)?;
        sigma_u2 = (1.0 / precision_u).clamp(1e-12, 1e12);
        timing.sigma_u += section_started.elapsed();

        // === 5. Sample sigma_e2 given u, beta and the new delta. ===
        let section_started = Instant::now();
        let mut residual_ss = 0.0;
        let mut obs_count = 0usize;
        for obs in &prepared.ref_obs {
            let residual = obs.value - beta - u[obs.year_index];
            residual_ss += obs.weight * residual * residual;
            obs_count += 1;
        }
        for pair in current_pairs {
            let residual = pair.target_value - beta - u[pair.year_index];
            residual_ss += residual * residual;
            obs_count += 1;
        }
        let precision_e =
            sample_gamma_precision(ae + obs_count as f64 / 2.0, be + 0.5 * residual_ss, rng)?;
        sigma_e2 = (1.0 / precision_e).clamp(1e-12, 1e12);
        timing.sigma_e += section_started.elapsed();

        let section_started = Instant::now();
        if iteration >= burn_in && (iteration - burn_in) % thin == 0 {
            samples.deltas.push(current_delta);
            samples.beta.push(beta);
            samples.sigma_u2.push(sigma_u2);
            samples.sigma_e2.push(sigma_e2);
            samples.signal_to_noise.push(sigma_u2 / sigma_e2);
        }
        timing.retention += section_started.elapsed();
    }

    timing.total = chain_started.elapsed();
    Ok((samples, timing))
}

fn initial_delta_index(prepared: &PreparedInput, chain_index: usize, rng: &mut StdRng) -> usize {
    match chain_index {
        0 => prepared.best_correlation_index,
        1 if prepared.candidates.len() > 1 => rng.gen_range(0..prepared.candidates.len()),
        2 if prepared.candidates.len() > 1 => prepared.candidates.len() / 2,
        _ => rng.gen_range(0..prepared.candidates.len()),
    }
}

fn sample_normal(mean: f64, sd: f64, rng: &mut StdRng) -> f64 {
    let z: f64 = StandardNormal.sample(rng);
    mean + sd.max(1e-9) * z
}

fn sample_gamma_precision(shape: f64, rate: f64, rng: &mut StdRng) -> Result<f64, String> {
    let gamma =
        Gamma::new(shape.max(1e-9), 1.0 / rate.max(1e-12)).map_err(|error| error.to_string())?;
    Ok(gamma.sample(rng).max(1e-12))
}

// Log marginal likelihood of an alignment's overlapping target points, with the
// latent year effects u integrated out. Each target point contributes the log of a
// Gaussian density N(target ; pred_mean[y], pred_var[y]) whose mean and variance are
// derived from the reference only, so this score is identical regardless of which
// alignment the chain is currently sampling — that is what stops a chain from freezing
// onto its current delta.
fn marginal_delta_log_likelihood(
    candidate: &CandidateAlignment,
    pred_mean: &[f64],
    inv_pred_var: &[f64],
    half_ln_pred_var: &[f64],
) -> f64 {
    let mut acc = 0.0;
    for pair in &candidate.pairs {
        let year_index = pair.year_index;
        let residual = pair.target_value - pred_mean[year_index];
        acc += -half_ln_pred_var[year_index] - 0.5 * residual * residual * inv_pred_var[year_index];
    }
    acc
}

fn sample_categorical_log_probs(
    log_probs: &[f64],
    weights: &mut [f64],
    rng: &mut StdRng,
) -> Result<usize, String> {
    let max_log = log_probs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if !max_log.is_finite() {
        return Err("all delta log-probabilities are non-finite".to_string());
    }
    if weights.len() != log_probs.len() {
        return Err(
            "categorical weight buffer length does not match log-probability length".to_string(),
        );
    }

    let mut total_weight = 0.0;
    let mut last_positive_index = None;
    for (index, value) in log_probs.iter().enumerate() {
        let weight = (value - max_log).exp().max(0.0);
        weights[index] = weight;
        if weight > 0.0 {
            total_weight += weight;
            last_positive_index = Some(index);
        }
    }
    if !total_weight.is_finite() || total_weight <= 0.0 {
        return Err("all delta probabilities are zero or non-finite".to_string());
    }

    let mut draw = rng.gen::<f64>() * total_weight;
    for (index, weight) in weights.iter().enumerate() {
        if *weight <= 0.0 {
            continue;
        }
        if draw < *weight {
            return Ok(index);
        }
        draw -= *weight;
    }

    Ok(last_positive_index.unwrap_or(0))
}

fn format_duration_ms(duration: Duration) -> String {
    format!("{:.1}ms", duration.as_secs_f64() * 1000.0)
}

fn duration_percent(part: Duration, total: Duration) -> f64 {
    let total_secs = total.as_secs_f64();
    if total_secs <= 0.0 {
        0.0
    } else {
        100.0 * part.as_secs_f64() / total_secs
    }
}

fn log_chain_timing(series_id: &str, chain_index: usize, chain_count: usize, timing: &ChainTiming) {
    println!(
        "[Bayesian dating][{}] chain {}/{} total={} beta={} ({:.1}%) targetMap={} ({:.1}%) u={} ({:.1}%) sigmaU={} ({:.1}%) sigmaE={} ({:.1}%) deltaLikelihood={} ({:.1}%) deltaSample={} ({:.1}%) retain={} ({:.1}%)",
        series_id,
        chain_index + 1,
        chain_count,
        format_duration_ms(timing.total),
        format_duration_ms(timing.beta),
        duration_percent(timing.beta, timing.total),
        format_duration_ms(timing.target_alignment),
        duration_percent(timing.target_alignment, timing.total),
        format_duration_ms(timing.latent_year_effects),
        duration_percent(timing.latent_year_effects, timing.total),
        format_duration_ms(timing.sigma_u),
        duration_percent(timing.sigma_u, timing.total),
        format_duration_ms(timing.sigma_e),
        duration_percent(timing.sigma_e, timing.total),
        format_duration_ms(timing.delta_likelihood),
        duration_percent(timing.delta_likelihood, timing.total),
        format_duration_ms(timing.delta_sample),
        duration_percent(timing.delta_sample, timing.total),
        format_duration_ms(timing.retention),
        duration_percent(timing.retention, timing.total),
    );
}

fn retained_count(iterations: usize, burn_in: usize, thin: usize) -> usize {
    if burn_in >= iterations {
        return 0;
    }
    ((iterations - burn_in - 1) / thin) + 1
}

fn pearson_from_pairs(pairs: &[Pair]) -> Option<f64> {
    if pairs.len() < 3 {
        return None;
    }
    let mean_target = pairs.iter().map(|pair| pair.target_value).sum::<f64>() / pairs.len() as f64;
    let mean_reference =
        pairs.iter().map(|pair| pair.reference_value).sum::<f64>() / pairs.len() as f64;
    let mut numerator = 0.0;
    let mut target_ss = 0.0;
    let mut reference_ss = 0.0;
    for pair in pairs {
        let dt = pair.target_value - mean_target;
        let dr = pair.reference_value - mean_reference;
        numerator += dt * dr;
        target_ss += dt * dt;
        reference_ss += dr * dr;
    }
    let denominator = (target_ss * reference_ss).sqrt();
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

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

fn sample_sd(values: &[f64]) -> f64 {
    if values.len() <= 1 {
        return 0.0;
    }
    let avg = mean(values);
    let variance = values
        .iter()
        .map(|value| (value - avg).powi(2))
        .sum::<f64>()
        / (values.len() - 1) as f64;
    variance.sqrt()
}

fn summarize(values: &[f64]) -> ParameterStats {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    ParameterStats {
        mean: mean(values),
        sd: sample_sd(values),
        q025: quantile_sorted(&sorted, 0.025),
        median: quantile_sorted(&sorted, 0.5),
        q975: quantile_sorted(&sorted, 0.975),
    }
}

fn quantile_sorted(sorted: &[f64], probability: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let position = probability.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    if lower == upper {
        sorted[lower]
    } else {
        let fraction = position - lower as f64;
        sorted[lower] * (1.0 - fraction) + sorted[upper] * fraction
    }
}

fn build_hpd95(candidates: &[BayesianDatingCandidate]) -> Vec<BayesianDatingCandidate> {
    let mut total = 0.0;
    let mut result = Vec::new();
    for candidate in candidates {
        if total >= 0.95 && !result.is_empty() {
            break;
        }
        total += candidate.posterior;
        result.push(candidate.clone());
    }
    result
}

fn build_diagnostics(
    chain_samples: &[ChainSamples],
    candidates: &[CandidateAlignment],
    best: Option<&BayesianDatingCandidate>,
    hpd95_count: usize,
    iterations: usize,
    retained_samples: usize,
    retained_per_chain: usize,
) -> Diagnostics {
    let chain_diagnostics: Vec<ChainDiagnostics> = chain_samples
        .iter()
        .enumerate()
        .map(|(chain_index, samples)| {
            let mut counts: HashMap<usize, usize> = HashMap::new();
            for &delta in &samples.deltas {
                *counts.entry(delta).or_insert(0) += 1;
            }
            let mut top: Vec<ChainDeltaTop> = counts
                .into_iter()
                .map(|(delta_index, count)| ChainDeltaTop {
                    start_year: candidates[delta_index].start_year,
                    posterior: if samples.deltas.is_empty() {
                        0.0
                    } else {
                        count as f64 / samples.deltas.len() as f64
                    },
                    sample_count: count,
                })
                .collect();
            top.sort_by(|a, b| {
                b.posterior
                    .total_cmp(&a.posterior)
                    .then_with(|| a.start_year.cmp(&b.start_year))
            });
            ChainDiagnostics {
                chain_index,
                retained_samples: samples.deltas.len(),
                best_start_year: top.first().map(|item| item.start_year),
                top_deltas: top.into_iter().take(5).collect(),
            }
        })
        .collect();

    let first_top = chain_diagnostics
        .first()
        .and_then(|chain| chain.best_start_year);
    let chain_top_agreement = first_top.is_some()
        && chain_diagnostics
            .iter()
            .all(|chain| chain.best_start_year == first_top);
    let best_posterior = best.map(|candidate| candidate.posterior).unwrap_or(0.0);
    let discrete_delta_stable = chain_top_agreement && best_posterior >= 0.95;
    let r_hat = RhatSummary {
        beta: gelman_rubin(
            chain_samples
                .iter()
                .map(|samples| samples.beta.as_slice())
                .collect(),
        ),
        sigma_u2: gelman_rubin(
            chain_samples
                .iter()
                .map(|samples| samples.sigma_u2.as_slice())
                .collect(),
        ),
        sigma_e2: gelman_rubin(
            chain_samples
                .iter()
                .map(|samples| samples.sigma_e2.as_slice())
                .collect(),
        ),
        signal_to_noise: gelman_rubin(
            chain_samples
                .iter()
                .map(|samples| samples.signal_to_noise.as_slice())
                .collect(),
        ),
    };

    let mut warnings = Vec::new();
    if retained_samples < 1000 {
        warnings.push("retained samples < 1000".to_string());
    }
    for (name, value) in [
        ("beta", r_hat.beta),
        ("sigmaU2", r_hat.sigma_u2),
        ("sigmaE2", r_hat.sigma_e2),
        ("signalToNoise", r_hat.signal_to_noise),
    ] {
        if value.is_some_and(|rhat| rhat > 1.1) {
            warnings.push(format!("R-hat for {} > 1.1", name));
        }
    }
    if !chain_top_agreement {
        warnings.push("chain top delta values do not agree".to_string());
    }
    if best_posterior < 0.10 {
        warnings.push("best posterior < 0.10".to_string());
    }
    if hpd95_count > 20 {
        warnings.push("95% HPD contains more than 20 candidates".to_string());
    }
    if candidates.len() > iterations / 20 && retained_per_chain < candidates.len().max(1) {
        warnings.push("candidateCount is large relative to iterations".to_string());
    }

    Diagnostics {
        chains: chain_diagnostics,
        combined_best_start_year: best.map(|candidate| candidate.start_year),
        chain_top_agreement,
        discrete_delta_stable,
        r_hat,
        warnings,
    }
}

fn gelman_rubin(chains: Vec<&[f64]>) -> Option<f64> {
    if chains.len() < 2 {
        return None;
    }
    let n = chains.iter().map(|chain| chain.len()).min().unwrap_or(0);
    if n < 2 {
        return None;
    }
    let trimmed: Vec<&[f64]> = chains.iter().map(|chain| &chain[..n]).collect();
    let m = trimmed.len() as f64;
    let means: Vec<f64> = trimmed.iter().map(|chain| mean(chain)).collect();
    let mean_all = mean(&means);
    let b = n as f64
        * means
            .iter()
            .map(|value| (value - mean_all).powi(2))
            .sum::<f64>()
        / (m - 1.0);
    let w = trimmed
        .iter()
        .map(|chain| sample_sd(chain).powi(2))
        .sum::<f64>()
        / m;
    if w <= 0.0 {
        return Some(1.0);
    }
    let var_hat = ((n as f64 - 1.0) / n as f64) * w + b / n as f64;
    Some((var_hat / w).sqrt())
}

fn build_decision(
    best: Option<&BayesianDatingCandidate>,
    posterior_top: Option<&BayesianDatingCandidate>,
    diagnostics: &Diagnostics,
) -> Decision {
    let Some(best) = best else {
        return Decision {
            status: "unavailable".to_string(),
            reason: "no candidate start years met minOverlap".to_string(),
        };
    };

    // The point estimate is the deterministic best-fit alignment (max t-value), so the
    // decision is driven by its fit strength, not by the MCMC vote count which is
    // unreliable in multimodal cases. The posterior is used only to gauge confidence.
    const T_SIGNIFICANT: f64 = 3.5;
    let t = best.t_value.unwrap_or(0.0);
    if t < T_SIGNIFICANT {
        return Decision {
            status: "rejected".to_string(),
            reason: format!(
                "best-fit alignment t={:.2} is below the significance threshold {:.1}; no reliable date",
                t, T_SIGNIFICANT
            ),
        };
    }

    let rhat_ok = [
        diagnostics.r_hat.beta,
        diagnostics.r_hat.sigma_u2,
        diagnostics.r_hat.sigma_e2,
        diagnostics.r_hat.signal_to_noise,
    ]
    .iter()
    .all(|value| value.map(|rhat| rhat < 1.1).unwrap_or(true));

    let posterior_agrees = posterior_top
        .map(|candidate| candidate.start_year == best.start_year)
        .unwrap_or(false);
    let posterior_concentrated = posterior_top
        .map(|candidate| candidate.posterior >= 0.90)
        .unwrap_or(false);

    if posterior_agrees && posterior_concentrated && rhat_ok && diagnostics.chain_top_agreement {
        return Decision {
            status: "accepted".to_string(),
            reason: format!(
                "best-fit alignment (end {}, t={:.2}) is also the posterior mode and chains converged",
                best.end_year, t
            ),
        };
    }

    // A strong fit whose posterior mass is not concentrated on it is the signature of an
    // internal false/missing ring: no single rigid offset aligns the whole series.
    Decision {
        status: "ambiguous".to_string(),
        reason: format!(
            "best-fit alignment is end year {} (t={:.2}), but the posterior is not concentrated there \u{2014} possible internal false/missing ring; confirm with edit-distance from the end year",
            best.end_year, t
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wave_reference(start: i32, length: usize) -> Vec<ReferencePoint> {
        (0..length)
            .map(|index| {
                let x = index as f64;
                ReferencePoint {
                    year: start + index as i32,
                    value: (x / 3.1).sin() + 0.45 * (x / 7.0).cos() + 0.18 * (x / 2.0).sin(),
                    replication: Some(8.0),
                    weight: Some(1.0),
                }
            })
            .collect()
    }

    fn target_from_reference(
        reference: &[ReferencePoint],
        start_index: usize,
        length: usize,
    ) -> Vec<TargetPoint> {
        reference[start_index..start_index + length]
            .iter()
            .enumerate()
            .map(|(index, point)| TargetPoint {
                index,
                value: point.value,
                original_year: Some(10_000 + index as i32),
            })
            .collect()
    }

    fn test_input(
        target: Vec<TargetPoint>,
        reference: Vec<ReferencePoint>,
    ) -> BayesianMcmcDatingInput {
        BayesianMcmcDatingInput {
            target_series_id: "T1".to_string(),
            target,
            reference,
            min_overlap: Some(20),
            prior_start_year: None,
            prior_end_year: None,
            iterations: Some(2_000),
            burn_in: Some(400),
            thin: Some(4),
            chains: Some(3),
            seed: Some(42),
            k_beta: Some(1000.0),
            au: Some(0.01),
            bu: Some(0.01),
            ae: Some(0.01),
            be: Some(0.01),
            max_returned_candidates: Some(30),
            use_reference_replication_weight: Some(false),
            candidate_overlap_fraction_of_best: Some(0.9),
        }
    }

    #[test]
    fn exact_target_best_start_matches_reference_start() {
        let reference = wave_reference(1900, 70);
        let target = target_from_reference(&reference, 0, reference.len());
        let result = run_bayesian_date_series_mcmc(test_input(target, reference)).unwrap();
        assert_eq!(result.best.unwrap().start_year, 1900);
        assert!(
            result
                .candidates
                .iter()
                .map(|candidate| candidate.posterior)
                .sum::<f64>()
                > 0.999
        );
    }

    #[test]
    fn sliced_target_best_start_matches_slice_start() {
        let reference = wave_reference(1800, 95);
        let target = target_from_reference(&reference, 23, 45);
        let result = run_bayesian_date_series_mcmc(test_input(target, reference)).unwrap();
        assert_eq!(result.best.unwrap().start_year, 1823);
        assert_eq!(
            result.mcmc_summary.retained_samples_per_chain,
            vec![400, 400, 400]
        );
    }

    #[test]
    fn target_shorter_than_min_overlap_errors() {
        let reference = wave_reference(1900, 80);
        let target = target_from_reference(&reference, 0, 10);
        let error = run_bayesian_date_series_mcmc(test_input(target, reference)).unwrap_err();
        assert!(error.contains("shorter than minOverlap"));
    }

    #[test]
    fn candidate_range_and_posterior_sum_are_valid() {
        let reference = wave_reference(1900, 80);
        let target = target_from_reference(&reference, 20, 35);
        let result = run_bayesian_date_series_mcmc(test_input(target, reference)).unwrap();
        assert!(result.candidate_count > 1);
        assert_eq!(result.reference_start_year, 1900);
        assert_eq!(result.reference_end_year, 1979);
        let total = result
            .candidates
            .iter()
            .map(|candidate| candidate.posterior)
            .sum::<f64>();
        assert!((total - 1.0).abs() < 1e-9 || total < 1.0);
    }

    #[test]
    fn rhat_and_chain_tops_are_reported() {
        let reference = wave_reference(1700, 90);
        let target = target_from_reference(&reference, 30, 40);
        let result = run_bayesian_date_series_mcmc(test_input(target, reference)).unwrap();
        assert!(result.diagnostics.r_hat.beta.is_some());
        assert_eq!(result.diagnostics.chains.len(), 3);
        assert!(result
            .diagnostics
            .chains
            .iter()
            .all(|chain| chain.best_start_year.is_some()));
    }

    // On clean data the marginalized sampler must concentrate the posterior on the true
    // alignment and the chains must agree — the property the frozen-chain bug violated.
    #[test]
    fn chains_agree_and_posterior_concentrates_on_true_alignment() {
        let reference = wave_reference(1500, 240);
        let target = target_from_reference(&reference, 80, 70);
        let result = run_bayesian_date_series_mcmc(test_input(target, reference)).unwrap();

        let best = result.best.as_ref().unwrap();
        assert_eq!(best.start_year, 1580);
        assert!(
            best.posterior > 0.9,
            "posterior should concentrate on the true alignment, got {}",
            best.posterior
        );
        assert!(result.diagnostics.chain_top_agreement);
    }

    // Internal false ring (an extra value inserted mid-series): no single rigid offset
    // aligns the whole series, but the dominant front portion still yields a strong
    // best-fit. Plan C must (1) recover that best-fit as the point estimate instead of
    // diffusing into a "no signal" basin, and (2) flag the result as not a clean rigid
    // match rather than falsely accepting it.
    #[test]
    fn inserted_ring_recovers_dominant_partial_match() {
        let reference = wave_reference(1500, 240);
        let clean = target_from_reference(&reference, 80, 90); // true start 1580
        let insert_at = 75usize;
        let mut target: Vec<TargetPoint> = clean
            .into_iter()
            .map(|point| TargetPoint {
                index: if point.index >= insert_at {
                    point.index + 1
                } else {
                    point.index
                },
                value: point.value,
                original_year: point.original_year,
            })
            .collect();
        target.push(TargetPoint {
            index: insert_at,
            value: 0.0,
            original_year: None,
        });

        let result = run_bayesian_date_series_mcmc(test_input(target, reference)).unwrap();
        let best = result.best.as_ref().unwrap();

        // The front (75-ring) portion aligns at the true start; the best-fit must recover it.
        assert_eq!(best.start_year, 1580);
        assert!(
            best.t_value.unwrap() > 4.0,
            "the partial match must stay significant, got t={:?}",
            best.t_value
        );
    }
}
