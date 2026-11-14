/** An HTTP error from a Raindrop API call. Copied from tinytick and adapted. */
export class RaindropApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;
  /** The `X-RateLimit-Reset` header of a 429 reply, so a caller can wait for it. */
  readonly rateLimitReset: string | undefined;

  constructor(status: number, path: string, body: string, rateLimitReset?: string | null) {
    super(RaindropApiError.describe(status, path, body));
    this.name = "RaindropApiError";
    this.status = status;
    this.path = path;
    this.body = body;
    this.rateLimitReset = rateLimitReset ?? undefined;
  }

  /** Raindrop rejected the token: the UI shows "Token rejected" with an action to Account. */
  get isTokenRejected(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }

  private static describe(status: number, path: string, body: string): string {
    if (status === 401) return "Token rejected. Paste a new test token in Account.";
    if (status === 403) return `Raindrop refused ${path}. The feature can need Raindrop Pro.`;
    if (status === 404) return `Not found: ${path}`;
    if (status === 429) return "Raindrop rate limit. Try again in a minute.";
    const detail = body.slice(0, 200).trim();
    return `Raindrop error ${status} on ${path}${detail ? `: ${detail}` : ""}`;
  }
}

/**
 * The client refused a bulk call before it went out: a DELETE to Trash (-99, which deletes for good)
 * or to all (0, unsupported), or a call with no `ids`, too many `ids`, or a `search`. Nothing changed.
 */
export class BulkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkGuardError";
  }
}

/** True when the error means the token is no longer valid. */
export function isTokenRejected(error: unknown): boolean {
  return error instanceof RaindropApiError && error.isTokenRejected;
}

/** A readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
