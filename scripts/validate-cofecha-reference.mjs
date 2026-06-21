import path from "node:path";
import { createServer } from "vite";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function makeSeries(startYear, endYear, phase = 0) {
  const series = new Map();
  for (let year = startYear; year <= endYear; year += 1) {
    const t = year - startYear;
    series.set(year, Math.round(950 + 80 * Math.sin((t + phase) * 0.25) + 35 * Math.cos((t + phase) * 0.11)));
  }
  return series;
}

function makeSite() {
  return new Map([
    ["REF1", makeSeries(1900, 1960, 0)],
    ["REF2", makeSeries(1900, 1960, 2)],
    ["REF3", makeSeries(1900, 1960, 4)],
    ["REF4", makeSeries(1900, 1960, 6)],
    ["REF5", makeSeries(1900, 1960, 8)],
    ["BAD1", makeSeries(1900, 1960, 10)],
    ["BAD2", makeSeries(1900, 1960, 12)],
  ]);
}

async function main() {
  const server = await createServer({
    configFile: false,
    appType: "custom",
    logLevel: "error",
    resolve: {
      alias: {
        "@": path.join(process.cwd(), "src"),
      },
    },
    optimizeDeps: { noDiscovery: true },
    server: {
      hmr: { port: 20_000 + Math.floor(Math.random() * 20_000) },
      middlewareMode: true,
    },
  });

  try {
    const formatter = await server.ssrLoadModule("/src/features/cofecha/formatter.ts");
    const reference = await server.ssrLoadModule("/src/features/crossdating/reference.ts");
    const siteData = makeSite();
    const part6 = `
PART 6: QUALITY CONTROL
========================================
BAD1 1900 to 1960  Series
  [A] Segment 1900 1949 low correlation
  [B] Best match offset +1
========================================
BAD2 1900 to 1960  Series
  [A] Segment 1910 1959 low correlation
========================================
`;

    const flaggedAIds = formatter.extractPart6FlaggedASeriesIds(part6);
    assert(flaggedAIds.length === 2 && flaggedAIds.includes("BAD1") && flaggedAIds.includes("BAD2"), "PART 6 A flags should be extracted via existing problem parser");

    const config = reference.createCofechaPassReferenceConfig({
      siteData,
      flaggedAIds,
      cofechaRunId: "test-run",
      rwlHash: reference.hashRwlSiteData(siteData),
    });
    const classification = config.classification;
    assert(classification.anchorPassIds.length === 5, "five no-A series should become anchor_pass");
    assert(classification.candidateFlaggedIds.length === 2, "two A-flagged series should become candidate_flagged");
    assert(!classification.anchorPassIds.includes("BAD1"), "A-flagged series must not enter anchor_pass");

    const dynamicSeries = reference.buildReferenceSeries(siteData, config);
    assert(dynamicSeries, "dynamic reference series should be generated");
    assert(dynamicSeries.mode === "dynamic", "reference series should be marked dynamic");
    assert(dynamicSeries.data.size > 0, "dynamic reference should contain points");

    const firstPoint = config.cofechaPassReference.points[0];
    assert(Number.isFinite(firstPoint.value), "reference point should include value");
    assert(Number.isFinite(firstPoint.replication), "reference point should include replication");
    assert(Number.isFinite(firstPoint.sd), "reference point should include sd");
    assert(Number.isFinite(firstPoint.se), "reference point should include se");
    assert(Number.isFinite(firstPoint.weight), "reference point should include weight");
    const referenceValues = config.cofechaPassReference.points.map((point) => point.value);
    assert(Math.abs(mean(referenceValues)) < 1e-9, "final master should be standardized to mean 0");
    assert(Math.abs(standardDeviation(referenceValues) - 1) < 1e-9, "final master should be standardized to sd 1");

    const targetSet = reference.getOffsetCheckTargetSet(config);
    assert(targetSet.candidateSeriesIds.length === 2, "offset target set should only contain candidate_flagged IDs");
    assert(!targetSet.candidateSeriesIds.some((id) => classification.anchorPassIds.includes(id)), "anchor_pass IDs should not enter offset target set");

    const smallConfig = reference.createCofechaPassReferenceConfig({
      siteData: new Map(Array.from(siteData.entries()).slice(0, 4)),
      flaggedAIds: [],
      cofechaRunId: "small-run",
      rwlHash: "small",
    });
    assert(!smallConfig.cofechaPassReference, "fewer than five anchor_pass series should not create a valid reference");
    assert(smallConfig.unavailableReason, "insufficient anchor_pass count should carry a UI reason");

    console.log("cofecha-pass reference validation passed");
    console.log(`anchor_pass=${classification.anchorPassIds.length}, candidate_flagged=${classification.candidateFlaggedIds.length}, points=${dynamicSeries.pointCount}`);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
