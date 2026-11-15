// API error type. Handlers throw ApiError; the dispatcher converts it to
// { ok: false, error } with the matching HTTP status.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
