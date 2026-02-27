export interface ICofechaResult {
    masterSeriesYear: string,
    seriesIntercorrelation: number,
    averageMeanSensitivity: number,
    meanLength: number,
    absentRings: string,
    masterDatingSeries: Map<number, number>,  // Map<年份, 相关性>
    possibleProblemsCount: number,
    possibleProblemsDetail: Map<string, string>,
}