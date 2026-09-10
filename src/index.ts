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
 * Nine modules so far. EAM - euclid's access management module - is where a login comes from; ESM (storage),
 * EQS (queues), ENS (notifications), EKM (keys), EKV (tables), EAP (applications), ESS (secrets) and EAG
 * (the API gateway) are reached from the session it hands back:
 *
 * ```ts
 * const bucket = await session.esm().createBucket("reports");
 * const queue = await session.eqs().createQueue("orders");
 * const key = await session.ekm().createKey({ description: "customer exports" });
 * const password = await session.ess().getSecret("db-password");
 * await session.eap().startApplication("order-service");
 * await session.eag().createRoute("orders", "/api/orders", { applicationId: "order-service" });
 * ```
 *
 * The remaining modules (EES, ETS) speak the same protocol through the same client and will follow;
 * {@link EuclidSession.call} and
 * {@link import("./modules/base.js").ModuleClient.call} reach any action this SDK does not name.
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
export {
  PRIORITY_HIGH,
  PRIORITY_LOW,
  PRIORITY_MIDDLE,
  QUEUE,
  TOPIC,
  VARIANT_BINARY,
  VARIANT_BOOL,
  VARIANT_DOUBLE,
  VARIANT_FLOAT,
  VARIANT_INT,
  VARIANT_LONG,
  VARIANT_STRING,
  toSubscribeResult,
  toSubscription,
  toVariant,
  toVariantMap,
  variantMapToJson,
  variantOf,
  variantToJson,
  type SubscribeResult,
  type Subscription,
  type Variant,
  type VariantInput,
} from "./dto/com.js";
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
export type {
  ListListenersResult,
  Listener,
  ListenerCertificate,
  Route,
} from "./dto/eag.js";
export type { Application, Endpoint, LogLevelResult } from "./dto/eap.js";
export {
  CREATED_ATTRIBUTE,
  MODIFIED_ATTRIBUTE,
  type Item,
  type QueryResult,
  type ScanResult,
  type TableDescription,
} from "./dto/ekv.js";
export type {
  Certificate,
  CreateKeyResult,
  DeleteCertificateResult,
  DeleteKeyResult,
  Key,
  KeyDescriptionResult,
  RevokeKeyResult,
} from "./dto/ekm.js";
export type {
  CreateTopicResult,
  Topic,
  TopicMessage,
  TopicMessageAttribute,
  TopicMessageCount,
  TopicMetadata,
  TopicRetentionResult,
  TopicStateResult,
} from "./dto/ens.js";
export type { DeleteSecretResult, Secret, SecretValue } from "./dto/ess.js";
export type {
  CreateQueueResult,
  Queue,
  QueueMessage,
  QueueMessageAttribute,
  QueueMessageCount,
  QueueMessageMetadata,
  QueueMetadata,
  QueueStatusResult,
  RedriveDlqResult,
  RedriveTarget,
} from "./dto/eqs.js";
export type {
  Bucket,
  BucketEvent,
  CreateBucketResult,
  CreateDownloadResult,
  CreateUploadResult,
  DeleteObjectsResult,
  DisableEncryptionResult,
  EnableEncryptionResult,
  EsmObject,
  ObjectAttribute,
  PurgeBucketResult,
  RenameBucketResult,
  SetBucketInternalResult,
  StoredObject,
  TouchObjectResult,
} from "./dto/esm.js";
export { EuclidAuthenticationError, EuclidError, EuclidServiceError } from "./errors.js";
export { DEFAULT_CA_CERT_PATH, EuclidHttpClient, Response } from "./http/client.js";
export { ModuleClient, type Bytes, type ModuleClientOptions, type PageOptions } from "./modules/base.js";
export {
  AUTH_AUTO,
  AUTH_BEARER,
  AUTH_SIGNATURE,
  EuclidEam,
  EuclidSession,
  type AuthMode,
  type ListOptions,
} from "./modules/eam.js";
export {
  EuclidEag,
  PROTOCOL_HTTP,
  PROTOCOL_HTTPS,
  ROUTE_AUTH_BASIC,
  ROUTE_AUTH_EUCLID,
  ROUTE_AUTH_NONE,
  type CreateModuleRouteOptions,
  type CreateRouteOptions,
  type UpdateRouteChanges,
} from "./modules/eag.js";
export {
  DEFAULT_MAX_INSTANCES,
  DEFAULT_MIN_INSTANCES,
  DEFAULT_READY_TIMEOUT_MS,
  EuclidEap,
  LOG_DEBUG,
  LOG_ERROR,
  LOG_FATAL,
  LOG_INFO,
  LOG_OFF,
  LOG_TRACE,
  LOG_WARNING,
  RUNTIME_BINARY,
  RUNTIME_JAVA,
  RUNTIME_NODEJS,
  RUNTIME_PYTHON,
  STATE_RUNNING,
  STATE_STOPPED,
  type CreateApplicationOptions,
  type UpdateApplicationChanges,
} from "./modules/eap.js";
export {
  EuclidEkv,
  KEY_BINARY,
  KEY_NUMBER,
  KEY_STRING,
  SORT_BEGINS_WITH,
  SORT_BETWEEN,
  SORT_EQ,
  SORT_GE,
  SORT_GT,
  SORT_LE,
  SORT_LT,
  WHOLE_PARTITION,
  type CreateTableOptions,
  type QueryOptions,
  type ScanOptions,
} from "./modules/ekv.js";
export {
  AES,
  DEFAULT_KEY_LENGTH,
  DEFAULT_PENDING_WINDOW_DAYS,
  EuclidEkm,
  type CreateCertificateOptions,
  type CreateKeyOptions,
} from "./modules/ekm.js";
export {
  EuclidEns,
  INSTALLATION_RETENTION,
  TOPIC_RUNNING,
  TOPIC_STOPPED,
  type PublishMessageOptions,
  type PurgeAllTopicsOptions,
} from "./modules/ens.js";
export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_VISIBILITY,
  EuclidEqs,
  type CreateQueueOptions,
  type ListQueuesOptions,
  type PurgeAllQueuesOptions,
  type ReceiveMessagesOptions,
  type SendMessageOptions,
} from "./modules/eqs.js";
export {
  EuclidEss,
  type CreateSecretOptions,
  type UpdateSecretChanges,
} from "./modules/ess.js";
export {
  DEFAULT_CONCURRENCY,
  DEFAULT_PART_SIZE,
  EuclidEsm,
  OBJECT_CREATED,
  OBJECT_DELETED,
  OBJECT_UPDATED,
  parseBucketEvent,
  type AttributeOptions,
  type DownloadOptions,
  type ListBucketsOptions,
  type ListObjectsOptions,
  type SubscribeOptions,
  type TouchObjectOptions,
  type UploadOptions,
} from "./modules/esm.js";

/** The version this package was published as. */
export const VERSION = "0.3.0";

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
 * EAM is reached before logging in; every other module hangs off the session that login answers with -
 * {@link EuclidSession.esm}, {@link EuclidSession.eqs}, {@link EuclidSession.ens},
 * {@link EuclidSession.ekm}, {@link EuclidSession.ekv}, {@link EuclidSession.eap},
 * {@link EuclidSession.ess}, {@link EuclidSession.eag} - as in euclid-jdk and euclid-pdk.
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
