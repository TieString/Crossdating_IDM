export interface ICofechaResult {
    masterSeriesYear: string,
    seriesIntercorrelation: number,
    averageMeanSensitivity: number,
    meanLength: number,
    absentRings: string,
    masterDatingSeries: Map<number, number>,  // Map<年份, 相关性>
    masterCorrelations: Map<string, number>,  // PART 7 各序列与主序列的整体相关性 Map<序列号(大写), r>
    seriesProblemCounts: Map<string, number>,  // PART 7 各序列的潜在问题分段数（Flags）Map<序列号(大写), 个数>
    possibleProblemsCount: number,
    possibleProblemsDetail: Map<string, string>,
}