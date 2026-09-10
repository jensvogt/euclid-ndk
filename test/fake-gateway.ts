/**
 * A stand-in euclid server, for tests that need one.
 *
 * Small enough to read in one sitting, and deliberately strict about the parts the SDK has to get
 * right: it authenticates the way `Core::HttpActionServer::Authenticate` does - an RFC 9421
 * signature first, then a bearer token, then SigV4 - dispatches on `x-euclid-action`, and answers
 * errors in the `{"error": "..."}` shape the real server uses.
 *
 * It records every request it saw, so a test can assert on what actually went over the wire rather
 * than on what the client meant to send.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import { RFC9421, SignableRequest, signingSchemeOf } from "../src/index.js";

/** One request as the server received it. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  target: string;
  action: string;
  /** How the request authenticated: "rfc9421", "sigv4", "bearer" or "" for none. */
  auth: string;
  /** The user the request was authenticated as, once it was. */
  subject: string;
  json(): Record<string, unknown>;
}

/**
 * What to answer with: a status, and a payload.
 *
 * A Buffer payload is answered as bytes rather than as JSON, because two of ESM's actions hand back an
 * object's bytes - and a test that received them base64-wrapped would be testing something else.
 */
export type Handler = (request: RecordedRequest) => [number, unknown] | Promise<[number, unknown]>;

/** A running fake server. Start it with {@link FakeGateway.start}; `baseUrl` is where it listens. */
export class FakeGateway {
  /** access key ID -> [secret, user id]. A signature is accepted when the key is in here. */
  readonly accessKeys = new Map<string, [string, string]>();
  /** Bearer tokens that authenticate, mapped to the user they authenticate as. */
  readonly tokens = new Map<string, string>();
  /** "target/action" -> handler. A missing one is a 400, as on the real server. */
  readonly handlers = new Map<string, Handler>();
  /** Actions that need no authentication at all. `login` is the real one. */
  readonly publicActions = new Set<string>(["eam/login"]);
  /** Every request seen, in order. */
  readonly requests: RecordedRequest[] = [];

  #server: Server | null = null;

  async start(): Promise<this> {
    this.#server = createServer((message, response) => {
      void this.#handle(message, response);
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === null) return;
    this.#server = null;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  get baseUrl(): string {
    if (this.#server === null) throw new Error("the gateway is not running");
    const address = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  /** Registers what to answer for one action. */
  on(target: string, action: string, handler: Handler): this {
    this.handlers.set(`${target}/${action}`, handler);
    return this;
  }

  /** Registers a fixed answer for one action. */
  answer(target: string, action: string, payload: unknown, status = 200): this {
    return this.on(target, action, () => [status, payload]);
  }

  /** The most recent request. Throws if there was none, which is itself a useful failure. */
  last(): RecordedRequest {
    const request = this.requests[this.requests.length - 1];
    if (request === undefined) throw new Error("no request was made");
    return request;
  }

  // -- internals ---------------------------------------------------------------------------------

  async #handle(message: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of message) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(message.headers)) {
      if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
    }

    const recorded: RecordedRequest = {
      method: message.method ?? "",
      path: message.url ?? "",
      headers,
      body,
      target: headers["x-euclid-target"] ?? "",
      action: headers["x-euclid-action"] ?? "",
      auth: "",
      subject: "",
      json: () => (body.length > 0 ? (JSON.parse(body.toString("utf8")) as Record<string, unknown>) : {}),
    };
    this.requests.push(recorded);

    const [status, payload] = await this.#dispatch(recorded);
    const binary = Buffer.isBuffer(payload);
    const encoded = binary ? payload : Buffer.from(JSON.stringify(payload), "utf8");
    response.writeHead(status, {
      "content-type": binary ? "application/octet-stream" : "application/json",
      "content-length": encoded.length,
    });
    response.end(encoded);
  }

  async #dispatch(request: RecordedRequest): Promise<[number, unknown]> {
    if (!request.action) return [400, { error: "Missing x-euclid-action header" }];

    if (!this.publicActions.has(`${request.target}/${request.action}`)) {
      const denial = this.#authenticate(request);
      if (denial !== null) return denial;
    }

    const handler = this.handlers.get(`${request.target}/${request.action}`);
    if (handler === undefined) return [400, { error: `Unknown action ${request.action}` }];
    return handler(request);
  }

  /** Null when the request authenticates, otherwise the response to send instead. */
  #authenticate(request: RecordedRequest): [number, unknown] | null {
    const signable = this.#signable(request);
    const scheme = signingSchemeOf(signable);

    if (scheme !== null) {
      const keyId = scheme.verify(signable, (key) => this.accessKeys.get(key)?.[0] ?? null);
      if (keyId === null) return [403, { error: "Signature does not match" }];
      request.auth = scheme === RFC9421 ? "rfc9421" : "sigv4";
      request.subject = this.accessKeys.get(keyId)![1];
      return null;
    }

    const authorization = request.headers["authorization"] ?? "";
    if (authorization.startsWith("Bearer ")) {
      const subject = this.tokens.get(authorization.slice("Bearer ".length));
      if (subject === undefined) return [401, { error: "Bearer token expired" }];
      request.auth = "bearer";
      request.subject = subject;
      return null;
    }

    return [401, { error: "Missing or invalid bearer token" }];
  }

  #signable(request: RecordedRequest): SignableRequest {
    return new SignableRequest(request.method, request.path)
      .headersFrom(request.headers)
      .setBody(request.body)
      .setScheme("http");
  }
}

/** The signing credentials a stubbed login hands out. AWS's own example key, as the test vectors use. */
export const ACCESS_KEY_ID = "AKIAEXAMPLE";
export const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

/**
 * A bearer token that expires when it says it does.
 *
 * Shaped like a JWT because that is what the session reads to decide whether a cached login is still
 * good; nothing here verifies the signature, and neither does that check.
 */
export function token(expiresInSeconds = 3600): string {
  const segment = (payload: object): string => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${segment({ alg: "HS256" })}.${segment({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
}

/**
 * Makes a gateway answer a login, and tells it the credentials that login handed out.
 *
 * Answers with the token, for a test that wants to expire it, rotate it or hand it back later.
 * `withKey: false` is the user who has no access key, and so has nothing to sign with.
 */
export function prepareLogin(gateway: FakeGateway, options: { withKey?: boolean; token?: string } = {}): string {
  const bearer = options.token ?? token();
  const withKey = options.withKey ?? true;
  gateway.answer("eam", "login", {
    metadata: { region: "eu-central-1", accountId: "000000000000", user: "jens" },
    token: bearer,
    accessKeyId: withKey ? ACCESS_KEY_ID : "",
    secretAccessKey: withKey ? SECRET_ACCESS_KEY : "",
    createdAt: "2026-09-10T10:00:00Z",
    isAdmin: true,
  });
  gateway.tokens.set(bearer, "jens");
  if (withKey) gateway.accessKeys.set(ACCESS_KEY_ID, [SECRET_ACCESS_KEY, "jens"]);
  return bearer;
}

/** Runs `body` against a gateway that is started and stopped around it. */
export async function withGateway(body: (gateway: FakeGateway) => Promise<void>): Promise<void> {
  const gateway = await new FakeGateway().start();
  try {
    await body(gateway);
  } finally {
    await gateway.stop();
  }
}
