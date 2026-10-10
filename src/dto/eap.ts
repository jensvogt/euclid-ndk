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
  /** `JAVA`, `JAVA21`, `JAVA25`, `PYTHON`, `NODEJS` or `BINARY` - see {@link import("../modules/eap.js")}. */
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
  /**
   * The labels a worker node has to carry for this application to be placed on it - see
   * {@link import("../modules/eap.js").EuclidEap.listNodes}. Empty is the ordinary case and means the
   * manager runs the application itself rather than handing it to a node.
   */
  nodeLabels: Record<string, string>;
  userId: string;
  /**
   * Whether the identity in {@link userId} still exists.
   *
   * `false` is the answer worth having, and why the server reports it: the user is checked when the
   * application is created and never again, so a principal can be deleted or renamed underneath a definition
   * that goes on naming it. The application then runs, authenticates as nobody, and is refused everything -
   * which arrives as "euclid refused my secret" rather than as "this application's user does not exist".
   */
  userExists: boolean;
  /** The level this application logs at, or empty when it is under the configured default. */
  logLevel: string;
  minInstances: number;
  maxInstances: number;
  readyTimeoutMs: number;
  /**
   * `PROCESS` or `JOB` - what finishing means for this application, and so whether an exit is a fault. See
   * {@link import("../modules/eap.js").TYPE_JOB}.
   *
   * An application stored before the field existed reads as `PROCESS`, which is what it has always behaved
   * as. A value this SDK does not know reads as itself rather than being mapped onto one of the two: it came
   * from a newer euclid, and guessing is how a job would be treated as a service.
   */
  type: string;
  /** The cron expression a JOB runs on, in UTC, or empty when it only runs on demand. */
  schedule: string;
  /**
   * When the schedule next fires, as an ISO 8601 instant - **empty when there is no schedule**, rather than
   * the epoch, which would read as a job fifty years overdue rather than one that is not scheduled at all.
   */
  nextRunAt: string;
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

/**
 * What applying an application's infrastructure declaration came to.
 *
 * `declared` false means the application has no declaration stored - not that applying one failed. Nothing was
 * created, deleted or granted, and the four lists are empty; an application that provisions its resources by
 * hand reads this way every time and is not in error.
 *
 * `deleted` is the half worth reading before trusting a declaration: a reconcile is full, so a resource this
 * application created and the declaration no longer names is removed, taking a queue's messages or a bucket's
 * objects with it. It is named here rather than counted so that a removal nobody intended is visible.
 *
 * `granted` and `revoked` name roles rather than permissions, and a re-apply that changes nothing still
 * reports every `access-` role in both: they are replaced wholesale rather than diffed, so the same role
 * appears as revoked and granted again.
 */
export interface InfrastructureResult {
  applicationId: string;
  declared: boolean;
  created: string[];
  deleted: string[];
  granted: string[];
  revoked: string[];
}

/**
 * One worker node: a host that has registered itself with euclid and can be given instances to run.
 *
 * A node registers itself and renews a lease; nothing here is configured through this SDK. What an operator
 * does with a node is read it, drain it, and - once it is gone for good - remove its registration.
 *
 * Named `WorkerNode` rather than `Node` because this package runs on Node.js and in a browser-typed
 * project, where `Node` is already a DOM interface.
 */
export interface WorkerNode {
  name: string;
  /** Where the manager reaches it. */
  address: string;
  /**
   * The principal that registered this name, and the only one that may renew it: a node able to take over
   * another's name would be handed its assignments and, with them, its applications' credentials.
   */
  principal: string;
  /**
   * What this node offers - `os=windows`, `gpu=true` - matched against an application's
   * {@link Application.nodeLabels} when the manager decides where to place an instance.
   */
  labels: Record<string, string>;
  cpuCount: number;
  /** The worker's own version, and the platform it reports running on. */
  version: string;
  os: string;
  arch: string;
  /**
   * Whether the node is being emptied. A drained node keeps what it is running and keeps renewing - it is
   * only refused *new* instances, which is the whole difference between draining and stopping.
   */
  drained: boolean;
  /**
   * Whether the lease is current. A node that stopped renewing reads `live: false` while its registration,
   * and everything it was running, is still on record - which is how an absent host is told from a
   * deregistered one.
   */
  live: boolean;
  lastSeen: string;
}

/**
 * One application a node is holding slots for.
 *
 * `instances` is the slots on this node and `running` the ones actually serving out of them. Both, because
 * a node holding four slots and running none is exactly the state worth seeing, and one number cannot say
 * it.
 */
export interface WorkerNodeApplication {
  applicationId: string;
  runtimeName: string;
  namespace: string;
  runtime: string;
  instances: number;
  running: number;
}

/**
 * A node and what it is running.
 *
 * Only {@link import("../modules/eap.js").EuclidEap.getNode} answers with this: the server deliberately
 * leaves `applications` off a listing, since working it out means walking every pool once per node and a
 * listing is read to find a node rather than to read what is on it.
 */
export interface WorkerNodeDetails extends WorkerNode {
  applications: WorkerNodeApplication[];
}

/** A node and whether it is now being emptied. */
export interface DrainNodeResult {
  node: string;
  drained: boolean;
}

/** The name of a deregistered node, and that it went. */
export interface DeleteNodeResult {
  node: string;
  deleted: boolean;
}

/**
 * A load report as the server recorded it, which is not always as it was sent.
 *
 * `utilisation` comes back clamped to 0-100 and the two counts floored at zero, so this is worth reading
 * rather than discarding: a client reporting 150 learns here that euclid stored 100.
 */
export interface LoadReport {
  instanceId: string;
  utilisation: number;
  backlog: number;
  active: number;
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
    nodeLabels: stringMap(document, "nodeLabels"),
    userId: text(document, "userId"),
    // True when the server did not say, unlike every other flag here, because this one's false is an
    // alarm: against a euclid too old to report it, defaulting the other way would have every
    // application claiming its identity had been deleted.
    userExists: flag(document, "userExists", true),
    logLevel: text(document, "logLevel"),
    minInstances: number(document, "minInstances"),
    maxInstances: number(document, "maxInstances"),
    readyTimeoutMs: number(document, "readyTimeoutMs"),
    // "PROCESS" when absent, which is the server's own rule for a definition stored before the field
    // existed: it is one, and has to go on behaving as one. Written out rather than taken from
    // TYPE_PROCESS so that this file stays below the modules in the import graph.
    type: text(document, "type") || "PROCESS",
    schedule: text(document, "schedule"),
    nextRunAt: text(document, "nextRunAt"),
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

export function toInfrastructureResult(document: unknown): InfrastructureResult {
  return {
    applicationId: text(document, "applicationId"),
    declared: flag(document, "declared"),
    created: strings(document, "created"),
    deleted: strings(document, "deleted"),
    granted: strings(document, "granted"),
    revoked: strings(document, "revoked"),
  };
}

export function toWorkerNode(document: unknown): WorkerNode {
  return {
    name: text(document, "name"),
    address: text(document, "address"),
    principal: text(document, "principal"),
    labels: stringMap(document, "labels"),
    cpuCount: number(document, "cpuCount"),
    version: text(document, "version"),
    os: text(document, "os"),
    arch: text(document, "arch"),
    drained: flag(document, "drained"),
    live: flag(document, "live"),
    lastSeen: text(document, "lastSeen"),
  };
}

export function toWorkerNodes(document: unknown): WorkerNode[] {
  return documents(document, "nodes").map(toWorkerNode);
}

export function toWorkerNodeApplication(document: unknown): WorkerNodeApplication {
  return {
    applicationId: text(document, "applicationId"),
    runtimeName: text(document, "runtimeName"),
    namespace: text(document, "namespace"),
    runtime: text(document, "runtime"),
    instances: number(document, "instances"),
    running: number(document, "running"),
  };
}

export function toWorkerNodeDetails(document: unknown): WorkerNodeDetails {
  return {
    ...toWorkerNode(document),
    applications: documents(document, "applications").map(toWorkerNodeApplication),
  };
}

export function toDrainNodeResult(document: unknown): DrainNodeResult {
  return { node: text(document, "node"), drained: flag(document, "drained") };
}

export function toDeleteNodeResult(document: unknown): DeleteNodeResult {
  return { node: text(document, "node"), deleted: flag(document, "deleted") };
}

export function toLoadReport(document: unknown): LoadReport {
  return {
    instanceId: text(document, "instanceId"),
    utilisation: number(document, "utilisation"),
    backlog: number(document, "backlog"),
    active: number(document, "active"),
  };
}

export function toLogLevelResult(document: unknown): LogLevelResult {
  return {
    applicationId: text(document, "applicationId"),
    logLevel: text(document, "logLevel"),
    channel: text(document, "channel"),
  };
}
