import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "vite";

const filePath = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const targetArgument = process.argv.find((argument) => argument.startsWith("--target="));
const targetTree = targetArgument?.slice("--target=".length) || null;
const repeatArgument = process.argv.find((argument) => argument.startsWith("--repeat="));
const repeat = Math.max(1, Math.round(Number(repeatArgument?.slice("--repeat=".length) ?? 1)));
const verificationArgument = process.argv.find(
  (argument) => argument.startsWith("--verification-hypotheses="),
);
const verificationHypotheses = verificationArgument
  ? Math.max(1, Math.round(Number(verificationArgument.slice("--verification-hypotheses=".length))))
  : null;
const alternativesArgument = process.argv.find(
  (argument) => argument.startsWith("--operation-alternatives="),
);
const operationAlternatives = alternativesArgument
  ? Math.max(0, Math.round(Number(alternativesArgument.slice("--operation-alternatives=".length))))
  : null;
const supplementalLocationsArgument = process.argv.find(
  (argument) => argument.startsWith("--supplemental-locations="),
);
const supplementalLocations = supplementalLocationsArgument
  ? Math.max(
    0,
    Math.round(Number(supplementalLocationsArgument.slice("--supplemental-locations=".length))),
  )
  : null;
const locationsPerSignalArgument = process.argv.find(
  (argument) => argument.startsWith("--locations-per-signal="),
);
const locationsPerSignal = locationsPerSignalArgument
  ? Math.max(
    1,
    Math.round(Number(locationsPerSignalArgument.slice("--locations-per-signal=".length))),
  )
  : null;
const maximumSignalLocationsArgument = process.argv.find(
  (argument) => argument.startsWith("--maximum-signal-locations="),
);
const maximumSignalLocations = maximumSignalLocationsArgument
  ? Math.max(
    1,
    Math.round(Number(
      maximumSignalLocationsArgument.slice("--maximum-signal-locations=".length),
    )),
  )
  : null;
const compareRecovery = process.argv.includes("--compare-recovery");

if (!filePath) {
  throw new Error("Usage: node scripts/profile-js-diagnosis.mjs <file.rwl> [--target=SERIES] [--repeat=N]");
}

const absolutePath = path.resolve(filePath);
const server = await createServer({
  configFile: false,
  appType: "custom",
  logLevel: "error",
  resolve: { alias: { "@": path.join(process.cwd(), "src") } },
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
});

try {
  const rwlModule = await server.ssrLoadModule("/src/features/rwl/index.ts");
  const diagnosisModule = await server.ssrLoadModule("/src/features/crossdating/diagnosis.ts");
  const recoveryModule = await server.ssrLoadModule(
    "/src/features/crossdating/diagnosis/eventOperationRecovery.ts",
  );
  const originalRecoveryConfig = {
    ...recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
  };
  if (verificationHypotheses !== null) {
    recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.verificationHypothesisCount =
      verificationHypotheses;
  }
  if (operationAlternatives !== null) {
    recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.maximumOperationAlternatives =
      operationAlternatives;
  }
  if (supplementalLocations !== null) {
    recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG
      .supplementalVerificationLocationCount = supplementalLocations;
  }
  if (locationsPerSignal !== null) {
    recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.locationsPerSignal =
      locationsPerSignal;
  }
  if (maximumSignalLocations !== null) {
    recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.maximumSignalLocationChoices =
      maximumSignalLocations;
  }
  const text = await readFile(absolutePath, "utf8");

  const parseStarted = performance.now();
  const parsed = await rwlModule.readRwlString(text);
  const parseMs = performance.now() - parseStarted;
  const selectedTarget = targetTree ?? parsed.data.keys().next().value ?? null;

  if (!selectedTarget || !parsed.data.has(selectedTarget)) {
    throw new Error(`Target series not found: ${selectedTarget ?? "(none)"}`);
  }
  const runDiagnosis = () => diagnosisModule.diagnoseCrossdating(parsed.data, {
    referenceConfig: null,
    targetTrees: [selectedTarget],
  });
  const summarizeRuns = (runs) => {
    const sorted = [...runs].sort((a, b) => a - b);
    return {
      diagnosisMs: sorted[Math.floor(sorted.length / 2)],
      diagnosisRunsMs: runs,
      diagnosisMinMs: sorted[0],
      diagnosisMaxMs: sorted[sorted.length - 1],
    };
  };
  let recoveryComparison = null;
  let diagnosisRuns = [];
  let diagnosis = null;
  if (compareRecovery) {
    const presets = [
      {
        name: "two-hypothesis",
        verificationHypothesisCount: 2,
        supplementalVerificationLocationCount: 2,
        maximumOperationAlternatives: 1,
      },
      {
        name: "three-hypothesis-two-locations",
        verificationHypothesisCount: 3,
        supplementalVerificationLocationCount: 2,
        maximumOperationAlternatives: 2,
      },
      {
        name: "three-hypothesis-one-location",
        verificationHypothesisCount: 3,
        supplementalVerificationLocationCount: 1,
        maximumOperationAlternatives: 2,
      },
    ];
    const runsByPreset = Object.fromEntries(presets.map((preset) => [preset.name, []]));
    const applyPreset = ({ name: _name, ...config }) => {
      Object.assign(recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG, config);
    };
    for (const preset of presets) {
      applyPreset(preset);
      runDiagnosis();
    }
    for (let round = 0; round < repeat; round += 1) {
      const ordered = [
        ...presets.slice(round % presets.length),
        ...presets.slice(0, round % presets.length),
      ];
      for (const preset of ordered) {
        applyPreset(preset);
        const diagnosisStarted = performance.now();
        diagnosis = runDiagnosis();
        runsByPreset[preset.name].push(performance.now() - diagnosisStarted);
      }
    }
    recoveryComparison = Object.fromEntries(presets.map((preset) => {
      const summary = summarizeRuns(runsByPreset[preset.name]);
      return [preset.name, {
        ...preset,
        diagnosisMs: Math.round(summary.diagnosisMs),
        diagnosisRunsMs: summary.diagnosisRunsMs.map(Math.round),
        diagnosisMinMs: Math.round(summary.diagnosisMinMs),
        diagnosisMaxMs: Math.round(summary.diagnosisMaxMs),
      }];
    }));
    Object.assign(recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG, originalRecoveryConfig);
    diagnosisRuns = runsByPreset["three-hypothesis-one-location"];
  } else {
    for (let run = 0; run < repeat; run += 1) {
      const diagnosisStarted = performance.now();
      diagnosis = runDiagnosis();
      diagnosisRuns.push(performance.now() - diagnosisStarted);
    }
  }
  const runSummary = summarizeRuns(diagnosisRuns);

  console.log(JSON.stringify({
    file: absolutePath,
    bytes: text.length,
    series: parsed.data.size,
    target: selectedTarget,
    exampleTarget: selectedTarget,
    recoveryConfig: {
      verificationHypothesisCount:
        recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.verificationHypothesisCount,
      primaryDecisionHypothesisCount:
        recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.primaryDecisionHypothesisCount,
      verificationLocationCount:
        recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.verificationLocationCount,
      supplementalVerificationLocationCount:
        recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG
          .supplementalVerificationLocationCount,
      maximumOperationAlternatives:
        recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.maximumOperationAlternatives,
      locationsPerSignal:
        recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.locationsPerSignal,
      maximumSignalLocationChoices:
        recoveryModule.DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.maximumSignalLocationChoices,
    },
    ...(recoveryComparison ? { recoveryComparison } : {}),
    parseMs: Math.round(parseMs),
    diagnosisMs: Math.round(runSummary.diagnosisMs),
    diagnosisRunsMs: diagnosisRuns.map(Math.round),
    diagnosisMinMs: Math.round(runSummary.diagnosisMinMs),
    diagnosisMaxMs: Math.round(runSummary.diagnosisMaxMs),
    diagnosedSeries: diagnosis.seriesCount,
    events: diagnosis.eventCount,
    candidates: diagnosis.candidateCount,
    eventDetails: diagnosis.events.map((event) => ({
      type: event.eventType,
      range: [event.startYear, event.endYear],
      topYear: event.rankedYears[0]?.year ?? null,
      sources: event.evidence.algorithmSources,
    })),
  }, null, 2));
} finally {
  await server.close();
}
