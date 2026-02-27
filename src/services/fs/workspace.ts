// cofecha-work 目录生命周期、清理策略

import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir } from "@tauri-apps/plugin-fs";

/**
 * 获取工作目录路径
 * 如果目录不存在，则创建该目录
 * @returns {Promise<string>} 返回工作目录的路径
 */
export async function getWorkDir(): Promise<string> {
    const dir = await appDataDir(); // 获取应用程序数据目录路径
    if (await exists(dir)) {
        return dir; // 如果存在，直接返回目录路径
    } else {
        await mkdir(dir, { recursive: true }); // 如果不存在，递归创建目录
        return dir;
    }
}

export async function getCofechaWorkDir(): Promise<string> {
    const baseDir = await getWorkDir();
    // 确保基础路径没有尾部斜杠
    const dir: string = await join(baseDir, "cofecha-work");

    if (await exists(dir)) {
        return dir;
    } else {
        await mkdir(dir, { recursive: true });
        return dir;
    }
}

export async function clearWorkDir() {
    const dir = await getWorkDir();
    return dir;
}