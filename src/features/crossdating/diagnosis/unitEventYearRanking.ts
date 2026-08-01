import type { DiagnosisEventType } from "./types";

type UnitEventType = Extract<
    DiagnosisEventType,
    "missingRing" | "falseRing"
>;

export type UnitEventYearRankingInput = {
    eventType: UnitEventType;
    years: readonly number[];
    allYears: readonly number[];
    ranks: ReadonlyMap<string, readonly number[]>;
};

export type UnitEventYearRankingResult = {
    scoreByYear: ReadonlyMap<number, number>;
    profileNames: string[];
};

const MISSING_RING_PROFILES = [
    "cumulativeReferenceVote",
    "comboFull",
    "piecewiseCombinedObjective",
] as const;

const mean = (values: readonly number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

export const rankUnitEventYears = (
    input: UnitEventYearRankingInput,
): UnitEventYearRankingResult | null => {
    if (input.years.length === 0) return null;
    const sourceIndices = input.years.map(
        (year) => input.allYears.indexOf(year),
    );
    if (sourceIndices.some((index) => index < 0)) return null;

    if (input.eventType === "missingRing") {
        if (!MISSING_RING_PROFILES.every((profile) => input.ranks.has(profile))) {
            return null;
        }
        return {
            scoreByYear: new Map(input.years.map((year, index) => [
                year,
                mean(MISSING_RING_PROFILES.map((profile) => (
                    input.ranks.get(profile)?.[sourceIndices[index]] ?? 0
                ))),
            ])),
            profileNames: [...MISSING_RING_PROFILES],
        };
    }

    const difference = input.ranks.get("differenceFull");
    if (!difference) return null;
    return {
        scoreByYear: new Map(input.years.map((year, index) => [
            year,
            difference[sourceIndices[index]] ?? 0,
        ])),
        profileNames: ["differenceFull"],
    };
};
