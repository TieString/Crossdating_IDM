/** Canonical key used by every COFECHA-derived per-series map. */
export const normalizeCofechaSeriesId = (seriesId: string) => (
    seriesId.trim().toUpperCase()
);

export const getCofechaSeriesMapValue = <T>(
    values: ReadonlyMap<string, T>,
    seriesId: string,
): T | undefined => {
    const normalizedId = normalizeCofechaSeriesId(seriesId);
    if (values.has(normalizedId)) {
        return values.get(normalizedId);
    }
    for (const [key, value] of values) {
        if (normalizeCofechaSeriesId(key) === normalizedId) {
            return value;
        }
    }
    return undefined;
};

export const hasCofechaSeriesMapValue = (
    values: ReadonlyMap<string, unknown>,
    seriesId: string,
) => getCofechaSeriesMapValue(values, seriesId) !== undefined;
