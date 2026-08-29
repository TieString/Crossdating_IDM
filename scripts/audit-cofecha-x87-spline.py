"""Test high-precision intermediate arithmetic against captured COFECHA SPLINE output."""

from __future__ import annotations

import argparse
import json
import math
import struct
from decimal import Decimal, localcontext
from pathlib import Path


def float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def solve(
    values: list[float],
    penalty: float,
    precision: int,
    high_expressions: bool,
    high_reciprocal_sqrt: bool,
) -> list[float]:
    size = len(values) - 2
    band = [[0.0] * 5 for _ in range(size + 1)]
    c1 = [0.0, 1.0, -4.0, 6.0, -2.0]
    c2 = [0.0, 0.0, 0.33333333333333, 1.33333333333333]

    def decimal(value: float) -> Decimal:
        return Decimal.from_float(value)

    def stored(expression: Decimal) -> float:
        return float(expression)

    def multiply_add(left: float, right: float, addend: float) -> float:
        if not high_expressions:
            return left * right + addend
        return stored(decimal(left) * decimal(right) + decimal(addend))

    def sum_three(first: float, second: float, third: float) -> float:
        if not high_expressions:
            return first + second + third
        return stored(decimal(first) + decimal(second) + decimal(third))

    with localcontext() as context:
        context.prec = precision
        for row in range(1, size + 1):
            for column in range(1, 4):
                band[row][column] = multiply_add(
                    penalty, c2[column], c1[column]
                )
                band[row][4] = sum_three(
                    c1[4] * values[row], values[row + 1], values[row - 1]
                )
        band[1][1] = 0.0
        band[1][2] = 0.0
        band[2][1] = 0.0
        diagonal_column = 3
        for row in range(1, size + 1):
            row_minus_diagonal = row - diagonal_column
            first_column = max(1, 1 - row_minus_diagonal)
            for column in range(first_column, diagonal_column + 1):
                previous_row = row_minus_diagonal + column
                inner_offset = diagonal_column - column
                running = band[row][column]
                for inner in range(1, column):
                    previous_column = inner_offset + inner
                    running = multiply_add(
                        -band[row][inner], band[previous_row][previous_column], running
                    )
                if column == diagonal_column:
                    band[row][column] = (
                        stored(Decimal(1) / decimal(running).sqrt())
                        if high_reciprocal_sqrt
                        else 1 / math.sqrt(running)
                    )
                    continue
                band[row][column] = running * band[previous_row][diagonal_column]

        active_bandwidth = 0
        encountered_non_zero = False
        for row in range(1, size + 1):
            running = band[row][4]
            if encountered_non_zero:
                active_bandwidth = min(2, active_bandwidth + 1)
                first_column = diagonal_column - active_bandwidth
                previous_row = row - active_bandwidth
                for column in range(first_column, 3):
                    running = multiply_add(
                        -band[previous_row][4], band[row][column], running
                    )
                    previous_row += 1
            elif running != 0:
                encountered_non_zero = True
            band[row][4] = running * band[row][diagonal_column]

        band[size][4] = band[size][4] * band[size][3]
        for offset in range(2, size + 1):
            row = size + 1 - offset
            running = band[row][4]
            relative_column = 1
            for next_row in range(row + 1, min(size, row + 2) + 1):
                running = multiply_add(
                    -band[next_row][4], band[next_row][3 - relative_column], running
                )
                relative_column += 1
            band[row][4] = running * band[row][3]

        correction = [0.0] * len(values)
        for index in range(3, size + 1):
            correction[index - 1] = sum_three(
                band[index - 2][4],
                c1[4] * band[index - 1][4],
                band[index][4],
            )
        correction[0] = band[1][4]
        correction[1] = multiply_add(c1[4], band[1][4], band[2][4])
        correction[-2] = multiply_add(c1[4], band[size][4], band[size - 1][4])
        correction[-1] = band[size][4]
        return [
            float32(value - correction[index])
            for index, value in enumerate(values)
        ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-stages", required=True, type=Path)
    parser.add_argument("--call", type=int, default=1)
    args = parser.parse_args()
    runtime = json.loads(args.runtime_stages.read_text(encoding="utf-8"))
    record = next(
        row for row in runtime["records"]
        if row.get("stage") == "spline" and row.get("call") == args.call
    )
    penalty = next(
        row["value"] for row in runtime["records"]
        if row.get("stage") == "splinePenalty"
    )
    for high_expressions, high_reciprocal_sqrt in (
        (False, False),
        (True, False),
        (False, True),
        (True, True),
    ):
        actual = solve(
            record["input"],
            penalty,
            25,
            high_expressions,
            high_reciprocal_sqrt,
        )
        errors = [left - right for left, right in zip(actual, record["output"])]
        print(json.dumps({
            "highExpressions": high_expressions,
            "highReciprocalSqrt": high_reciprocal_sqrt,
            "exact": sum(error == 0 for error in errors),
            "rmse": math.sqrt(sum(error * error for error in errors) / len(errors)),
            "maxAbsoluteError": max(abs(error) for error in errors),
        }))


if __name__ == "__main__":
    main()
