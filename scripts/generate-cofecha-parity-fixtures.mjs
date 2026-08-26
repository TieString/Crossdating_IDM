import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const outputDir = resolve(valueFor("--output-dir"));
mkdirSync(outputDir, { recursive: true });

const formatSeries = (id, values, startYear = 1800) => {
    const lines = [];
    for (let offset = 0; offset < values.length; offset += 10) {
        const year = startYear + offset;
        lines.push(
            id.padEnd(8, " ")
            + String(year).padStart(4, " ")
            + values.slice(offset, offset + 10)
                .map((value) => {
                    const rounded = Math.max(1, Math.round(value));
                    const safe = rounded === 999 || rounded === 9999
                        ? rounded + 2
                        : rounded;
                    return String(safe).padStart(6, " ");
                })
                .join(""),
        );
    }
    lines.push(
        id.padEnd(8, " ")
        + String(startYear + values.length).padStart(4, " ")
        + String(-9999).padStart(6, " "),
    );
    return lines.join("\r\n");
};

const width = (index, seriesIndex) => {
    const shared = 950
        + 170 * Math.sin(index * 0.41)
        + 85 * Math.cos(index * 0.17)
        + 55 * Math.sin(index * 1.07);
    const growth = 1.65 - 0.0032 * index + 0.000004 * index ** 2;
    const individual = 1
        + 0.08 * Math.sin(index * 0.071 + seriesIndex * 0.8)
        + 0.03 * Math.cos(index * 0.23 + seriesIndex);
    return shared * growth * individual * (0.72 + seriesIndex * 0.11);
};
const length = 200;
const oneValues = Array.from({ length }, (_, index) => width(index, 0));
const identical = Array.from({ length: 6 }, (_, seriesIndex) => ({
    id: `IDT00${seriesIndex + 1}`,
    values: oneValues.map((value) => value * (0.7 + seriesIndex * 0.12)),
}));
const varied = Array.from({ length: 6 }, (_, seriesIndex) => ({
    id: `VAR00${seriesIndex + 1}`,
    values: Array.from({ length }, (_, index) => width(index, seriesIndex)),
}));
const impulseSeries = (idPrefix, impulseIndex) => Array.from(
    { length: 12 },
    (_, seriesIndex) => ({
        id: `${idPrefix}${String(seriesIndex + 1).padStart(2, "0")}`,
        values: Array.from({ length }, (_, index) => {
            const independentJitter = 7 * Math.sin(
                index * (0.71 + seriesIndex * 0.013) + seriesIndex * 1.7,
            ) + 4 * Math.cos(index * 1.19 + seriesIndex * 0.41);
            return 1000
                + independentJitter
                + (index === impulseIndex ? 100 : 0);
        }),
    }),
);
const impulseCenter = impulseSeries("IMPC", 100);
const impulseNearEdge = impulseSeries("IMPE", 8);

const fixtures = {
    "single.rwl": formatSeries("SINGLE1", oneValues),
    "identical-six.rwl": identical.map((series) => (
        formatSeries(series.id, series.values)
    )).join("\r\n"),
    "varied-six.rwl": varied.map((series) => (
        formatSeries(series.id, series.values)
    )).join("\r\n"),
    "impulse-center-six.rwl": impulseCenter.map((series) => (
        formatSeries(series.id, series.values)
    )).join("\r\n"),
    "impulse-edge-six.rwl": impulseNearEdge.map((series) => (
        formatSeries(series.id, series.values)
    )).join("\r\n"),
};
Object.entries(fixtures).forEach(([name, text]) => {
    writeFileSync(resolve(outputDir, name), `${text}\r\n`, "ascii");
});
console.log(`COFECHA_PARITY_FIXTURES_COMPLETE ${JSON.stringify({
    outputDir,
    files: Object.keys(fixtures),
})}`);
