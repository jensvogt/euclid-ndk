/**
 * euclid-ndk - the Node.js SDK for a euclid server.
 *
 * Start here:
 *
 * ```ts
 * import { Euclid } from "euclid-ndk";
 *
 * const session = await Euclid.forServer("https://euclid.example.com").login("jens", "secret");
 * const users = await session.listUsers({ prefix: "j", pageSize: 25 });
 * for (const user of users.items) console.log(user.userId, user.email);
 * session.close();
 * ```
 *
 * This first release covers the three things everything else needs: the connection, request signing,
 * and EAM - euclid's access management module. The remaining modules (ESM, EQS, ENS, EES, EKM, ESS,
 * EKV, EAG, EAP, ETS) speak the same protocol through the same client and will follow;
 * {@link EuclidSession.call} reaches any EAM action this SDK does not name.
 */

import { EuclidEam, type EuclidSession } from "./modules/eam.js";

export {
  RFC9421,
  SIGV4,
  SignableRequest,
  signingSchemeOf,
  type SigningScheme,
  rfc9421,
  sigv4,
} from "./auth/index.js";
export {
  credentialsPath,
  isTokenValid,
  type CachedCredentials,
} from "./credentials.js";
export type {
  AccessKey,
  Account,
  AccountGrant,
  CreateAccessKeyResult,
  LoginResult,
  Metadata,
  Namespace,
  Page,
  User,
  UserGroup,
} from "./dto/eam.js";
export { EuclidAuthenticationError, EuclidError, EuclidServiceError } from "./errors.js";
export { DEFAULT_CA_CERT_PATH, EuclidHttpClient, Response } from "./http/client.js";
export {
  AUTH_AUTO,
  AUTH_BEARER,
  AUTH_SIGNATURE,
  EuclidEam,
  EuclidSession,
  type AuthMode,
  type ListOptions,
} from "./modules/eam.js";

/** The version this package was published as. */
export const VERSION = "0.1.0";

/** Options {@link Euclid.login} passes through to the builder, for the case that needs no builder. */
export interface LoginOptions {
  email?: string;
  namespace?: string;
  caCertPath?: string | null;
  verify?: boolean;
  timeoutMs?: number;
  signingScheme?: import("./auth/index.js").SigningScheme;
  auth?: import("./modules/eam.js").AuthMode;
  useCache?: boolean;
  loginPath?: string;
}

/**
 * Entry point: names a server, and hands out the module clients for it.
 *
 * Exists so that a caller writes the server's URL once. Only EAM is reached from here, because only
 * EAM is reached before logging in; every other module will hang off the session that login answers
 * with, as it does in euclid-jdk and euclid-pdk.
 */
export class Euclid {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    if (!baseUrl) throw new Error("baseUrl must not be empty");
    this.#baseUrl = baseUrl;
  }

  /** Targets a euclid server, e.g. `https://euclid.example.com`. */
  static forServer(baseUrl: string): Euclid {
    return new Euclid(baseUrl);
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** Starts a login against this server. */
  access(): EuclidEam {
    return EuclidEam.forServer(this.#baseUrl);
  }

  /** Alias for {@link access}, for callers who think in module names. */
  eam(): EuclidEam {
    return this.access();
  }

  /** Logs in, for the common case that needs no builder. */
  async login(username?: string, password?: string, options: LoginOptions = {}): Promise<EuclidSession> {
    const builder = this.access();
    if (username !== undefined) builder.username(username);
    if (password !== undefined) builder.password(password);
    if (options.email !== undefined) builder.email(options.email);
    if (options.namespace !== undefined) builder.namespace(options.namespace);
    if (options.caCertPath !== undefined) builder.caCertPath(options.caCertPath);
    if (options.verify !== undefined) builder.verify(options.verify);
    if (options.timeoutMs !== undefined) builder.timeout(options.timeoutMs);
    if (options.signingScheme !== undefined) builder.signingScheme(options.signingScheme);
    if (options.auth !== undefined) builder.auth(options.auth);
    if (options.useCache !== undefined) builder.useCache(options.useCache);
    if (options.loginPath !== undefined) builder.loginPath(options.loginPath);
    return builder.login();
  }
}
