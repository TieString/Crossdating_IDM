import { readFileSync, writeFileSync } from "node:fs";
import { selectCalibratedEventWindow } from "../src/features/crossdating/diagnosis/calibratedEventWindow";

type EventType = "missingRing" | "falseRing";
type Window = { startYear: number; endYear: number };

type LocatorRow = {
    context: {
        file: string;
        target: string;
        baselineFlagged?: boolean;
    };
    truthYear: number;
    truthCorrectionYears: number;
    eventType: EventType;
    correctionYears: number;
    years: number[];
    ranks: Record<string, number[]>;
    candidates: Array<Window & { source: string }>;
    coarseWindow: Window;
    finalWindow?: Window;
    calibratedWidth?: 5 | 7 | 9 | 13;
    currentPrimaryYear?: number;
    selectedOperation?: {
        bestYear: number;
        remoteDifferenceMargin: number;
        sideStepBestYear?: number;
        sideStepRemoteMargin?: number;
        bestDifferenceGain?: number;
        bestCorrectedSideSupport?: number;
    };
};

type Audit = {
    counterfactualLocatorCases?: LocatorRow[];
    formalEventCaseOutcomes?: Array<{
        context: { file: string; target: string; year: number };
        eventType: EventType;
        width: number | null;
        primaryPredictionRange: [number, number] | null;
    }>;
};

const values = (name: string): string[] => process.argv.flatMap((value, index) => (
    value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []
));

const sourceArguments = values("--source");
const outputPath = values("--output")[0];
const finalAuditPath = values("--final-audit")[0];
if (sourceArguments.length === 0 || !outputPath) {
    throw new Error(
        "Usage: tsx analyze-unit-independent-window-calibration.ts "
        + "--source label=audit.json [--source ...] --output report.json",
    );
}

const key = (
    eventType: EventType,
    file: string,
    target: string,
    truthYear: number,
): string => [eventType, file.toLowerCase(), target, truthYear].join("|");

const finalOverrides = new Map<string, { window: Window; width: number }>();
if (finalAuditPath) {
    const audit = JSON.parse(readFileSync(finalAuditPath, "utf8")) as Audit;
    audit.formalEventCaseOutcomes?.forEach((row) => {
        if (!row.primaryPredictionRange || row.width === null) return;
        finalOverrides.set(
            key(row.eventType, row.context.file, row.context.target, row.context.year),
            {
                window: {
                    startYear: row.primaryPredictionRange[0],
                    endYear: row.primaryPredictionRange[1],
                },
                width: row.width,
            },
        );
    });
}

const rows = sourceArguments.flatMap((argument) => {
    const separator = argument.indexOf("=");
    if (separator < 1) throw new Error(`Invalid --source: ${argument}`);
    const dataset = argument.slice(0, separator);
    const path = argument.slice(separator + 1);
    const audit = JSON.parse(readFileSync(path, "utf8")) as Audit;
    return (audit.counterfactualLocatorCases ?? []).flatMap((source) => {
        if (
            source.context.baselineFlagged !== false
            || source.correctionYears !== source.truthCorrectionYears
            || !source.finalWindow
            || !source.calibratedWidth
        ) return [];
        const independent = selectCalibratedEventWindow({
            eventType: source.eventType,
            years: source.years,
            ranks: new Map(Object.entries(source.ranks)),
            coarseWindow: source.coarseWindow,
            internalCandidates: source.candidates,
            ...(source.currentPrimaryYear === undefined
                ? {}
                : { currentPrimaryYear: source.currentPrimaryYear }),
            ...(source.selectedOperation ? {
                operationEvidence: {
                    bestYear: source.selectedOperation.bestYear,
                    remoteDifferenceMargin:
                        source.selectedOperation.remoteDifferenceMargin,
                    ...(source.selectedOperation.sideStepBestYear === undefined
                        ? {}
                        : { sideStepBestYear: source.selectedOperation.sideStepBestYear }),
                    ...(source.selectedOperation.sideStepRemoteMargin === undefined
                        ? {}
                        : { sideStepRemoteMargin: source.selectedOperation.sideStepRemoteMargin }),
                },
            } : {}),
        });
        if (!independent) return [];
        const selected = finalOverrides.get(key(
            source.eventType,
            source.context.file,
            source.context.target,
            source.truthYear,
        )) ?? {
            window: source.finalWindow,
            width: source.calibratedWidth,
        };
        if (selected.width !== 13) return [];
        const independentCenter = (
            independent.window.startYear + independent.window.endYear
        ) / 2;
        const candidateStart = Math.max(
            selected.window.startYear,
            Math.min(
                Math.round(independentCenter) - 4,
                selected.window.endYear - 8,
            ),
        );
        const candidate = {
            startYear: candidateStart,
            endYear: candidateStart + 8,
        };
        const truthYear = source.truthYear;
        const anchors = [
            source.currentPrimaryYear,
            source.selectedOperation?.bestYear,
            source.selectedOperation?.sideStepBestYear,
        ].filter((year): year is number => year !== undefined);
        const candidateCenter = (candidate.startYear + candidate.endYear) / 2;
        return [{
            dataset,
            eventType: source.eventType,
            file: source.context.file,
            target: source.context.target,
            truthYear,
            selectedWindow: selected.window,
            oldHit: truthYear >= selected.window.startYear
                && truthYear <= selected.window.endYear,
            independentWindow: independent.window,
            independentWidth: independent.width,
            independentRule: independent.calibrationRule,
            independentConcentration: independent.concentration,
            independentRemoteMargin: independent.remoteMargin,
            centerDistance: Math.abs(
                independentCenter
                - (selected.window.startYear + selected.window.endYear) / 2,
            ),
            candidateWindow: candidate,
            candidateHit: truthYear >= candidate.startYear
                && truthYear <= candidate.endYear,
            anchorsInsideCandidate: anchors.filter((year) => (
                year >= candidate.startYear && year <= candidate.endYear
            )).length,
            anchorSpread: anchors.length > 0
                ? Math.max(...anchors) - Math.min(...anchors)
                : null,
            maximumAnchorDistance: anchors.length > 0
                ? Math.max(...anchors.map((year) => Math.abs(year - candidateCenter)))
                : null,
            operationDifferenceGain:
                source.selectedOperation?.bestDifferenceGain ?? null,
            operationRemoteMargin:
                source.selectedOperation?.remoteDifferenceMargin ?? null,
            correctedSideSupport:
                source.selectedOperation?.bestCorrectedSideSupport ?? null,
        }];
    });
});

writeFileSync(outputPath, JSON.stringify({ schemaVersion: 1, rows }), "utf8");
console.log(JSON.stringify({ outputPath, rows: rows.length }));
