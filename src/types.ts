// 文件内容
export interface IFileResult {
    content: string;
    path: string;
}

export type RwlTreeData = Map<number, number>

export type RwlSiteData = Map<string, RwlTreeData>
