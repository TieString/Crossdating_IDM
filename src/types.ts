// 文件内容
export interface IFileResult {
    content: string;
    path: string;
}

export type RwlTreeData = Map<number, number | null>

export type RwlSiteData = Map<string, RwlTreeData>


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