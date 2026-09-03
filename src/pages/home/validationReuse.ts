export type ValidationInput = { inputText: string; sourcePath: string; executablePath: string; version: string };

/** Reuse only an exactly validated serialized input, with the same EXE and file. */
export const canReuseValidation = (previous: Partial<ValidationInput> | null, next: ValidationInput): boolean => (
    previous !== null && previous.inputText === next.inputText && previous.sourcePath === next.sourcePath
    && previous.executablePath === next.executablePath && previous.version === next.version
);

/** Undo may return to the validated input while its reference is still marked stale. */
export function refreshReusedReference<T extends { rwlHash?: string; isStale?: boolean }>(reference: T | null, inputSignature: string): T | null {
    return reference?.isStale && reference.rwlHash === inputSignature
        ? { ...reference, isStale: false } : reference;
}
