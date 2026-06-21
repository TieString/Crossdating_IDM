/**
 * 用于单轮插入/删除建议的局部编辑对齐。
 * 这个有界动态规划会比较目标窗口和 master chronology，并记录能解释局部 lag 变化的小 gap 编辑。
 */
import { CrossdateConfig } from "./config";
import type { LocalEditAlignmentEdit, LocalEditAlignmentResult, YearRange } from "./types";

type LocalEditAlignmentOptions = {
    maxGaps?: number;
    insertPenalty?: number;
    deletePenalty?: number;
    excessiveEditPenalty?: number;
    narrowYearBonus?: number;
    strongNarrowYearBonus?: number;
    diagonalBand?: number;
    minLocalOverlap?: number;
    narrowYearThreshold?: number;
    strongNarrowYearThreshold?: number;
};

type LocalDpState = {
    score: number;
    edits: LocalEditAlignmentEdit[];
};

const localEditOptionsWithDefaults = (
    options: LocalEditAlignmentOptions,
) => ({
    ...CrossdateConfig.localEditAlignment,
    ...options,
});

const localSimilarityScore = (targetValue: number, masterValue: number): number => (
    1 - Math.min(3, Math.abs(targetValue - masterValue))
);

const getMasterNarrowBonus = (
    masterValue: number | undefined,
    options: ReturnType<typeof localEditOptionsWithDefaults>,
): number => {
    if (masterValue === undefined) return 0;
    const narrowThreshold = options.narrowYearThreshold ?? CrossdateConfig.narrowYearThreshold;
    const strongThreshold = options.strongNarrowYearThreshold ?? CrossdateConfig.strongNarrowYearThreshold;
    if (masterValue <= strongThreshold) return options.strongNarrowYearBonus;
    if (masterValue <= narrowThreshold) return options.narrowYearBonus;
    if (masterValue > 0) return -options.narrowYearBonus * 0.5;
    return 0;
};

const shouldKeepLocalState = (
    current: LocalDpState | undefined,
    candidate: LocalDpState,
): boolean => (
    !current
    || candidate.score > current.score
    || (
        candidate.score === current.score
        && candidate.edits.length < current.edits.length
    )
);

const localDpKey = (i: number, j: number, gapCount: number): string => `${i}:${j}:${gapCount}`;

export function runLocalEditAlignment(
    seriesId: string,
    targetSeries: Map<number, number>,
    masterChronology: Map<number, number>,
    window: YearRange,
    options: LocalEditAlignmentOptions = {},
): LocalEditAlignmentResult | null {
    const effective = localEditOptionsWithDefaults(options);
    const targetEntries = Array.from(targetSeries.entries())
        .filter(([year]) => year >= window.startYear && year <= window.endYear)
        .sort((a, b) => a[0] - b[0]);
    const masterEntries = Array.from(masterChronology.entries())
        .filter(([year]) => year >= window.startYear && year <= window.endYear)
        .sort((a, b) => a[0] - b[0]);

    if (
        targetEntries.length < effective.minLocalOverlap
        || masterEntries.length < effective.minLocalOverlap
    ) {
        return null;
    }

    const states = new Map<string, LocalDpState>();
    states.set(localDpKey(0, 0, 0), { score: 0, edits: [] });

    const update = (i: number, j: number, gapCount: number, candidate: LocalDpState) => {
        const key = localDpKey(i, j, gapCount);
        const current = states.get(key);
        if (shouldKeepLocalState(current, candidate)) {
            states.set(key, candidate);
        }
    };

    for (let i = 0; i <= targetEntries.length; i += 1) {
        for (let j = 0; j <= masterEntries.length; j += 1) {
            for (let gapCount = 0; gapCount <= effective.maxGaps; gapCount += 1) {
                const state = states.get(localDpKey(i, j, gapCount));
                if (!state) continue;

                if (i < targetEntries.length && j < masterEntries.length) {
                    const diagonalDistance = Math.abs(i - j);
                    if (diagonalDistance <= effective.diagonalBand + gapCount) {
                        const [, targetValue] = targetEntries[i];
                        const [, masterValue] = masterEntries[j];
                        update(i + 1, j + 1, gapCount, {
                            score: state.score + localSimilarityScore(targetValue, masterValue),
                            edits: state.edits,
                        });
                    }
                }

                if (j < masterEntries.length && gapCount < effective.maxGaps) {
                    const diagonalDistance = Math.abs(i - (j + 1));
                    if (diagonalDistance <= effective.diagonalBand + gapCount + 1) {
                        const [anchorYear, masterValue] = masterEntries[j];
                        const contribution = -effective.insertPenalty + getMasterNarrowBonus(masterValue, effective);
                        update(i, j + 1, gapCount + 1, {
                            score: state.score + contribution,
                            edits: [
                                ...state.edits,
                                {
                                    type: "insertMissingYear",
                                    anchorYear,
                                    scoreContribution: contribution,
                                    reason: masterValue <= (effective.strongNarrowYearThreshold ?? CrossdateConfig.strongNarrowYearThreshold)
                                        ? "strong narrow-year prior"
                                        : masterValue <= (effective.narrowYearThreshold ?? CrossdateConfig.narrowYearThreshold)
                                            ? "narrow-year prior"
                                            : "gap in target path",
                                },
                            ],
                        });
                    }
                }

                if (i < targetEntries.length && gapCount < effective.maxGaps) {
                    const diagonalDistance = Math.abs((i + 1) - j);
                    if (diagonalDistance <= effective.diagonalBand + gapCount + 1) {
                        const [anchorYear] = targetEntries[i];
                        const contribution = -effective.deletePenalty;
                        update(i + 1, j, gapCount + 1, {
                            score: state.score + contribution,
                            edits: [
                                ...state.edits,
                                {
                                    type: "deleteFalseYear",
                                    anchorYear,
                                    scoreContribution: contribution,
                                    reason: "extra target ring in banded path",
                                },
                            ],
                        });
                    }
                }
            }
        }
    }

    const terminalStates = Array.from(states.entries())
        .filter(([key, state]) => {
            const [i, j] = key.split(":").map(Number);
            return i === targetEntries.length && j === masterEntries.length && state.edits.length > 0;
        })
        .map(([, state]) => state)
        .sort((a, b) => (
            b.score - a.score
            || a.edits.length - b.edits.length
        ));
    const best = terminalStates[0];
    if (!best) return null;

    const excessiveEditPenalty = Math.max(0, best.edits.length - 1) * effective.excessiveEditPenalty;
    return {
        seriesId,
        windowStartYear: window.startYear,
        windowEndYear: window.endYear,
        method: "banded_edit_dp",
        pathScore: best.score - excessiveEditPenalty,
        edits: best.edits,
    };
}
