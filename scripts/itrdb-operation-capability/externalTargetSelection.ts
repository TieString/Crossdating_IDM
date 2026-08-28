import { createHash } from "node:crypto";
import type { CapabilityFile, CapabilityTarget } from "./types";

export type TargetLengthBand = "100-199" | "200-299" | "300+";

export const targetLengthBand = (target: CapabilityTarget): TargetLengthBand => (
    target.seriesYears < 200
        ? "100-199"
        : target.seriesYears < 300
            ? "200-299"
            : "300+"
);

type Edge = {
    to: number;
    reverse: number;
    capacity: number;
    cost: number;
    initialCapacity: number;
};

const addEdge = (
    graph: Edge[][],
    from: number,
    to: number,
    capacity: number,
    cost: number,
): Edge => {
    const forward: Edge = {
        to,
        reverse: graph[to].length,
        capacity,
        cost,
        initialCapacity: capacity,
    };
    const reverse: Edge = {
        to: from,
        reverse: graph[from].length,
        capacity: 0,
        cost: -cost,
        initialCapacity: 0,
    };
    graph[from].push(forward);
    graph[to].push(reverse);
    return forward;
};

const minimumCostFlow = (
    graph: Edge[][],
    source: number,
    sink: number,
    requiredFlow: number,
): void => {
    let flow = 0;
    while (flow < requiredFlow) {
        const distance = Array.from({ length: graph.length }, () => Infinity);
        const previousNode = Array.from({ length: graph.length }, () => -1);
        const previousEdge = Array.from({ length: graph.length }, () => -1);
        const queued = Array.from({ length: graph.length }, () => false);
        const queue: number[] = [source];
        distance[source] = 0;
        queued[source] = true;
        while (queue.length > 0) {
            const node = queue.shift()!;
            queued[node] = false;
            graph[node].forEach((edge, edgeIndex) => {
                if (edge.capacity <= 0
                    || distance[edge.to] <= distance[node] + edge.cost) return;
                distance[edge.to] = distance[node] + edge.cost;
                previousNode[edge.to] = node;
                previousEdge[edge.to] = edgeIndex;
                if (!queued[edge.to]) {
                    queue.push(edge.to);
                    queued[edge.to] = true;
                }
            });
        }
        if (!Number.isFinite(distance[sink])) {
            throw new Error(`unable to select ${requiredFlow} balanced targets; flow=${flow}`);
        }
        let increment = requiredFlow - flow;
        for (let node = sink; node !== source; node = previousNode[node]) {
            increment = Math.min(
                increment,
                graph[previousNode[node]][previousEdge[node]].capacity,
            );
        }
        for (let node = sink; node !== source; node = previousNode[node]) {
            const edge = graph[previousNode[node]][previousEdge[node]];
            edge.capacity -= increment;
            graph[node][edge.reverse].capacity += increment;
        }
        flow += increment;
    }
};

const stableOrder = (seed: string, fileId: string, targetId: string): string => (
    createHash("sha256").update(`${seed}:${fileId}:${targetId}`).digest("hex")
);

export const selectLengthBalancedTargets = (
    files: readonly CapabilityFile[],
    targetsPerFile: number,
    seed: string,
): {
    selectedByFile: Map<string, CapabilityTarget[]>;
    counts: Record<TargetLengthBand, number>;
    idealCounts: Record<TargetLengthBand, number>;
} => {
    if (!Number.isInteger(targetsPerFile) || targetsPerFile <= 0) {
        throw new Error("targetsPerFile must be a positive integer");
    }
    const bands: TargetLengthBand[] = ["100-199", "200-299", "300+"];
    const total = files.length * targetsPerFile;
    const base = Math.floor(total / bands.length);
    const idealCounts: Record<TargetLengthBand, number> = {
        "100-199": base + (total % 3 > 0 ? 1 : 0),
        "200-299": base + (total % 3 > 1 ? 1 : 0),
        "300+": base,
    };
    const source = 0;
    const bandOffset = 1;
    const fileOffset = bandOffset + bands.length;
    const sink = fileOffset + files.length;
    const graph = Array.from({ length: sink + 1 }, () => [] as Edge[]);
    const bandFileEdges = new Map<string, Edge>();
    bands.forEach((band, bandIndex) => {
        addEdge(graph, source, bandOffset + bandIndex, idealCounts[band], 0);
        addEdge(graph, source, bandOffset + bandIndex, total, 1);
    });
    files.forEach((file, fileIndex) => {
        if (file.eligibleTargets.length < targetsPerFile) {
            throw new Error(`file ${file.fileId} has fewer than ${targetsPerFile} targets`);
        }
        bands.forEach((band, bandIndex) => {
            const capacity = file.eligibleTargets.filter((target) => (
                targetLengthBand(target) === band
            )).length;
            const edge = addEdge(
                graph,
                bandOffset + bandIndex,
                fileOffset + fileIndex,
                capacity,
                0,
            );
            bandFileEdges.set(`${band}|${file.fileId}`, edge);
        });
        addEdge(graph, fileOffset + fileIndex, sink, targetsPerFile, 0);
    });
    minimumCostFlow(graph, source, sink, total);

    const counts: Record<TargetLengthBand, number> = {
        "100-199": 0,
        "200-299": 0,
        "300+": 0,
    };
    const selectedByFile = new Map<string, CapabilityTarget[]>();
    files.forEach((file) => {
        const selected: CapabilityTarget[] = [];
        bands.forEach((band) => {
            const edge = bandFileEdges.get(`${band}|${file.fileId}`)!;
            const take = edge.initialCapacity - edge.capacity;
            const candidates = file.eligibleTargets.filter((target) => (
                targetLengthBand(target) === band
            )).sort((left, right) => (
                stableOrder(seed, file.fileId, left.targetId)
                    .localeCompare(stableOrder(seed, file.fileId, right.targetId))
                || left.targetId.localeCompare(right.targetId)
            ));
            selected.push(...candidates.slice(0, take));
            counts[band] += take;
        });
        if (selected.length !== targetsPerFile) {
            throw new Error(`balanced target selection failed for ${file.fileId}`);
        }
        selectedByFile.set(
            file.fileId,
            selected.sort((left, right) => left.targetId.localeCompare(right.targetId)),
        );
    });
    return { selectedByFile, counts, idealCounts };
};

const balanceError = (
    counts: Record<TargetLengthBand, number>,
    total: number,
): number => {
    const ideal = total / 3;
    return (Object.values(counts) as number[]).reduce((sum, value) => (
        sum + Math.abs(value - ideal)
    ), 0);
};

export const selectFilesForLengthBalance = <Band extends string>(
    candidatesByBand: ReadonlyMap<Band, readonly CapabilityFile[]>,
    requiredByBand: Readonly<Record<Band, number>>,
    targetsPerFile: number,
    seed: string,
): CapabilityFile[] => {
    const selected: CapabilityFile[] = [];
    const selectedIds = new Set<string>();
    const remaining = new Map<Band, number>(
        [...candidatesByBand.keys()].map((band) => [band, requiredByBand[band]]),
    );
    while ([...remaining.values()].some((count) => count > 0)) {
        const band = [...remaining.entries()].filter(([, count]) => count > 0)
            .sort(([leftBand, leftCount], [rightBand, rightCount]) => {
                const leftAvailable = candidatesByBand.get(leftBand)!
                    .filter((file) => !selectedIds.has(file.fileId)).length;
                const rightAvailable = candidatesByBand.get(rightBand)!
                    .filter((file) => !selectedIds.has(file.fileId)).length;
                return (rightCount / Math.max(1, rightAvailable))
                    - (leftCount / Math.max(1, leftAvailable))
                    || rightCount - leftCount
                    || String(leftBand).localeCompare(String(rightBand));
            })[0][0];
        const candidates = candidatesByBand.get(band)!
            .filter((file) => !selectedIds.has(file.fileId));
        if (candidates.length < remaining.get(band)!) {
            throw new Error(`insufficient files in correlation band ${String(band)}`);
        }
        const choice = candidates.map((candidate) => {
            const trial = selectLengthBalancedTargets(
                [...selected, candidate],
                targetsPerFile,
                `${seed}:trial`,
            );
            return {
                candidate,
                error: balanceError(trial.counts, (selected.length + 1) * targetsPerFile),
                order: stableOrder(seed, String(band), candidate.fileId),
            };
        }).sort((left, right) => (
            left.error - right.error
            || left.order.localeCompare(right.order)
            || left.candidate.fileId.localeCompare(right.candidate.fileId)
        ))[0].candidate;
        selected.push(choice);
        selectedIds.add(choice.fileId);
        remaining.set(band, remaining.get(band)! - 1);
    }
    const bandByFile = new Map<string, Band>();
    candidatesByBand.forEach((files, band) => files.forEach((file) => {
        bandByFile.set(file.fileId, band);
    }));
    const profile = (file: CapabilityFile): Record<TargetLengthBand, number> => {
        const counts: Record<TargetLengthBand, number> = {
            "100-199": 0,
            "200-299": 0,
            "300+": 0,
        };
        file.eligibleTargets.forEach((target) => {
            counts[targetLengthBand(target)] += 1;
        });
        return counts;
    };
    for (let round = 0; round < 25; round += 1) {
        const current = selectLengthBalancedTargets(selected, targetsPerFile, seed);
        const currentError = balanceError(current.counts, selected.length * targetsPerFile);
        const deficits = Object.fromEntries(
            (Object.keys(current.idealCounts) as TargetLengthBand[]).map((band) => (
                [band, current.idealCounts[band] - current.counts[band]]
            )),
        ) as Record<TargetLengthBand, number>;
        let best: {
            index: number;
            replacement: CapabilityFile;
            error: number;
            order: string;
        } | null = null;
        selected.forEach((selectedFile, index) => {
            const correlationBand = bandByFile.get(selectedFile.fileId)!;
            const alternatives = candidatesByBand.get(correlationBand)!
                .filter((file) => !selectedIds.has(file.fileId))
                .map((file) => {
                    const counts = profile(file);
                    const priority = (Object.keys(deficits) as TargetLengthBand[])
                        .reduce((sum, band) => (
                            sum + Math.min(targetsPerFile, counts[band]) * deficits[band]
                        ), 0);
                    return {
                        file,
                        priority,
                        order: stableOrder(seed, String(correlationBand), file.fileId),
                    };
                })
                .sort((left, right) => (
                    right.priority - left.priority
                    || left.order.localeCompare(right.order)
                ))
                .slice(0, 12);
            alternatives.forEach(({ file, order }) => {
                const trialFiles = [...selected];
                trialFiles[index] = file;
                const trial = selectLengthBalancedTargets(
                    trialFiles,
                    targetsPerFile,
                    `${seed}:swap`,
                );
                const error = balanceError(trial.counts, trialFiles.length * targetsPerFile);
                if (error >= currentError || (best && (
                    error > best.error || (error === best.error && order >= best.order)
                ))) return;
                best = { index, replacement: file, error, order };
            });
        });
        if (!best) break;
        const resolvedBest = best as {
            index: number;
            replacement: CapabilityFile;
            error: number;
            order: string;
        };
        selectedIds.delete(selected[resolvedBest.index].fileId);
        selected[resolvedBest.index] = resolvedBest.replacement;
        selectedIds.add(resolvedBest.replacement.fileId);
    }
    return selected.sort((left, right) => left.fileId.localeCompare(right.fileId));
};
