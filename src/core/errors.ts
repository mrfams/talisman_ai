export class TalismanError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
    readonly code: string = "bad_request",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "TalismanError";
  }
}

export const errors = {
  unauthorized: (message = "Sign in required") =>
    new TalismanError(message, 401, "unauthorized"),
  forbidden: (message = "Not permitted") => new TalismanError(message, 403, "forbidden"),
  notFound: (message = "Not found") => new TalismanError(message, 404, "not_found"),
  conflict: (message: string) => new TalismanError(message, 409, "conflict"),
  invalid: (message: string, details?: unknown) =>
    new TalismanError(message, 422, "invalid", details),
  rateLimited: (message = "Too many attempts") =>
    new TalismanError(message, 429, "rate_limited"),
  unavailable: (message = "Service unavailable") =>
    new TalismanError(message, 503, "unavailable"),
};

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
