/**
 * EAP - euclid's application platform: what euclid runs, from what, and as whom.
 *
 * One object, {@link EuclidEap}, built from a session that has already logged in:
 *
 * ```ts
 * const eap = session.eap();
 *
 * await eap.createApplication("order-service", RUNTIME_JAVA, "artifacts", "order-service-1.4.0.jar", {
 *   queues: ["orders"],
 * });
 * await eap.startApplication("order-service");
 * ```
 *
 * An application is deployed from an artifact already in a bucket - ESM puts it there, and EAP names it.
 * The deployment says which buckets, queues, topics and secrets it may reach, and euclid grants those to
 * the identity it runs as: a technical principal it creates for the application unless one is named, with no
 * password, no login and one access key. Nothing an application leaks is then a person's credential.
 *
 * A deployment that names none of them says nothing about what it needs, and euclid reads that the only way
 * it safely can: the application role with every resource in the namespace. Naming the four lists is how an
 * application is held to what it actually uses.
 *
 * Two names for the same things, and the asymmetry is the server's: a deployment names a `bucket` and an
 * `artifact`, and the application that comes back describes a `bucketErn` and an `artifactKey`. Likewise
 * the `buckets` and `queues` it is granted come back resolved into `resources`.
 *
 * Every action that *defines* an application is administrator-only, server-side - which is most of them,
 * since between them they decide what code euclid executes and under whose identity.
 * {@link EuclidSession.isAdmin} says whether the logged-in user is one, though the server enforces it
 * regardless.
 *
 * Three things here are not that. {@link EuclidEap.reportLoad} is called by an application about itself, so
 * it is open to the identity that application runs as and to nobody else. {@link EuclidEap.listNodes},
 * {@link EuclidEap.getNode} and {@link EuclidEap.drainNode} are open to any authenticated caller, because
 * reading the fleet and taking a host out of rotation are operations work rather than privilege; only
 * {@link EuclidEap.deleteNode} needs an administrator, since freeing a node's name is what would let
 * another principal claim it.
 */

import {
  toApplication,
  toDeleteNodeResult,
  toDrainNodeResult,
  toInfrastructureResult,
  toLoadReport,
  toLogLevelResult,
  toRestartResult,
  toWorkerNodeDetails,
  toWorkerNodes,
  type Application,
  type DeleteNodeResult,
  type DrainNodeResult,
  type InfrastructureResult,
  type LoadReport,
  type LogLevelResult,
  type RestartResult,
  type WorkerNode,
  type WorkerNodeDetails,
} from "../dto/eap.js";
import { ModuleClient } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "eap";

/**
 * What an artifact is handed to. Matched exactly, in upper case, and anything else is refused with
 * HTTP 400 - `JAVA21` is a runtime, `java21` and `JAVA 21` are typos.
 *
 * {@link RUNTIME_JAVA} is whichever java the host calls java, which is what every application deployed
 * before the versioned ones said. {@link RUNTIME_JAVA21} and {@link RUNTIME_JAVA25} name a version and are
 * started with the executable that host has configured for it - a jar built for 25 does not start on 21,
 * and leaving it to whichever java resolved first made the version an accident of the manager's PATH.
 */
export const RUNTIME_JAVA = "JAVA";
export const RUNTIME_JAVA21 = "JAVA21";
export const RUNTIME_JAVA25 = "JAVA25";
export const RUNTIME_PYTHON = "PYTHON";
export const RUNTIME_NODEJS = "NODEJS";
/** Anything already executable, which is where C++ and Rust applications land. */
export const RUNTIME_BINARY = "BINARY";

/**
 * The levels {@link EuclidEap.setLogLevel} accepts. An unrecognised one is refused rather than defaulted:
 * "warnign" quietly meaning "info" is an application logging more than somebody asked for, and quietly
 * meaning "off" is silence nobody asked for at all.
 */
export const LOG_TRACE = "trace";
export const LOG_DEBUG = "debug";
export const LOG_INFO = "info";
export const LOG_WARNING = "warning";
export const LOG_ERROR = "error";
export const LOG_FATAL = "fatal";
export const LOG_OFF = "off";

/** What an application's `desiredState` and `state` read as. */
export const STATE_RUNNING = "RUNNING";
export const STATE_STOPPED = "STOPPED";

/**
 * What kind of thing an application is, and therefore what finishing means.
 *
 * A {@link TYPE_PROCESS} is started and kept up: an exit is a fault, the slot is filled again, and the pool
 * is held at its instance count. That is what everything euclid ran before this field existed is, and what
 * an application with no type stored still reads as.
 *
 * A {@link TYPE_JOB} is started to do one thing and finish. Exit 0 is success rather than a crash to back
 * off from, the slot is not refilled, and the autoscaler leaves it alone - a backlog says nothing about how
 * many copies of a one-shot task to run. A nightly import deployed as a PROCESS would be restarted forever,
 * each completed run reported as a crash, which is the mistake this exists to make impossible to express.
 *
 * Matched exactly and in upper case; `job` is refused rather than read as one, because a typo silently
 * meaning PROCESS is found out the first time a run that was meant to finish is restarted instead.
 */
export const TYPE_PROCESS = "PROCESS";
export const TYPE_JOB = "JOB";

/** What a pool is sized at unless the deployment says otherwise. */
export const DEFAULT_MIN_INSTANCES = 1;
export const DEFAULT_MAX_INSTANCES = 1;

/** How long an instance has to become ready before the manager gives up on it, in milliseconds. */
export const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** Everything a deployment says beyond what it runs and where the artifact is. */
export interface CreateApplicationOptions {
  /**
   * What to record as the deployed version. Left empty, the server reads it out of the artifact's name,
   * and refuses the deployment if it cannot.
   */
  version?: string;
  /**
   * What to run, when the runtime's own interpreter is not it. Empty means the runtime decides, resolved
   * through PATH.
   */
  command?: string;
  /** What follows the command. */
  arguments?: readonly string[];
  /** The environment the process is given. */
  environment?: Record<string, string>;
  /**
   * The buckets this application may reach, by name; euclid resolves them and grants them to the identity
   * it runs as.
   */
  buckets?: readonly string[];
  /** Likewise for queues. */
  queues?: readonly string[];
  /** Likewise for topics, which it may publish to and subscribe. */
  topics?: readonly string[];
  /** Likewise for ESS secrets, which it may read. */
  secrets?: readonly string[];
  /**
   * An existing user to run as. Left empty, euclid creates a technical principal for the application -
   * which is the better answer, and why this is not required.
   */
  user?: string;
  /**
   * The labels a worker node has to carry for this application to be placed on it - `{ os: "windows" }`,
   * `{ gpu: "true" }`. Left empty, the manager runs the application itself rather than handing it to a
   * node. A label needs a non-empty string value; the server refuses the set rather than dropping one,
   * since a label silently dropped is a placement constraint silently dropped.
   */
  nodeLabels?: Record<string, string>;
  /** The smallest the pool goes; at least 1. */
  minInstances?: number;
  /** The largest it goes; never below `minInstances`. */
  maxInstances?: number;
  /** How long an instance has to become ready; at least 1000. */
  readyTimeoutMs?: number;
  /**
   * {@link TYPE_PROCESS} - the default - for something that stays up, or {@link TYPE_JOB} for something
   * that runs once and finishes.
   */
  type?: string;
  /**
   * A cron expression a {@link TYPE_JOB} runs on, in UTC - `"0 2 * * *"`, or `"@daily"`. Only valid
   * together with `type: TYPE_JOB`: a PROCESS is held at its instance count for as long as it is running,
   * so a schedule on one would be stored, listed, and never fire - which the server refuses rather than
   * accepts. An expression that does not parse is refused here and now rather than at the moment it was
   * due, hours later, in the manager's log.
   */
  schedule?: string;
}

/**
 * The instance bounds {@link EuclidEap.scaleApplication} sets. Either may be left out, which leaves that
 * bound as it stands - so a ceiling can be raised without touching the floor. The same number for both pins
 * the pool at that size and leaves the autoscaler nothing to decide.
 */
export interface ScaleApplicationBounds {
  minInstances?: number;
  maxInstances?: number;
}

/** Everything a load report says beyond how busy the instance is. */
export interface ReportLoadOptions {
  /** How much work is waiting that this instance has not started. */
  backlog?: number;
  /**
   * How much work has been started and not finished, right now - a gauge rather than a counter, so the
   * newest figure is the whole answer.
   *
   * Not a load signal: it says "do not stop me", not "start another one". Scale-down passes over an instance
   * reporting any, because work in flight is work a second instance cannot take over - stopping the instance
   * abandons it and it has to be done again. A listener part-way through a message is the case this is for.
   */
  active?: number;
  /**
   * The application being reported for. Only needed by an application deployed with a *named* user, since
   * one running as its own `app-<runtimeName>` principal already says which pool it is. The caller has to be
   * the identity that application runs as.
   */
  applicationId?: string;
}

/**
 * What an update changes - and only what it names.
 *
 * The distinction the server draws is between a field being sent and not being sent, rather than between
 * its values: leaving `command` out leaves the stored command alone, while passing `""` clears it and
 * hands the artifact back to the runtime's own interpreter.
 *
 * `buckets`, `queues`, `topics` and `secrets` are **re-resolved together whenever any one of them is
 * named**: the server rebuilds the whole resource list from what the request carries, so naming one and
 * leaving the others out revokes what the others used to grant. Pass every list the application should end
 * up with, or none of them. They are resolved in the namespace the application is in *after* this update,
 * which is what makes moving one and re-granting its resources a single call.
 *
 * `namespace` is a move rather than a field change, and the one way an application deployed before
 * applications carried a namespace can acquire one without being deleted and made again - see
 * {@link EuclidEap.updateApplication}.
 *
 * `type` and `schedule` are a pair the server checks *after* both have been applied, so a `JOB` being turned
 * back into a `PROCESS` has to clear its schedule in the same request - a cron expression that only fires on
 * a job would otherwise sit there having quietly stopped firing. An empty `schedule` unschedules, which is
 * how a job goes back to running on demand without being redefined.
 */
export interface UpdateApplicationChanges {
  runtime?: string;
  artifact?: string;
  version?: string;
  command?: string;
  arguments?: readonly string[];
  environment?: Record<string, string>;
  /** See the note above: naming any one of these four rebuilds the grant from all four. */
  buckets?: readonly string[];
  queues?: readonly string[];
  topics?: readonly string[];
  secrets?: readonly string[];
  /** Replaces the whole set; `{}` clears it, which hands the application back to the manager's own host. */
  nodeLabels?: Record<string, string>;
  minInstances?: number;
  maxInstances?: number;
  readyTimeoutMs?: number;
  /** {@link TYPE_PROCESS} or {@link TYPE_JOB}; anything else is refused rather than left as it was. */
  type?: string;
  /** A cron expression, or `""` to unschedule. Only valid while the application is a {@link TYPE_JOB}. */
  schedule?: string;
  namespace?: string;
}

/** The fields an update sends when - and only when - it was given them. */
const UPDATABLE = [
  "runtime",
  "artifact",
  "version",
  "command",
  "arguments",
  "environment",
  "buckets",
  "queues",
  "topics",
  "secrets",
  "nodeLabels",
  "minInstances",
  "maxInstances",
  "readyTimeoutMs",
  "type",
  "schedule",
  "namespace",
] as const satisfies readonly (keyof UpdateApplicationChanges)[];

/**
 * EAP's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.eap} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEap extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  // -- deploying -------------------------------------------------------------------------------

  /**
   * Deploys an application, stopped, and answers with it as it was stored.
   *
   * Nothing runs yet: a new application's desired state is `STOPPED`, so {@link startApplication} is what
   * puts it in service. Refused with HTTP 409 if this account and namespace already have an application of
   * that ID - the pair it is unique within, so the same ID in another namespace is another application - and
   * with 404 if the bucket, the artifact, a named resource or a named user is not there. A deployment
   * pointing at nothing would otherwise become an application that fails to start for a reason nobody can
   * see.
   *
   * The namespace is the session's, and the buckets and queues named here are resolved in it: a deployment
   * cannot grant itself another namespace's bucket by naming it.
   *
   * @param applicationId application ID
   * @param runtime {@link RUNTIME_JAVA}, {@link RUNTIME_JAVA21}, {@link RUNTIME_JAVA25},
   *   {@link RUNTIME_PYTHON}, {@link RUNTIME_NODEJS} or
   *   {@link RUNTIME_BINARY}.
   * @param bucket the name of the bucket holding the artifact - a name, not an ERN.
   * @param artifact the artifact's object key within that bucket.
   * @param options call options
   */
  async createApplication(
    applicationId: string,
    runtime: string,
    bucket: string,
    artifact: string,
    options: CreateApplicationOptions = {},
  ): Promise<Application> {
    return this.#application("create-application", {
      applicationId,
      runtime,
      bucket,
      artifact,
      version: options.version ?? "",
      command: options.command ?? "",
      arguments: [...(options.arguments ?? [])],
      environment: { ...options.environment },
      buckets: [...(options.buckets ?? [])],
      queues: [...(options.queues ?? [])],
      topics: [...(options.topics ?? [])],
      secrets: [...(options.secrets ?? [])],
      nodeLabels: { ...options.nodeLabels },
      user: options.user ?? "",
      minInstances: options.minInstances ?? DEFAULT_MIN_INSTANCES,
      maxInstances: options.maxInstances ?? DEFAULT_MAX_INSTANCES,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      type: options.type ?? "",
      schedule: options.schedule ?? "",
    });
  }

  /**
   * Changes a deployed application. Only what `changes` names changes - see
   * {@link UpdateApplicationChanges}, which is where the rules about that live.
   *
   * Changing the artifact is a change of what will run next; {@link redeployApplication} is what a new
   * build of the same application usually wants.
   *
   * Changing the `namespace` moves the application: its ERN is rebuilt from the namespace it lands in, its
   * row moves, and the grant of the technical principal it runs as follows it - while its
   * {@link import("../dto/eap.js").Application.runtimeName} stays as it was, so the directory, socket and log
   * channel on the host do not move underneath a running instance. An empty string moves it back to the
   * account root, which is why absent and empty mean different things here, and a namespace that already has
   * an application of this ID refuses the move with HTTP 409.
   */
  async updateApplication(applicationId: string, changes: UpdateApplicationChanges = {}): Promise<Application> {
    const payload: Record<string, unknown> = { applicationId };
    for (const field of UPDATABLE) {
      const value = changes[field];
      if (value !== undefined) payload[field] = value;
    }
    return this.#application("update-application", payload);
  }

  /**
   * Defines the same application again in another namespace, leaving the original alone and running.
   *
   * The sibling of moving one with {@link EuclidEap.updateApplication}'s `namespace`, and the difference is
   * the point: a move takes the definition with it, so what ran in the old namespace stops running there. A
   * copy is how a build is promoted - development to integration, integration to production - while the
   * namespace it came from goes on serving.
   *
   * The copy runs the same artifact, down to the checksum, so it is the same bytes rather than a rebuild
   * that happens to share a version. It is given its own runtime name and its own technical principal with
   * its own access key, both being installation-wide and unshareable, so revoking the copy's credentials
   * leaves the original running. An application told to run as a named user keeps that user.
   *
   * What it may reach is re-resolved rather than copied: a bucket or queue ERN carries the namespace it was
   * resolved in, so copying the list would point the new application at the old namespace's data. The same
   * names are looked up in the target namespace, and one with no counterpart there fails the copy with HTTP
   * 404 rather than quietly leaving the application with less access than the original.
   *
   * The copy is created stopped whatever the original is doing, and refuses with HTTP 409 if an application
   * of that name is already defined in the target namespace.
   *
   * @param applicationId the application to copy, in the namespace this session works in
   * @param targetNamespace the namespace to copy it into; it has to exist already
   * @param targetApplicationId the name the copy is defined under; the original's unless given, which is how
   *   an application is copied beside itself within one namespace
   */
  async copyApplication(applicationId: string, targetNamespace: string, targetApplicationId = ""): Promise<Application> {
    const payload: Record<string, unknown> = { applicationId, targetNamespace };
    if (targetApplicationId) payload["targetApplicationId"] = targetApplicationId;
    return this.#application("copy-application", payload);
  }

  /**
   * Changes how many instances an application runs, without restarting the ones it has.
   *
   * {@link EuclidEap.updateApplication} can set the same two fields, but it writes the whole definition and
   * stamps the modification date - and the manager restarts a pool whose application changed since it started
   * it. Scaling that way stops every running instance and starts it again, which is the opposite of what
   * asking for capacity means and worst at the moment it is asked for.
   *
   * What is set is the range the autoscaler works within, not a count: the manager scales toward it on its
   * next reconcile, adding instances one at a time and stopping idle ones as the load allows. Nothing is
   * started or stopped by this call. The same number for both bounds pins the pool at that size.
   *
   * A bound left undefined is left as it stands, so a ceiling can be raised without touching the floor. The
   * two are checked against each other as they *will* stand rather than as they are, so raising only the
   * floor fails with HTTP 400 when it would pass the stored ceiling. A floor of zero is refused for its own
   * reason: an application desired RUNNING with no instances reads everywhere as a pool that failed to
   * start, and {@link EuclidEap.stopApplication} is how one is taken out of service.
   *
   * @param applicationId the application to scale
   * @param bounds the floor and ceiling to set; either may be left out to leave it as it stands
   */
  async scaleApplication(applicationId: string, bounds: ScaleApplicationBounds = {}): Promise<Application> {
    const payload: Record<string, unknown> = { applicationId };
    if (bounds.minInstances !== undefined) payload["minInstances"] = bounds.minInstances;
    if (bounds.maxInstances !== undefined) payload["maxInstances"] = bounds.maxInstances;
    return this.#application("scale-application", payload);
  }

  /**
   * Points an application at a new build of itself.
   *
   * The artifact defaults to the one already deployed - which is what a rebuilt artifact stored under the
   * same key wants - and the version to whatever the artifact's name says. A redeploy that would change
   * neither the version nor the checksum is refused with HTTP 409: it would restart the instances for
   * nothing, and usually means the new artifact never reached the bucket.
   */
  async redeployApplication(applicationId: string, artifact = "", version = ""): Promise<Application> {
    const payload: Record<string, unknown> = { applicationId };
    if (artifact) payload["artifact"] = artifact;
    if (version) payload["version"] = version;
    return this.#application("redeploy-application", payload);
  }

  /** Removes an application. Stop it first - this does not. */
  async deleteApplication(applicationId: string): Promise<void> {
    await this.call("delete-application", { applicationId });
  }

  // -- running ---------------------------------------------------------------------------------

  /**
   * Asks for an application to run, and answers with it as it stands.
   *
   * Asking is all this does: the desired state changes here and the manager acts on it, so the application
   * in the answer is usually still `STOPPED` - it says what was asked for, not what has happened yet.
   */
  async startApplication(applicationId: string): Promise<Application> {
    return this.#application("start-application", { applicationId });
  }

  /** Asks for an application to stop, and answers with it as it stands. */
  async stopApplication(applicationId: string): Promise<Application> {
    return this.#application("stop-application", { applicationId });
  }

  /**
   * Asks for a running application's instances to be started again.
   *
   * The manager stops the whole pool on its next reconcile and starts it straight back up from the current
   * definition - the same thing it does after a redeploy, with nothing new to pick up. The artifact, the
   * environment and the credentials all come back as they were, so this is for an instance that has to do
   * its startup again rather than a way to deploy anything.
   *
   * Deliberately not {@link stopApplication} followed by {@link startApplication}: between those two the
   * desired state is `STOPPED`, so a caller that fails in between leaves the application down. Here it stays
   * `RUNNING` throughout, and one that is already stopped is refused with HTTP 400 rather than started.
   */
  async restartApplication(applicationId: string): Promise<RestartResult> {
    return toRestartResult(await this.call("restart-application", { applicationId }));
  }

  /**
   * Makes the installation match the application's own infrastructure declaration.
   *
   * The declaration is a file the application has already stored beside its artifact -
   * `<applicationId>.euclid.json` in the bucket it deploys from - naming the queues, topics and buckets it owns
   * and the ones belonging to others that it reaches. This applies it: creates what is missing, grants the
   * access it asks for, and **deletes what this application created and the declaration no longer names**,
   * with everything that resource held.
   *
   * Applying is idempotent and changes nothing about the running instances - the modification date is
   * deliberately not stamped, so the manager does not read it as a new revision and cycle the pool. It happens
   * on its own whenever the application is created, updated or redeployed; this is for reconciling without a
   * deploy.
   *
   * An application with no declaration stored is answered rather than refused, with `declared` false. A
   * declaration that cannot be applied rejects: one that names a resource belonging to another application, or
   * claims one it does not own, throws rather than being partly applied.
   */
  async applyInfrastructure(applicationId: string): Promise<InfrastructureResult> {
    return toInfrastructureResult(await this.call("apply-infrastructure", { applicationId }));
  }

  /**
   * The applications whose ID starts with a prefix; an empty prefix lists them all.
   *
   * The session's own account and namespace, not the installation: every other action here resolves an
   * application ID in the namespace the request was made in, so a listing that crossed namespaces would show
   * applications the caller cannot then address. {@link EuclidSession.changeNamespace} is how to look
   * elsewhere.
   *
   * A list rather than a page: EAP answers with every match at once, since an installation has tens of
   * applications rather than thousands.
   */
  async listApplications(prefix = ""): Promise<Application[]> {
    const response = await this.call("list-applications", { prefix });
    const applications = response["applications"];
    return Array.isArray(applications) ? applications.map(toApplication) : [];
  }

  /** One application, by its ID, with the instances that are answering for it. */
  async getApplication(applicationId: string): Promise<Application> {
    return this.#application("get-application", { applicationId });
  }

  // -- logging ---------------------------------------------------------------------------------

  /**
   * Sets what one application logs at, without restarting or redeploying it.
   *
   * @param applicationId application ID
   * @param level {@link LOG_TRACE}, {@link LOG_DEBUG}, {@link LOG_INFO}, {@link LOG_WARNING},
   *   {@link LOG_ERROR}, {@link LOG_FATAL} or {@link LOG_OFF}. An empty one takes the setting back - see
   *   {@link resetLogLevel}, which says that in a word.
   */
  async setLogLevel(applicationId: string, level: string): Promise<LogLevelResult> {
    return toLogLevelResult(await this.call("set-log-level", { applicationId, level }));
  }

  /**
   * Puts an application back under the installation's own logging configuration.
   *
   * Which is not the same as setting it to whatever that configuration says: this removes the override, so
   * the application follows the configuration as it changes from here on.
   */
  async resetLogLevel(applicationId: string): Promise<LogLevelResult> {
    return this.setLogLevel(applicationId, "");
  }

  // -- load ------------------------------------------------------------------------------------

  /**
   * Tells euclid how loaded this instance is, which is what the autoscaler grows and shrinks the pool on.
   *
   * Called by an application about itself, on its own timer. `instanceId` is the one euclid handed the
   * process in `EUCLID_INSTANCE_ID`: a report that cannot say which slot of which pool it came from is
   * refused rather than attributed to the wrong one, which is how nine hundred reports can land nowhere
   * while every call answers 200.
   *
   * An application deployed without a user of its own runs as `app-<runtimeName>`, which already says which
   * pool it is, so nothing else is needed. One deployed *with* a named user has to pass `applicationId`, and
   * has to be the identity that application runs as - an application able to report another's load could
   * drive somebody else's pool to its ceiling or its floor.
   *
   * **This is not a metric.** Push the same numbers to {@link import("./emo.js").EuclidEmo.pushMetrics} as
   * well if you want the history: that path aggregates into five-minute buckets, which is right for a graph
   * and five minutes too slow for a control loop.
   *
   * @param instanceId this instance, from `EUCLID_INSTANCE_ID`
   * @param utilisation how busy, 0-100; the server clamps it to that range and answers with what it stored
   * @param options the rest of the report - all optional, and all meaning zero or "me" when left out
   */
  async reportLoad(instanceId: string, utilisation: number, options: ReportLoadOptions = {}): Promise<LoadReport> {
    return toLoadReport(
      await this.call("report-load", {
        instanceId,
        utilisation,
        backlog: options.backlog ?? 0,
        active: options.active ?? 0,
        applicationId: options.applicationId ?? "",
      }),
    );
  }

  // -- worker nodes ----------------------------------------------------------------------------

  /**
   * The worker nodes registered to this account, live or not.
   *
   * A node registers itself and renews a lease, so this is the fleet as it has reported itself rather than
   * anything configured here. A node that stopped renewing stays in the listing with `live: false`, which is
   * what tells an absent host from a deregistered one.
   *
   * A list rather than a page, as {@link listApplications} is: the server answers with every node at once,
   * and an installation has tens of hosts rather than thousands. Unlike an application listing this is not
   * scoped by namespace - a host belongs to the account and runs whatever it is given.
   */
  async listNodes(): Promise<WorkerNode[]> {
    return toWorkerNodes(await this.call("list-nodes"));
  }

  /**
   * One node, and what it is holding slots for.
   *
   * The `applications` list is the reason this exists next to {@link listNodes}: working it out means
   * walking every pool once, so the server answers it for one node and not for a listing. Each entry says
   * how many slots this node holds and how many are actually serving out of them.
   *
   * @param node the node's name, as it registered itself
   */
  async getNode(node: string): Promise<WorkerNodeDetails> {
    return toWorkerNodeDetails(await this.call("get-node", { node }));
  }

  /**
   * Stops new instances being placed on a node, and lets the ones it has leave as they are replaced.
   *
   * Not a stop. The node keeps running what it has and keeps renewing its lease - a node that downed tools
   * on being drained would make draining an outage. What changes is that the manager refuses it new
   * assignments, so the pool drifts off it as instances are replaced elsewhere, and the host is empty when
   * it is empty rather than at a moment somebody chose.
   *
   * Taking a host out of service for good is this, then stopping the worker, then
   * {@link deleteNode} - in that order. {@link deleteNode} on its own does not stop a node: a worker that
   * is still running finds itself unregistered on its next renewal and registers again.
   *
   * @param node the node's name
   * @param drained `false` puts it back into service - see {@link resumeNode}, which says that in a word
   */
  async drainNode(node: string, drained = true): Promise<DrainNodeResult> {
    return toDrainNodeResult(await this.call("drain-node", { node, drained }));
  }

  /** Puts a drained node back into service, so the manager places instances on it again. */
  async resumeNode(node: string): Promise<DrainNodeResult> {
    return this.drainNode(node, false);
  }

  /**
   * Removes a node's registration, which is how its name is freed for another host.
   *
   * Administrator-only, unlike the other node actions, and for exactly that reason: a name is bound to the
   * principal that registered it, so a worker able to delete another's registration could re-register under
   * its name and be handed its assignments and its applications' credentials.
   *
   * This does not stop anything. The leases are left alone, and a worker that is still running registers
   * itself again on its next renewal - so {@link drainNode} and stopping the worker are what take a host out
   * of service, and this is what forgets it afterwards.
   *
   * @param node the node's name; one that is not registered is HTTP 404
   */
  async deleteNode(node: string): Promise<DeleteNodeResult> {
    return toDeleteNodeResult(await this.call("delete-node", { node }));
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * EAP's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to EAP.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }

  /** The actions that answer with one application, which is most of them. */
  async #application(action: string, payload: Record<string, unknown>): Promise<Application> {
    return toApplication(await this.call(action, payload));
  }
}
