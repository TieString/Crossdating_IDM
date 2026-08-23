import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const roles = ["development", "calibration", "final-holdout"];
const expectedFiles = { development: 18, calibration: 10, "final-holdout": 17 };
const expectedTargets = { development: 108, calibration: 60, "final-holdout": 102 };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("freezes disjoint unseen high-quality RWL files before final evaluation", () => {
    const old = JSON.parse(readFileSync(resolve(
        root,
        "docs/benchmarks/itrdb-operation-capability-paper-v4-1000-holdout-config.json",
    ), "utf8"));
    const oldIds = new Set(old.fileIds.map((fileId) => fileId.toLowerCase()));
    const idsByRole = new Map();
    roles.forEach((role) => {
        const prefix = resolve(
            root,
            `docs/benchmarks/itrdb-unified-adjudicator-v2-${role}`,
        );
        const configBytes = readFileSync(`${prefix}-config.json`);
        const config = JSON.parse(configBytes.toString("utf8"));
        const manifest = JSON.parse(readFileSync(`${prefix}-manifest.json`, "utf8"));
        const ids = new Set(config.fileIds.map((fileId) => fileId.toLowerCase()));
        idsByRole.set(role, ids);
        assert.equal(ids.size, expectedFiles[role]);
        assert.equal(manifest.configSha256, digest(configBytes));
        assert.deepEqual(ids, new Set(manifest.files.map((file) => file.fileId.toLowerCase())));
        assert.equal(
            manifest.files.reduce((sum, file) => sum + file.eligibleTargets.length, 0),
            expectedTargets[role],
        );
        manifest.files.forEach((file) => {
            assert.ok(file.seriesIntercorrelation >= 0.8);
            assert.equal(file.possibleProblemSegments, 0);
            assert.equal(file.eligibleTargets.length, 6);
            assert.ok(!oldIds.has(file.fileId.toLowerCase()));
            file.eligibleTargets.forEach((target) => {
                assert.ok(target.seriesYears >= 200);
                assert.ok(target.masterCorrelation >= 0.8);
                assert.equal(target.problemSegments, 0);
            });
        });
    });
    for (let left = 0; left < roles.length; left += 1) {
        for (let right = left + 1; right < roles.length; right += 1) {
            const overlap = [...idsByRole.get(roles[left])]
                .filter((fileId) => idsByRole.get(roles[right]).has(fileId));
            assert.deepEqual(overlap, []);
        }
    }

    const frozen = JSON.parse(readFileSync(resolve(
        root,
        "docs/benchmarks/itrdb-unified-adjudicator-v2-frozen-split.json",
    ), "utf8"));
    const reserveIds = new Set(frozen.files
        .filter((file) => file.role === "reserve")
        .map((file) => file.fileId.toLowerCase()));
    const reserveConfigPath = resolve(
        root,
        "docs/benchmarks/itrdb-unified-adjudicator-v2-reserve-calibration-config.json",
    );
    const reserveManifestPath = resolve(
        root,
        "docs/benchmarks/itrdb-unified-adjudicator-v2-reserve-calibration-manifest.json",
    );
    const reserveConfigBytes = readFileSync(reserveConfigPath);
    const reserveConfig = JSON.parse(reserveConfigBytes.toString("utf8"));
    const reserveManifest = JSON.parse(readFileSync(reserveManifestPath, "utf8"));
    assert.deepEqual(
        new Set(reserveConfig.fileIds.map((fileId) => fileId.toLowerCase())),
        reserveIds,
    );
    assert.equal(reserveIds.size, 12);
    assert.equal(reserveManifest.configSha256, digest(reserveConfigBytes));
    assert.equal(
        reserveManifest.files.reduce(
            (sum, file) => sum + file.eligibleTargets.length,
            0,
        ),
        72,
    );
    reserveManifest.files.forEach((file) => {
        assert.ok(file.seriesIntercorrelation >= 0.8);
        assert.equal(file.possibleProblemSegments, 0);
    });
});
