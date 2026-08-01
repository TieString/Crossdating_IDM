/**
 * Calibrated review-window width for the full-interval counterfactual locator.
 *
 * The locator first chooses a coarse region and constructs a complete year-score profile.
 * This module estimates whether the 9-year fine window is at risk of missing the event. It
 * never changes the location hypothesis or operation. Three calibrated miss-risk models choose
 * 9, 13, or 17 years; only unresolved high-risk cases expose the already selected coarse region.
 */
import modelData from "./adaptiveWindowRiskModel.json";

type AdaptiveEventType = "missingRing" | "falseRing" | "partialMove";

type Window = {
    startYear: number;
    endYear: number;
};

type ScoredWindow = Window & {
    score: number;
};

type WindowEvidence = {
    selected: ScoredWindow;
    margin: number;
    remoteMargin: number;
};

type CandidateWindow = Window & {
    source: string;
};

type RiskTree = {
    probability: number;
} | {
    featureIndex: number;
    threshold: number;
    left: RiskTree;
    right: RiskTree;
};

type RiskForest = {
    trees: RiskTree[];
};

type RiskModel = {
    thresholds: Record<"9" | "13" | "17", number>;
    widthRisks: Record<"9" | "13" | "17", RiskForest>;
};

type AdaptiveRiskModelData = {
    schemaVersion: number;
    featureNames: string[];
    models: Record<AdaptiveEventType, RiskModel>;
};

export type AdaptiveWindowRiskInput = {
    eventType: AdaptiveEventType;
    years: number[];
    profileNames: string[];
    ranks: ReadonlyMap<string, readonly number[]>;
    coarseWindow: Window;
    coarseSource: string;
    internalCandidates: CandidateWindow[];
    currentPrimaryYear?: number;
    currentWindow: Window;
};

export type AdaptiveWindowRiskResult = {
    width: number;
    risk: number;
    threshold: number;
    risks: Record<"9" | "13" | "17", number>;
    windows: Record<"9" | "13" | "17", Window>;
    window: Window;
};

const MODEL = modelData as unknown as AdaptiveRiskModelData;
const WIDTHS = [5, 7, 9, 11, 13, 15, 17] as const;

const mean = (values: number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
        ? ordered[middle]
        : (ordered[middle - 1] + ordered[middle]) / 2;
};

const standardDeviation = (values: number[]): number => {
    const center = mean(values);
    return Math.sqrt(mean(values.map((value) => (value - center) ** 2)));
};

const percentileRanks = (values: number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Array(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) {
            end += 1;
        }
        const rank = ((start + end - 1) / 2) / Math.max(1, ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            result[ordered[index].index] = rank;
        }
        start = end;
    }
    return result;
};

const contains = (window: Window, year: number): boolean => (
    year >= window.startYear && year <= window.endYear
);

const boundedWindow = (
    startYear: number,
    width: number,
    minimumYear: number,
    maximumYear: number,
): Window => {
    const safeWidth = Math.max(1, Math.min(width, maximumYear - minimumYear + 1));
    const boundedStart = Math.max(
        minimumYear,
        Math.min(startYear, maximumYear - safeWidth + 1),
    );
    return {
        startYear: boundedStart,
        endYear: boundedStart + safeWidth - 1,
    };
};

const scoreWindows = (
    rows: Array<{ year: number; value: number }>,
    width: number,
    minimumYear: number,
    maximumYear: number,
): WindowEvidence => {
    const candidates = rows.map((row): ScoredWindow => {
        const window = boundedWindow(row.year, width, minimumYear, maximumYear);
        const inside = rows.filter((candidate) => contains(window, candidate.year));
        return {
            ...window,
            score: inside.reduce((sum, candidate) => sum + candidate.value, 0)
                / Math.sqrt(Math.max(1, inside.length)),
        };
    }).sort((left, right) => (
        right.score - left.score || right.startYear - left.startYear
    ));
    const selected = candidates[0];
    const remote = candidates.find((candidate) => (
        candidate.endYear < selected.startYear
        || candidate.startYear > selected.endYear
    ));
    return {
        selected,
        margin: selected.score - (candidates[1]?.score ?? selected.score),
        remoteMargin: selected.score - (remote?.score ?? selected.score),
    };
};

const sourceCategory = (source: string): string => {
    if (source === "coarse" || source.startsWith("profile:")) return "coarse";
    if (source === "transition" || source === "lag_transition") return "transition";
    if (source === "current" || source === "current_event") return "current";
    if (source.startsWith("reference:") || source.startsWith("reference_transition:")) {
        return "reference";
    }
    return "other";
};

const predictTree = (
    tree: RiskTree,
    features: ReadonlyMap<string, number>,
): number => {
    if ("probability" in tree) return tree.probability;
    const featureName = MODEL.featureNames[tree.featureIndex];
    const value = features.get(featureName) ?? 0;
    return predictTree(
        value <= tree.threshold ? tree.left : tree.right,
        features,
    );
};

export const selectAdaptiveCounterfactualWindow = (
    input: AdaptiveWindowRiskInput,
): AdaptiveWindowRiskResult | null => {
    const localIndexes = input.years
        .map((year, index) => ({ year, index }))
        .filter(({ year }) => contains(input.coarseWindow, year));
    if (localIndexes.length === 0
        || input.coarseWindow.endYear - input.coarseWindow.startYear + 1 < 17
        || input.profileNames.length === 0) {
        return null;
    }
    const aggregateRows = localIndexes.map(({ year, index }) => ({
        year,
        value: mean(input.profileNames.map(
            (profile) => input.ranks.get(profile)?.[index] ?? 0,
        )),
    }));
    const windows = new Map<number, WindowEvidence>(
        WIDTHS.map((width) => [
            width,
            scoreWindows(
                aggregateRows,
                width,
                input.coarseWindow.startYear,
                input.coarseWindow.endYear,
            ),
        ]),
    );
    const window9 = windows.get(9);
    const window13 = windows.get(13);
    const window17 = windows.get(17);
    if (!window9 || !window13 || !window17) return null;

    const center9 = (window9.selected.startYear + window9.selected.endYear) / 2;
    const coarseWidth = input.coarseWindow.endYear
        - input.coarseWindow.startYear + 1;
    const scale = Math.max(1, coarseWidth);
    const features = new Map<string, number>();
    const set = (name: string, value: number): void => {
        features.set(name, Number.isFinite(value) ? value : 0);
    };

    set("coarse_width", coarseWidth);
    set(
        "coarse_center_relative",
        (
            (input.coarseWindow.startYear + input.coarseWindow.endYear) / 2
            - mean([
                input.years[0],
                input.years[input.years.length - 1] ?? input.years[0],
            ])
        ) / Math.max(
            1,
            (input.years[input.years.length - 1] ?? input.years[0])
                - input.years[0],
        ),
    );
    const selectedSource = sourceCategory(input.coarseSource);
    ["coarse", "transition", "reference", "current", "other"].forEach((source) => {
        set(`coarse_source_${source}`, selectedSource === source ? 1 : 0);
    });

    WIDTHS.forEach((width) => {
        const result = windows.get(width);
        if (!result) return;
        const center = (result.selected.startYear + result.selected.endYear) / 2;
        set(`window_${width}_score`, result.selected.score);
        set(`window_${width}_margin`, result.margin);
        set(`window_${width}_remote_margin`, result.remoteMargin);
        set(`window_${width}_center_delta_9`, (center - center9) / scale);
        set(
            `window_${width}_score_per_year`,
            result.selected.score / Math.sqrt(width),
        );
    });
    const center13 = (window13.selected.startYear + window13.selected.endYear) / 2;
    const center17 = (window17.selected.startYear + window17.selected.endYear) / 2;
    set("window_9_13_center_delta", (center9 - center13) / scale);
    set("window_9_17_center_delta", (center9 - center17) / scale);
    set(
        "window_9_17_score_ratio",
        window9.selected.score / Math.max(1e-9, window17.selected.score),
    );
    set(
        "window_13_17_score_ratio",
        window13.selected.score / Math.max(1e-9, window17.selected.score),
    );

    const profilePeaks: number[] = [];
    const profileWindowCenters: number[] = [];
    input.profileNames.forEach((profile) => {
        const profileRows = localIndexes.map(({ year, index }) => ({
            year,
            value: input.ranks.get(profile)?.[index] ?? 0,
        }));
        const ordered = profileRows.slice().sort((left, right) => (
            right.value - left.value || right.year - left.year
        ));
        const peak = ordered[0];
        const profileWindow = scoreWindows(
            profileRows,
            9,
            input.coarseWindow.startYear,
            input.coarseWindow.endYear,
        );
        const profileCenter = (
            profileWindow.selected.startYear + profileWindow.selected.endYear
        ) / 2;
        profilePeaks.push(peak.year);
        profileWindowCenters.push(profileCenter);
        set(`${profile}_peak_delta_9`, (peak.year - center9) / scale);
        set(`${profile}_peak_value`, peak.value);
        set(`${profile}_peak_gap`, peak.value - (ordered[1]?.value ?? peak.value));
        set(`${profile}_mean`, mean(profileRows.map(({ value }) => value)));
        set(`${profile}_sd`, standardDeviation(profileRows.map(({ value }) => value)));
        set(`${profile}_window_center_delta_9`, (profileCenter - center9) / scale);
        set(`${profile}_window_margin`, profileWindow.margin);
        set(`${profile}_window_remote_margin`, profileWindow.remoteMargin);
    });
    set(
        "profile_peak_range",
        (Math.max(...profilePeaks) - Math.min(...profilePeaks)) / scale,
    );
    set("profile_peak_sd", standardDeviation(profilePeaks) / scale);
    set(
        "profile_window_center_range",
        (
            Math.max(...profileWindowCenters) - Math.min(...profileWindowCenters)
        ) / scale,
    );
    set(
        "profile_window_center_sd",
        standardDeviation(profileWindowCenters) / scale,
    );

    const candidateCenters = input.internalCandidates.map(
        (candidate) => (candidate.startYear + candidate.endYear) / 2,
    );
    set("candidate_count", candidateCenters.length);
    set(
        "candidate_center_range",
        candidateCenters.length > 0
            ? (Math.max(...candidateCenters) - Math.min(...candidateCenters)) / scale
            : 0,
    );
    set("candidate_center_sd", standardDeviation(candidateCenters) / scale);
    set(
        "candidate_center_median_delta_9",
        (median(candidateCenters) - center9) / scale,
    );

    const currentPeakRanks = percentileRanks(input.years.map((year) => (
        input.currentPrimaryYear === undefined
            ? 0
            : Math.max(0, 1 - Math.abs(year - input.currentPrimaryYear) / 9)
    )));
    const currentPeakIndex = currentPeakRanks.reduce(
        (best, value, index) => value > currentPeakRanks[best] ? index : best,
        0,
    );
    const currentPeakSpread = Math.max(...currentPeakRanks)
        - Math.min(...currentPeakRanks);
    set("current_peak_available", currentPeakSpread > 0 ? 1 : 0);
    set(
        "current_peak_delta_9",
        currentPeakSpread > 0
            ? (input.years[currentPeakIndex] - center9) / scale
            : 0,
    );
    const currentWindowRanks = percentileRanks(input.years.map((year) => (
        contains(input.currentWindow, year) ? 1 : 0
    )));
    const currentWindowYears = input.years.filter(
        (_, index) => currentWindowRanks[index] > 0.5,
    );
    set(
        "current_window_center_delta_9",
        currentWindowYears.length > 0
            ? (mean(currentWindowYears) - center9) / scale
            : 0,
    );
    set(
        "current_window_overlap_9",
        currentWindowYears.filter((year) => contains(window9.selected, year)).length
            / Math.max(1, currentWindowYears.length),
    );

    const model = MODEL.models[input.eventType];
    const riskFor = (width: "9" | "13" | "17"): number => mean(
        model.widthRisks[width].trees.map((tree) => predictTree(tree, features)),
    );
    const risks = {
        "9": riskFor("9"),
        "13": riskFor("13"),
        "17": riskFor("17"),
    };
    const selectedWidth = risks["9"] <= model.thresholds["9"]
        ? 9
        : risks["13"] <= model.thresholds["13"]
            ? 13
            : risks["17"] <= model.thresholds["17"]
                ? 17
                : null;
    const width = selectedWidth
        ?? input.coarseWindow.endYear - input.coarseWindow.startYear + 1;
    const riskWidth: "9" | "13" | "17" = selectedWidth === 9
        ? "9"
        : selectedWidth === 13
            ? "13"
            : "17";
    return {
        width,
        risk: risks[riskWidth],
        threshold: model.thresholds[riskWidth],
        risks,
        windows: {
            "9": window9.selected,
            "13": window13.selected,
            "17": window17.selected,
        },
        window: selectedWidth === null
            ? input.coarseWindow
            : windows.get(selectedWidth)?.selected ?? window17.selected,
    };
};
