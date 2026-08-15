export interface IntegerWheelStepOptions {
    step?: number;
    min?: number;
    max?: number;
    fallback?: number;
}

const parseInteger = (value: string): number | null => {
    const trimmed = value.trim();
    if (trimmed === "") return null;

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
};

/** Returns the next integer for a wheel gesture; wheel-up increments. */
export function getWheelSteppedIntegerValue(
    currentValue: string,
    deltaY: number,
    options: IntegerWheelStepOptions = {},
): number | null {
    if (!Number.isFinite(deltaY) || deltaY === 0) return null;

    const step = Number.isInteger(options.step) && (options.step ?? 0) > 0
        ? options.step!
        : 1;
    const fallback = Number.isInteger(options.fallback) ? options.fallback! : 0;
    const current = parseInteger(currentValue) ?? fallback;
    let next = current + (deltaY < 0 ? step : -step);

    if (Number.isInteger(options.min)) {
        next = Math.max(options.min!, next);
    }
    if (Number.isInteger(options.max)) {
        next = Math.min(options.max!, next);
    }

    return next;
}
