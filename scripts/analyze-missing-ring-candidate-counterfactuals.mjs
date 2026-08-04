import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error("Pass one or more candidate-counterfactual audit paths");
}

const WIDTH = 13;

const contains = (window, year) => (
    window && year >= window.startYear && year <= window.endYear
);

const mean = (values) => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;

const percentileRanks = (values) => values.map((selected) => (
    values.filter((value) => value < selected).length
        + 0.5 * values.filter((value) => value === selected).length
) / Math.max(1, values.length));

const bestWindow = (rows, profile, useRanks) => {
    const values = rows.map((row) => Number(row.profiles?.[profile] ?? -10));
    const scoredValues = useRanks ? percentileRanks(values) : values;
    if (rows.length < WIDTH) return null;
    let best = null;
    for (let start = 0; start <= rows.length - WIDTH; start += 1) {
        const inside = scoredValues.slice(start, start + WIDTH);
        const outside = [
            ...scoredValues.slice(0, start),
            ...scoredValues.slice(start + WIDTH),
        ];
        const rawInside = values.slice(start, start + WIDTH);
        const candidate = {
            startYear: rows[start].year,
            endYear: rows[start + WIDTH - 1].year,
            centerYear: rows[start + Math.floor(WIDTH / 2)].year,
            mass: inside.reduce((sum, value) => sum + value, 0),
            mean: mean(inside),
            rawMean: mean(rawInside),
            rawMaximum: Math.max(...rawInside),
            prominence: mean(inside) - mean(outside),
        };
        if (!best || candidate.mass > best.mass) best = candidate;
    }
    return best;
};

const select = (contexts, profile, mode, useRanks) => {
    const candidates = contexts.flatMap((context) => {
        const window = bestWindow(context.rows ?? [], profile, useRanks);
        return window ? [{ ...window, source: context.source }] : [];
    });
    if (candidates.length === 0) return null;
    return candidates.sort((left, right) => (
        right[mode] - left[mode]
        || right.rawMean - left.rawMean
        || right.centerYear - left.centerYear
    ))[0];
};

const reports = {};
for (const path of paths) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    const rows = (payload.counterfactualLocatorCases ?? []).filter((row) => (
        row.eventType === "missingRing"
        && row.correctionYears === row.truthCorrectionYears
        && row.context?.baselineFlagged === false
        && row.finalWindow
        && (row.coarseCandidateCounterfactuals?.length ?? 0) > 0
    ));
    const profileNames = [...new Set(rows.flatMap((row) => (
        row.coarseCandidateCounterfactuals.flatMap((context) => (
            context.rows.flatMap((source) => Object.keys(source.profiles ?? {}))
        ))
    )))];
    const policies = [];
    for (const profile of profileNames) {
        for (const useRanks of [false, true]) {
            for (const mode of ["mass", "mean", "rawMean", "rawMaximum", "prominence"]) {
                let hits = 0;
                let gains = 0;
                let losses = 0;
                const changes = [];
                rows.forEach((row) => {
                    const selected = select(
                        row.coarseCandidateCounterfactuals,
                        profile,
                        mode,
                        useRanks,
                    );
                    const oldHit = contains(row.modeWindow ?? row.finalWindow, row.truthYear);
                    const newHit = contains(selected, row.truthYear);
                    hits += Number(newHit);
                    gains += Number(newHit && !oldHit);
                    losses += Number(oldHit && !newHit);
                    if (oldHit !== newHit) {
                        changes.push({
                            file: row.context.file,
                            target: row.context.target,
                            truthYear: row.truthYear,
                            oldHit,
                            newHit,
                            selected,
                        });
                    }
                });
                policies.push({
                    profile,
                    useRanks,
                    mode,
                    cases: rows.length,
                    hits,
                    gains,
                    losses,
                    changes,
                });
            }
        }
    }
    policies.sort((left, right) => (
        right.hits - left.hits
        || left.losses - right.losses
        || left.profile.localeCompare(right.profile)
    ));
    reports[path] = {
        cases: rows.length,
        baselineModeHits: rows.filter((row) => (
            contains(row.modeWindow ?? row.finalWindow, row.truthYear)
        )).length,
        profiles: profileNames,
        policies,
    };
}

process.stdout.write(`${JSON.stringify({ reports }, null, 2)}\n`);
