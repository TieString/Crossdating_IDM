export class RwlParseError extends Error {
  constructor(message: string, public readonly format: string = "unknown") {
    super(message);
    this.name = "RwlParseError";
  }
}