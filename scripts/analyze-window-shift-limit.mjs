import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Pass an ITRDB frozen-audit log");

const text = readFileSync(path, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
const markerJson = (marker) => {
    const markerStart = text.indexOf(marker);
    if (markerStart < 0) throw new Error(`Missing marker: ${marker}`);
    const line = text.slice(markerStart + marker.length).split(/\r?\n/, 1)[0];
    const start = line.indexOf("[");
    return JSON.parse(line.slice(start, line.lastIndexOf("]") + 1));
};

const noteValue = (notes, prefix) => {
    const note = notes.find((value) => value.startsWith(prefix));
    if (!note) return null;
    const value = Number(note.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const windowBefore = (notes) => {
    const note = notes.find((value) => value.startsWith("window_before="));
    const match = note?.match(/=(-?\d+)-(-?\d+)$/);
    return match ? [Number(match[1]), Number(match[2])] : null;
};

const rows = new Map();
const add = (seriesId, eventType, truthYear, range, notes) => {
    const reason = notes.find((value) => value.startsWith("window_refinement="))?.slice(18);
    const before = windowBefore(notes);
    const scanYear = noteValue(notes, "scan_top_year=");
    if (!reason || !before || scanYear === null) return;
    const key = [seriesId, eventType, truthYear].join(":");
    rows.set(key, {
        seriesId,
        eventType,
        truthYear,
        range,
        notes,
        reason,
        before,
        scanYear,
        candidateYear: noteValue(notes, "candidate_top_year="),
    });
};

for (const row of markerJson("ITRDB RANKING CASES ")) {
    add(row.seriesId, row.eventType, row.truthYear, row.range, row.notes);
}
for (const failure of markerJson("ITRDB FROZEN FAILURES ")) {
    const prediction = failure.predictions.find((row) => row.type === failure.eventType);
    if (prediction) {
        add(
            failure.target,
            failure.eventType,
            failure.truthYear,
            prediction.range,
            prediction.notes ?? [],
        );
    }
}

const contains = (range, year) => year >= range[0] && year <= range[1];
for (const strategy of ["scan", "extremeCandidate"]) {
for (const maximumShift of [1, 2, 3, 4, 5, 6, 7]) {
    const reports = new Map();
    for (const row of rows.values()) {
        const candidateCanExtend = strategy === "extremeCandidate"
            && row.reason === "candidate_corroborated_edge"
            && row.candidateYear !== null
            && Math.abs(row.candidateYear - row.scanYear) <= 2
            && ((row.scanYear < row.before[0] && row.candidateYear < row.scanYear)
                || (row.scanYear > row.before[1] && row.candidateYear > row.scanYear));
        const targetYear = candidateCanExtend ? row.candidateYear : row.scanYear;
        const outsideDistance = targetYear < row.before[0]
            ? row.before[0] - targetYear
            : targetYear > row.before[1]
                ? targetYear - row.before[1]
                : 0;
        if (outsideDistance === 0) continue;
        const direction = targetYear < row.before[0] ? -1 : 1;
        const shift = Math.min(outsideDistance, maximumShift);
        const proposed = [
            row.before[0] + direction * shift,
            row.before[1] + direction * shift,
        ];
        const key = `${row.eventType}:${row.reason}`;
        const report = reports.get(key) ?? {
            eventType: row.eventType,
            reason: row.reason,
            eligible: 0,
            currentHits: 0,
            proposedHits: 0,
            gained: 0,
            lost: 0,
        };
        const currentHit = contains(row.range, row.truthYear);
        const proposedHit = contains(proposed, row.truthYear);
        report.eligible += 1;
        report.currentHits += Number(currentHit);
        report.proposedHits += Number(proposedHit);
        report.gained += Number(!currentHit && proposedHit);
        report.lost += Number(currentHit && !proposedHit);
        reports.set(key, report);
    }
    console.log(JSON.stringify({ strategy, maximumShift, reports: Array.from(reports.values()) }));
}
}
