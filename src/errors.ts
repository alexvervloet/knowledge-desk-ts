/** Domain errors, mapped to HTTP status codes at the API edge. */

/** Base for expected, caller-facing failures. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** A uniqueness or state conflict (maps to 409). */
export class Conflict extends DomainError {}

/** A resource the caller may not see or that does not exist (maps to 404). */
export class NotFound extends DomainError {}

/** Authenticated but not allowed (maps to 403). */
export class Forbidden extends DomainError {}

/** Bad or missing credentials (maps to 401). */
export class AuthError extends DomainError {}

/** A tenant limit would be exceeded by this request (maps to 413). */
export class QuotaExceeded extends DomainError {}
