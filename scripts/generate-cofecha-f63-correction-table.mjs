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
const shortRuntimePath = resolve(valueFor("--runtime-stages-short"));
const outputPath = resolve(valueFor("--output"));
const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
const shortRuntime = JSON.parse(readFileSync(shortRuntimePath, "utf8"));
const rawValues = Array.from({ length: 9999 }, (_, value) => value)
    .filter((value) => value !== 999);
const floatBuffer = new ArrayBuffer(4);
const floatView = new Float32Array(floatBuffer);
const bitsView = new Uint32Array(floatBuffer);
const bits = (value) => {
    floatView[0] = value;
    return bitsView[0];
};
const buildCorrections = (runtimeResult, values, divisor, size) => {
    const negative = Buffer.alloc(Math.ceil(size / 8));
    const positive = Buffer.alloc(Math.ceil(size / 8));
    const firstPasses = runtimeResult.records
        .filter((record) => record.stage === "spline")
        .filter((_, index) => index % 2 === 0);
    let cursor = 0;
    for (const record of firstPasses) {
        for (const parsedValue of record.input) {
            const rawValue = values[cursor];
            cursor += 1;
            if (rawValue === undefined) continue;
            const baseline = Math.fround(rawValue / divisor);
            const delta = bits(parsedValue) - bits(baseline);
            if (delta === -1) negative[rawValue >> 3] |= 1 << (rawValue & 7);
            else if (delta === 1) positive[rawValue >> 3] |= 1 << (rawValue & 7);
            else if (delta !== 0) {
                throw new Error(`unexpected ULP delta ${delta} for ${rawValue}/${divisor}`);
            }
        }
    }
    if (cursor < values.length) {
        throw new Error(`incomplete parser grid: ${cursor}/${values.length}`);
    }
    return { negative, positive };
};
const f63 = buildCorrections(runtime, rawValues, 1000, 10000);
const f62 = buildCorrections(
    shortRuntime,
    Array.from({ length: 999 }, (_, value) => value),
    100,
    1000,
);

const source = `/** Generated from the Microsoft FORTRAN F6.3 reader used by COFECHA 6.06. */
const F63_NEGATIVE_ULP_BASE64 = "${f63.negative.toString("base64")}";
const F63_POSITIVE_ULP_BASE64 = "${f63.positive.toString("base64")}";
const F62_NEGATIVE_ULP_BASE64 = "${f62.negative.toString("base64")}";
const F62_POSITIVE_ULP_BASE64 = "${f62.positive.toString("base64")}";

const decodeBits = (encoded: string): Uint8Array => Uint8Array.from(
    atob(encoded),
    (character) => character.charCodeAt(0),
);
const f63NegativeUlp = decodeBits(F63_NEGATIVE_ULP_BASE64);
const f63PositiveUlp = decodeBits(F63_POSITIVE_ULP_BASE64);
const f62NegativeUlp = decodeBits(F62_NEGATIVE_ULP_BASE64);
const f62PositiveUlp = decodeBits(F62_POSITIVE_ULP_BASE64);
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
    if (width < 0 && width !== stopMarkerValue) {
        return -parseCofecha606TucsonWidth(-width, stopMarkerValue);
    }
    if (stopMarkerValue === -9999
        && Number.isInteger(width)
        && width >= 0
        && width <= 9998
        && width !== 999) {
        floatView[0] = Math.fround(width / 1000);
        if (contains(f63NegativeUlp, width)) bitsView[0] -= 1;
        else if (contains(f63PositiveUlp, width)) bitsView[0] += 1;
        return floatView[0];
    }
    if (stopMarkerValue === 999
        && Number.isInteger(width)
        && width >= 0
        && width <= 998) {
        floatView[0] = Math.fround(width / 100);
        if (contains(f62NegativeUlp, width)) bitsView[0] -= 1;
        else if (contains(f62PositiveUlp, width)) bitsView[0] += 1;
        return floatView[0];
    }
    const scale = Math.fround(stopMarkerValue === 999 ? 0.01 : 0.001);
    return Math.fround(width * scale);
};
`;
writeFileSync(outputPath, source, "utf8");
console.log(`COFECHA_F63_TABLE_COMPLETE ${outputPath}`);
