/**
 * EAM - euclid's access management module: login, users, groups, accounts, namespaces, keys.
 *
 * Two objects. {@link EuclidEam} is the login builder: it collects the server, the credentials and
 * the options, and hands back a session. {@link EuclidSession} is that session - the authenticated
 * client every other call goes through, and the thing that holds the token and the access key the
 * login produced.
 *
 * The split exists because logging in and being logged in need different arguments. A builder that
 * also carried the operations would let a caller write `.listUsers()` on an object that has not
 * authenticated yet, and a session that also carried the login options would have a namespace field
 * that means one thing before login and another after.
 */

import { SIGV4, SignableRequest, type SigningScheme } from "../auth/index.js";
import {
  type CachedCredentials,
  emptyCredentials,
  isTokenValid,
  load as loadCredentials,
  save as saveCredentials,
  updateNamespace as updateCachedNamespace,
} from "../credentials.js";
import {
  type Account,
  type AccessKey,
  type CreateAccessKeyResult,
  type Namespace,
  type Page,
  toAccessKey,
  toAccount,
  toCreateAccessKeyResult,
  toLoginResult,
  toNamespace,
  toPage,
  toUser,
  toUserGroup,
  type User,
  type UserGroup,
} from "../dto/eam.js";
import { EuclidAuthenticationError, EuclidServiceError } from "../errors.js";
import { DEFAULT_CA_CERT_PATH, DEFAULT_TIMEOUT_MS, EuclidHttpClient, type HeaderFactory } from "../http/client.js";
import { authorityOf, hostHeaderOf, schemeOf, stripTrailingSlash } from "../url.js";
import { listPayload, type ListOptions, type ModuleClient } from "./base.js";
// This module imports the clients and they import nothing of it but its types, which is what keeps the
// two-way relationship - a client needs the session it authenticates as, a session hands out the
// clients - out of the runtime module graph. See EuclidSession.alwaysSigns for the one place that
// would otherwise have put it back.
import { EuclidEag } from "./eag.js";
import { EuclidEap } from "./eap.js";
import { EuclidEkm } from "./ekm.js";
import { EuclidEkv } from "./ekv.js";
import { EuclidEns } from "./ens.js";
import { EuclidEqs } from "./eqs.js";
import { EuclidEsm } from "./esm.js";
import { EuclidEss } from "./ess.js";

export type { ListOptions } from "./base.js";

export const TARGET = "eam";

/**
 * Authenticate with a signature when there is an access key to sign with, and with the bearer token
 * otherwise. euclid accepts either for every action (`HttpActionServer::Authenticate`).
 */
export const AUTH_AUTO = "auto";
/**
 * Always sign. Fails loudly if the session has no access key, rather than quietly falling back to a
 * token - which is what a caller who asked for signatures wants to know about.
 */
export const AUTH_SIGNATURE = "signature";
/** Always present the bearer token, even when an access key is available. */
export const AUTH_BEARER = "bearer";

/** How a session authenticates: {@link AUTH_AUTO}, {@link AUTH_SIGNATURE} or {@link AUTH_BEARER}. */
export type AuthMode = typeof AUTH_AUTO | typeof AUTH_SIGNATURE | typeof AUTH_BEARER;

/** Everything {@link EuclidSession} needs to exist, which is what a login produces. */
export interface SessionOptions {
  baseUrl: string;
  token: string;
  userId: string;
  accountId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  isAdmin: boolean;
  namespace: string;
  raw: Record<string, unknown>;
  caCertPath: string | null;
  verify: boolean;
  timeoutMs: number;
  signingScheme: SigningScheme;
  auth: AuthMode;
  cache: boolean;
}

/**
 * Builder for authenticating against a euclid server.
 *
 * ```ts
 * const session = await EuclidEam.forServer("https://euclid.example.com")
 *   .credentials("jens", "secret")
 *   .login();
 * ```
 */
export class EuclidEam {
  #baseUrl: string;
  #loginPath = "/";
  #username: string | null = null;
  #email: string | null = null;
  #password: string | null = null;
  #namespace: string | null = null;
  // Applied only when the file is actually there, so this default is a no-op on a machine with no
  // euclid deployment and the right thing on one that has.
  #caCertPath: string | null = DEFAULT_CA_CERT_PATH;
  #verify = true;
  #timeoutMs = DEFAULT_TIMEOUT_MS;
  #signingScheme: SigningScheme = SIGV4;
  #auth: AuthMode = AUTH_AUTO;
  #useCache = true;

  constructor(baseUrl: string) {
    this.#baseUrl = stripTrailingSlash(baseUrl);
  }

  /** Targets a euclid server, e.g. `https://euclid.example.com`. */
  static forServer(baseUrl: string): EuclidEam {
    if (!baseUrl) throw new Error("baseUrl must not be empty");
    return new EuclidEam(baseUrl);
  }

  // -- builder ---------------------------------------------------------------------------------

  /** The user ID to log in as. */
  username(username: string): this {
    this.#username = username;
    return this;
  }

  /**
   * The email address to log in with, when there is no user ID.
   *
   * The server resolves the user by ID first and only falls back to the email, so setting both
   * silently ignores the email; {@link login} sends whichever one identifies the account.
   */
  email(email: string): this {
    this.#email = email;
    return this;
  }

  /** The password. */
  password(password: string): this {
    this.#password = password;
    return this;
  }

  /** User ID and password together. */
  credentials(username: string, password: string): this {
    return this.username(username).password(password);
  }

  /**
   * The namespace to make active once login succeeds.
   *
   * Applied with a follow-up `change-namespace` call, mirroring euclid-cli's `eam login
   * --namespace`, and applied whether the login was fresh or served from the cache - a cached
   * session may have been established before this was ever asked for, or scoped to another
   * namespace.
   */
  namespace(namespace: string): this {
    this.#namespace = namespace;
    return this;
  }

  /** The path to post the login to. `/` unless a deployment puts the gateway elsewhere. */
  loginPath(path: string): this {
    this.#loginPath = path.startsWith("/") ? path : `/${path}`;
    return this;
  }

  /** A PEM CA certificate to trust alongside the system store, or null for the store alone. */
  caCertPath(path: string | null): this {
    this.#caCertPath = path;
    return this;
  }

  /** Whether to verify the server's certificate. Turn it off for development servers only. */
  verify(verify: boolean): this {
    this.#verify = verify;
    return this;
  }

  /** How long to wait for a response, in milliseconds. */
  timeout(milliseconds: number): this {
    this.#timeoutMs = milliseconds;
    return this;
  }

  /**
   * Which signing scheme the session signs with. SigV4 unless told otherwise, as euclid's server
   * has understood that one from the start.
   */
  signingScheme(scheme: SigningScheme): this {
    this.#signingScheme = scheme;
    return this;
  }

  /** How the session authenticates: {@link AUTH_AUTO}, {@link AUTH_SIGNATURE} or {@link AUTH_BEARER}. */
  auth(mode: AuthMode): this {
    if (mode !== AUTH_AUTO && mode !== AUTH_SIGNATURE && mode !== AUTH_BEARER) {
      throw new Error(`auth must be one of "${AUTH_AUTO}", "${AUTH_SIGNATURE}", "${AUTH_BEARER}"`);
    }
    this.#auth = mode;
    return this;
  }

  /**
   * Whether `~/.euclid/credentials` may be read and written. On by default, which is what makes a
   * login shared with euclid-cli, euclid-jdk and euclid-pdk.
   */
  useCache(useCache: boolean): this {
    this.#useCache = useCache;
    return this;
  }

  // -- login -----------------------------------------------------------------------------------

  /**
   * Authenticates, and answers with the session every other call goes through.
   *
   * A still-valid cached session for this server is reused rather than re-authenticating, so
   * calling this repeatedly costs nothing after the first time. Pass `useCache(false)` to force a
   * fresh login.
   *
   * @throws {EuclidAuthenticationError} if the server refuses the credentials.
   * @throws {Error} if no password, or neither a username nor an email, was set and there is no
   *   cached session to fall back on.
   */
  async login(): Promise<EuclidSession> {
    const cached = await this.#cachedSession();
    if (cached !== null) {
      if (this.#namespace !== null && this.#namespace !== cached.namespace) {
        await cached.changeNamespace(this.#namespace);
      }
      return cached;
    }

    if (!this.#username && !this.#email) throw new Error("username or email must be set before calling login()");
    if (this.#password === null) throw new Error("password must be set before calling login()");

    // Only one identifier goes out: the server takes the user ID when it is present and only falls
    // back to the email, so sending both would silently ignore the email.
    const body = JSON.stringify({
      userId: this.#username ?? "",
      password: this.#password,
      email: this.#username ? "" : (this.#email ?? ""),
    });

    const client = new EuclidHttpClient({
      caCertPath: this.#caCertPath,
      timeoutMs: this.#timeoutMs,
      verify: this.#verify,
    });
    let response;
    try {
      response = await client.post(this.#baseUrl + this.#loginPath, body, TARGET, "login", {
        "content-type": "application/json",
        host: hostHeaderOf(this.#baseUrl),
      });
    } finally {
      client.close();
    }

    if (!response.ok) throw new EuclidAuthenticationError(response.status, response.text);

    const result = toLoginResult(response.json());
    const session = new EuclidSession({
      baseUrl: this.#baseUrl,
      token: result.token,
      userId: result.metadata.user,
      accountId: result.metadata.accountId,
      region: result.metadata.region,
      accessKeyId: result.accessKeyId,
      secretAccessKey: result.secretAccessKey,
      isAdmin: result.isAdmin,
      namespace: "",
      raw: result.raw,
      caCertPath: this.#caCertPath,
      verify: this.#verify,
      timeoutMs: this.#timeoutMs,
      signingScheme: this.#signingScheme,
      auth: this.#auth,
      cache: this.#useCache,
    });

    if (this.#namespace) await session.changeNamespace(this.#namespace);
    if (this.#useCache) await saveCredentials(session.toCachedCredentials());
    return session;
  }

  /**
   * A session rebuilt from `~/.euclid/credentials`, if one is cached for this server and its token
   * has not expired.
   */
  async #cachedSession(): Promise<EuclidSession | null> {
    if (!this.#useCache) return null;
    const cached = await loadCredentials();
    if (cached === null || !cached.token || cached.baseUrl !== this.#baseUrl) return null;
    if (!isTokenValid(cached.token)) return null;

    return new EuclidSession({
      baseUrl: this.#baseUrl,
      token: cached.token,
      userId: cached.userId,
      accountId: cached.accountId,
      region: cached.region,
      accessKeyId: cached.accessKeyId,
      secretAccessKey: cached.secretAccessKey,
      isAdmin: cached.isAdmin,
      namespace: cached.namespace,
      raw: cached.raw,
      caCertPath: this.#caCertPath,
      verify: this.#verify,
      timeoutMs: this.#timeoutMs,
      signingScheme: this.#signingScheme,
      auth: this.#auth,
      cache: this.#useCache,
    });
  }
}

/**
 * An authenticated session, and every EAM operation that needs one.
 *
 * Holds two credentials, because the server accepts two. The bearer token is what a login always
 * produces; the access key and secret are what it produces when the user has one, and they are what
 * a signature is made with. Which of the two a request presents is decided per session by
 * {@link EuclidSession.auth} - see {@link AUTH_AUTO}.
 *
 * Sessions are mutable: {@link EuclidSession.changeNamespace} changes this session rather than
 * answering with a new one, since the namespace is a property of what the caller is doing next
 * rather than of the login.
 */
export class EuclidSession {
  readonly baseUrl: string;
  token: string;
  readonly userId: string;
  readonly accountId: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly isAdmin: boolean;
  namespace: string;
  readonly raw: Record<string, unknown>;
  signingScheme: SigningScheme;
  readonly auth: AuthMode;

  /**
   * Where the bearer token comes from, when it does not simply come from {@link EuclidSession.token}.
   *
   * A process that runs for days holds a token that does not last that long. euclid rewrites an
   * application's credentials file before the token in it expires, so an application that cached the
   * first token it saw would start collecting 401s about an hour in. Setting this to something that
   * re-reads that file makes the session follow the rotation, and is what the retry on "credentials
   * expired" then has something new to retry with.
   */
  tokenProvider: (() => string) | null = null;

  readonly #cache: boolean;
  readonly #hostHeader: string;
  readonly #scheme: string;
  // Kept so that a module client this session hands out reaches the same server on the same terms,
  // rather than having to be told the connection settings again.
  readonly #connection: { caCertPath: string | null; timeoutMs: number; verify: boolean };
  readonly #modules = new Map<string, ModuleClient>();
  readonly #client: EuclidHttpClient;

  constructor(options: SessionOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.userId = options.userId;
    this.accountId = options.accountId;
    this.region = options.region;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.isAdmin = options.isAdmin;
    this.namespace = options.namespace;
    this.raw = options.raw;
    this.signingScheme = options.signingScheme;
    this.auth = options.auth;

    this.#cache = options.cache;
    this.#hostHeader = hostHeaderOf(options.baseUrl);
    this.#scheme = schemeOf(options.baseUrl);
    this.#connection = { caCertPath: options.caCertPath, timeoutMs: options.timeoutMs, verify: options.verify };
    this.#client = this.newClient((action, body) => this.authHeaders(TARGET, action, body));
  }

  // -- identity --------------------------------------------------------------------------------

  /** This session in the shape `~/.euclid/credentials` holds it. */
  toCachedCredentials(): CachedCredentials {
    return {
      ...emptyCredentials(),
      token: this.token,
      userId: this.userId,
      accountId: this.accountId,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      isAdmin: this.isAdmin,
      baseUrl: this.baseUrl,
      namespace: this.namespace || "",
    };
  }

  /** The `@authority` this session's signatures are made over, for diagnostics. */
  get authority(): string {
    return authorityOf(this.baseUrl);
  }

  /**
   * Whether this session signs even the requests that would otherwise present the token.
   *
   * What {@link AUTH_SIGNATURE} means to a module whose action carries raw bytes: those present the
   * token by default, and a session that asked for signatures gets them anyway. Asked of the session
   * rather than read off {@link auth} by each module client, so that "what this mode means" is decided
   * in one place - and so that a module client needs no value out of this module at all, which is what
   * keeps the import between the two one-directional.
   */
  get alwaysSigns(): boolean {
    return this.auth === AUTH_SIGNATURE;
  }

  /** Releases the connections this session was holding, its module clients' included. */
  close(): void {
    this.#client.close();
    for (const module of this.#modules.values()) module.close();
    this.#modules.clear();
  }

  // -- the other modules -----------------------------------------------------------------------

  /**
   * ESM - euclid's storage module - on this session's credentials.
   *
   * The same client each time, so an application that reaches for this inside a loop pays for one
   * connection rather than one per iteration. It follows this session: a {@link changeNamespace}
   * between two calls scopes the second one, and a {@link tokenProvider} set here is the token it
   * presents.
   */
  esm(): EuclidEsm {
    return this.#module("esm", () => new EuclidEsm(this));
  }

  /** EQS - euclid's queue module - on this session's credentials. */
  eqs(): EuclidEqs {
    return this.#module("eqs", () => new EuclidEqs(this));
  }

  /** ENS - euclid's notification module - on this session's credentials. */
  ens(): EuclidEns {
    return this.#module("ens", () => new EuclidEns(this));
  }

  /** EKM - euclid's key management module - on this session's credentials. */
  ekm(): EuclidEkm {
    return this.#module("ekm", () => new EuclidEkm(this));
  }

  /** EKV - euclid's key-value store - on this session's credentials. */
  ekv(): EuclidEkv {
    return this.#module("ekv", () => new EuclidEkv(this));
  }

  /** EAP - euclid's application platform - on this session's credentials. */
  eap(): EuclidEap {
    return this.#module("eap", () => new EuclidEap(this));
  }

  /** ESS - euclid's secret store - on this session's credentials. */
  ess(): EuclidEss {
    return this.#module("ess", () => new EuclidEss(this));
  }

  /** EAG - euclid's API gateway - on this session's credentials. */
  eag(): EuclidEag {
    return this.#module("eag", () => new EuclidEag(this));
  }

  /** One client per module rather than one per call, built the first time it is asked for. */
  #module<T extends ModuleClient>(name: string, factory: () => T): T {
    const existing = this.#modules.get(name);
    if (existing !== undefined) return existing as T;
    const client = factory();
    this.#modules.set(name, client);
    return client;
  }

  // -- users -----------------------------------------------------------------------------------

  /** One page of users, and how many exist in total. */
  async listUsers(options: ListOptions = {}): Promise<Page<User>> {
    return toPage(await this.call("list-users", listPayload(options, "userId")), "users", toUser);
  }

  /** Creates a user. `accountId` and `region` default to this session's own. */
  async register(
    userId: string,
    password: string,
    options: { email?: string; accountId?: string; region?: string; isAdmin?: boolean } = {},
  ): Promise<User> {
    const response = await this.call("register", {
      userId,
      password,
      email: options.email ?? "",
      accountId: options.accountId || this.accountId,
      region: options.region || this.region,
      isAdmin: options.isAdmin ?? false,
    });
    return toUser((response as { user?: unknown }).user);
  }

  /** Deletes a user. */
  async deleteUser(userId: string): Promise<void> {
    await this.call("delete-user", { userId });
  }

  // -- namespace scoping -----------------------------------------------------------------------

  /**
   * Switches the namespace every namespace-scoped call is restricted to, until changed again.
   *
   * The server validates it against the current account and the caller's grants, so this is a round
   * trip rather than a local assignment. An empty string clears the scope.
   *
   * Answers with this session, so it can be chained onto a login.
   */
  async changeNamespace(namespace: string): Promise<this> {
    await this.call("change-namespace", { namespace });
    this.namespace = namespace;
    if (this.#cache) await updateCachedNamespace(this.baseUrl, namespace);
    return this;
  }

  // -- access keys -----------------------------------------------------------------------------

  /**
   * Creates an access key for this session's user.
   *
   * The secret comes back here and nowhere else - {@link listAccessKeys} will never show it again -
   * so a caller that does not store it has to create another key.
   */
  async createAccessKey(): Promise<CreateAccessKeyResult> {
    return toCreateAccessKeyResult(await this.call("create-access-key"));
  }

  /** This user's own access keys, without their secrets. */
  async listAccessKeys(): Promise<AccessKey[]> {
    const response = await this.call("list-access-keys");
    const keys = (response as { accessKeys?: unknown }).accessKeys;
    return Array.isArray(keys) ? keys.map(toAccessKey) : [];
  }

  /** Deletes one of this user's own access keys. */
  async deleteAccessKey(accessKeyId: string): Promise<void> {
    await this.call("delete-access-key", { accessKeyId });
  }

  // -- user groups -----------------------------------------------------------------------------

  /** Creates an empty user group. Administrator only. */
  async createUserGroup(name: string, description = ""): Promise<UserGroup> {
    const response = await this.call("create-user-group", { name, description });
    return toUserGroup((response as { userGroup?: unknown }).userGroup);
  }

  /** One page of user groups, and how many exist in total. */
  async listUserGroups(options: ListOptions = {}): Promise<Page<UserGroup>> {
    return toPage(await this.call("list-user-groups", listPayload(options, "name")), "userGroups", toUserGroup);
  }

  /** Adds a user to a group. Both are ERNs. */
  async addUserToUserGroup(userGroup: string, user: string): Promise<void> {
    await this.call("user-group-add-user", { userGroup, user });
  }

  /** Removes a user from a group. Both are ERNs. */
  async removeUserFromUserGroup(userGroup: string, user: string): Promise<void> {
    await this.call("user-group-remove-user", { userGroup, user });
  }

  /** Deletes a user group. Administrator only. */
  async deleteUserGroup(name: string): Promise<void> {
    await this.call("delete-user-group", { name });
  }

  // -- accounts --------------------------------------------------------------------------------

  /**
   * Creates an account. Administrator only - account creation is platform-level and is not
   * delegated to account owners.
   */
  async createAccount(accountId: string, name: string, description = ""): Promise<Account> {
    const response = await this.call("create-account", { accountId, name, description });
    return toAccount((response as { account?: unknown }).account);
  }

  /** One page of accounts, and how many exist in total. */
  async listAccounts(options: ListOptions = {}): Promise<Page<Account>> {
    return toPage(await this.call("list-accounts", listPayload(options, "accountId")), "accounts", toAccount);
  }

  /** Deletes an account. Administrator only, and it must have no namespaces or grants left. */
  async deleteAccount(accountId: string): Promise<void> {
    await this.call("delete-account", { accountId });
  }

  // -- namespaces ------------------------------------------------------------------------------

  /** Creates a namespace under an account. Requires admin rights on that account. */
  async createNamespace(accountId: string, name: string, description = ""): Promise<Namespace> {
    const response = await this.call("create-namespace", { accountId, name, description });
    return toNamespace((response as { namespace?: unknown }).namespace);
  }

  /** One page of an account's namespaces, and how many exist in total. */
  async listNamespaces(accountId: string, options: ListOptions = {}): Promise<Page<Namespace>> {
    const payload = { accountId, ...listPayload(options, "name") };
    return toPage(await this.call("list-namespaces", payload), "namespaces", toNamespace);
  }

  /** Deletes a namespace. Requires admin rights on the account, and no grants may remain. */
  async deleteNamespace(accountId: string, name: string): Promise<void> {
    await this.call("delete-namespace", { accountId, name });
  }

  /** Grants a user access to a namespace. Requires admin rights on the account. */
  async grantNamespaceAccess(user: string, accountId: string, namespace: string): Promise<void> {
    await this.call("grant-namespace-access", { user, accountId, namespace });
  }

  /** Revokes a user's access to a namespace. Requires admin rights on the account. */
  async revokeNamespaceAccess(user: string, accountId: string, namespace: string): Promise<void> {
    await this.call("revoke-namespace-access", { user, accountId, namespace });
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * EAM's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to EAM.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }

  // -- transport -------------------------------------------------------------------------------

  /**
   * Sends any EAM action, for one this SDK does not wrap yet.
   *
   * Public on purpose: a server that gains an action should be reachable without waiting for a
   * release here.
   */
  async call(
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const response = await this.#client.post(
      `${this.baseUrl}/`,
      body,
      TARGET,
      action,
      this.requestHeaders(TARGET, action, body),
      timeoutMs,
    );
    if (!response.ok) throw new EuclidServiceError(TARGET, action, response.status, response.text);

    const result = response.json();
    return result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { result };
  }

  /**
   * Every header a request to one of this session's modules goes out with, signature included.
   *
   * Takes the target rather than assuming EAM because the target is signed: a client for another
   * module has to sign for *its* module, and signing here rather than in each module client is what
   * keeps one implementation of how this session authenticates.
   */
  requestHeaders(target: string, action: string, body: Buffer): Record<string, string> {
    return { ...this.routingHeaders(), ...this.authHeaders(target, action, body) };
  }

  /** Who is asking and what they are scoped to. Signed, apart from the namespace. */
  routingHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json", host: this.#hostHeader };
    if (this.region) headers["x-euclid-region"] = this.region;
    if (this.accountId) headers["x-euclid-account-id"] = this.accountId;
    if (this.userId) headers["x-euclid-user-id"] = this.userId;
    // Not covered by either signature scheme - see the note in auth/rfc9421.ts.
    if (this.namespace) headers["x-euclid-namespace"] = this.namespace;
    return headers;
  }

  /**
   * The authentication headers alone, rebuilt per request.
   *
   * Rebuilt rather than cached because a signature is only valid around the moment it was made, and
   * because this is what the client calls again when the server says the credentials it just
   * presented had expired.
   */
  authHeaders(target: string, action: string, body: Buffer): Record<string, string> {
    if (!this.#shouldSign()) return this.bearerHeaders();

    const request = new SignableRequest("POST", "/");
    request.headersFrom(this.routingHeaders());
    request.header("x-euclid-target", target);
    request.header("x-euclid-action", action);
    request.setBody(body);
    request.setScheme(this.#scheme);
    this.signingScheme.sign(request, this.accessKeyId, this.secretAccessKey, this.region, target);

    const headers: Record<string, string> = {};
    for (const name of this.signingScheme.signatureHeaderNames()) headers[name] = request.get(name);
    return headers;
  }

  /**
   * The bearer token, presented as an `Authorization` header.
   *
   * Its own method because a request is not always free to sign: a module whose action carries raw
   * bytes presents the token whatever this session would otherwise do.
   */
  bearerHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.currentToken()}` };
  }

  /** The bearer token to present now - {@link tokenProvider}'s, or {@link token}. */
  currentToken(): string {
    return this.tokenProvider === null ? this.token : this.tokenProvider();
  }

  /**
   * A connection to this session's server, on the TLS and timeout settings it logged in with.
   *
   * The factory is what a request whose credentials expired in flight is rebuilt with, so a module
   * client passes the one that rebuilds *its* headers - see {@link authHeaders}.
   */
  newClient(headerFactory: HeaderFactory): EuclidHttpClient {
    return new EuclidHttpClient(this.#connection).headerFactory(headerFactory);
  }

  #shouldSign(): boolean {
    const hasKey = Boolean(this.accessKeyId && this.secretAccessKey);
    if (this.auth === AUTH_BEARER) return false;
    if (this.auth === AUTH_SIGNATURE) {
      if (!hasKey) {
        throw new Error(
          "auth='signature' was requested but this session has no access key - the login returned none, " +
            "so there is nothing to sign with",
        );
      }
      return true;
    }
    return hasKey;
  }
}
