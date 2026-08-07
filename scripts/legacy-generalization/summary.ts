import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { qualityBin } from "./evaluator";
import type {
    LegacyCaseRow,
    LegacyConfig,
    LegacyEventRow,
    LegacyFileWorkerOutput,
    LegacyManifest,
    LegacySerialEventState,
    LegacySerialRound,
} from "./types";

type RatioMetric = {
    numerator: number;
    denominator: number;
    rate: number | null;
};

const ratio = (numerator: number, denominator: number): RatioMetric => ({
    numerator,
    denominator,
    rate: denominator > 0 ? numerator / denominator : null,
});

const quantile = (values: number[], probability: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.max(
        0,
        Math.ceil(sorted.length * probability) - 1,
    ))];
};

const mean = (values: number[]): number | null => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

const summarizeCases = (rows: LegacyCaseRow[]) => {
    const exact = rows.filter((row) => (
        row.truthQuality === "exact-injected" && row.truthId !== null
    ));
    const responded = exact.filter((row) => row.response);
    const operationApplicable = responded.filter((row) => row.operationCorrect !== null);
    const localized = exact.filter((row) => row.windowApplicable);
    const conditionallyLocalized = localized.filter((row) => row.operationCorrect === true);
    const errors = conditionallyLocalized.flatMap((row) => (
        row.breakpointError === null ? [] : [row.breakpointError]
    ));
    const absoluteErrors = errors.map(Math.abs);
    const widths = responded.flatMap((row) => row.windowWidth === null ? [] : [row.windowWidth]);
    const negatives = rows.filter((row) => row.truthQuality === "negative-clean");
    return {
        files: new Set(rows.map((row) => row.fileId)).size,
        series: new Set(rows.map((row) => `${row.fileId}:${row.seriesId}`)).size,
        scenarios: new Set(rows.map((row) => row.scenarioId)).size,
        events: exact.length,
        exactInjected: exact.length,
        negativeClean: negatives.length,
        response: ratio(responded.length, exact.length),
        typeAccuracyAll: ratio(exact.filter((row) => row.typeCorrect === true).length, exact.length),
        typeAccuracyAnswered: ratio(
            responded.filter((row) => row.typeCorrect === true).length,
            responded.length,
        ),
        shiftAccuracyAll: ratio(exact.filter((row) => row.shiftCorrect === true).length, exact.length),
        shiftAccuracyAnswered: ratio(
            responded.filter((row) => row.shiftCorrect === true).length,
            responded.length,
        ),
        operationAccuracyAll: ratio(
            exact.filter((row) => row.operationCorrect === true).length,
            exact.length,
        ),
        operationAccuracyAnswered: ratio(
            operationApplicable.filter((row) => row.operationCorrect === true).length,
            operationApplicable.length,
        ),
        firstWindowCoverage: ratio(
            localized.filter((row) => row.windowCovered === true).length,
            localized.length,
        ),
        conditionalWindowCoverage: ratio(
            conditionallyLocalized.filter((row) => row.windowCovered === true).length,
            conditionallyLocalized.length,
        ),
        top1: ratio(
            localized.filter((row) => row.top1Exact === true).length,
            localized.length,
        ),
        breakpoint: {
            applicable: errors.length,
            medianAbsoluteError: quantile(absoluteErrors, 0.5),
            p90AbsoluteError: quantile(absoluteErrors, 0.9),
            p95AbsoluteError: quantile(absoluteErrors, 0.95),
            signedBias: mean(errors),
        },
        windowWidth: {
            count: widths.length,
            median: quantile(widths, 0.5),
            p90: quantile(widths, 0.9),
        },
        cleanStrictFalsePositive: ratio(
            negatives.filter((row) => row.strictResponse).length,
            negatives.length,
        ),
        cleanReviewFalsePositive: ratio(
            negatives.filter((row) => row.reviewResponse).length,
            negatives.length,
        ),
        saveReopenStable: ratio(
            rows.filter((row) => row.saveReopenStable === true).length,
            rows.filter((row) => row.saveReopenStable !== null).length,
        ),
        runtimeMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
    };
};

const summarizeSerial = (rows: LegacySerialEventState[]) => {
    const confirmed = rows.filter((row) => row.confirmedRound !== null);
    const firstResponse = rows.filter((row) => row.firstResponseRound !== null);
    const everCorrect = rows.filter((row) => row.firstCorrectWindowRound !== null);
    const widths = confirmed.flatMap((row) => (
        row.windowWidthAtConfirmation === null ? [] : [row.windowWidthAtConfirmation]
    ));
    const waitRounds = confirmed.flatMap((row) => (
        row.firstQueueRound === null || row.confirmedRound === null
            ? []
            : [row.confirmedRound - row.firstQueueRound]
    ));
    const seriesGroups = new Map<string, LegacySerialEventState[]>();
    rows.forEach((row) => {
        const key = `${row.fileId}:${row.scenarioId}:${row.seriesId}`;
        seriesGroups.set(key, [...(seriesGroups.get(key) ?? []), row]);
    });
    return {
        files: new Set(rows.map((row) => row.fileId)).size,
        seriesScenarios: seriesGroups.size,
        truthEvents: rows.length,
        confirmed: ratio(confirmed.length, rows.length),
        everCorrectWindow: ratio(everCorrect.length, rows.length),
        firstResponse: ratio(firstResponse.length, rows.length),
        firstResponseOperationAccuracy: ratio(
            firstResponse.filter((row) => row.firstResponseOperationCorrect === true).length,
            firstResponse.length,
        ),
        firstResponseWindowCoverage: ratio(
            rows.filter((row) => row.firstResponseWindowCovered === true).length,
            rows.length,
        ),
        firstResponseWindowCoverageAnswered: ratio(
            firstResponse.filter((row) => row.firstResponseWindowCovered === true).length,
            firstResponse.length,
        ),
        firstResponseTop1: ratio(
            rows.filter((row) => row.firstResponseTop1Exact === true).length,
            rows.length,
        ),
        confirmedTop1: ratio(
            confirmed.filter((row) => row.top1AtConfirmation === true).length,
            rows.length,
        ),
        top1AmongConfirmed: ratio(
            confirmed.filter((row) => row.top1AtConfirmation === true).length,
            confirmed.length,
        ),
        completelyRecoveredSeries: ratio(
            Array.from(seriesGroups.values()).filter((group) => (
                group.every((row) => row.confirmedRound !== null)
            )).length,
            seriesGroups.size,
        ),
        seriesWithAnyRecovery: ratio(
            Array.from(seriesGroups.values()).filter((group) => (
                group.some((row) => row.confirmedRound !== null)
            )).length,
            seriesGroups.size,
        ),
        directFrontierFailure: rows.filter((row) => row.directFrontierFailure).length,
        blockedByPriorEvent: rows.filter((row) => row.blockedByPriorEvent).length,
        queueWaitRounds: {
            median: quantile(waitRounds, 0.5),
            p90: quantile(waitRounds, 0.9),
        },
        windowWidth: {
            median: quantile(widths, 0.5),
            p90: quantile(widths, 0.9),
        },
    };
};

const flatten = (
    value: Record<string, unknown>,
    prefix = "",
    output: Record<string, unknown> = {},
): Record<string, unknown> => {
    Object.entries(value).forEach(([key, nested]) => {
        const name = prefix ? `${prefix}.${key}` : key;
        if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
            flatten(nested as Record<string, unknown>, name, output);
        } else {
            output[name] = Array.isArray(nested) ? JSON.stringify(nested) : nested;
        }
    });
    return output;
};

const csvValue = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const writeCsv = (path: string, rows: Array<Record<string, unknown>>): void => {
    if (rows.length === 0) {
        writeFileSync(path, "", "utf8");
        return;
    }
    const flattened = rows.map((row) => flatten(row));
    const headers = Array.from(new Set(flattened.flatMap((row) => Object.keys(row))));
    writeFileSync(path, `${[
        headers.join(","),
        ...flattened.map((row) => headers.map((header) => csvValue(row[header])).join(",")),
    ].join("\n")}\n`, "utf8");
};

const writeJsonLines = (path: string, rows: unknown[]): void => {
    writeFileSync(path, rows.length > 0
        ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
        : "", "utf8");
};

const lcg = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
    };
};

const bootstrapMetric = (
    rows: LegacyCaseRow[],
    fileIds: string[],
    replicates: number,
    seed: number,
    selector: (rows: LegacyCaseRow[]) => RatioMetric,
) => {
    const byFile = new Map(fileIds.map((fileId) => [
        fileId,
        rows.filter((row) => row.fileId === fileId),
    ]));
    const random = lcg(seed);
    const estimates: number[] = [];
    for (let iteration = 0; iteration < replicates; iteration += 1) {
        const sampled = Array.from({ length: fileIds.length }, () => (
            fileIds[Math.floor(random() * fileIds.length)]
        )).flatMap((fileId) => byFile.get(fileId) ?? []);
        const metric = selector(sampled);
        if (metric.rate !== null) estimates.push(metric.rate);
    }
    return {
        replicates,
        validReplicates: estimates.length,
        estimate: selector(rows).rate,
        lower95: quantile(estimates, 0.025),
        upper95: quantile(estimates, 0.975),
    };
};

const bootstrapSerialMetric = (
    rows: LegacySerialEventState[],
    fileIds: string[],
    replicates: number,
    seed: number,
    selector: (rows: LegacySerialEventState[]) => RatioMetric,
) => {
    const byFile = new Map(fileIds.map((fileId) => [
        fileId,
        rows.filter((row) => row.fileId === fileId),
    ]));
    const random = lcg(seed);
    const estimates: number[] = [];
    for (let iteration = 0; iteration < replicates; iteration += 1) {
        const sampled = Array.from({ length: fileIds.length }, () => (
            fileIds[Math.floor(random() * fileIds.length)]
        )).flatMap((fileId) => byFile.get(fileId) ?? []);
        const metric = selector(sampled);
        if (metric.rate !== null) estimates.push(metric.rate);
    }
    return {
        replicates,
        validReplicates: estimates.length,
        estimate: selector(rows).rate,
        lower95: quantile(estimates, 0.025),
        upper95: quantile(estimates, 0.975),
    };
};

const metricSelectors = {
    response: (rows: LegacyCaseRow[]) => summarizeCases(rows).response,
    operationAccuracyAnswered: (rows: LegacyCaseRow[]) => (
        summarizeCases(rows).operationAccuracyAnswered
    ),
    firstWindowCoverage: (rows: LegacyCaseRow[]) => summarizeCases(rows).firstWindowCoverage,
    conditionalWindowCoverage: (rows: LegacyCaseRow[]) => (
        summarizeCases(rows).conditionalWindowCoverage
    ),
};

const serialMetricSelectors = {
    confirmed: (rows: LegacySerialEventState[]) => summarizeSerial(rows).confirmed,
    everCorrectWindow: (rows: LegacySerialEventState[]) => (
        summarizeSerial(rows).everCorrectWindow
    ),
    firstResponse: (rows: LegacySerialEventState[]) => summarizeSerial(rows).firstResponse,
    firstResponseWindowCoverage: (rows: LegacySerialEventState[]) => (
        summarizeSerial(rows).firstResponseWindowCoverage
    ),
};

const stratumRows = (
    rows: LegacyCaseRow[],
    manifest: LegacyManifest,
    config: LegacyConfig,
) => {
    const targetByKey = new Map(manifest.files.flatMap((file) => file.targets.map((target) => [
        `${file.fileId}:${target.targetId}`,
        target,
    ])));
    const dimensions: Array<[string, (row: LegacyCaseRow) => string]> = [
        ["file", (row) => row.fileId],
        ["source", (row) => row.source],
        ["truthQuality", (row) => row.truthQuality],
        ["developmentExposure", (row) => row.developmentExposure],
        ["eventType", (row) => row.truthEventType ?? "negative"],
        ["eventComplexity", (row) => row.eventComplexity],
        ["correlation", (row) => qualityBin(
            row.quality.leaveOneOutCorrelation,
            config.qualityBins.leaveOneOutCorrelation,
        )],
        ["referenceDepth", (row) => qualityBin(
            row.quality.effectiveReferenceSourceCount,
            config.qualityBins.effectiveReferenceCount,
        )],
        ["segmentStability", (row) => qualityBin(
            row.quality.segmentStability,
            config.qualityBins.segmentStability,
        )],
        ["seriesLength", (row) => qualityBin(
            row.quality.seriesLength,
            config.qualityBins.seriesLength,
        )],
        ["zeroMissingComplexity", (row) => qualityBin(
            row.quality.zeroMissingDensity,
            config.qualityBins.zeroDensity,
        )],
        ["identifiability", (row) => (
            row.absoluteIdentifiable ? "absolute-identifiable" : "absolute-unidentifiable"
        )],
        ["savePair", (row) => row.scenarioPair],
        ["endpointDistance", (row) => {
            const target = targetByKey.get(`${row.fileId}:${row.seriesId}`);
            if (!target || row.truthYear === null) return "not-applicable";
            const distance = Math.min(
                row.truthYear - target.startYear,
                target.endYear - row.truthYear,
            );
            return qualityBin(distance, config.qualityBins.endpointDistance);
        }],
    ];
    return dimensions.flatMap(([dimension, keyFor]) => {
        const groups = new Map<string, LegacyCaseRow[]>();
        rows.forEach((row) => {
            const key = keyFor(row);
            groups.set(key, [...(groups.get(key) ?? []), row]);
        });
        return Array.from(groups, ([value, group]) => ({
            dimension,
            value,
            ...summarizeCases(group),
        }));
    });
};

const sourceSha256 = (path: string): string => createHash("sha256")
    .update(readFileSync(path)).digest("hex");

export const writeLegacyGeneralizationArtifacts = (input: {
    runDir: string;
    manifest: LegacyManifest;
    config: LegacyConfig;
    configHash: string;
    manifestHash: string;
    outputs: LegacyFileWorkerOutput[];
    metadataBase: Record<string, unknown>;
    co612Gate: Record<string, unknown> | null;
    directedRegressions: Array<Record<string, unknown>>;
}) => {
    mkdirSync(input.runDir, { recursive: true });
    const cases = input.outputs.flatMap((output) => output.cases);
    const primaryCases = cases.filter((row) => row.scenarioPair === "before-save");
    const events: LegacyEventRow[] = input.outputs.flatMap((output) => output.events);
    const serialRounds: LegacySerialRound[] = input.outputs.flatMap((output) => output.serialRounds);
    const serialEvents: LegacySerialEventState[] = input.outputs.flatMap((output) => (
        output.serialEvents
    ));
    const negatives = primaryCases.filter((row) => row.truthQuality === "negative-clean");
    const failures = [
        ...primaryCases.filter((row) => row.truthQuality === "exact-injected" && (
            !row.response
            || row.operationCorrect !== true
            || (row.windowApplicable && row.windowCovered !== true)
        )).map((row) => ({
            layer: !row.response
                ? "proposal-or-review-gate"
                : row.operationCorrect !== true
                    ? "candidate-ranking-or-event-fusion"
                    : "window",
            reason: !row.response
                ? row.refusalReason ?? "no_response"
                : row.operationCorrect !== true
                    ? "operation_mismatch"
                    : "window_miss",
            ...row,
        })),
        ...serialEvents.filter((row) => row.confirmedRound === null).map((row) => ({
            layer: row.blockedByPriorEvent ? "serial-blocking" : "serial-frontier",
            reason: row.failureReason,
            ...row,
        })),
    ];
    const perFile = input.manifest.files.map((file) => {
        const rows = primaryCases.filter((row) => row.fileId === file.fileId);
        const serial = serialEvents.filter((row) => row.fileId === file.fileId);
        return {
            fileId: file.fileId,
            relativePath: file.relativePath,
            source: file.source,
            role: file.role,
            developmentExposure: file.developmentExposure,
            single: summarizeCases(rows),
            serial: summarizeSerial(serial),
            runtimeMs: input.outputs.filter((output) => output.fileId === file.fileId)
                .reduce((sum, output) => sum + output.runtimeMs, 0),
            sourceMutationCount: input.outputs.filter((output) => output.fileId === file.fileId)
                .reduce((sum, output) => sum + output.sourceMutationCount, 0),
            errors: input.outputs.filter((output) => output.fileId === file.fileId)
                .flatMap((output) => output.errors),
        };
    });
    const exactRows = primaryCases.filter((row) => row.truthQuality === "exact-injected");
    const fileIds = Array.from(new Set(exactRows.map((row) => row.fileId)));
    const singleBootstrap = Object.fromEntries(Object.entries(metricSelectors).map(([
        name,
        selector,
    ], index) => [name, bootstrapMetric(
        exactRows,
        fileIds,
        input.config.runtime.bootstrapReplicates,
        input.config.runtime.bootstrapSeed + index,
        selector,
    )]));
    const serialFileIds = Array.from(new Set(serialEvents.map((row) => row.fileId)));
    const serialBootstrap = Object.fromEntries(Object.entries(serialMetricSelectors).map(([
        name,
        selector,
    ], index) => [name, bootstrapSerialMetric(
        serialEvents,
        serialFileIds,
        input.config.runtime.bootstrapReplicates,
        input.config.runtime.bootstrapSeed + 100 + index,
        selector,
    )]));
    const bootstrap = {
        cluster: "file",
        single: singleBootstrap,
        serial: serialBootstrap,
    };
    const fileWindowRates = perFile.flatMap((file) => {
        const rate = file.single.firstWindowCoverage.rate;
        return rate === null ? [] : [{ fileId: file.fileId, rate }];
    }).sort((left, right) => left.rate - right.rate);
    const fileMacro = {
        response: mean(perFile.flatMap((file) => (
            file.single.response.rate === null ? [] : [file.single.response.rate]
        ))),
        operationAccuracyAnswered: mean(perFile.flatMap((file) => (
            file.single.operationAccuracyAnswered.rate === null
                ? []
                : [file.single.operationAccuracyAnswered.rate]
        ))),
        firstWindowCoverage: mean(fileWindowRates.map((row) => row.rate)),
        conditionalWindowCoverage: mean(perFile.flatMap((file) => (
            file.single.conditionalWindowCoverage.rate === null
                ? []
                : [file.single.conditionalWindowCoverage.rate]
        ))),
        serialConfirmed: mean(perFile.flatMap((file) => (
            file.serial.confirmed.rate === null ? [] : [file.serial.confirmed.rate]
        ))),
        p10File: fileWindowRates[Math.max(
            0,
            Math.ceil(fileWindowRates.length * 0.1) - 1,
        )] ?? null,
        worstFile: fileWindowRates[0] ?? null,
        betweenFileIqr: (() => {
            const q25 = quantile(fileWindowRates.map((row) => row.rate), 0.25);
            const q75 = quantile(fileWindowRates.map((row) => row.rate), 0.75);
            return q25 !== null && q75 !== null ? q75 - q25 : null;
        })(),
    };
    const strata = stratumRows(primaryCases, input.manifest, input.config);
    const summary = {
        schemaVersion: 1,
        protocolVersion: input.config.protocolVersion,
        denominators: {
            files: new Set(primaryCases.map((row) => row.fileId)).size,
            series: new Set(primaryCases.map((row) => `${row.fileId}:${row.seriesId}`)).size,
            scenarios: new Set(primaryCases.map((row) => row.scenarioId)).size,
            exactInjectedEvents: primaryCases.filter((row) => (
                row.truthQuality === "exact-injected"
            )).length,
            naturalConfirmedEvents: primaryCases.filter((row) => (
                row.truthQuality === "natural-confirmed"
            )).length,
            weakNaturalEvents: primaryCases.filter((row) => (
                row.truthQuality === "weak-natural"
            )).length,
            negativeCleanCases: negatives.length,
        },
        single: summarizeCases(primaryCases),
        serial: summarizeSerial(serialEvents),
        eventLevelMicro: summarizeCases(exactRows),
        fileLevelMacro: fileMacro,
        bootstrap,
        co612Gate: input.co612Gate,
        directedRegressions: input.directedRegressions,
        technical: {
            workerOutputs: input.outputs.length,
            sourceMutationCount: input.outputs.reduce(
                (sum, output) => sum + output.sourceMutationCount,
                0,
            ),
            saveReopenDifferentialCount: input.outputs.reduce(
                (sum, output) => sum + output.saveReopenDifferentialCount,
                0,
            ),
            errors: input.outputs.reduce((sum, output) => sum + output.errors.length, 0),
        },
    };
    const metadata = {
        schemaVersion: 1,
        ...input.metadataBase,
        configHash: input.configHash,
        manifestHash: input.manifestHash,
        inputHashes: input.manifest.inputHashes,
        sourceMutationCount: summary.technical.sourceMutationCount,
        baselineProductionDifferential: input.metadataBase.baselineProductionDifferential,
        developmentExposureCounts: input.manifest.files.reduce<Record<string, number>>(
            (counts, file) => ({
                ...counts,
                [file.developmentExposure]: (counts[file.developmentExposure] ?? 0) + 1,
            }),
            {},
        ),
        missingRequiredFields: [],
        gateStatus: input.metadataBase.gateStatus,
    };
    writeFileSync(join(input.runDir, "resolved-manifest.json"), `${JSON.stringify(
        input.manifest,
        null,
        2,
    )}\n`, "utf8");
    writeJsonLines(join(input.runDir, "cases.jsonl"), cases);
    writeCsv(join(input.runDir, "cases.csv"), cases as unknown as Array<Record<string, unknown>>);
    writeJsonLines(join(input.runDir, "events.jsonl"), events);
    writeCsv(join(input.runDir, "events.csv"), events as unknown as Array<Record<string, unknown>>);
    writeJsonLines(join(input.runDir, "serial-rounds.jsonl"), serialRounds);
    writeCsv(
        join(input.runDir, "serial-rounds.csv"),
        serialRounds as unknown as Array<Record<string, unknown>>,
    );
    writeFileSync(join(input.runDir, "per-file-summary.json"), `${JSON.stringify(
        perFile,
        null,
        2,
    )}\n`, "utf8");
    writeCsv(
        join(input.runDir, "per-file-summary.csv"),
        perFile as unknown as Array<Record<string, unknown>>,
    );
    writeFileSync(join(input.runDir, "strata.json"), `${JSON.stringify(strata, null, 2)}\n`);
    writeCsv(join(input.runDir, "strata.csv"), strata as Array<Record<string, unknown>>);
    writeFileSync(join(input.runDir, "bootstrap.json"), `${JSON.stringify(bootstrap, null, 2)}\n`);
    writeJsonLines(join(input.runDir, "negative-controls.jsonl"), negatives);
    writeCsv(
        join(input.runDir, "negative-controls.csv"),
        negatives as unknown as Array<Record<string, unknown>>,
    );
    writeJsonLines(join(input.runDir, "failures.jsonl"), failures);
    writeCsv(join(input.runDir, "failures.csv"), failures as Array<Record<string, unknown>>);
    writeFileSync(join(input.runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(input.runDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    ["stdout.log", "stderr.log"].forEach((name) => {
        const path = join(input.runDir, name);
        if (!existsSync(path)) writeFileSync(path, "", "utf8");
    });
    const checksumFiles = [
        "resolved-manifest.json",
        "cases.jsonl",
        "cases.csv",
        "events.jsonl",
        "events.csv",
        "serial-rounds.jsonl",
        "serial-rounds.csv",
        "per-file-summary.json",
        "per-file-summary.csv",
        "strata.json",
        "strata.csv",
        "bootstrap.json",
        "negative-controls.jsonl",
        "negative-controls.csv",
        "failures.jsonl",
        "failures.csv",
        "summary.json",
        "metadata.json",
    ];
    const checksums = Object.fromEntries(checksumFiles.map((name) => [
        name,
        sourceSha256(join(input.runDir, name)),
    ]));
    writeFileSync(join(input.runDir, "checksums.sha256.json"), `${JSON.stringify({
        schemaVersion: 1,
        files: checksums,
    }, null, 2)}\n`, "utf8");
    return {
        summary,
        metadata,
        checksums,
        artifactCount: checksumFiles.length + 1,
        names: checksumFiles.map((name) => basename(name)),
    };
};
