import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error("Pass one or more counterfactual locator audit JSON paths");
}

const WIDTH = 13;

const contains = (window, year) => (
    window && year >= window.startYear && year <= window.endYear
);

const bestMassWindow = (years, values) => {
    if (!Array.isArray(values) || values.length !== years.length) return null;
    if (years.length < WIDTH) return null;
    let mass = values.slice(0, WIDTH).reduce((sum, value) => sum + value, 0);
    let bestMass = mass;
    let bestIndex = 0;
    for (let index = 1; index <= years.length - WIDTH; index += 1) {
        mass += values[index + WIDTH - 1] - values[index - 1];
        if (mass > bestMass) {
            bestMass = mass;
            bestIndex = index;
        }
    }
    return {
        startYear: years[bestIndex],
        endYear: years[bestIndex + WIDTH - 1],
        centerYear: years[bestIndex + Math.floor(WIDTH / 2)],
        mass: bestMass,
    };
};

const familyFor = (name) => {
    if (name.startsWith("cumulativeReference")) return "cumulativeReference";
    if (name.startsWith("cumulative")) return "cumulative";
    if (name.startsWith("reference:")) return "referenceTransition";
    if (name.startsWith("pairFixed")) return "pairFixedLag";
    if (name.startsWith("pairLag")) return "pairAdaptiveLag";
    if (name.startsWith("pair")) return "pairCounterfactual";
    if (name.startsWith("localSide")) return "localSide";
    if (["rawFull", "differenceFull", "comboFull", "whitenedFull"].includes(name)) {
        return "fullCorrection";
    }
    if (["sideStepScore", "sideMinimumAdvantage", "correctedSideSupport", "jointOperationMargin"].includes(name)) {
        return "operation";
    }
    if (["piecewiseCombinedObjective", "transitionSplitGain"].includes(name)) {
        return "changePoint";
    }
    return "other";
};

const summarize = (rows) => {
    const profileStats = new Map();
    const familyStats = new Map();
    const cases = [];
    for (const row of rows) {
        const profileWindows = Object.entries(row.ranks ?? {}).flatMap(([name, values]) => {
            const window = bestMassWindow(row.years, values);
            if (!window) return [];
            const hit = contains(window, row.truthYear);
            const stats = profileStats.get(name) ?? { cases: 0, hits: 0 };
            stats.cases += 1;
            stats.hits += Number(hit);
            profileStats.set(name, stats);
            return [{ name, family: familyFor(name), window, hit }];
        });
        const byFamily = new Map();
        profileWindows.forEach((profile) => {
            const family = byFamily.get(profile.family) ?? [];
            family.push(profile);
            byFamily.set(profile.family, family);
        });
        byFamily.forEach((profiles, family) => {
            const stats = familyStats.get(family) ?? {
                cases: 0,
                oracleHits: 0,
                consensusHits: 0,
            };
            const centers = profiles.map((profile) => profile.window.centerYear);
            const consensusCenter = centers.reduce((best, center) => {
                const votes = centers.filter((candidate) => (
                    Math.abs(candidate - center) <= Math.floor(WIDTH / 2)
                )).length;
                const bestVotes = centers.filter((candidate) => (
                    Math.abs(candidate - best) <= Math.floor(WIDTH / 2)
                )).length;
                return votes > bestVotes || (votes === bestVotes && center > best)
                    ? center
                    : best;
            }, centers[0]);
            const consensusWindow = {
                startYear: consensusCenter - Math.floor(WIDTH / 2),
                endYear: consensusCenter + Math.floor(WIDTH / 2),
            };
            stats.cases += 1;
            stats.oracleHits += Number(profiles.some((profile) => profile.hit));
            stats.consensusHits += Number(contains(consensusWindow, row.truthYear));
            familyStats.set(family, stats);
        });
        const currentWindow = row.modeWindow ?? row.finalWindow;
        const currentHit = contains(currentWindow, row.truthYear);
        const profileHits = profileWindows.filter((profile) => profile.hit);
        cases.push({
            file: row.context.file,
            target: row.context.target,
            truthYear: row.truthYear,
            currentWindow,
            finalWindow: row.finalWindow,
            coarseWindow: row.coarseWindow,
            currentHit,
            finalHit: contains(row.finalWindow, row.truthYear),
            coarseHit: contains(row.coarseWindow, row.truthYear),
            profileOracleHit: profileHits.length > 0,
            profileHitCount: profileHits.length,
            profileHits: profileHits.map((profile) => profile.name),
            candidateUnionHit: (row.candidates ?? []).some((candidate) => (
                contains(candidate, row.truthYear)
            )),
        });
    }
    const count = rows.length;
    return {
        cases: count,
        currentHits: cases.filter((row) => row.currentHit).length,
        finalHits: cases.filter((row) => row.finalHit).length,
        coarseHits: cases.filter((row) => row.coarseHit).length,
        candidateUnionHits: cases.filter((row) => row.candidateUnionHit).length,
        profileOracleHits: cases.filter((row) => row.profileOracleHit).length,
        profiles: [...profileStats.entries()]
            .map(([name, stats]) => ({ name, ...stats }))
            .sort((left, right) => right.hits - left.hits || left.name.localeCompare(right.name)),
        families: Object.fromEntries([...familyStats.entries()].map(([name, stats]) => [
            name,
            stats,
        ])),
        currentMisses: cases.filter((row) => !row.currentHit),
    };
};

const report = {};
for (const path of paths) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    const rows = (payload.counterfactualLocatorCases ?? []).filter((row) => (
        row.eventType === "missingRing"
        && row.correctionYears === row.truthCorrectionYears
        && row.context?.baselineFlagged === false
        && row.finalWindow
    ));
    report[path] = summarize(rows);
}

process.stdout.write(`${JSON.stringify({ report }, null, 2)}\n`);
