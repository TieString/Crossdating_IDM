import type { CofechaEngine, CofechaUndatedSort } from "./types";

export type CofechaValidationIdentity = {
  inputSignature: string;
  engine: CofechaEngine;
  undatedInputSignature: string | null;
  undatedSort: CofechaUndatedSort | null;
};

export const hashCofechaText = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return `${text.length.toString(16)}-${(hash >>> 0).toString(16)}`;
};

export const isCofechaValidationFresh = (
  hasOut: boolean,
  validation: CofechaValidationIdentity | null,
  inputSignature: string,
  engine: CofechaEngine,
  undatedInputSignature: string | null = null,
  undatedSort: CofechaUndatedSort | null = null,
) => Boolean(
  hasOut
  && validation
  && validation.inputSignature === inputSignature
  && validation.engine === engine
  && validation.undatedInputSignature === undatedInputSignature
  && validation.undatedSort === undatedSort
);
