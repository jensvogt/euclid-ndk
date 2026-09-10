/**
 * The connection to a euclid server.
 *
 * euclid speaks one request shape: `POST /` with a JSON body, the module named in
 * `x-euclid-target` and the operation in `x-euclid-action`. Everything else - which module, which
 * action, who is asking - travels in headers, which is why the signing schemes cover the headers
 * they do. This client knows that shape and nothing about any particular module.
 *
 * Built on node's own `http`/`https` rather than a third-party client so that installing this SDK
 * does not drag a dependency tree into an application that only wanted to call euclid.
 */

import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { rootCertificates } from "node:tls";

/**
 * Where euclid installs the certificate its gateway presents. Applied only when the file is there,
 * so this is a no-op on a machine with no euclid deployment, and the same default euclid-cli uses.
 */
export const DEFAULT_CA_CERT_PATH = "/etc/euclid/euclid_cert.crt";

/** How long to wait for a response, in milliseconds, unless a call overrides it. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** One HTTP response, with the body already read. */
export class Response {
  readonly status: number;
  readonly reason: string;
  readonly headers: Record<string, string>;
  readonly content: Buffer;

  constructor(status: number, reason: string, headers: Record<string, string>, content: Buffer) {
    this.status = status;
    this.reason = reason;
    this.headers = headers;
    this.content = content;
  }

  /** Whether the server answered 2xx. */
  get ok(): boolean {
    return Math.floor(this.status / 100) === 2;
  }

  /** The body decoded as UTF-8. */
  get text(): string {
    return this.content.toString("utf8");
  }

  /** The body parsed as JSON. An empty body reads as an empty object. */
  json(): unknown {
    return this.content.toString("utf8").trim() ? JSON.parse(this.content.toString("utf8")) : {};
  }
}

/** How a request's authentication headers are rebuilt when the first attempt is refused. */
export type HeaderFactory = (action: string, body: Buffer) => Record<string, string>;

export interface HttpClientOptions {
  /**
   * A PEM CA certificate to trust *alongside* the system trust store, for reaching a euclid server
   * that presents its own certificate. Null uses only the system store. Mirrors euclid-cli's
   * `--ca-cert`.
   */
  caCertPath?: string | null;
  /** How long to wait for a response, in milliseconds, unless a call overrides it. */
  timeoutMs?: number;
  /**
   * Whether to verify the server certificate at all. Turning it off is for a development server
   * with a certificate nothing vouches for, and for nothing else.
   */
  verify?: boolean;
}

/**
 * Sends euclid's action requests over a connection it keeps open.
 *
 * One keep-alive agent rather than a connection per call: a fresh connection per action would pay
 * for a TLS handshake every time, and node's agent already serialises what has to be serialised.
 *
 * Two retries are built in, and both are deliberately narrow:
 *
 * - A connection closed while it sat idle - by the server's timeout, a proxy, a load balancer - is
 *   not visible until the next write, and surfaces as a failure with no response at all. That is
 *   retried once on a fresh connection. It is not quite the same as knowing the request was never
 *   processed, so this trades a possible repeat for the far commoner case of a socket that was
 *   already gone.
 * - A 401 whose body says the credentials had expired is retried once with rebuilt headers, if
 *   {@link EuclidHttpClient.headerFactory} was given one and it produces different headers. A wrong
 *   password or a missing permission is answered once, as before; and a token nobody has refreshed
 *   comes back identical, so there is nothing to retry with.
 */
export class EuclidHttpClient {
  readonly caCertPath: string | null;

  #timeoutMs: number;
  #verify: boolean;
  #agents = new Map<string, http.Agent | https.Agent>();
  #headerFactory: HeaderFactory | null = null;
  #ca: string | null = null;
  #caLoaded = false;

  constructor(options: HttpClientOptions = {}) {
    this.caCertPath = options.caCertPath ?? null;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#verify = options.verify ?? true;
  }

  /**
   * Registers how to rebuild the authentication headers for an `(action, body)` pair.
   *
   * Without one, a request whose credentials expired between the header being built and the server
   * reading it fails like any other error - which for a long-lived application is a business
   * operation lost to a token that a second attempt would have carried correctly.
   */
  headerFactory(factory: HeaderFactory | null): this {
    this.#headerFactory = factory;
    return this;
  }

  /**
   * Sends one euclid action request.
   *
   * @param url the full URL to post to, normally the server's base URL plus `/`.
   * @param body the JSON request body.
   * @param target the module to route to, e.g. `"eam"`.
   * @param action the operation, e.g. `"list-users"`.
   * @param headers authentication and routing headers, as a module client builds them.
   * @param timeoutMs overrides this client's timeout, for the actions a server answers slowly on
   *   purpose - a long poll is told how many seconds to hold the request open, and a caller
   *   unwilling to wait that long would abandon a request still being served.
   */
  async post(
    url: string,
    body: Buffer | string,
    target: string,
    action: string,
    headers: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<Response> {
    const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const sent: Record<string, string> = { ...headers, "x-euclid-target": target, "x-euclid-action": action };

    const response = await this.#send(url, payload, sent, timeoutMs);

    const refreshed = this.#refreshedHeaders(response, action, payload, sent);
    if (refreshed === null) return response;
    return this.#send(url, payload, refreshed, timeoutMs);
  }

  /** Releases the connections this client was holding. */
  close(): void {
    for (const agent of this.#agents.values()) agent.destroy();
    this.#agents.clear();
  }

  // -- internals -----------------------------------------------------------------------------

  /**
   * The headers to retry with, or null if this response should not be retried.
   *
   * Kept narrow so it never turns one real rejection into two: only 401, only when the server said
   * the credentials had expired, and only when the rebuilt headers actually differ.
   */
  #refreshedHeaders(
    response: Response,
    action: string,
    body: Buffer,
    headers: Record<string, string>,
  ): Record<string, string> | null {
    if (this.#headerFactory === null || response.status !== 401) return null;
    if (!response.text.toLowerCase().includes("expired")) return null;

    const refreshed = { ...headers, ...this.#headerFactory(action, body) };
    return sameHeaders(refreshed, headers) ? null : refreshed;
  }

  async #send(
    url: string,
    body: Buffer,
    headers: Record<string, string>,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    try {
      return await this.#exchange(url, body, headers, timeoutMs);
    } catch (error) {
      // No response at all came back, which is what a connection closed while it was idle looks
      // like from here. One more attempt, on a socket that is definitely new.
      if (!isRetryable(error)) throw error;
      this.#dropAgent(url);
      return this.#exchange(url, body, headers, timeoutMs);
    }
  }

  async #exchange(
    url: string,
    body: Buffer,
    headers: Record<string, string>,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const agent = await this.#agentFor(url, secure);
    const effectiveTimeout = timeoutMs ?? this.#timeoutMs;

    const options: https.RequestOptions = {
      method: "POST",
      host: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      // Host is the client's to set: it is a signed header, and letting node compose it would put
      // a different spelling on the wire than the one the signature covers.
      headers: { ...headers, "content-length": String(body.length) },
      agent,
      timeout: effectiveTimeout,
    };
    if (secure && !this.#verify) options.rejectUnauthorized = false;

    return new Promise<Response>((resolve, reject) => {
      const request = (secure ? https : http).request(options, (message) => {
        const chunks: Buffer[] = [];
        message.on("data", (chunk: Buffer) => chunks.push(chunk));
        message.on("end", () => {
          const responseHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(message.headers)) {
            if (value !== undefined) responseHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          resolve(new Response(message.statusCode ?? 0, message.statusMessage ?? "", responseHeaders, Buffer.concat(chunks)));
        });
        message.on("error", reject);
      });

      request.on("timeout", () => {
        // node does not fail a timed-out request by itself; it only tells us the socket went quiet.
        request.destroy(new Error(`no response within ${effectiveTimeout}ms`));
      });
      request.on("error", reject);
      request.end(body);
    });
  }

  /**
   * The keep-alive agent for one origin, built on first use.
   *
   * The CA file is read once, here, rather than per request: it is the same file every time, and a
   * client that read it on every call would turn one action into two system calls plus a parse.
   */
  async #agentFor(url: string, secure: boolean): Promise<http.Agent | https.Agent> {
    const key = originOf(url);
    const existing = this.#agents.get(key);
    if (existing) return existing;

    let agent: http.Agent | https.Agent;
    if (secure) {
      const ca = await this.#caCertificate();
      // Added to the system trust store rather than replacing it, so a certificate is accepted if
      // either root set vouches for it - the same union euclid-cli builds with
      // set_default_verify_paths() followed by load_verify_file(). Node replaces the store when
      // "ca" is given, so the union has to be spelled out.
      agent = new https.Agent({ keepAlive: true, ...(ca ? { ca: [...rootCertificates, ca] } : {}) });
    } else {
      agent = new http.Agent({ keepAlive: true });
    }
    this.#agents.set(key, agent);
    return agent;
  }

  async #caCertificate(): Promise<string | null> {
    if (this.#caLoaded) return this.#ca;
    this.#caLoaded = true;
    if (this.caCertPath) {
      try {
        this.#ca = await readFile(this.caCertPath, "utf8");
      } catch {
        // Absent is the ordinary case on a machine with no euclid deployment - see
        // DEFAULT_CA_CERT_PATH - and unreadable is the same thing as far as trust goes.
        this.#ca = null;
      }
    }
    return this.#ca;
  }

  #dropAgent(url: string): void {
    const key = originOf(url);
    const agent = this.#agents.get(key);
    if (agent) {
      agent.destroy();
      this.#agents.delete(key);
    }
  }
}

function originOf(url: string): string {
  const target = new URL(url);
  return `${target.protocol}//${target.host}`;
}

function sameHeaders(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * Failures that mean nothing came back. A reset, a broken pipe, or a socket that hung up where the
 * status line should have been is a dead cached socket, and a fresh one usually answers. A refused
 * connection is not in here: that one means the server is not listening, and a second attempt a
 * microsecond later would tell the caller the same thing more slowly.
 */
function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "ECONNRESET" || code === "EPIPE") return true;
  return error instanceof Error && error.message.includes("socket hang up");
}
