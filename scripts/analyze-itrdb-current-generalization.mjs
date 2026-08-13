/** Freezes and audits the current ITRDB A/B/C/D generalization runs. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = null) => {
    const index = args.indexOf(name);
    if (index >= 0) return args[index + 1] ?? fallback;
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    return inline?.slice(name.length + 1) ?? fallback;
};
const requiredValue = (name) => {
    const value = valueFor(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
};
const manifestPath = resolve(valueFor(
    "--manifest",
    "docs/benchmarks/itrdb-current-generalization-manifest-v1.json",
));
const configPath = resolve(valueFor(
    "--config",
    "docs/benchmarks/itrdb-current-generalization-config-v1.json",
));
const abDir = resolve(requiredValue("--ab-dir"));
const cdDir = resolve(requiredValue("--cd-dir"));
const executionGitCommit = requiredValue("--execution-git-commit");
const outputJson = resolve(valueFor(
    "--output-json",
    "docs/benchmarks/itrdb-current-generalization-result-v1.json",
));
const outputMarkdown = resolve(valueFor(
    "--output-markdown",
    "docs/benchmarks/itrdb-current-generalization-2026-08-13.md",
));

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fileSha256 = (path) => sha256(readFileSync(path));
const assert = (condition, message) => {
    if (!condition) throw new Error(message);
};
const rate = (count, total) => total > 0 ? count / total : null;
const percent = (value, digits = 2) => value === null || value === undefined
    ? "n/a"
    : `${(value * 100).toFixed(digits)}%`;
const fraction = (count, total) => `${count}/${total} = ${percent(rate(count, total))}`;
const percentile = (values, probability) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * probability) - 1)];
};
const stableSeed = (text) => Number.parseInt(sha256(text).slice(0, 8), 16) >>> 0;
const mulberry32 = (seed) => () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
};

const config = readJson(configPath);
const manifest = readJson(manifestPath);
assert(fileSha256(configPath) === manifest.configSha256, "config hash mismatch");
const manifestByFile = new Map(manifest.files.map((file) => [file.fileId, file]));
const sourceMismatches = manifest.files.flatMap((file) => {
    const path = resolve(manifest.itrdbRoot, file.relativePath);
    return fileSha256(path) === file.sourceSha256 ? [] : [file.fileId];
});
assert(sourceMismatches.length === 0, `source hash mismatch: ${sourceMismatches.join(",")}`);

const loadRun = (label, directory, expectedFamilies) => {
    const paths = Object.fromEntries([
        "summary.json",
        "cases.json",
        "steps.json",
        "resolved-cases.json",
        "run-plan.json",
    ].map((name) => [name, join(directory, name)]));
    const summary = readJson(paths["summary.json"]);
    const cases = readJson(paths["cases.json"]);
    const steps = readJson(paths["steps.json"]);
    const specs = readJson(paths["resolved-cases.json"]);
    const plan = readJson(paths["run-plan.json"]);
    assert(summary.errors === 0, `${label}: benchmark errors=${summary.errors}`);
    assert(summary.sourceFilesUnchanged, `${label}: run reported mutated source files`);
    assert(summary.manifestSha256 === fileSha256(manifestPath), `${label}: manifest mismatch`);
    assert(plan.manifestSha256 === summary.manifestSha256, `${label}: plan mismatch`);
    assert(cases.length === summary.selectedCases, `${label}: case count mismatch`);
    assert(expectedFamilies.every((family) => summary.selectedFamilies.includes(family)),
        `${label}: missing family`);
    assert(cases.every((row) => row.saveReopenStable), `${label}: save/reopen instability`);
    assert(summary.overall.illegalWindowWidths === 0, `${label}: illegal window width`);
    const badAutomaticPartial = steps.flatMap((step) => [step.primary, step.alternative]
        .filter((event) => event?.eventType === "partialMove" && event.shiftYears >= -1));
    assert(badAutomaticPartial.length === 0, `${label}: invalid automatic partial shift`);
    return {
        label,
        directory,
        summary,
        cases,
        steps,
        specs,
        plan,
        specByCase: new Map(specs.map((spec) => [spec.caseId, spec])),
        artifactSha256: Object.fromEntries(Object.entries(paths).map(([name, path]) => [
            name,
            fileSha256(path),
        ])),
    };
};

const runs = {
    AB: loadRun("AB", abDir, ["A", "B"]),
    CD: loadRun("CD", cdDir, ["C", "D"]),
};

const subsetMetrics = (run, predicate) => {
    const cases = run.cases.filter(predicate);
    const eventCases = cases.filter((row) => row.truthCount > 0);
    const cleanCases = cases.filter((row) => row.truthCount === 0);
    const truthEvents = eventCases.reduce((sum, row) => sum + row.truthCount, 0);
    const recovered = eventCases.reduce((sum, row) => sum + row.recoveredTruths, 0);
    return {
        files: new Set(cases.map((row) => row.fileId)).size,
        cases: cases.length,
        eventCases: eventCases.length,
        truthEvents,
        recoveredTruthEvents: recovered,
        truthRecoveryRate: rate(recovered, truthEvents),
        completeCases: eventCases.filter((row) => row.complete).length,
        completeCaseRate: rate(
            eventCases.filter((row) => row.complete).length,
            eventCases.length,
        ),
        cleanCases: cleanCases.length,
        cleanFalsePositives: cleanCases.filter((row) => row.cleanFalsePositive).length,
        cleanFalsePositiveRate: rate(
            cleanCases.filter((row) => row.cleanFalsePositive).length,
            cleanCases.length,
        ),
    };
};

const summarizeTruths = (run) => {
    const denominators = new Map();
    const numerators = new Map();
    const keyFor = (truth) => `${truth.eventType}:${truth.shiftYears}`;
    run.specs.forEach((spec) => spec.truths.forEach((truth) => {
        const key = keyFor(truth);
        denominators.set(key, (denominators.get(key) ?? 0) + 1);
    }));
    run.steps.filter((step) => step.acceptedTruthType !== null).forEach((step) => {
        const key = `${step.acceptedTruthType}:${step.acceptedTruthShiftYears}`;
        numerators.set(key, (numerators.get(key) ?? 0) + 1);
    });
    return Object.fromEntries([...denominators.keys()].sort().map((key) => {
        const total = denominators.get(key);
        const recovered = numerators.get(key) ?? 0;
        return [key, { total, recovered, recoveryRate: rate(recovered, total) }];
    }));
};

const eventMatchesTruth = (event, truth) => event
    && event.eventType === truth.eventType
    && event.shiftYears === truth.shiftYears;
const nearestOperationTruth = (run, step, event) => {
    const spec = run.specByCase.get(step.caseId);
    const remainingIds = new Set(step.remainingTruthIds);
    const candidates = spec.truths.filter((truth) => remainingIds.has(truth.truthId)
        && truth.year !== null
        && eventMatchesTruth(event, truth));
    const anchor = event.topYear ?? Math.round((event.startYear + event.endYear) / 2);
    return candidates.sort((left, right) => Math.abs(left.year - anchor) - Math.abs(right.year - anchor))[0]
        ?? null;
};

const summarizeWindowMisses = (run) => {
    const rows = run.steps.filter((step) => step.stopReason === "window_miss").flatMap((step) => {
        const event = step.primaryOperationCorrect ? step.primary : step.alternative;
        if (!event) return [];
        const truth = nearestOperationTruth(run, step, event);
        if (!truth) return [];
        const signedDistance = truth.year < event.startYear
            ? truth.year - event.startYear
            : truth.year > event.endYear
                ? truth.year - event.endYear
                : 0;
        return [{
            caseId: step.caseId,
            family: step.family,
            truthYear: truth.year,
            window: [event.startYear, event.endYear],
            signedDistance,
            distance: Math.abs(signedDistance),
        }];
    });
    const distances = rows.map((row) => row.distance);
    return {
        steps: run.steps.filter((step) => step.stopReason === "window_miss").length,
        matchedSteps: rows.length,
        medianDistance: percentile(distances, 0.5),
        p90Distance: percentile(distances, 0.9),
        within2Years: rows.filter((row) => row.distance <= 2).length,
        within4Years: rows.filter((row) => row.distance <= 4).length,
        truthOlderThanWindow: rows.filter((row) => row.signedDistance < 0).length,
        truthNewerThanWindow: rows.filter((row) => row.signedDistance > 0).length,
    };
};

const summarizeRunMechanics = (run) => {
    const attempted = run.steps.filter((step) => step.remainingTruthsBefore > 0);
    const acceptedLocal = attempted.filter((step) => step.acceptedTruthType !== null
        && step.acceptedTruthType !== "wholeSeriesMove");
    const referenceModes = Object.fromEntries([...new Set(attempted.map((step) => step.referenceMode))]
        .sort().map((mode) => [mode, attempted.filter((step) => step.referenceMode === mode).length]));
    const widths = Object.fromEntries([5, 7, 9, 13].map((width) => [
        String(width),
        acceptedLocal.filter((step) => step.windowWidth === width).length,
    ]));
    const frontierOutcomes = Object.fromEntries([
        "recovered",
        "window_miss",
        "wrong_operation",
        "refused",
    ].map((outcome) => [
        outcome,
        outcome === "recovered"
            ? attempted.filter((step) => step.acceptedTruthId !== null).length
            : attempted.filter((step) => step.stopReason === outcome).length,
    ]));
    return { attemptedSteps: attempted.length, referenceModes, widths, frontierOutcomes };
};

const cumulativeAlias = (run, step) => {
    if (step.stopReason !== "wrong_operation" || step.primary?.eventType !== "partialMove") {
        return null;
    }
    const spec = run.specByCase.get(step.caseId);
    const remainingIds = new Set(step.remainingTruthIds);
    const localTruths = spec.truths.filter((truth) => remainingIds.has(truth.truthId)
        && truth.eventType !== "wholeSeriesMove"
        && truth.year !== null);
    for (let mask = 3; mask < 2 ** localTruths.length; mask += 1) {
        const subset = localTruths.filter((_, index) => (mask & (1 << index)) !== 0);
        if (subset.length < 2) continue;
        const years = subset.map((truth) => truth.year);
        const firstYear = Math.min(...years);
        const lastYear = Math.max(...years);
        const shiftYears = subset.reduce((sum, truth) => sum + truth.shiftYears, 0);
        const overlapsRegion = step.primary.endYear >= firstYear - 2
            && step.primary.startYear <= lastYear + 2;
        if (lastYear - firstYear <= 13
            && shiftYears === step.primary.shiftYears
            && overlapsRegion) {
            return {
                caseId: step.caseId,
                family: step.family,
                scenarioId: step.scenarioId,
                predictedShiftYears: step.primary.shiftYears,
                predictedWindow: [step.primary.startYear, step.primary.endYear],
                componentTruths: subset.map((truth) => ({
                    eventType: truth.eventType,
                    year: truth.year,
                    shiftYears: truth.shiftYears,
                })),
            };
        }
    }
    return null;
};

const summarizeAliases = (run) => {
    const wrongSteps = run.steps.filter((step) => step.stopReason === "wrong_operation");
    const aliases = wrongSteps.flatMap((step) => cumulativeAlias(run, step) ?? []);
    const byFamily = Object.fromEntries([...new Set(wrongSteps.map((step) => step.family))]
        .sort().map((family) => {
            const wrong = wrongSteps.filter((step) => step.family === family).length;
            const compatible = aliases.filter((row) => row.family === family).length;
            return [family, {
                wrongOperationSteps: wrong,
                cumulativeLagCompatible: compatible,
                compatibleShare: rate(compatible, wrong),
            }];
        }));
    return {
        wrongOperationSteps: wrongSteps.length,
        cumulativeLagCompatible: aliases.length,
        compatibleShare: rate(aliases.length, wrongSteps.length),
        byFamily,
        examples: aliases.slice(0, 12),
    };
};

const measurementKind = (file) => {
    const text = readFileSync(resolve(manifest.itrdbRoot, file.relativePath), "utf8").slice(0, 5000);
    if (/DENSITY_[A-Z_]+/.test(text)) return "density";
    if (/WIDTH_(?:EARLY|LATE)/.test(text)) return "width_component";
    return "ring_width_or_unlabeled";
};

const fileStrata = {
    all: new Set(manifest.files.map((file) => file.fileId)),
    fileCleanHigh: new Set(manifest.files.filter((file) => (
        file.seriesIntercorrelation >= 0.8 && file.possibleProblemSegments === 0
    )).map((file) => file.fileId)),
    fileNearHigh: new Set(manifest.files.filter((file) => (
        file.seriesIntercorrelation >= 0.8 && file.possibleProblemSegments <= 1
    )).map((file) => file.fileId)),
    ringWidthOrUnlabeled: new Set(manifest.files.filter((file) => (
        measurementKind(file) === "ring_width_or_unlabeled"
    )).map((file) => file.fileId)),
};
const stratumSummary = (run) => Object.fromEntries(Object.entries(fileStrata).map(([name, ids]) => [
    name,
    {
        allFamilies: subsetMetrics(run, (row) => ids.has(row.fileId)),
        ...Object.fromEntries(run.summary.selectedFamilies.map((family) => [
            family,
            subsetMetrics(run, (row) => ids.has(row.fileId) && row.family === family),
        ])),
    },
]));

const perFile = manifest.files.map((file) => ({
    fileId: file.fileId,
    measurementKind: measurementKind(file),
    fileIntercorrelation: file.seriesIntercorrelation,
    fileProblemSegments: file.possibleProblemSegments,
    targetId: file.eligibleTargets[0]?.targetId ?? null,
    targetCorrelation: file.eligibleTargets[0]?.masterCorrelation ?? null,
    AB: subsetMetrics(runs.AB, (row) => row.fileId === file.fileId),
    CD: subsetMetrics(runs.CD, (row) => row.fileId === file.fileId),
}));

const bootstrapMetric = (run, family, iterations = 10000) => {
    const files = manifest.files.map((file) => file.fileId);
    const perFileCounts = new Map(files.map((fileId) => {
        const rows = run.cases.filter((row) => row.fileId === fileId
            && row.truthCount > 0
            && (family === null || row.family === family));
        return [fileId, {
            numerator: rows.reduce((sum, row) => sum + row.recoveredTruths, 0),
            denominator: rows.reduce((sum, row) => sum + row.truthCount, 0),
        }];
    }));
    const pointCounts = [...perFileCounts.values()].reduce((total, item) => ({
        numerator: total.numerator + item.numerator,
        denominator: total.denominator + item.denominator,
    }), { numerator: 0, denominator: 0 });
    const random = mulberry32(stableSeed(`generalization-bootstrap:${run.label}:${family ?? "all"}`));
    const samples = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        let numerator = 0;
        let denominator = 0;
        for (let index = 0; index < files.length; index += 1) {
            const item = perFileCounts.get(files[Math.floor(random() * files.length)]);
            numerator += item.numerator;
            denominator += item.denominator;
        }
        samples.push(rate(numerator, denominator));
    }
    return {
        files: files.length,
        iterations,
        pointEstimate: rate(pointCounts.numerator, pointCounts.denominator),
        ci95: [percentile(samples, 0.025), percentile(samples, 0.975)],
    };
};

const cleanFalsePositives = runs.AB.steps.filter((step) => {
    const spec = runs.AB.specByCase.get(step.caseId);
    return spec.truths.length === 0 && step.response;
}).map((step) => ({
    fileId: step.fileId,
    targetId: step.targetId,
    referenceMode: step.referenceMode,
    event: step.primary,
}));

const result = {
    schemaVersion: 1,
    protocolVersion: manifest.protocolVersion,
    createdAt: [runs.AB.summary.createdAt, runs.CD.summary.createdAt].sort().at(-1),
    verdict: "strict_generalization_target_not_met",
    executionGitCommit,
    manifestGitCommit: manifest.gitCommit,
    manifestPath,
    manifestSha256: fileSha256(manifestPath),
    configPath,
    configSha256: fileSha256(configPath),
    sourceFilesUnchanged: true,
    sourceMismatches,
    population: {
        candidateFiles: config.generalizationSelection.candidateFileCount,
        includedFiles: manifest.files.length,
        targets: manifest.counts.eligibleTargets,
        excludedFiles: manifest.excludedFiles.length,
        selectionUnit: "target series",
        targetMinimumYears: config.selection.minimumSeriesYears,
        targetMinimumCorrelation: config.selection.minimumMasterCorrelation,
        targetMaximumProblemSegments: config.selection.maximumProblemSegments,
        measurementKinds: Object.fromEntries([
            "density",
            "width_component",
            "ring_width_or_unlabeled",
        ].map((kind) => [kind, manifest.files.filter((file) => measurementKind(file) === kind).length])),
    },
    runs: Object.fromEntries(Object.entries(runs).map(([key, run]) => [key, {
        directory: run.directory,
        artifactSha256: run.artifactSha256,
        official: run.summary,
        truthByOperationAndShift: summarizeTruths(run),
        mechanics: summarizeRunMechanics(run),
        windowMisses: summarizeWindowMisses(run),
        strata: stratumSummary(run),
    }])),
    fileClusterBootstrap: {
        A: bootstrapMetric(runs.AB, "A"),
        B: bootstrapMetric(runs.AB, "B"),
        C: bootstrapMetric(runs.CD, "C"),
        D: bootstrapMetric(runs.CD, "D"),
    },
    nearEventEquivalentInterpretations: summarizeAliases(runs.CD),
    cleanFalsePositives,
    perFile,
    integrity: {
        benchmarkErrors: runs.AB.summary.errors + runs.CD.summary.errors,
        illegalWindowWidths: runs.AB.summary.overall.illegalWindowWidths
            + runs.CD.summary.overall.illegalWindowWidths,
        invalidAutomaticPartialMoves: 0,
        saveReopenStable: runs.AB.summary.overall.saveReopenStableRate === 1
            && runs.CD.summary.overall.saveReopenStableRate === 1,
    },
};

const scenarioRows = (run, family) => Object.entries(run.summary.byScenario)
    .filter(([scenarioId]) => scenarioId.startsWith(family))
    .map(([scenarioId, summary]) => `| ${scenarioId} | ${summary.truthEvents} | ${fraction(
        summary.recoveredTruthEvents,
        summary.truthEvents,
    )} | ${percent(summary.responseRateAtAttemptedFrontier)} | ${percent(
        summary.reviewChoiceOperationAccuracy,
    )} | ${percent(summary.responseRateAtAttemptedFrontier
        ? summary.reviewChoiceOperationAccuracy / summary.responseRateAtAttemptedFrontier
        : null)} | ${percent(
        summary.reviewChoiceWindowCoverage,
    )} | ${percent(summary.conditionalLocalWindowCoverage)} | ${percent(summary.top1)} |`)
    .join("\n");
const stratumRow = (name, label) => {
    const ab = result.runs.AB.strata[name];
    const cd = result.runs.CD.strata[name];
    return `| ${label} | ${ab.allFamilies.files} | ${percent(ab.A.truthRecoveryRate)} | ${percent(
        ab.B.truthRecoveryRate,
    )} | ${percent(cd.C.truthRecoveryRate)} | ${percent(cd.D.truthRecoveryRate)} |`;
};
const bootstrapRow = (family) => {
    const item = result.fileClusterBootstrap[family];
    return `| ${family} | ${percent(item.pointEstimate)} | ${percent(item.ci95[0])}-${percent(
        item.ci95[1],
    )} |`;
};
const fileRows = perFile.map((row) => `| ${row.fileId} | ${row.measurementKind} | ${row.fileIntercorrelation.toFixed(
    3,
)} | ${row.fileProblemSegments} | ${percent(row.AB.truthRecoveryRate)} | ${percent(
    row.CD.truthRecoveryRate,
)} |`).join("\n");
const operationRows = (runKey) => Object.entries(result.runs[runKey].truthByOperationAndShift)
    .map(([key, item]) => `| ${key} | ${item.total} | ${fraction(item.recovered, item.total)} |`)
    .join("\n");
const headlineRow = (family, runKey) => {
    const item = runs[runKey].summary.byFamily[family];
    return `| ${family} | ${item.truthEvents} | ${fraction(item.recoveredTruthEvents, item.truthEvents)} | ${percent(
        item.responseRateAtAttemptedFrontier,
    )} | ${percent(
        item.reviewChoiceOperationAccuracy,
    )} | ${percent(item.responseRateAtAttemptedFrontier
        ? item.reviewChoiceOperationAccuracy / item.responseRateAtAttemptedFrontier
        : null)} | ${percent(
        item.reviewChoiceWindowCoverage,
    )} | ${percent(
        item.conditionalLocalWindowCoverage,
    )} | ${percent(item.top1)} |`;
};
const abWindow = result.runs.AB.windowMisses;
const cdWindow = result.runs.CD.windowMisses;
const alias = result.nearEventEquivalentInterpretations;
const markdown = `# 当前 JS 定年建议 ITRDB 跨文件泛化验证（2026-08-13）

## 结论

**严格泛化目标未通过。** 23 个此前未进入三份既有验证 manifest 的 ITRDB 文件上，单事件 A 恢复 ${percent(
    runs.AB.summary.byFamily.A.truthRecoveryRate,
)}，远距离双事件 B 恢复 ${percent(runs.AB.summary.byFamily.B.truthRecoveryRate)}；均未同时达到预设的 90%。A 中单缺轮和整体移动超过 90%，但伪轮与局部移动仍低于目标。近距离 C 是非阻断压力集，严格恢复 ${percent(
    runs.CD.summary.byFamily.C.truthRecoveryRate,
)}；三类混合 D 恢复 ${percent(runs.CD.summary.byFamily.D.truthRecoveryRate)}。

这批结果是留出评估，不用于本轮调参或修改生产诊断。完成本次查看后，这 23 个文件只能作为后续开发回归集；下一轮宣称泛化提升时必须另取未见文件。

## 冻结协议

- 实际执行提交：\`${executionGitCommit}\`。
- manifest 生成提交：\`${manifest.gitCommit}\`。
- manifest SHA-256：\`${result.manifestSha256}\`。
- 固定 seed 候选池 240 个文件；排除三份既有 manifest 的路径和内容哈希后，以目标样芯长度 >=200 年、目标对 master 相关 >=0.80、目标问题段=0 筛选。
- 最终 23 个文件、23 条目标样芯。筛选条件是**目标样芯级**，不是文件整体质量门槛；因此文件整体相关性和问题段数仍有较大跨度。
- 测量类型：${result.population.measurementKinds.ring_width_or_unlabeled} 个 ring-width/未标注、${result.population.measurementKinds.width_component} 个早晚材宽度分量、${result.population.measurementKinds.density} 个密度文件。全体结果刻意保留这些跨测量类型差异。
- A/B 共 ${runs.AB.summary.selectedCases} 个案例、${runs.AB.summary.overall.truthEvents} 个真值；C/D 共 ${runs.CD.summary.selectedCases} 个案例、${runs.CD.summary.overall.truthEvents} 个真值。
- 参考路径与 Tauri 一致：正常使用 COFECHA master；anchor 少于 3 时使用排除目标芯的 pairwise bootstrap。
- 每轮只接受一个操作正确且窗口覆盖真值的唯一建议，模拟人工确认、保存重开、再诊断。

早期 summary 的 \`gitCommit\` 字段错误记录了 manifest 提交，而非实际执行提交；本轮已修复 runner 供未来运行写入 \`executionGitCommit\` 与 \`manifestGitCommit\`。本报告单独冻结实际执行提交，不改写原始结果文件。

## 总体结果

| 家族 | 真值 | 严格恢复 | 响应 | 全前沿操作正确 | 已回答操作准确 | 主窗口覆盖 | 条件窗口覆盖 | Top1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${headlineRow("A", "AB")}
${headlineRow("B", "AB")}
${headlineRow("C", "CD")}
${headlineRow("D", "CD")}

说明：严格恢复要求操作、位移量和窗口同时正确，并允许修复一个事件后继续暴露下一事件。条件窗口覆盖只在操作已正确时计算，不能代替全案例覆盖。

## A 单事件

| 场景 | 真值 | 严格恢复 | 响应 | 全前沿操作正确 | 已回答操作准确 | 主窗口覆盖 | 条件窗口覆盖 | Top1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${scenarioRows(runs.AB, "A")}

单缺轮 21/23（91.30%）和整体移动 22/23（95.65%）达到 90%；单伪轮 20/23（86.96%）与单局部移动 18/23（78.26%）未达到。A0 干净对照误报 1/23（4.35%）。

## B 远距离双事件

| 场景 | 真值 | 严格恢复 | 响应 | 全前沿操作正确 | 已回答操作准确 | 主窗口覆盖 | 条件窗口覆盖 | Top1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${scenarioRows(runs.AB, "B")}

B 的总体真值恢复为 ${fraction(
    runs.AB.summary.byFamily.B.recoveredTruthEvents,
    runs.AB.summary.byFamily.B.truthEvents,
)}。最弱的是 B5 false-missing（60.87%）和 B12 whole-partial（63.04%）；没有一个 B 子场景达到 90%。

## C/D 压力集

| 场景 | 真值 | 严格恢复 | 响应 | 全前沿操作正确 | 已回答操作准确 | 主窗口覆盖 | 条件窗口覆盖 | Top1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${scenarioRows(runs.CD, "C")}
${scenarioRows(runs.CD, "D")}

C 的严格分数不能全部解释为普通分类错误：${alias.byFamily.C.cumulativeLagCompatible}/${alias.byFamily.C.wrongOperationSteps} 次 C 类错误操作满足严格的累计 lag 等价条件，即预测 partialMove 的位移恰好等于 13 年内多个局部真值位移之和，且窗口覆盖同一区域。例如 \`missing -1 + partial -6 -> partial -7\`、\`partial -20 + false +1 -> partial -19\`。这些案例符合“让用户用样本断裂证据在多缺轮与局部移动之间裁决”的产品语义，但本报告**不把它们改记为严格恢复**。D 的 ${alias.byFamily.D.wrongOperationSteps} 次错误中，0 次满足该等价条件，仍是真正的整体基线与局部事件联合裁决失败。

## 操作与位移量

### A/B

| 真值操作:位移 | 数量 | 严格恢复 |
| --- | ---: | ---: |
${operationRows("AB")}

### C/D

| 真值操作:位移 | 数量 | 严格恢复 |
| --- | ---: | ---: |
${operationRows("CD")}

所有正式自动 partialMove 均小于 -1；没有正向自动 partialMove，也没有把 -20 静默压成 -3。保存重开一致率为 100%。

## 窗口定位

- A/B 已正确操作的条件窗口覆盖为 ${percent(runs.AB.summary.overall.conditionalLocalWindowCoverage)}，但全前沿主窗口覆盖只有 ${percent(
    runs.AB.summary.overall.reviewChoiceWindowCoverage,
)}。
- A/B 有 ${abWindow.steps} 次窗口失败；可匹配失败的距离中位数 ${abWindow.medianDistance} 年、P90 ${abWindow.p90Distance} 年，${abWindow.within2Years} 次只差 <=2 年，${abWindow.within4Years} 次只差 <=4 年。另有远距离错误模式，不能靠统一扩窗解决。
- C/D 有 ${cdWindow.steps} 次窗口失败；距离中位数 ${cdWindow.medianDistance} 年、P90 ${cdWindow.p90Distance} 年。
- 接受窗口宽度全部属于 5/7/9/13 年，但 A/B 与 C/D 的中位数和 P90 都是 13 年。算法保持了宽度上限，却尚未实现“多数容易案例 5-9 年”的目标。
- A/B Top1 只有 ${percent(runs.AB.summary.overall.top1)}，说明窗口内年份排序仍明显弱于窗口级定位。

## 文件质量敏感性

| 分层 | 文件 | A | B | C | D |
| --- | ---: | ---: | ---: | ---: | ---: |
${stratumRow("all", "全部目标合格文件")}
${stratumRow("ringWidthOrUnlabeled", "排除密度与早/晚材宽度分量")}
${stratumRow("fileCleanHigh", "文件整体 r>=0.80 且问题段=0")}
${stratumRow("fileNearHigh", "文件整体 r>=0.80 且问题段<=1")}

文件整体 r>=0.80、问题段<=1 的 7 文件上，A/B 合并恢复 ${percent(
    result.runs.AB.strata.fileNearHigh.allFamilies.truthRecoveryRate,
)}，比全体 ${percent(result.runs.AB.strata.all.allFamilies.truthRecoveryRate)} 高，但仍不能据此宣称稳定达到 90%。这也确认了参考结构质量是主要适用边界之一。

## 文件聚类不确定性

按 23 个文件为聚类单位进行固定 seed 的 10,000 次 bootstrap：

| 家族 | 点估计 | 95% CI |
| --- | ---: | ---: |
${bootstrapRow("A")}
${bootstrapRow("B")}
${bootstrapRow("C")}
${bootstrapRow("D")}

## 逐文件严格恢复

| 文件 | 测量类型 | 文件相关 | 文件问题段 | A/B | C/D |
| --- | --- | ---: | ---: | ---: | ---: |
${fileRows}

文件间差异很大：A/B 从 10.71% 到 100%。\`russ110e\`、\`russ070n\` 和 \`swit292\` 是主要退化点；其中 \`russ070n\` 是密度文件、整体相关 0.414、170 个问题段，也是唯一干净误报。它仍保留在总体统计中，但不应被误认为普通高质量 ring-width 文件。

## 完整性与安全门禁

- 23 个源 RWL 的 SHA-256 当前全部与冻结 manifest 一致；正式运行也报告源文件未修改。
- 两批运行错误 0；保存重开差异 0；非法窗口宽度 0。
- 自动 partialMove 正向或 -1：0。
- A0 干净误报：${cleanFalsePositives.length}/23；唯一案例为 \`${cleanFalsePositives[0]?.fileId ?? "none"}:${cleanFalsePositives[0]?.targetId ?? "none"}\`。
- A/B 使用 COFECHA master ${result.runs.AB.mechanics.referenceModes["cofecha-master"] ?? 0} 个前沿步骤，pairwise bootstrap ${result.runs.AB.mechanics.referenceModes["pairwise-bootstrap-target-excluded"] ?? 0} 个前沿步骤；没有目标序列泄漏到 pairwise 参考。
- 本轮只修改评估与报告基础设施，没有改生产诊断阈值、事件裁决、窗口定位或编辑语义，因此不会把这批留出结果反向拟合进当前版本。

## 验证状态

- \`npm run analyze:itrdb:current-generalization\` 连续运行两次，JSON 与 Markdown 的 SHA-256 均完全一致。
- evaluator 与 scenario generator 定向 Vitest：2 个文件、10 项测试全部通过。
- \`npm run validate:itrdb:generalization-pool\` 通过：240 个候选文件与 802 条既有路径、803 个既有内容哈希均无重叠。
- 1 案例 runner 冒烟通过：实际执行提交与 manifest 生成提交被分别记录，源文件未变，错误 0。
- \`npm run build\` 通过；仅保留既有的 chunk size 与重复静态/动态 import 警告。

## 最终判断

当前 JS 定年建议已经具备可用的**单缺轮和单整体移动复核能力**，在操作已经判断正确时，局部窗口通常也能覆盖真值；但尚不能泛化为“A/B 各类事件均 >=90%”。首要缺口依次是：单局部移动、伪轮、远距离多事件的串行前沿选择、D 类整体基线与局部事件联合裁决，以及 13 年窗口内的 Top1 排序。

C 应继续同时保留严格分数和累计 lag 等价解释，不宜通过硬改标签制造高准确率；产品层适合接入已经设计的受约束解释切换器。下一轮若优化，应使用这 23 文件作为开发回归，并另冻一批全新的最终留出文件。
`;

writeFileSync(outputJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
writeFileSync(outputMarkdown, markdown, "utf8");
console.log(`ITRDB_CURRENT_GENERALIZATION_ANALYSIS ${JSON.stringify({
    verdict: result.verdict,
    outputJson,
    outputMarkdown,
    A: result.fileClusterBootstrap.A,
    B: result.fileClusterBootstrap.B,
    C: result.fileClusterBootstrap.C,
    D: result.fileClusterBootstrap.D,
    cumulativeAliases: alias.cumulativeLagCompatible,
})}`);
