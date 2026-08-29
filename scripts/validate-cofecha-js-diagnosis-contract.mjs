import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { runCofecha } from "cofecha-js";
import { createServer } from "vite";

const rootArgument = process.argv.find((argument) => argument.startsWith("--root="));
const fixtureRoot = rootArgument?.slice("--root=".length) || process.env.COFECHA_PARITY_ROOT;
const casesArgument = process.argv.find((argument) => argument.startsWith("--cases="));
const casesDirectory = casesArgument?.slice("--cases=".length);

if (!fixtureRoot && !casesDirectory) {
  throw new Error("Pass --root=PATH, --cases=PATH, or set COFECHA_PARITY_ROOT.");
}

const normalizeId = (value) => value.trim().toUpperCase();
const sortedEntries = (map) => Array.from(map.entries()).sort(([left], [right]) => (
  String(left).localeCompare(String(right))
));
const sameEntries = (left, right) => JSON.stringify(sortedEntries(left)) === JSON.stringify(sortedEntries(right));
const sameStrings = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

const collectPairs = (directory) => {
  const pairs = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      pairs.push(...collectPairs(fullPath));
      continue;
    }
    if (path.extname(entry.name).toLowerCase() !== ".out") continue;
    const rwlPath = fullPath.slice(0, -path.extname(fullPath).length) + ".rwl";
    if (existsSync(rwlPath)) {
      pairs.push({ outPath: fullPath, rwlPath });
    }
  }
  return pairs.sort((left, right) => left.rwlPath.localeCompare(right.rwlPath));
};

const collectManifestPairs = (directory) => readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".json")
  .map((entry) => ({
    label: path.basename(entry.name, path.extname(entry.name)),
    audit: JSON.parse(readFileSync(path.join(directory, entry.name), "utf8")),
  }))
  .filter(({ audit }) => (
    typeof audit.rwlPath === "string"
    && typeof audit.outPath === "string"
    && audit.part1?.expected?.masterTimeSpan !== null
  ))
  .map(({ label, audit }) => ({ label, rwlPath: audit.rwlPath, outPath: audit.outPath }))
  .filter(({ rwlPath, outPath }) => existsSync(rwlPath) && existsSync(outPath))
  .sort((left, right) => left.rwlPath.localeCompare(right.rwlPath));

const compareResult = (official, generated, officialFlags, generatedFlags) => {
  const checks = {
    masterSeriesYear: official.masterSeriesYear === generated.masterSeriesYear,
    seriesIntercorrelation: official.seriesIntercorrelation === generated.seriesIntercorrelation,
    averageMeanSensitivity: official.averageMeanSensitivity === generated.averageMeanSensitivity,
    meanLength: official.meanLength === generated.meanLength,
    possibleProblemsCount: official.possibleProblemsCount === generated.possibleProblemsCount,
    masterDatingSeries: sameEntries(official.masterDatingSeries, generated.masterDatingSeries),
    masterCorrelations: sameEntries(official.masterCorrelations, generated.masterCorrelations),
    seriesProblemCounts: sameEntries(official.seriesProblemCounts, generated.seriesProblemCounts),
    possibleProblemSeries: sameStrings(
      Array.from(official.possibleProblemsDetail.keys(), normalizeId),
      Array.from(generated.possibleProblemsDetail.keys(), normalizeId),
    ),
    part6FlaggedSeries: sameStrings(officialFlags.map(normalizeId), generatedFlags.map(normalizeId)),
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
  };
};

const server = await createServer({
  configFile: false,
  appType: "custom",
  logLevel: "error",
  resolve: { alias: { "@": path.join(process.cwd(), "src") } },
  optimizeDeps: { noDiscovery: true },
  server: {
    hmr: { port: 20_000 + Math.floor(Math.random() * 20_000) },
    middlewareMode: true,
  },
});

try {
  const formatter = await server.ssrLoadModule("/src/features/cofecha/formatter.ts");
  const pairs = casesDirectory
    ? collectManifestPairs(path.resolve(casesDirectory))
    : collectPairs(path.resolve(fixtureRoot));
  if (pairs.length === 0) {
    throw new Error(`No matching .rwl/.OUT pairs found under ${casesDirectory ?? fixtureRoot}`);
  }

  const cases = pairs.map(({ label, outPath, rwlPath }) => {
    const inputText = readFileSync(rwlPath, "utf8");
    const officialOut = readFileSync(outPath, "utf8");
    const baseName = path.basename(rwlPath);
    const artifacts = runCofecha({
      input: { format: "tucson-rwl", text: inputText, fileName: baseName },
      options: { masterOutput: "N" },
      metadata: {
        jobName: path.basename(rwlPath, path.extname(rwlPath)).slice(0, 8).toUpperCase() || "VERIFY",
        runAt: "2026-08-30T00:00:00.000Z",
      },
    });
    const officialParts = formatter.splitReportByParts(officialOut);
    const generatedParts = formatter.splitReportByParts(artifacts.outText);
    const comparison = compareResult(
      formatter.parseCofechaResult(officialOut),
      formatter.parseCofechaResult(artifacts.outText),
      formatter.extractPart6FlaggedASeriesIds(officialParts.get("PART 6") ?? ""),
      formatter.extractPart6FlaggedASeriesIds(generatedParts.get("PART 6") ?? ""),
    );
    return {
      file: label ?? baseName,
      passed: comparison.passed,
      failedFields: Object.entries(comparison.checks)
        .filter(([, passed]) => !passed)
        .map(([field]) => field),
    };
  });
  const passed = cases.filter((item) => item.passed).length;
  const result = {
    package: "cofecha-js@0.1.0",
    fixtureSource: path.resolve(casesDirectory ?? fixtureRoot),
    files: cases.length,
    passed,
    failed: cases.length - passed,
    cases,
  };
  console.log(JSON.stringify(result, null, 2));
  if (passed !== cases.length) process.exitCode = 1;
} finally {
  await server.close();
}
