/**
 * EMM - euclid's module manager: the processes euclid runs itself, and the database underneath them.
 *
 * One object, {@link EuclidEmm}, built from a session that has already logged in:
 *
 * ```ts
 * const emm = session.emm();
 *
 * for (const module of await emm.listModules()) {
 *   console.log(module.name, module.instances.length, "instance(s)");
 * }
 * ```
 *
 * Two unrelated jobs live here, and they are here together because both are about the installation rather
 * than about anything stored in it.
 *
 * The first is the **module pools**: every module the manager runs, the processes in each, how many of them
 * there may be, how many threads each runs and what it logs. "Module" is wider than the ten modules this
 * SDK has clients for - an application pool and a transfer server are modules to the manager too - which is
 * why {@link import("../dto/emm.js").Module.core} exists, and why starting and stopping through EMM is for
 * core modules only. EAP and ETS own the desired state of their own kind, and anything recorded here for
 * them would be undone on the next reconcile.
 *
 * Nothing here acts immediately. EMM runs in its own process while the pools live in the manager's, so
 * every control action *records* what was asked for and the manager picks it up on its next reconcile,
 * within a second or so. That is also why these requests survive a restart: they are written on the module
 * document, and start-up applies them over `euclid.json`.
 *
 * The second is **export and import**: the module collections as documents, out of the database and back
 * into it. That is a backup, a copy of one installation into another, and the one way to look at what
 * euclid stores without a database client - see {@link EuclidEmm.exportArchive}.
 *
 * Every action here is administrator-only, server-side, and more plainly so than elsewhere: between them
 * they expose every module's live process pool and every module's raw collections.
 * {@link EuclidSession.isAdmin} says whether the logged-in user is one, though the server enforces it
 * regardless.
 */

import {
  toArchive,
  toImportResult,
  toInstanceLimitsResult,
  toModuleLogLevelResult,
  toModuleStateResult,
  toModuleThreadsResult,
  toModules,
  toRestartModuleResult,
  type Archive,
  type ImportResult,
  type InstanceLimitsResult,
  type Module,
  type ModuleLogLevelResult,
  type ModuleStateResult,
  type ModuleThreadsResult,
  type RestartModuleResult,
} from "../dto/emm.js";
import { ModuleClient } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "emm";

/**
 * What an instance's `state` reads as.
 *
 * The three middles - {@link MODULE_STARTING}, {@link MODULE_STOPPING}, {@link MODULE_RESTARTING} - are
 * what a pool looks like between two reconciles, and seeing one is ordinary rather than a problem. Seeing
 * one for long is not.
 *
 * {@link MODULE_COMPLETED} and {@link MODULE_CRASHED} are both terminal and are not the same thing: a
 * completed instance did what it was started for, which only an EAP job can do - see
 * {@link import("./eap.js").TYPE_JOB} - and nothing restarts it or counts it as lost. A crashed one ended
 * without having been asked to.
 */
export const MODULE_STOPPED = "STOPPED";
export const MODULE_STARTING = "STARTING";
export const MODULE_RUNNING = "RUNNING";
export const MODULE_STOPPING = "STOPPING";
export const MODULE_CRASHED = "CRASHED";
export const MODULE_PENDING_RESTART = "PENDING_RESTART";
export const MODULE_RESTARTING = "RESTARTING";
export const MODULE_COMPLETED = "COMPLETED";
/** What a state this SDK does not know reads as, and what the server calls one it does not either. */
export const MODULE_UNKNOWN = "UNKNOWN";

/** What EMM reports in place of a number nobody has given it - a pending limit, or a load never reported. */
export const NOTHING_PENDING = -1;

/** The largest worker thread count a module will honour, which is what the server clamps to. */
export const MAX_WORKER_THREADS = 256;

/** The instance limits {@link EuclidEmm.setInstances} records. At least one of the two is required. */
export interface InstanceLimits {
  /**
   * The smallest the pool goes; zero is meaningful and means it may scale away entirely when idle, which
   * is why only a negative floor is refused.
   */
  minInstances?: number;
  /** The largest the autoscaler may run; at least 1. */
  maxInstances?: number;
}

/** What goes into an archive. Exactly one of `all` and `modules` is required. */
export interface ExportOptions {
  /** Every module euclid can export. */
  all?: boolean;
  /**
   * The modules to export, by name: `eam`, `eap`, `ekm`, `emm`, `emo`, `ens`, `eqs`, `esm`, `ess`, `ets`.
   * One the server does not recognise is refused, naming the ones it does.
   */
  modules?: readonly string[];
  /**
   * Take the bulk child data too - EQS and ENS messages, ESM objects - rather than only the resources that
   * own them. Off by default, because it can dwarf everything around it and is usually not what somebody
   * inspecting an installation wants.
   */
  full?: boolean;
  /**
   * Seal the archive with this passphrase. The file then holds nothing worth anything without it, which is
   * what makes an export safe to leave on disk - access-key secrets are in there, and EKM's key material
   * if `ekm` was asked for.
   *
   * **`ekm` requires one**, and the server refuses that export without it: a key store's export carries
   * the key material itself, base64-encoded rather than encrypted, because a key store restored without
   * its keys restores nothing.
   *
   * What this protects is the file, not the action: anybody who may call this may call it again without a
   * passphrase. And the passphrase reaches the server to be used, so it wants the same care as a password
   * does on the way in.
   */
  passphrase?: string;
}

/** What an import reads, and what of it. */
export interface ImportOptions {
  /** The passphrase the archive was sealed with. Required for one that was, ignored for one that was not. */
  passphrase?: string;
  /**
   * A subset of the file's modules to import - `["esm"]` out of an archive holding every module. Empty,
   * the default, imports everything the file contains; a collection the filter leaves out is reported in
   * {@link import("../dto/emm.js").ImportResult.skipped} rather than silently dropped.
   */
  modules?: readonly string[];
}

/**
 * EMM's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.emm} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEmm extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  // -- the pools -------------------------------------------------------------------------------

  /**
   * Every module the manager knows, with its pool.
   *
   * A list rather than a page: an installation has tens of modules counting its application pools and
   * transfer servers, and the server answers with all of them at once. Not scoped by namespace either -
   * these are the installation's processes rather than anybody's resources.
   *
   * This is the one view in euclid that shows a process: pids, hosts, ports, restart counts, and what each
   * instance last reported about its own load.
   */
  async listModules(): Promise<Module[]> {
    return toModules(await this.call("list-modules"));
  }

  /**
   * One module by name, or `null` if the manager has never heard of it.
   *
   * Filtered out of {@link listModules} here rather than asked for over the wire, because EMM has no
   * per-module read: there is nothing cheaper to call. For one module out of a handful that costs nothing
   * worth avoiding; in a loop over many names, list once instead.
   *
   * Names are lower case everywhere euclid writes them down - they are the keys of `euclid.modules` - so
   * this matches case-insensitively, as the server does where it can.
   */
  async findModule(name: string): Promise<Module | null> {
    const wanted = name.toLowerCase();
    return (await this.listModules()).find((module) => module.name.toLowerCase() === wanted) ?? null;
  }

  /**
   * Records the instance limits a module's pool runs within.
   *
   * A limit left out is left as it stands, so a ceiling can be raised without restating the floor. The two
   * are checked against each other as they *will* stand - including against a limit set moments ago and
   * not yet reconciled - so the pair can never be left crossed; `minInstances` above the effective
   * `maxInstances` is refused with HTTP 400 naming both.
   *
   * A floor of zero is allowed and means the pool may scale away entirely when idle. Only a negative floor
   * is refused, and a ceiling below 1 - a module that may run no instances at all is a module switched
   * off, and {@link stopModule} is how that is said.
   *
   * @param name the module, e.g. `"esm"`
   * @param limits the floor and the ceiling; at least one of them, or the server refuses the request
   */
  async setInstances(name: string, limits: InstanceLimits): Promise<InstanceLimitsResult> {
    const payload: Record<string, unknown> = { name };
    if (limits.minInstances !== undefined) payload["minInstances"] = limits.minInstances;
    if (limits.maxInstances !== undefined) payload["maxInstances"] = limits.maxInstances;
    return toInstanceLimitsResult(await this.call("set-instances", payload));
  }

  /**
   * Records how many worker threads each of a module's processes runs.
   *
   * Unlike a log level, this cannot be applied to a running process: a thread count is fixed when one
   * starts. So the manager cycles the instances to apply it, one per reconcile tick, and the result's
   * `runningInstances` is how many that will be.
   *
   * Refused outside 1 to {@link MAX_WORKER_THREADS} rather than clamped, because a number stored that the
   * module will not honour is worse than an error - nothing afterwards would ever say so.
   */
  async setThreads(name: string, threads: number): Promise<ModuleThreadsResult> {
    return toModuleThreadsResult(await this.call("set-threads", { name, threads }));
  }

  /**
   * Sets what one module's own output is logged at, without restarting anything.
   *
   * The manager reads it on its next reconcile and applies it to that module's log channel, which the
   * result names. Nothing is interrupted - this is the one control action here that a running process can
   * take as it stands.
   *
   * @param name the module
   * @param level {@link import("./eap.js").LOG_TRACE} and its siblings - the same seven constants EAP's
   *   own log level takes, since a level is a level wherever it is applied, and this package exports one
   *   set of them rather than two identical ones. An empty level takes the setting back - see
   *   {@link resetLogLevel}, which says that in a word.
   */
  async setLogLevel(name: string, level: string): Promise<ModuleLogLevelResult> {
    return toModuleLogLevelResult(await this.call("set-log-level", { name, level }));
  }

  /**
   * Puts a module back under the installation's own logging configuration.
   *
   * Which is not the same as setting it to whatever that configuration says: this removes the override, so
   * the module follows the configuration as it changes from here on.
   */
  async resetLogLevel(name: string): Promise<ModuleLogLevelResult> {
    return this.setLogLevel(name, "");
  }

  /**
   * Stops a module, and keeps it stopped.
   *
   * The desired state is recorded here and the manager acts on it, so the result's `runningInstances` is
   * the pool as it still stands rather than as it will be. It stays stopped across a manager restart,
   * which is the difference between this and killing the processes.
   *
   * Two refusals, both HTTP 400 and both worth knowing before asking - {@link Module.core} says which
   * applies. A module that is not core is EAP's or ETS's to stop
   * ({@link import("./eap.js").EuclidEap.stopApplication}, {@link import("./ets.js").EuclidEts.stopServer}),
   * because a desired state recorded here would be undone by their own reconcile within seconds. And
   * `emm` cannot stop itself: every other module can be brought back with the call this is, and that one
   * could not - it would be a door that locks behind you.
   */
  async stopModule(name: string): Promise<ModuleStateResult> {
    return toModuleStateResult(await this.call("stop-module", { name }));
  }

  /** Lets a stopped module run again. Core modules only, as {@link stopModule} is. */
  async startModule(name: string): Promise<ModuleStateResult> {
    return toModuleStateResult(await this.call("start-module", { name }));
  }

  /**
   * Asks for a module's instances to be started again, one at a time.
   *
   * The manager cycles the pool from the next reconcile tick on, one instance per tick, so a module keeps
   * serving out of the instances it has not reached yet. `runningInstances` is how many it will work
   * through.
   *
   * Unlike {@link stopModule} this is allowed for application pools and transfer servers too: it changes
   * no desired state, so there is nothing for EAP's or ETS's reconcile to disagree with and the same
   * instances come straight back. A module that is *stopped* is refused with HTTP 400 - there is nothing
   * to restart, and honouring it would mean starting what somebody asked to have stopped.
   */
  async restartModule(name: string): Promise<RestartModuleResult> {
    return toRestartModuleResult(await this.call("restart-module", { name }));
  }

  // -- export and import -----------------------------------------------------------------------

  /**
   * Exports module collections as documents - a backup, or a copy of one installation into another.
   *
   * Hand the result to {@link importArchive}, or write it to a file: it is the same shape `euclid-cli emm
   * export` writes, and either tool reads the other's.
   *
   * `all` and `modules` are the two ways to say what goes in, and exactly one of them is required - "every
   * module" and "these modules" are different enough requests that the server will not guess between them.
   * `full` adds the bulk child data; without it an archive holds the resources and not their contents.
   *
   * **A sealed export is one request per module.** When a `passphrase` is given for named modules, this
   * makes a request for each and seals every frame under one key, which is why the archive carries
   * `frames` rather than a single payload: a file holding ten modules is then not also one response
   * holding them. `all` stays a single request, since there is nothing to tie together. None of that shows
   * in the result, and {@link importArchive} reads either.
   *
   * What an archive is worth is worth saying plainly: it carries access-key secrets, and EKM's key
   * material if `ekm` was asked for. An unsealed one is as sensitive as the database it came from.
   */
  async exportArchive(options: ExportOptions): Promise<Archive> {
    const all = options.all ?? false;
    const modules = [...(options.modules ?? [])];
    if (all === modules.length > 0) {
      throw new Error("name exactly one of all or modules");
    }

    const full = options.full ?? false;
    const passphrase = options.passphrase ?? "";
    const body = (named: readonly string[]): Record<string, unknown> => {
      const payload: Record<string, unknown> = { full };
      if (all) payload["all"] = true;
      else payload["modules"] = [...named];
      if (passphrase) payload["passphrase"] = passphrase;
      return payload;
    };

    if (!passphrase || all) return toArchive(await this.call("export", body(modules)));

    // One request per module, every frame under the first one's salt - that is what makes them one
    // archive rather than several files that happen to have been written together.
    const frames: string[] = [];
    const exported: string[] = [];
    let envelope: Archive | null = null;
    let salt = "";

    for (const module of modules) {
      const payload = body([module]);
      if (salt) payload["salt"] = salt;

      const answer = toArchive(await this.call("export", payload));
      if (!answer.encrypted) {
        // The server was asked to seal and did not, which is not a file to hand on as though it were.
        throw new Error(`export of ${module} came back unsealed`);
      }
      frames.push(...answer.frames);
      // Which modules the archive holds is the server's answer rather than the request's, so a file can
      // always say what is in it.
      exported.push(...answer.modules);
      if (!salt) {
        salt = answer.salt;
        envelope = answer;
      }
    }

    if (envelope === null || !envelope.encrypted) throw new Error("nothing was exported");
    return { ...envelope, modules: exported, frames };
  }

  /**
   * Writes an archive back into the database, upserting each document by its `_id`.
   *
   * Replacing the whole document rather than merging fields, so what lands matches the export exactly.
   *
   * A sealed archive needs the passphrase it was sealed with. A wrong passphrase and an altered file fail
   * in the same way and nothing is written when they do - the archive is authenticated as it is opened,
   * which is also why a half-imported archive is not a state this can leave behind.
   *
   * Read the result rather than the absence of an error. A collection the installation does not recognise
   * is skipped and reported, not refused, so an import that wrote nothing still succeeds: the file may
   * have come from a newer euclid, or be something else entirely.
   *
   * @param archive what {@link exportArchive} answered with, or a file written by it or by `euclid-cli`
   * @param options the passphrase, and which of the file's modules to take
   */
  async importArchive(archive: Archive | Record<string, unknown>, options: ImportOptions = {}): Promise<ImportResult> {
    const payload: Record<string, unknown> = { ...archive };
    // Never any part of what was exported, and not something to send back as though it were.
    delete payload["encrypted"];
    if (options.passphrase) payload["passphrase"] = options.passphrase;
    if (options.modules?.length) payload["modules"] = [...options.modules];
    return toImportResult(await this.call("import", payload));
  }
}
