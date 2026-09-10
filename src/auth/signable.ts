/** The view of a request that the signing schemes work on. */

/**
 * A minimal, transport-agnostic request: method, target, headers and body.
 *
 * Deliberately not node's `ClientRequest`. A signature has to be computed over headers that are
 * already set and then written back as more headers, which needs a mutable object that exists
 * before anything is sent - and it has to be the same object the verifier sees on the other side,
 * so that signing and verification are demonstrably the same canonicalisation rather than two
 * implementations of one description.
 *
 * Header names are stored lowercase and values trimmed, because that is what both canonical forms
 * are defined over: HTTP header names are case-insensitive, and neither SigV4 nor RFC 9421 treats
 * the surrounding whitespace of a value as part of it.
 */
export class SignableRequest {
  readonly method: string;
  readonly target: string;

  #headers = new Map<string, string>();
  #body: Buffer = Buffer.alloc(0);
  // https, because that is how euclid is reached anywhere the distinction can matter. A
  // plain-HTTP caller sets it so that both ends agree on whether the port belongs in "@authority".
  #scheme = "https";

  constructor(method: string, target: string) {
    this.method = method;
    this.target = target;
  }

  get body(): Buffer {
    return this.#body;
  }

  get scheme(): string {
    return this.#scheme;
  }

  /** The headers, keyed by lowercase name, in the order they were first set. */
  get headers(): Record<string, string> {
    return Object.fromEntries(this.#headers);
  }

  /** Sets a header, and returns this so calls can be chained. */
  header(name: string, value: string): this {
    this.#headers.set(name.toLowerCase(), value.trim());
    return this;
  }

  /** Copies every header of an object onto this request. */
  headersFrom(headers: Record<string, string | undefined>): this {
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) this.header(name, value);
    }
    return this;
  }

  /** A header's value, or the empty string when the request does not carry it. */
  get(name: string): string {
    return this.#headers.get(name.toLowerCase()) ?? "";
  }

  /** Whether the request carries a header at all, which is not the same as it being non-empty. */
  has(name: string): boolean {
    return this.#headers.has(name.toLowerCase());
  }

  /** Sets the body. Text is encoded as UTF-8, which is what both ends hash. */
  setBody(body: Buffer | string | null | undefined): this {
    this.#body = body == null ? Buffer.alloc(0) : typeof body === "string" ? Buffer.from(body, "utf8") : body;
    return this;
  }

  /** Sets the URI scheme. Ignored when empty, leaving the https default in place. */
  setScheme(scheme: string | null | undefined): this {
    if (scheme) this.#scheme = scheme.toLowerCase();
    return this;
  }
}
