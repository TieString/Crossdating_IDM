import { useEffect, useState } from "react";
import {
    acquireTreeRingScanImage,
    type TreeRingScanCrop,
    type TreeRingScanFile,
} from "@/features/treeRingScans";

interface TreeRingScanImageState {
    url: string | null;
    loading: boolean;
    error: string | null;
    cropApplied: boolean;
}

export function useTreeRingScanImage(
    file: TreeRingScanFile | undefined,
    crop?: TreeRingScanCrop,
): TreeRingScanImageState {
    const [state, setState] = useState<TreeRingScanImageState>({
        url: null,
        loading: Boolean(file),
        error: null,
        cropApplied: false,
    });

    useEffect(() => {
        let active = true;
        let release: (() => void) | undefined;
        if (!file) {
            setState({ url: null, loading: false, error: null, cropApplied: false });
            return () => undefined;
        }

        setState({ url: null, loading: true, error: null, cropApplied: false });
        void acquireTreeRingScanImage(file, crop)
            .then((image) => {
                if (!active) {
                    image.release();
                    return;
                }
                release = image.release;
                setState({
                    url: image.url,
                    loading: false,
                    error: null,
                    cropApplied: image.cropApplied,
                });
            })
            .catch((error) => {
                if (!active) return;
                setState({
                    url: null,
                    loading: false,
                    error: error instanceof Error ? error.message : String(error),
                    cropApplied: false,
                });
            });

        return () => {
            active = false;
            release?.();
        };
    }, [file, crop?.heightRatio, crop?.widthRatio, crop?.xRatio, crop?.yRatio]);

    return state;
}
