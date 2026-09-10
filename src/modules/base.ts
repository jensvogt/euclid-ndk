/**
 * What every module client has in common.
 *
 * euclid speaks one request shape, so most of a module client is the same client over and over: post
 * JSON to `/`, name the module in `x-euclid-target` and the operation in `x-euclid-action`,
 * authenticate the way the session that created it authenticates, and turn a non-2xx into a
 * {@link EuclidServiceError}. That part lives here; what is left in {@link import("./esm.js")} - and
 * in the module clients that follow it - is the operations themselves.
 *
 * Subclassing this is also how an application reaches a module this SDK has not wrapped: give the
 * subclass a target and call {@link ModuleClient.call}.
 */

import type { EuclidHttpClient, Response } from "../http/client.js";
import { EuclidServiceError } from "../errors.js";
import type { EuclidSession } from "./eam.js";

/**
 * What an action whose body is bytes will take.
 *
 * A string is sent as its UTF-8 bytes, which is then exactly what the server stored or encrypted;
 * anything that matters about the encoding is the caller's to decide before calling.
 */
export type Bytes = Buffer | Uint8Array | string;

/** How a listing is paged and ordered. Every field has a server-side default. */
export interface PageOptions {
  pageSize?: number;
  pageIndex?: number;
  sortColumn?: string;
  sortDirection?: string;
}

/**
 * How a listing is paged, ordered and narrowed.
 *
 * Most listings take a prefix; the ones that page messages do not, and take {@link PageOptions}
 * instead - the server has nothing to match a message against.
 */
export interface ListOptions extends PageOptions {
  prefix?: string;
}

/** What a {@link ModuleClient} needs beyond the session: which module it is, and how it behaves. */
export interface ModuleClientOptions {
  /** The module this client talks to - what travels in `x-euclid-target`. */
  target: string;
  /**
   * The actions of this module that carry raw bytes rather than JSON, and so present the session's
   * bearer token rather than a signature - see {@link ModuleClient.authHeaders}.
   */
  byteActions?: Iterable<string>;
  /** Headers every request of this client carries on top of the session's own. */
  headers?: Record<string, string>;
  /**
   * A connection to share rather than open. Only for a second view of the same module, where two
   * clients that differ by a header have no reason to differ by a socket.
   */
  client?: EuclidHttpClient;
}

/**
 * One euclid module, on the credentials of the session that created it.
 *
 * Holds the session rather than a copy of what it knew at the time, so the client follows it: a
 * {@link EuclidSession.changeNamespace} between two calls scopes the second one, and a token the
 * session refreshes is the token the next request carries.
 */
export abstract class ModuleClient {
  /** The module this client talks to - what travels in `x-euclid-target`. */
  readonly target: string;

  /** The session this client authenticates as. */
  protected readonly session: EuclidSession;

  /**
   * The connection this client sends on.
   *
   * Visible to a subclass because a second view of the same module shares it - see
   * {@link import("./eqs.js").EuclidEqs.asInternal}, where two clients that differ by a header have no
   * reason to differ by a socket.
   */
  protected readonly client: EuclidHttpClient;

  readonly #byteActions: ReadonlySet<string>;
  readonly #headers: Record<string, string>;

  protected constructor(session: EuclidSession, options: ModuleClientOptions) {
    if (!options.target) throw new Error("a module client must name its target, e.g. target: 'esm'");
    this.target = options.target;
    this.session = session;
    this.#byteActions = new Set(options.byteActions ?? []);
    this.#headers = { ...options.headers };
    // Its own connection, and its own header factory: a request of this module whose credentials
    // expired in flight has to be rebuilt as a request of *this* module rather than of EAM.
    this.client = options.client ?? session.newClient((action, body) => this.authHeaders(action, body));
  }

  /** Releases the connection this client was holding. Closing the session calls it. */
  close(): void {
    this.client.close();
  }

  // -- transport -------------------------------------------------------------------------------

  /**
   * Sends any action of this module, for one this SDK does not wrap yet.
   *
   * Public on purpose: a server that gains an action should be reachable without waiting for a
   * release here.
   */
  async call(
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.result(action, await this.post(action, payload, {}, timeoutMs));
  }

  /** Who is asking, what they are scoped to, and whatever this client adds to that. */
  routingHeaders(): Record<string, string> {
    return { ...this.session.routingHeaders(), ...this.#headers };
  }

  /** One action, sent. The raw response, for a caller that reads a status this does not. */
  protected async post(
    action: string,
    payload: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const sent = { ...this.routingHeaders(), ...headers, ...this.authHeaders(action, body) };
    return this.client.post(`${this.session.baseUrl}/`, body, this.target, action, sent, timeoutMs);
  }

  /**
   * One of the actions whose body is bytes rather than JSON, described by its headers instead.
   *
   * The content type is the only routing header that changes, and neither signing scheme covers it -
   * both sign a fixed list of headers, which is what lets this differ without the signature having to
   * know.
   */
  protected async postBytes(
    action: string,
    data: Bytes,
    headers: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const bytes = bytesOf(data);
    const sent = {
      ...this.routingHeaders(),
      "content-type": "application/octet-stream",
      ...headers,
      ...this.authHeaders(action, bytes),
    };
    return this.client.post(`${this.session.baseUrl}/`, bytes, this.target, action, sent, timeoutMs);
  }

  /**
   * How this request authenticates - and what it is rebuilt with when the server says the credentials
   * had expired.
   *
   * A byte-carrying action presents the session's bearer token rather than a signature, which is what
   * euclid-cli and euclid-jdk do for the same actions, so all of them write an object the same way. A
   * session that {@link EuclidSession.alwaysSigns} signs them anyway: it asked not to be handed a token
   * silently, and a signature over raw bytes is exact here in a way it is not in every language.
   */
  protected authHeaders(action: string, body: Buffer): Record<string, string> {
    if (this.#byteActions.has(action) && !this.session.alwaysSigns) return this.session.bearerHeaders();
    return this.session.authHeaders(this.target, action, body);
  }

  /** The response body as an object, or the server's own reason for refusing. */
  protected result(action: string, response: Response): Record<string, unknown> {
    if (!response.ok) throw new EuclidServiceError(this.target, action, response.status, response.text);
    const parsed = response.json();
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { result: parsed };
  }

  // -- reading answers -------------------------------------------------------------------------

  /** An action whose answer is one string - an ERN, mostly. */
  protected async textOf(action: string, payload: Record<string, unknown>, field: string): Promise<string> {
    const value = (await this.call(action, payload))[field];
    return typeof value === "string" ? value : "";
  }

  /** An action whose answer is one number - a size, a count. */
  protected async numberOf(action: string, payload: Record<string, unknown>, field: string): Promise<number> {
    const value = (await this.call(action, payload))[field];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }
}

/** A listing's paging and ordering, with the server's defaults filled in where the caller said nothing. */
export function pagePayload(options: PageOptions, defaultSortColumn: string): Record<string, unknown> {
  return {
    pageSize: options.pageSize ?? 10,
    pageIndex: options.pageIndex ?? 0,
    sortColumn: options.sortColumn ?? defaultSortColumn,
    sortDirection: options.sortDirection ?? "asc",
  };
}

/** The same, for the listings that also narrow by prefix. */
export function listPayload(options: ListOptions, defaultSortColumn: string): Record<string, unknown> {
  return { prefix: options.prefix ?? "", ...pagePayload(options, defaultSortColumn) };
}

/** One request body's bytes, whichever of the three spellings a caller reached for. */
export function bytesOf(data: Bytes): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
