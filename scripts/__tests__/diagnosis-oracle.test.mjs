import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "analyze-diagnosis-oracle.mjs",
);

const event = (year, source = "bounded") => ({
    eventType: "missingRing",
    startYear: year - 6,
    endYear: year + 6,
    topYear: year,
    score: 10,
    algorithmSources: [source],
});

test("attributes oracle availability to the correct pipeline layer", () => {
    const runDir = mkdtempSync(join(tmpdir(), "diagnosis-oracle-"));
    const outputDir = join(runDir, "analysis");
    const steps = [];
    const writeAttempt = ({ index, correct = false, layer = "none", clean = false }) => {
        const caseDir = join(runDir, "workers", "worker-0", `case-${index}-step-1`);
        mkdirSync(caseDir, { recursive: true });
        steps.push({
            caseIndex: index,
            caseId: `case-${index}`,
            step: 1,
            family: clean ? "Clean" : "A",
            fileId: "file-a",
            targetId: `target-${index}`,
            diagnosedTruthType: clean ? "" : "missingRing",
            diagnosedTruthYear: clean ? "" : 1900,
            diagnosedTruthShiftYears: clean ? "" : -1,
            workflowSuggestionCorrect: correct,
            response: correct,
            stopReason: correct ? "" : "window_miss",
        });
        const audit = {
            candidateProjectedEvents: layer === "stage" ? [event(1900)] : [],
            detectedBeforeFusion: [],
            detectedAfterFusion: [],
            retainedAfterEndpointGuard: [],
            displayedBeforeLocator: [],
            finalEvents: layer === "final" ? [event(1900)] : [],
            stableBoundedPathEvidence: null,
            positiveUnitChainEvidence: null,
        };
        const hypotheses = layer === "joint" ? [event(1900)] : [];
        const gridEvents = layer === "grid" || clean ? [event(1900)] : [];
        writeFileSync(join(caseDir, "diagnosis-audit.json"), JSON.stringify({
            after: {
                audit,
                operationGrid: {
                    jointDecision: { hypotheses },
                    boundedRawPath: { events: gridEvents },
                },
            },
        }));
    };
    writeAttempt({ index: 1, correct: true });
    writeAttempt({ index: 2, layer: "final" });
    writeAttempt({ index: 3, layer: "joint" });
    writeAttempt({ index: 4, layer: "stage" });
    writeAttempt({ index: 5, layer: "grid" });
    writeAttempt({ index: 6 });
    writeAttempt({ index: 7, clean: true });
    writeFileSync(join(runDir, "steps.json"), JSON.stringify(steps));

    const result = spawnSync(process.execPath, [
        scriptPath,
        `--run-dir=${runDir}`,
        `--output-dir=${outputDir}`,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
    assert.deepEqual(summary.overall.categories, {
        evidence_projection_loss: 1,
        joint_selection_loss: 1,
        no_complete_hypothesis: 1,
        pipeline_rewrite_loss: 1,
        post_final_loss: 1,
        product_correct: 1,
    });
    assert.equal(summary.overall.strictOracleAccuracy, 5 / 6);
    assert.deepEqual(summary.clean, {
        attempts: 1,
        productFalsePositives: 0,
        stageHypothesisCases: 0,
        jointHypothesisCases: 0,
        gridHypothesisCases: 1,
    });
    rmSync(runDir, { recursive: true, force: true });
});
