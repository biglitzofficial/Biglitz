export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string): HttpError => new HttpError(400, code, message);
export const unauthorized = (message = "Please log in again."): HttpError => new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to do that."): HttpError =>
  new HttpError(403, "FORBIDDEN", message);
export const notFound = (what: string): HttpError => new HttpError(404, "NOT_FOUND", `${what} was not found.`);
export const conflict = (code: string, message: string): HttpError => new HttpError(409, code, message);
export const monthLocked = (): HttpError => new HttpError(423, "MONTH_LOCKED", "Month locked: payroll for this month is approved.");
