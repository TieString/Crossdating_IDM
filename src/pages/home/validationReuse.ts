import type { CofechaEngine, CofechaUndatedSort } from "@/features/cofecha/types";

export type ValidationInput = {
    inputText: string;
    sourcePath: string;
    engine: CofechaEngine;
    executablePath: string | null;
    cofechaJsVersion: string;
    undatedInputText: string | null;
    undatedSourcePath: string | null;
    undatedSort: CofechaUndatedSort | null;
};

export const hashValidationText = (text: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
    return `${text.length.toString(16)}-${(hash >>> 0).toString(16)}`;
};

/** Reuse only an exactly validated serialized input, with the same EXE and file. */
export const canReuseValidation = (previous: Partial<ValidationInput> | null, next: ValidationInput): boolean => (
    previous !== null && previous.inputText === next.inputText && previous.sourcePath === next.sourcePath
    && previous.engine === next.engine && previous.executablePath === next.executablePath
    && previous.cofechaJsVersion === next.cofechaJsVersion
    && previous.undatedInputText === next.undatedInputText
    && previous.undatedSourcePath === next.undatedSourcePath
    && previous.undatedSort === next.undatedSort
);

export const shouldScheduleAutomaticValidation = (input: {
    filePath: string | null;
    siteSize: number;
    isLoading: boolean;
    engine: CofechaEngine;
    executablePath: string;
    validationCurrent: boolean;
}): boolean => Boolean(input.filePath && input.siteSize > 0 && !input.isLoading
    && (input.engine === "javascript" || input.executablePath.trim())
    && !input.validationCurrent);

/** Undo may return to the validated input while its reference is still marked stale. */
export function refreshReusedReference<T extends { rwlHash?: string; isStale?: boolean }>(reference: T | null, inputSignature: string): T | null {
    return reference?.isStale && reference.rwlHash === inputSignature
        ? { ...reference, isStale: false } : reference;
}
