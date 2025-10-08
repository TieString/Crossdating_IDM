import { BaseDirectory, readTextFile } from "@tauri-apps/plugin-fs";
import { ICofechaResult } from "../types";

const readOutFile = async (): Promise<string> => {
    try {
        const content = await readTextFile('VERYCOF.OUT', { baseDir: BaseDirectory.Resource }); // 路径相对于应用程序数据目录
        return content;
    } catch (error) {
        console.log('读取文件出错:' + error);
        return "读取文件出错"
    }
}

const parseCofechaResult = (content: string): ICofechaResult => {
    // 解析数据
    const reportParts = splitReportByParts(content);

    const part1 = reportParts.get("PART 1") || "";
    const part3 = reportParts.get("PART 3") || "";
    const part6 = reportParts.get("PART 6") || "";

    const masterSeriesYear = extractMasterSeriesYear(part1);
    const interCorrelation = extractSeriesIntercorrelation(part1);
    const meanSensitivity = extractAverageMeanSensitivity(part1);
    const meanLength = extractMeanLength(part1);
    const masterDatingSeries = extractMasterDatingSeries(part3);

    const possibleProblemsCount = extractPossibleProblemsCount(part1);

    const possibleProblemsDetail = extractPossibleProblemsDetail(part6);

    const cofechaResult: ICofechaResult = {
        masterSeriesYear,
        seriesIntercorrelation: interCorrelation,
        averageMeanSensitivity: meanSensitivity,
        meanLength,
        absentRings: "",
        masterDatingSeries,
        possibleProblemsCount,
        possibleProblemsDetail
    }
    return cofechaResult;
}

function extractMasterSeriesYear(text: string): string {
    const match = text.match(/Master series\s+(\d{4})\s+(\d{4})\s+(\d+)/);
    if (match) {
        return `${match[1]}-${match[2]}`; // 返回格式为 "1791-2023"
    }
    return "";
}

function extractSeriesIntercorrelation(text: string): number {
    const match = text.match(/Series intercorrelation\s+([\d.]+)/);
    if (match) {
        return parseFloat(match[1]); // 转换为浮点数
    }
    return -1;
}

function extractAverageMeanSensitivity(text: string): number {
    const match = text.match(/Average mean sensitivity\s+([\d.]+)/);
    if (match) {
        return parseFloat(match[1]); // 转换为浮点数
    }
    return -1;
}

function extractPossibleProblemsCount(text: string): number {
    const match = text.match(/Segments, possible problems\s+(\d+)/);

    if (match) {
        return parseInt(match[1], 10); // 转换为整数
    }
    return -1;
}

function extractMeanLength(text: string): number {
    const match = text.match(/Mean length of series\s+([\d.]+)/);
    if (match) {
        return parseFloat(match[1]); // 转换为浮点数
    }
    return -1;
}


function extractMasterDatingSeries(text: string): Map<number, number> {
    const masterDatingSeries = new Map<number, number>();

    // 正则匹配：年份（4位）、相关性值（可带负号和小数点）
    const regex = /(\d{4})\s+([-+]?\d*\.\d+|\d+)/g;
    let match;

    // 逐步解析每个匹配项
    while ((match = regex.exec(text)) !== null) {
        const year = parseInt(match[1], 10); // 提取年份
        const value = parseFloat(match[2]); // 提取相关性值
        masterDatingSeries.set(year, value);
    }

    return masterDatingSeries;
}


//DONE: 处理同号 PART 时，合并其内容而非覆盖（例如两个 PART 3）[v1.1.3]
export function splitReportByParts(text: string): Map<string, string> {
 const parts = new Map<string, string>();

    // 1. 先提取 PART 1（从文件开头到 PART 2: 之前）
    const part2Index = text.indexOf("PART 2:");
    if (part2Index !== -1) {
        const part1Content = text.substring(0, part2Index).trim();
        parts.set("PART 1", part1Content);
    }

    // 2. 处理 PART 2: 及后续 PART X:
    const regex = /(PART \d+:.*?)(?=(PART \d+:|$))/gs;
    let match;

    while ((match = regex.exec(text.substring(part2Index))) !== null) {
        const partTitle = match[1].split("\n")[0].trim(); // 提取 PART X: 标题
        const partNumber = partTitle.split(" ")[1].replace(":", ""); // 提取 `X`
        const partContent = match[1].trim(); // 获取该部分的内容
        const key = `PART ${partNumber}`;
        // 同号 PART（分页续页）=> 合并
    parts.set(key, parts.has(key) ? `${parts.get(key)}\n${partContent}` : partContent);
    }

    return parts;
}


function extractPossibleProblemsDetail(text: string): Map<string, string> {
    const possibleProblems = new Map<string, string>();

    // 按 `==========` 分割成多个块
    const sections = text.split(/=+/);

    for (const section of sections) {
        const lines = section.trim().split("\n").map(line => line.trim()).filter(line => line);

        if (lines.length === 0) continue; // 跳过空块

        // 取第一行的第一个字符串作为 key
        const seriesID = lines[0].split(/\s+/)[0]; // 按空格分割，取第一个单词

        // 查找 `[A] Segment` 部分
        const aMatch = section.match(/\[A\] Segment[\s\S]*?(?=\[[B-E]\]|\={10,}|$)/);
        if (aMatch) {
            possibleProblems.set(seriesID, aMatch[0].trim());
        }
    }

    return possibleProblems;
}



export { readOutFile, parseCofechaResult };

