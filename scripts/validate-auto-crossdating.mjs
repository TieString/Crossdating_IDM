import path from "node:path";
import { createServer } from "vite";

const START_YEAR = 1900;
const END_YEAR = 2050;
const TARGET_TREE = "TGT";
const REFERENCE_TREES = ["REF1", "REF2", "REF3"];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function baseWidth(year) {
  const t = year - START_YEAR;
  const narrowPulse = [1931, 1965, 1990, 2027].includes(year) ? -320 : 0;
  return Math.round(
    1000
    + 260 * Math.sin(t * 0.31)
    + 170 * Math.cos(t * 0.073)
    + 95 * Math.sin(t * 0.83)
    + narrowPulse,
  );
}

function makeTree(startYear = START_YEAR, endYear = END_YEAR, offset = 0) {
  const tree = new Map();
  for (let year = startYear; year <= endYear; year += 1) {
    const shapeOffset = Math.round(18 * Math.sin((year - startYear + offset) * 0.19));
    tree.set(year, Math.max(80, baseWidth(year) + shapeOffset));
  }
  return tree;
}

function cloneTree(tree) {
  return new Map(tree);
}

function makeSite(targetTree) {
  return new Map([
    ["REF1", makeTree(START_YEAR, END_YEAR, 0)],
    ["REF2", makeTree(START_YEAR, END_YEAR, 3)],
    ["REF3", makeTree(START_YEAR, END_YEAR, 7)],
    [TARGET_TREE, targetTree],
  ]);
}

function makeReferenceConfig() {
  return {
    selectedTrees: REFERENCE_TREES,
    minSampleDepth: 2,
    method: "mean",
    updatedAt: "synthetic-demo",
  };
}

function findTargetSummary(diagnosis) {
  const summary = diagnosis.summaries.find((item) => item.tree === TARGET_TREE);
  assert(summary, "missing target summary");
  return summary;
}

function findCandidate(diagnosis, predicate, label) {
  const candidate = diagnosis.candidates.find((item) => item.targetTree === TARGET_TREE && predicate(item));
  assert(candidate, `expected ${label} candidate; got ${diagnosis.candidates.map((item) => `${item.targetTree}:${item.candidateType}:${item.mode ?? ""}:${item.deltaYears ?? ""}`).join(", ")}`);
  return candidate;
}

function applyCandidate(editor, candidate) {
  if (candidate.operationType === "INSERT_MISSING_RING") {
    editor.insertMissingYearAtSide(candidate.targetTree, candidate.targetYear, candidate.side);
    return;
  }
  if (candidate.operationType === "DELETE_FALSE_RING") {
    editor.deleteYearWithMode(candidate.targetTree, candidate.targetYear, "direct", candidate.side);
    return;
  }
  if (candidate.operationType === "SHIFT_RANGE") {
    editor.moveSeriesTailByOffset(
      candidate.targetTree,
      candidate.selectedRange.startYear,
      candidate.selectedRange.endYear,
      candidate.deltaYears,
    );
    return;
  }
  throw new Error(`unsupported candidate operation: ${candidate.operationType}`);
}

function makePartialRangeError(trueTree, gapStartYear, gapEndYear) {
  const gapLength = gapEndYear - gapStartYear + 1;
  const current = new Map();

  trueTree.forEach((width, year) => {
    if (year < gapStartYear) {
      current.set(year + gapLength, width);
    } else if (year > gapEndYear) {
      current.set(year, width);
    }
  });

  return current;
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
    const diagnosisModule = await server.ssrLoadModule("/src/features/crossdating/diagnosis.ts");
    const editModule = await server.ssrLoadModule("/src/features/rwl/edit.ts");

    const options = {
      referenceConfig: makeReferenceConfig(),
      segmentLength: 40,
      overlap: 20,
      lagMin: -8,
      lagMax: 8,
      lowCorrelationThreshold: 0.45,
      lagImprovementThreshold: 0.06,
      maxTopCandidates: 8,
    };

    const trueTarget = makeTree();
    const normalDiagnosis = diagnosisModule.diagnoseCrossdating(makeSite(cloneTree(trueTarget)), options);
    assert(findTargetSummary(normalDiagnosis).flaggedSegmentCount === 0, "normal aligned target should have no abnormal segment");

    const missingTree = editModule.deleteYearWithMode(cloneTree(trueTarget), 1990, "direct", "right");
    const missingDiagnosis = diagnosisModule.diagnoseCrossdating(makeSite(missingTree), options);
    const missingCandidate = findCandidate(
      missingDiagnosis,
      (candidate) => candidate.candidateType === "insertMissingYear",
      "insertMissingYear",
    );
    assert(missingCandidate.targetYear !== undefined, "missing-ring candidate should include targetYear");
    assert(missingCandidate.evidence.after.problemSegmentCount <= missingCandidate.evidence.before.problemSegmentCount, "insert candidate should not worsen problem count");
    assert(
      missingDiagnosis.propagationPatterns.some((pattern) => pattern.targetTree === TARGET_TREE && pattern.patternType === "possibleMissingYear"),
      "missing-ring case should expose propagation pattern",
    );
    assert(
      missingDiagnosis.candidates.filter((candidate) => candidate.targetTree === TARGET_TREE && candidate.candidateType === "insertMissingYear").length <= 1,
      "missing-ring propagation should not create one insert candidate per abnormal window",
    );

    const falseTree = editModule.insertMissingYearAtSide(cloneTree(trueTarget), 1965, "right");
    falseTree.set(1965, Math.round((trueTarget.get(1965) ?? 800) * 0.45));
    const falseDiagnosis = diagnosisModule.diagnoseCrossdating(makeSite(falseTree), options);
    const falseCandidate = findCandidate(
      falseDiagnosis,
      (candidate) => candidate.candidateType === "deleteFalseYear",
      "deleteFalseYear",
    );
    assert(falseCandidate.evidence.deletedValue !== undefined, "delete candidate should keep deletedValue evidence");

    const wholeMoveTree = editModule.moveSeriesTailByOffset(cloneTree(trueTarget), START_YEAR, END_YEAR, 4);
    const wholeDiagnosis = diagnosisModule.diagnoseCrossdating(makeSite(wholeMoveTree), options);
    const wholeCandidate = findCandidate(
      wholeDiagnosis,
      (candidate) => candidate.candidateType === "batchMoveYears" && candidate.mode === "wholeSeriesMove",
      "batchMoveYears wholeSeriesMove",
    );
    assert(Math.abs(wholeCandidate.deltaYears) === 4, "wholeSeriesMove should carry the detected deltaYears");
    assert(wholeCandidate.selectedRange.startYear === START_YEAR + 4, "wholeSeriesMove selectedRange should cover current shifted series");

    const partialTree = makePartialRangeError(cloneTree(trueTarget), 1961, 1965);
    const partialDiagnosis = diagnosisModule.diagnoseCrossdating(makeSite(partialTree), options);
    const partialCandidate = findCandidate(
      partialDiagnosis,
      (candidate) => candidate.candidateType === "batchMoveYears" && candidate.mode === "partialRangeMove",
      "batchMoveYears partialRangeMove",
    );
    assert(partialCandidate.selectedRange, "partialRangeMove should include selectedRange");
    assert(partialCandidate.missingRange, "partialRangeMove should include missingRange");
    assert(partialCandidate.deltaYears, "partialRangeMove should include deltaYears");

    const editor = new editModule.RwlEditor(makeSite(missingTree));
    const staleCandidates = diagnosisModule.markCandidatesStale(missingDiagnosis.candidates);
    assert(staleCandidates.length > 0 && staleCandidates.every((candidate) => candidate.status === "stale"), "candidate staleness should mark old candidates stale");
    const beforeProblems = findTargetSummary(missingDiagnosis).flaggedSegmentCount;
    applyCandidate(editor, missingCandidate);
    const afterDiagnosis = diagnosisModule.diagnoseCrossdating(editor.getData(), options);
    const afterProblems = findTargetSummary(afterDiagnosis).flaggedSegmentCount;
    assert(afterProblems <= beforeProblems, "applying accepted candidate should update working series and allow re-diagnosis");

    console.log("auto-crossdating validation passed");
    console.log(`normal target problems: ${findTargetSummary(normalDiagnosis).flaggedSegmentCount}`);
    console.log(`missing candidate: ${missingCandidate.label} @ ${missingCandidate.targetYear}, stale checked: ${staleCandidates.length}`);
    console.log(`false candidate: ${falseCandidate.label} @ ${falseCandidate.targetYear}, deletedValue=${falseCandidate.evidence.deletedValue}`);
    console.log(`whole move: delta=${wholeCandidate.deltaYears}, selected=${wholeCandidate.selectedRange.startYear}-${wholeCandidate.selectedRange.endYear}`);
    console.log(`partial move: delta=${partialCandidate.deltaYears}, selected=${partialCandidate.selectedRange.startYear}-${partialCandidate.selectedRange.endYear}, missing=${partialCandidate.missingRange.startYear}-${partialCandidate.missingRange.endYear}`);
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
