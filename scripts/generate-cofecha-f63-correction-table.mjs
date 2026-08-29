import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name) => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : "";
};
const runtimePath = resolve(valueFor("--runtime-stages"));
const outputPath = resolve(valueFor("--output"));
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
const firstPasses = runtime.records
    .filter((record) => record.stage === "spline")
    .filter((_, index) => index % 2 === 0);
const rawValues = Array.from({ length: 9999 }, (_, value) => value)
    .filter((value) => value !== 999);
const negative = Buffer.alloc(Math.ceil(10000 / 8));
const positive = Buffer.alloc(Math.ceil(10000 / 8));
const floatBuffer = new ArrayBuffer(4);
const floatView = new Float32Array(floatBuffer);
const bitsView = new Uint32Array(floatBuffer);
const bits = (value) => {
    floatView[0] = value;
    return bitsView[0];
};
let cursor = 0;
for (const record of firstPasses) {
    for (const parsedValue of record.input) {
        const rawValue = rawValues[cursor];
        cursor += 1;
        if (rawValue === undefined) continue;
        const baseline = Math.fround(rawValue / 1000);
        const delta = bits(parsedValue) - bits(baseline);
        if (delta === -1) negative[rawValue >> 3] |= 1 << (rawValue & 7);
        else if (delta === 1) positive[rawValue >> 3] |= 1 << (rawValue & 7);
        else if (delta !== 0) throw new Error(`unexpected ULP delta ${delta} for ${rawValue}`);
    }
}
if (cursor < rawValues.length) {
    throw new Error(`incomplete parser grid: ${cursor}/${rawValues.length}`);
}

const source = `/** Generated from the Microsoft FORTRAN F6.3 reader used by COFECHA 6.06. */
const NEGATIVE_ULP_BASE64 = "${negative.toString("base64")}";
const POSITIVE_ULP_BASE64 = "${positive.toString("base64")}";

const decodeBits = (encoded: string): Uint8Array => Uint8Array.from(
    atob(encoded),
    (character) => character.charCodeAt(0),
);
const negativeUlp = decodeBits(NEGATIVE_ULP_BASE64);
const positiveUlp = decodeBits(POSITIVE_ULP_BASE64);
const floatBuffer = new ArrayBuffer(4);
const floatView = new Float32Array(floatBuffer);
const bitsView = new Uint32Array(floatBuffer);

const contains = (bits: Uint8Array, value: number): boolean => (
    (bits[value >> 3] & (1 << (value & 7))) !== 0
);

export const parseCofecha606TucsonWidth = (
    width: number,
    stopMarkerValue: number,
): number => {
    if (stopMarkerValue === -9999
        && Number.isInteger(width)
        && width >= 0
        && width <= 9998
        && width !== 999) {
        floatView[0] = Math.fround(width / 1000);
        if (negativeUlp && contains(negativeUlp, width)) bitsView[0] -= 1;
        else if (positiveUlp && contains(positiveUlp, width)) bitsView[0] += 1;
        return floatView[0];
    }
    const scale = Math.fround(stopMarkerValue === 999 ? 0.01 : 0.001);
    return Math.fround(width * scale);
};
`;
writeFileSync(outputPath, source, "utf8");
console.log(`COFECHA_F63_TABLE_COMPLETE ${outputPath}`);
