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
 * The deployment says which buckets and queues it may reach, and euclid grants those to the identity it
 * runs as: a technical principal it creates for the application unless one is named, with no password, no
 * login and one access key. Nothing an application leaks is then a person's credential.
 *
 * Two names for the same things, and the asymmetry is the server's: a deployment names a `bucket` and an
 * `artifact`, and the application that comes back describes a `bucketErn` and an `artifactKey`. Likewise
 * the `buckets` and `queues` it is granted come back resolved into `resources`.
 *
 * Every action here is administrator-only, server-side. {@link EuclidSession.isAdmin} says whether the
 * logged-in user is one, though the server enforces it regardless.
 */

import {
  toApplication,
  toLogLevelResult,
  type Application,
  type LogLevelResult,
} from "../dto/eap.js";
import { ModuleClient } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "eap";

/**
 * What an artifact is handed to. Matched exactly, in upper case, and anything else is refused with
 * HTTP 400 - a runtime is a category rather than a version, so a JDK 17 and a JDK 25 application are both
 * {@link RUNTIME_JAVA} and it is the command or the PATH that decides which one runs.
 */
export const RUNTIME_JAVA = "JAVA";
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
  /**
   * An existing user to run as. Left empty, euclid creates a technical principal for the application -
   * which is the better answer, and why this is not required.
   */
  user?: string;
  /** The smallest the pool goes; at least 1. */
  minInstances?: number;
  /** The largest it goes; never below `minInstances`. */
  maxInstances?: number;
  /** How long an instance has to become ready; at least 1000. */
  readyTimeoutMs?: number;
}

/**
 * What an update changes - and only what it names.
 *
 * The distinction the server draws is between a field being sent and not being sent, rather than between
 * its values: leaving `command` out leaves the stored command alone, while passing `""` clears it and
 * hands the artifact back to the runtime's own interpreter.
 *
 * `buckets` and `queues` are re-resolved together whenever either is named, so naming one and not the
 * other revokes what the other used to grant. Pass both, or neither.
 */
export interface UpdateApplicationChanges {
  runtime?: string;
  artifact?: string;
  version?: string;
  command?: string;
  arguments?: readonly string[];
  environment?: Record<string, string>;
  buckets?: readonly string[];
  queues?: readonly string[];
  minInstances?: number;
  maxInstances?: number;
  readyTimeoutMs?: number;
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
  "minInstances",
  "maxInstances",
  "readyTimeoutMs",
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
   * puts it in service. Refused with HTTP 409 if the ID is taken, and with 404 if the bucket, the
   * artifact, a named resource or a named user is not there - a deployment pointing at nothing would
   * otherwise become an application that fails to start for a reason nobody can see.
   *
   * @param applicationId aoolication ID
   * @param runtime {@link RUNTIME_JAVA}, {@link RUNTIME_PYTHON}, {@link RUNTIME_NODEJS} or
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
      user: options.user ?? "",
      minInstances: options.minInstances ?? DEFAULT_MIN_INSTANCES,
      maxInstances: options.maxInstances ?? DEFAULT_MAX_INSTANCES,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
  }

  /**
   * Changes a deployed application. Only what `changes` names changes - see
   * {@link UpdateApplicationChanges}, which is where the rules about that live.
   *
   * Changing the artifact is a change of what will run next; {@link redeployApplication} is what a new
   * build of the same application usually wants.
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
   * The applications whose ID starts with a prefix; an empty prefix lists them all.
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
