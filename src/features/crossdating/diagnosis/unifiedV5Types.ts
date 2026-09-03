/** Minimal normalized input owned by the deployed v5 evidence pipeline. */
export type UnifiedV5Sample = {
    target: Map<number, number>;
    master: Map<number, number>;
    references: Array<Map<number, number>>;
};
