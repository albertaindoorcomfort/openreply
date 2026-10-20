/** A refusal the caller can act on. `status` is the HTTP status the API returns. */
export class LeadError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    message?: string
  ) {
    super(message ?? code);
    this.name = "LeadError";
  }
}

export const notFound = (what: string) => new LeadError("NOT_FOUND", 404, `${what} not found`);
export const versionConflict = () =>
  new LeadError("VERSION_CONFLICT", 409, "The record changed since you read it. Reload and try again.");
