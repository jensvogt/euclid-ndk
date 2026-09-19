/**
 * The shapes EAP sends back.
 *
 * Parsed the same defensive way as every other module's, and on this module the field names are worth
 * reading twice: a request and the response to it call some of the same things by different names. An
 * application is deployed from a `bucket` and an `artifact`, and comes back describing a
 * {@link Application.bucketErn} and an {@link Application.artifactKey}. Names are what an operator has
 * in hand; ERNs are what euclid stores, and the server resolves the one into the other.
 */

import { documents, flag, number, stringMap, strings, text } from "./json.js";

/**
 * One running instance of an application, and where it can be reached.
 *
 * A pool's instances are started and stopped as it grows and shrinks, and each is given a port of its
 * own when it starts - so this is a snapshot rather than a setting.
 */
export interface Endpoint {
  instanceId: string;
  pid: number;
  httpPort: number;
}

/**
 * A deployed application: what euclid runs, as what, and how much of it.
 *
 * `desiredState` is what somebody asked for - see
 * {@link import("../modules/eap.js").EuclidEap.startApplication} - and `state` is what is actually
 * running, which is `RUNNING` exactly when at least one instance answers. The two differing is the
 * ordinary picture of an application starting up, and the lasting picture of one that cannot.
 *
 * `userId` is the identity the application runs as. Unless one was named at deployment it is a technical
 * principal euclid made for it - no password, no login, one access key - so that nothing an application
 * leaks is a person's credential.
 */
export interface Application {
  applicationId: string;
  /**
   * What everything belonging to this application on a host is actually called: its directory under the data
   * directory, its row in the module list, its socket, its log channel, and the technical principal named
   * after it (`app-<runtimeName>`).
   *
   * Distinct from `applicationId` because an ID is only unique within an account and namespace, while these
   * names are installation-wide - so the server issues a short unique name at deployment and keeps it across
   * a move between namespaces. For an application deployed before the field existed it is the bare
   * `applicationId`.
   */
  runtimeName: string;
  ern: string;
  accountId: string;
  /**
   * The other half of what identifies this application: an `applicationId` is unique within
   * (`accountId`, `namespace`), so the ID alone does not say which application this is. Empty for one at the
   * account root, and the only way to see where an application ended up after a move.
   */
  namespace: string;
  region: string;
  /** `JAVA`, `PYTHON`, `NODEJS` or `BINARY` - see {@link import("../modules/eap.js")}. */
  runtime: string;
  /** The bucket the artifact was deployed from, as an ERN. Deployed by name. */
  bucketErn: string;
  /** The object key of the artifact within that bucket. */
  artifactKey: string;
  version: string;
  /**
   * ESM's checksum of the artifact - the same hash the manager compares the copy on the host against,
   * and the one a redeploy has to differ from.
   */
  md5Sum: string;
  command: string;
  arguments: string[];
  environment: Record<string, string>;
  /**
   * The ERNs of the buckets and queues this application was granted, resolved from the names it was
   * deployed with.
   */
  resources: string[];
  userId: string;
  /** The level this application logs at, or empty when it is under the configured default. */
  logLevel: string;
  minInstances: number;
  maxInstances: number;
  readyTimeoutMs: number;
  /** `RUNNING` or `STOPPED`, as asked for. */
  desiredState: string;
  /** `RUNNING` or `STOPPED`, as observed - which is not the same as having been started. */
  state: string;
  /** How many instances are running - the length of {@link endpoints}. */
  instances: number;
  endpoints: Endpoint[];
  created: string;
  modified: string;
}

/**
 * What an application logs at now, and the channel it logs on.
 *
 * An empty `logLevel` means the level was taken back rather than changed: the application is under
 * whatever the installation's logging configuration says again.
 */
export interface LogLevelResult {
  applicationId: string;
  logLevel: string;
  channel: string;
}

/**
 * What a restart request came to.
 *
 * `restarting` says the request was recorded, not that anything has happened: the manager stops and starts
 * the instances on its next reconcile. `instances` is what was running when the request was answered, so it
 * is the size of the pool about to be cycled rather than the one that came back.
 */
export interface RestartResult {
  applicationId: string;
  restarting: boolean;
  instances: number;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toEndpoint(document: unknown): Endpoint {
  return {
    instanceId: text(document, "instanceId"),
    pid: number(document, "pid"),
    httpPort: number(document, "httpPort"),
  };
}

export function toApplication(document: unknown): Application {
  return {
    applicationId: text(document, "applicationId"),
    runtimeName: text(document, "runtimeName"),
    ern: text(document, "ern"),
    accountId: text(document, "accountId"),
    namespace: text(document, "namespace"),
    region: text(document, "region"),
    runtime: text(document, "runtime"),
    bucketErn: text(document, "bucketErn"),
    artifactKey: text(document, "artifactKey"),
    version: text(document, "version"),
    md5Sum: text(document, "md5Sum"),
    command: text(document, "command"),
    arguments: strings(document, "arguments"),
    environment: stringMap(document, "environment"),
    resources: strings(document, "resources"),
    userId: text(document, "userId"),
    logLevel: text(document, "logLevel"),
    minInstances: number(document, "minInstances"),
    maxInstances: number(document, "maxInstances"),
    readyTimeoutMs: number(document, "readyTimeoutMs"),
    desiredState: text(document, "desiredState"),
    state: text(document, "state"),
    instances: number(document, "instances"),
    endpoints: documents(document, "endpoints").map(toEndpoint),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toRestartResult(document: unknown): RestartResult {
  return {
    applicationId: text(document, "applicationId"),
    restarting: flag(document, "restarting"),
    instances: number(document, "instances"),
  };
}

export function toLogLevelResult(document: unknown): LogLevelResult {
  return {
    applicationId: text(document, "applicationId"),
    logLevel: text(document, "logLevel"),
    channel: text(document, "channel"),
  };
}
