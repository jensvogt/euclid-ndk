/**
 * The shapes EMM sends back.
 *
 * Parsed the same defensive way as every other module's, with one habit of this module's own worth knowing
 * before reading the numbers: EMM reports **-1 for "nothing was said"**, where other modules leave a field
 * out. An instance that has never reported its load, and a limit nobody has asked to change, are both -1 -
 * and -1 is not zero. A pool whose floor reads 0 has been asked to scale away when idle; one that reads -1
 * has been asked nothing.
 */

import { documents, flag, number, object, text } from "./json.js";

/**
 * One process of a module, as the manager last saw it.
 *
 * A module is a pool rather than a process, so this is one member of it. The instances come and go as the
 * pool grows, shrinks and restarts, which makes every field here a snapshot rather than a setting.
 */
export interface ModuleInstance {
  instanceId: string;
  pid: number;
  /**
   * Which machine that pid is on. Empty on a single-host installation - where it says nothing anybody did
   * not already know - and on a record written before the field existed.
   */
  host: string;
  /**
   * `RUNNING`, `STOPPED`, `CRASHED`, `COMPLETED` and the rest - see
   * {@link import("../modules/emm.js").MODULE_RUNNING}.
   */
  state: string;
  socketPath: string;
  /**
   * The port this instance was given for its own HTTP listener, 0 for a module that has none. The only
   * record of which instance is reachable where, which is why EMM reports it at all.
   */
  httpPort: number;
  restartCount: number;
  /**
   * How loaded the instance says it is, 0-100, and how much work it says is waiting - the two an instance
   * writes about itself through {@link import("../modules/eap.js").EuclidEap.reportLoad}. The manager
   * cannot observe either.
   *
   * **-1 means it has never reported**, which is a different thing from reporting no load: a module that
   * does not report, an SDK too old to know how, or a call being refused. Without these here, "why is the
   * pool not growing" has no answer short of reading the database by hand.
   */
  utilisation: number;
  backlog: number;
  /** When it last reported, or empty if it never has. */
  loadReportedAt: string;
  /**
   * Work the instance is doing that no request is waiting on - a background purge, say. Scale-down passes
   * over an instance reporting any, because stopping it would abandon the work.
   */
  backgroundTasks: number;
  created: string;
  modified: string;
}

/**
 * One module the manager runs, its pool, and the limits it runs within.
 *
 * "Module" is wider here than the ten this SDK has clients for: an application pool and a transfer server
 * are modules to the manager too, which is why {@link core} exists. Only a core module can be started and
 * stopped through EMM - an application's desired state belongs to EAP and a transfer server's to ETS, and
 * anything recorded here for them would be undone on the manager's next reconcile.
 */
export interface Module {
  name: string;
  executable: string;
  socketPath: string;
  /** Whether the manager has this module switched on at all - the `euclid.modules` entry, not the pool. */
  active: boolean;
  /**
   * Whether this is one of euclid's own modules, as against an application pool or a transfer server.
   *
   * Reported so a caller can say what will be refused before asking rather than by being refused:
   * {@link import("../modules/emm.js").EuclidEmm.stopModule} and `startModule` take core modules only.
   */
  core: boolean;
  /** Whether somebody has asked for it to stay stopped - what `stopModule` records. */
  desiredStopped: boolean;
  autoRestart: boolean;
  maxRestarts: number;
  /** The limits the pool is running within now, as the manager last reconciled them. */
  minInstances: number;
  maxInstances: number;
  /**
   * What has been asked for and not yet reconciled - **-1 when nothing is pending**.
   *
   * These are what `set-instances` and `set-threads` write, and they are separate fields rather than
   * changes to the three above because the module document's own limits are rewritten from the manager's
   * configuration whenever an instance changes state: a limit stored there would last until the next
   * restart. Reported because a caller adjusting a limit twice in quick succession would otherwise compute
   * the second change from a value the first has already replaced.
   */
  desiredMinInstances: number;
  desiredMaxInstances: number;
  desiredThreads: number;
  /** The level this module logs at, or empty when it is under the installation's own configuration. */
  logLevel: string;
  created: string;
  modified: string;
  /** When the pool was last started, or empty if it never has been - the server sends null for that. */
  lastStartTime: string;
  instances: ModuleInstance[];
}

/**
 * The instance limits a module now runs within, and what the pool looks like while it catches up.
 *
 * Both limits come back as they will stand - the one just set, or the one already standing - so neither
 * reads back as -1 here whatever the request named. `runningInstances` is the count *before* the manager
 * has acted: this records what was asked for, and the manager moves the pool toward it on its next
 * reconcile, within a second or so.
 */
export interface InstanceLimitsResult {
  name: string;
  minInstances: number;
  maxInstances: number;
  runningInstances: number;
}

/**
 * The worker thread count a module's processes will run with.
 *
 * A thread count is fixed when a process starts, so `runningInstances` is how many instances the manager
 * still has to cycle before every one of them is running with it - this number is a measure of what the
 * change will cost, not of what it has done.
 */
export interface ModuleThreadsResult {
  name: string;
  threads: number;
  runningInstances: number;
}

/**
 * What a module logs at now, and the channel it logs on.
 *
 * An empty `logLevel` means the level was taken back rather than changed: the module is under whatever the
 * installation's logging configuration says again.
 */
export interface ModuleLogLevelResult {
  name: string;
  logLevel: string;
  channel: string;
}

/**
 * What a stop or start recorded.
 *
 * `stopped` is the desired state as it now stands, and `runningInstances` is what the pool still looks
 * like: the manager stops or starts the instances on its next reconcile, so this is the count before it has
 * acted rather than after.
 */
export interface ModuleStateResult {
  name: string;
  stopped: boolean;
  runningInstances: number;
}

/** A module and how many instances the manager will cycle, one per reconcile tick, starting on the next. */
export interface RestartModuleResult {
  name: string;
  runningInstances: number;
}

/**
 * An export nobody sealed: the documents themselves, keyed by collection.
 *
 * `encrypted` is `false` rather than absent, so that {@link Archive} can be narrowed on it. The server
 * leaves the field out of a plain export; this parser writes it in.
 */
export interface PlainArchive {
  encrypted: false;
  /** The modules the archive holds, as the server named them - which is the answer for `all`, too. */
  modules: string[];
  /** Whether the bulk child data went in as well: EQS and ENS messages, ESM objects. */
  full: boolean;
  exportedAt: string;
  /** Collection name to the documents in it, exactly as the database holds them. */
  collections: Record<string, unknown[]>;
}

/**
 * A sealed export: the same thing, encrypted, plus what is needed to open it.
 *
 * The envelope stays readable on purpose - which modules, when, and how to derive the key. That is enough
 * to tell what a file is and to ask for the right passphrase, without giving away a byte of what it holds.
 *
 * `frames` is one sealed payload per request, all under the same key: a multi-module export is one request
 * per module, so that a file holding every module is not also a single response holding it.
 */
export interface SealedArchive {
  encrypted: true;
  modules: string[];
  full: boolean;
  exportedAt: string;
  /** How the key was derived from the passphrase, and over how many iterations. */
  kdf: string;
  iterations: number;
  /** The salt it was derived with, base64. A caller never needs it; opening the archive does. */
  salt: string;
  cipher: string;
  frames: string[];
}

/** What an export answers with - {@link SealedArchive} when a passphrase was given, else plain. */
export type Archive = PlainArchive | SealedArchive;

/** One collection an import wrote, and how much of it went in. */
export interface ImportedCollection {
  collection: string;
  imported: number;
  /** Documents the collection refused. Zero unless the file holds something the schema will not take. */
  failed: number;
}

/** One collection an import did not write, and why - an unknown name, or one the filter excluded. */
export interface SkippedCollection {
  collection: string;
  reason: string;
}

/**
 * What an import did, collection by collection.
 *
 * Both lists are worth reading, and `skipped` especially: a file naming a collection this installation does
 * not recognise is answered rather than refused, so an import that wrote nothing at all still succeeds. The
 * count a caller wants is usually the sum of `imported`, not the fact that the call returned.
 */
export interface ImportResult {
  imported: ImportedCollection[];
  skipped: SkippedCollection[];
}

// -- parsers ---------------------------------------------------------------------------------------

export function toModuleInstance(document: unknown): ModuleInstance {
  return {
    instanceId: text(document, "instanceId"),
    pid: number(document, "pid"),
    host: text(document, "host"),
    state: text(document, "state"),
    socketPath: text(document, "socketPath"),
    httpPort: number(document, "httpPort"),
    restartCount: number(document, "restartCount"),
    // Defaulted to -1 rather than to 0, unlike every other number this package parses: for these two
    // zero is a report of no load, and a server that said nothing has not reported one.
    utilisation: numberOr(document, "utilisation", -1),
    backlog: numberOr(document, "backlog", -1),
    loadReportedAt: text(document, "loadReportedAt"),
    backgroundTasks: number(document, "backgroundTasks"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toModule(document: unknown): Module {
  return {
    name: text(document, "name"),
    executable: text(document, "executable"),
    socketPath: text(document, "socketPath"),
    active: flag(document, "active"),
    core: flag(document, "core"),
    desiredStopped: flag(document, "desiredStopped"),
    autoRestart: flag(document, "autoRestart"),
    maxRestarts: number(document, "maxRestarts"),
    minInstances: number(document, "minInstances"),
    maxInstances: number(document, "maxInstances"),
    // -1 is the server's own "nothing pending", and what an older one not sending these means too.
    desiredMinInstances: numberOr(document, "desiredMinInstances", -1),
    desiredMaxInstances: numberOr(document, "desiredMaxInstances", -1),
    desiredThreads: numberOr(document, "desiredThreads", -1),
    logLevel: text(document, "logLevel"),
    created: text(document, "created"),
    modified: text(document, "modified"),
    // Sent as null for a pool that has never started, which `text` already reads as empty.
    lastStartTime: text(document, "lastStartTime"),
    instances: documents(document, "instances").map(toModuleInstance),
  };
}

export function toModules(document: unknown): Module[] {
  return documents(document, "modules").map(toModule);
}

export function toInstanceLimitsResult(document: unknown): InstanceLimitsResult {
  return {
    name: text(document, "name"),
    minInstances: number(document, "minInstances"),
    maxInstances: number(document, "maxInstances"),
    runningInstances: number(document, "runningInstances"),
  };
}

export function toModuleThreadsResult(document: unknown): ModuleThreadsResult {
  return {
    name: text(document, "name"),
    threads: number(document, "threads"),
    runningInstances: number(document, "runningInstances"),
  };
}

export function toModuleLogLevelResult(document: unknown): ModuleLogLevelResult {
  return {
    name: text(document, "name"),
    logLevel: text(document, "logLevel"),
    channel: text(document, "channel"),
  };
}

export function toModuleStateResult(document: unknown): ModuleStateResult {
  return {
    name: text(document, "name"),
    stopped: flag(document, "stopped"),
    runningInstances: number(document, "runningInstances"),
  };
}

export function toRestartModuleResult(document: unknown): RestartModuleResult {
  return { name: text(document, "name"), runningInstances: number(document, "runningInstances") };
}

export function toArchive(document: unknown): Archive {
  const source = object(document);
  const modules = Array.isArray(source["modules"])
    ? source["modules"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const common = { modules, full: flag(document, "full"), exportedAt: text(document, "exportedAt") };

  if (!flag(document, "encrypted")) {
    const collections: Record<string, unknown[]> = {};
    for (const [name, docs] of Object.entries(object(source["collections"]))) {
      if (Array.isArray(docs)) collections[name] = docs;
    }
    return { encrypted: false, ...common, collections };
  }

  // One response carries one sealed payload under "data"; an archive assembled from several carries them
  // all under "frames". Read either way round, so a file written by this SDK and one written by
  // euclid-cli parse the same.
  const frames = Array.isArray(source["frames"])
    ? source["frames"].filter((entry): entry is string => typeof entry === "string")
    : typeof source["data"] === "string"
      ? [source["data"]]
      : [];

  return {
    encrypted: true,
    ...common,
    kdf: text(document, "kdf"),
    iterations: number(document, "iterations"),
    salt: text(document, "salt"),
    cipher: text(document, "cipher"),
    frames,
  };
}

export function toImportResult(document: unknown): ImportResult {
  const imported = Object.entries(object(object(document)["imported"]))
    .map(([collection, result]) => ({
      collection,
      imported: number(result, "imported"),
      // Left out entirely when nothing failed, which is the ordinary case.
      failed: number(result, "failed"),
    }))
    .sort((left, right) => left.collection.localeCompare(right.collection));

  const skipped = documents(document, "skipped").map((entry) => ({
    collection: text(entry, "collection"),
    reason: text(entry, "reason"),
  }));

  return { imported, skipped };
}

/** A number field with a fallback other than zero, for the places EMM writes -1 to mean "nothing said". */
function numberOr(document: unknown, name: string, fallback: number): number {
  const value = object(document)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
