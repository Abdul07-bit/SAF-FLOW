export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Please sign in to continue.") => new HttpError(401, "UNAUTHENTICATED", message);
export const forbidden = (code: string, message: string, details?: unknown) => new HttpError(403, code, message, details);
export const notFound = (what = "Resource") => new HttpError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, "CONFLICT", message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);

export function assert(cond: unknown, err: HttpError): asserts cond {
  if (!cond) throw err;
}
