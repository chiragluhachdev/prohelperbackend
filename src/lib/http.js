/** An error with an HTTP status, so route code can just `throw new ApiError(...)`. */
export class ApiError extends Error {
  constructor(status, message, code = undefined, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m, code, d) => new ApiError(400, m, code, d);
export const unauthorized = (m = 'Not signed in') => new ApiError(401, m, 'UNAUTHORIZED');
export const forbidden = (m = 'Not allowed') => new ApiError(403, m, 'FORBIDDEN');
/** A blocked account (UC-C23) — its own code, so the apps can say so instead of a generic error. */
export const accountBlocked = (m) => new ApiError(403, m || 'This account has been blocked. Please contact support.', 'ACCOUNT_BLOCKED');
export const notFound = (m = 'Not found') => new ApiError(404, m, 'NOT_FOUND');
export const conflict = (m, code) => new ApiError(409, m, code);

/** Wraps an async route so rejected promises reach the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
