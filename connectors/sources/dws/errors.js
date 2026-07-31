export class DwsConnectorError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "DwsConnectorError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function dwsError(code, details) {
  return new DwsConnectorError(code, details);
}
