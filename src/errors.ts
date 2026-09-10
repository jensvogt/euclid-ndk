/**
 * Errors this SDK throws.
 *
 * The server answers every failure the same way - a non-2xx status and a JSON body of the form
 * `{"error": "..."}` (`Core::HttpActionServer::ErrorResponse`) - so the message a caller sees is
 * pulled out of that body when it is there, and falls back to the raw body when it is not.
 */

/** Base class for everything this SDK throws. */
export class EuclidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A login was refused.
 *
 * Separate from {@link EuclidServiceError} because it is the one failure a caller can nearly always
 * do something about: the password is wrong, the account is disabled, or the user is a technical
 * user the server refuses to log in interactively.
 */
export class EuclidAuthenticationError extends EuclidError {
  readonly status: number;
  readonly body: string;
  /** The server's own message, out of the `{"error": "..."}` body. */
  readonly reason: string;

  constructor(status: number, body = "") {
    const reason = reasonOf(body);
    super(`login failed with HTTP ${status}${reason ? `: ${reason}` : ""}`);
    this.status = status;
    this.body = body;
    this.reason = reason;
  }
}

/**
 * A module refused or failed an action.
 *
 * Carries the target and action alongside the status, so a caller catching one of these knows which
 * call failed without having to have wrapped each one individually.
 */
export class EuclidServiceError extends EuclidError {
  readonly target: string;
  readonly action: string;
  readonly status: number;
  readonly body: string;
  readonly reason: string;

  constructor(target: string, action: string, status: number, body = "") {
    const reason = reasonOf(body);
    super(`${target}/${action} failed with HTTP ${status}${reason ? `: ${reason}` : ""}`);
    this.target = target;
    this.action = action;
    this.status = status;
    this.body = body;
    this.reason = reason;
  }
}

/** The server's error message, or the body verbatim when it is not the shape we expect. */
function reasonOf(body: string): string {
  if (!body) return "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error;
    }
  } catch {
    // Not JSON at all, which is what a proxy's error page looks like. The body itself is then the
    // most useful thing there is to say.
  }
  return body.trim();
}
