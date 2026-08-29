import { describe, expect, it } from "vitest";
import {
    cofecha606DivideSeries,
    cofecha606StabilizeFilteredSeries,
    solveCofecha606SplineTrend,
    solveLtrrCubicSmoothingSplineTrend,
} from "../reference";

const denseSolve = (matrix: number[][], rhs: number[]) => {
    const size = rhs.length;
    const a = matrix.map((row) => [...row]);
    const b = [...rhs];
    for (let pivot = 0; pivot < size; pivot += 1) {
        let best = pivot;
        for (let row = pivot + 1; row < size; row += 1) {
            if (Math.abs(a[row][pivot]) > Math.abs(a[best][pivot])) best = row;
        }
        [a[pivot], a[best]] = [a[best], a[pivot]];
        [b[pivot], b[best]] = [b[best], b[pivot]];
        for (let row = pivot + 1; row < size; row += 1) {
            const factor = a[row][pivot] / a[pivot][pivot];
            for (let column = pivot; column < size; column += 1) {
                a[row][column] -= factor * a[pivot][column];
            }
            b[row] -= factor * b[pivot];
        }
    }
    const result = new Array<number>(size).fill(0);
    for (let row = size - 1; row >= 0; row -= 1) {
        const remainder = a[row].reduce((sum, value, column) => (
            column > row ? sum + value * result[column] : sum
        ), 0);
        result[row] = (b[row] - remainder) / a[row][row];
    }
    return result;
};

const denseLtrrTrend = (values: number[], period: number, response: number) => {
    const cosine = Math.cos(2 * Math.PI / period);
    const multiplier = (((1 / (1 - response)) - 1) * 6 * (cosine - 1) ** 2)
        / (cosine + 2);
    const size = values.length - 2;
    const matrix = Array.from({ length: size }, (_, row) => (
        Array.from({ length: size }, (_, column) => {
            const distance = Math.abs(row - column);
            if (distance === 0) return 6 + multiplier * 4 / 3;
            if (distance === 1) return -4 + multiplier / 3;
            if (distance === 2) return 1;
            return 0;
        })
    ));
    const rhs = Array.from({ length: size }, (_, index) => (
        values[index] - 2 * values[index + 1] + values[index + 2]
    ));
    const coefficients = denseSolve(matrix, rhs);
    const correction = values.map((_, index) => {
        if (index === 0) return coefficients[0];
        if (index === 1) return -2 * coefficients[0] + coefficients[1];
        if (index === values.length - 2) {
            return coefficients[size - 2] - 2 * coefficients[size - 1];
        }
        if (index === values.length - 1) return coefficients[size - 1];
        return coefficients[index - 2] - 2 * coefficients[index - 1] + coefficients[index];
    });
    return values.map((value, index) => value - correction[index]);
};

describe("LTRR Cook-Holmes cubic spline", () => {
    it("matches an independent dense solve of the published band equations", () => {
        const values = [120, 138, 111, 164, 155, 103, 145, 131, 178, 152];
        const expected = denseLtrrTrend(values, 32, 0.5);
        const actual = solveLtrrCubicSmoothingSplineTrend(values, 32, 0.5);

        actual.forEach((value, index) => {
            expect(value).toBeCloseTo(expected[index], 9);
        });
    });

    it("preserves a linear trend", () => {
        const values = Array.from({ length: 20 }, (_, index) => 100 + index * 3);
        expect(solveLtrrCubicSmoothingSplineTrend(values, 32, 0.5))
            .toEqual(values);
    });

    it("matches COFECHA 6.06 filtering stages at legacy float boundaries", () => {
        const width = (index: number) => {
            const shared = 950
                + 170 * Math.sin(index * 0.41)
                + 85 * Math.cos(index * 0.17)
                + 55 * Math.sin(index * 1.07);
            const growth = 1.65 - 0.0032 * index + 0.000004 * index ** 2;
            const individual = 1
                + 0.08 * Math.sin(index * 0.071)
                + 0.03 * Math.cos(index * 0.23);
            const rounded = Math.max(1, Math.round(
                shared * growth * individual * 0.72,
            ));
            return (rounded === 999 || rounded === 9999 ? rounded + 2 : rounded) / 1000;
        };
        const values = Array.from({ length: 200 }, (_, index) => width(index));
        const trend = solveCofecha606SplineTrend(values, 32, 0.5);
        expect(trend).not.toBeNull();
        const detrended = cofecha606DivideSeries(values, trend!);
        const stabilized = cofecha606StabilizeFilteredSeries(detrended, 32, 0.5);
        const checkpoints = [
            [0, 1.406529188156128, 0.9000880122184753, 0.8361272215843201],
            [1, 1.3783183097839355, 1.0237113237380981, 1.0386852025985718],
            [50, 0.9755228757858276, 1.15630304813385, 1.1771379709243774],
            [100, 0.9687645435333252, 0.9651468396186829, 0.9570547938346863],
            [150, 0.8256573677062988, 0.8344866037368774, 0.8097567558288574],
            [199, 0.7420222163200378, 1.020185112953186, 1.0369166135787964],
        ] as const;
        checkpoints.forEach(([index, expectedTrend, expectedDetrended, expectedStabilized]) => {
            expect(trend![index]).toBeCloseTo(expectedTrend, 5);
            expect(detrended[index]).toBeCloseTo(expectedDetrended, 5);
            expect(stabilized[index]).toBeCloseTo(expectedStabilized, 5);
        });
    });
});
