import type { RunCofechaRequest } from "cofecha-js";

export type CofechaJsWorkerRequest = {
  id: number;
  request: RunCofechaRequest;
};

export type CofechaJsWorkerResponse = {
  id: number;
  ok: true;
  outText: string;
} | {
  id: number;
  ok: false;
  error: { name: string; message: string };
};
