import type { CofechaEngine } from "./types";

export type CofechaValidationIdentity = {
  inputSignature: string;
  engine: CofechaEngine;
};

export const isCofechaValidationFresh = (
  hasOut: boolean,
  validation: CofechaValidationIdentity | null,
  inputSignature: string,
  engine: CofechaEngine,
) => Boolean(
  hasOut
  && validation
  && validation.inputSignature === inputSignature
  && validation.engine === engine
);
