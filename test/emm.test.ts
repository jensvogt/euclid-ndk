/**
 * EMM, end to end against a fake euclid server.
 *
 * Every action is one request, so what these check is that it carries the fields the server reads and
 * parses the ones it answers with. Three things here are worth more than that, and are what the awkward
 * cases below are about: EMM's -1 means "nothing was said" and must not arrive as zero, a sealed
 * multi-module export is several requests sharing one key, and a control action answers with the pool as
 * it still stands rather than as it will be.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  Euclid,
  LOG_DEBUG,
  MAX_WORKER_THREADS,
  MODULE_COMPLETED,
  MODULE_CRASHED,
  MODULE_RUNNING,
  NOTHING_PENDING,
  type EuclidEmm,
  type EuclidSession,
} from "../src/index.js";
import { toModule } from "../src/dto/emm.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin, type RecordedRequest } from "./fake-gateway.js";

const INSTANCE = {
  instanceId: "i-1",
  pid: 4711,
  host: "",
  state: "RUNNING",
  socketPath: "/var/run/euclid/esm-1.sock",
  httpPort: 0,
  restartCount: 2,
  utilisation: 42,
  backlog: 7,
  loadReportedAt: "2026-10-10T08:00:00Z",
  backgroundTasks: 1,
  created: "2026-09-01",
  modified: "2026-10-10",
};

const MODULE = {
  name: "esm",
  executable: "/usr/bin/euclid-esm",
  socketPath: "/var/run/euclid/esm.sock",
  active: true,
  core: true,
  desiredStopped: false,
  autoRestart: true,
  maxRestarts: 5,
  minInstances: 1,
  maxInstances: 4,
  desiredMinInstances: -1,
  desiredMaxInstances: -1,
  desiredThreads: -1,
  logLevel: "",
  created: "2026-09-01",
  modified: "2026-10-10",
  lastStartTime: "2026-10-09T22:00:00Z",
  instances: [INSTANCE],
};

let gateway: FakeGateway;
let session: EuclidSession;
let emm: EuclidEmm;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-emm-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  emm = session.emm();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- the pools ------------------------------------------------------------------------------------

describe("modules", () => {
  it("lists every module with its processes", async () => {
    gateway.answer("emm", "list-modules", {
      total: 2,
      modules: [
        MODULE,
        {
          ...MODULE,
          name: "order-service",
          // An application pool is a module to the manager too, which is what `core` is for.
          core: false,
          instances: [{ ...INSTANCE, instanceId: "i-2", httpPort: 34567, state: "COMPLETED" }],
        },
      ],
    });

    const modules = await emm.listModules();

    assert.deepEqual(modules.map((module) => module.name), ["esm", "order-service"]);
    assert.deepEqual([modules[0]?.core, modules[1]?.core], [true, false]);

    const instance = modules[0]?.instances[0];
    assert.deepEqual([instance?.pid, instance?.state, instance?.restartCount], [4711, MODULE_RUNNING, 2]);
    // The port is the only record of which instance is reachable where, and 0 for a module with no
    // listener of its own.
    assert.deepEqual([modules[0]?.instances[0]?.httpPort, modules[1]?.instances[0]?.httpPort], [0, 34567]);
    // Terminal, and not a fault: a completed instance did what it was started for.
    assert.equal(modules[1]?.instances[0]?.state, MODULE_COMPLETED);
  });

  it("reads -1 as nothing said, and keeps it apart from zero", async () => {
    // The distinction this module turns on. A pending limit of -1 is "nobody has asked"; a floor of 0
    // is "scale away entirely when idle". A load of -1 is "never reported"; 0 is "reported idle".
    const pending = toModule({ ...MODULE, desiredMinInstances: 0, desiredThreads: 8 });
    assert.deepEqual([pending.desiredMinInstances, pending.desiredThreads], [0, 8]);
    assert.equal(pending.desiredMaxInstances, NOTHING_PENDING);

    const never = toModule({ ...MODULE, instances: [{ ...INSTANCE, utilisation: -1, backlog: -1, loadReportedAt: "" }] });
    assert.deepEqual([never.instances[0]?.utilisation, never.instances[0]?.backlog], [-1, -1]);
    assert.equal(never.instances[0]?.loadReportedAt, "");

    const idle = toModule({ ...MODULE, instances: [{ ...INSTANCE, utilisation: 0, backlog: 0 }] });
    assert.deepEqual([idle.instances[0]?.utilisation, idle.instances[0]?.backlog], [0, 0]);

    // A server too old to send them says nothing either, which must not read as a reported zero.
    const silent = toModule({ name: "esm" });
    assert.deepEqual(
      [silent.desiredMinInstances, silent.desiredMaxInstances, silent.desiredThreads],
      [NOTHING_PENDING, NOTHING_PENDING, NOTHING_PENDING],
    );
    // And a pool that has never started sends null for its start time, which reads as empty.
    assert.equal(toModule({ ...MODULE, lastStartTime: null }).lastStartTime, "");
  });

  it("finds one module by name, case and all, and answers null for one nobody knows", async () => {
    gateway.answer("emm", "list-modules", { modules: [MODULE] });

    assert.equal((await emm.findModule("esm"))?.name, "esm");
    // Module names are the lower-case keys of euclid.modules, so "ESM" is a spelling rather than a miss.
    assert.equal((await emm.findModule("ESM"))?.name, "esm");
    assert.equal(await emm.findModule("ees"), null);
    // Filtered here because EMM has no per-module read: the listing is the only thing there is to call.
    assert.equal(gateway.last().action, "list-modules");
  });
});

// -- limits ---------------------------------------------------------------------------------------

describe("limits", () => {
  it("sends only the limit it was given", async () => {
    gateway.answer("emm", "set-instances", { name: "esm", minInstances: 1, maxInstances: 8, runningInstances: 2 });

    const raised = await emm.setInstances("esm", { maxInstances: 8 });
    assert.deepEqual(gateway.last().json(), { name: "esm", maxInstances: 8 });
    // Both come back as they will stand, not as they were asked for - the floor here was never named.
    assert.deepEqual([raised.minInstances, raised.maxInstances], [1, 8]);
    // The pool before the manager has acted, which is what makes this a measure of the change's cost.
    assert.equal(raised.runningInstances, 2);

    await emm.setInstances("esm", { minInstances: 0 });
    assert.deepEqual(gateway.last().json(), { name: "esm", minInstances: 0 });

    await emm.setInstances("esm", { minInstances: 2, maxInstances: 2 });
    assert.deepEqual(gateway.last().json(), { name: "esm", minInstances: 2, maxInstances: 2 });
  });

  it("leaves a crossed pair and a bad thread count to the server to refuse", async () => {
    // Checked server-side against whatever the other limit will end up being, including one set a
    // moment ago and not yet reconciled - which a client cannot know.
    gateway.answer("emm", "set-instances", { error: "minInstances (6) cannot exceed maxInstances (4)" }, 400);
    await assert.rejects(
      () => emm.setInstances("esm", { minInstances: 6 }),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["set-instances", 400]);
        return true;
      },
    );

    gateway.answer("emm", "set-threads", { error: "threads must be between 1 and 256" }, 400);
    await assert.rejects(
      () => emm.setThreads("esm", MAX_WORKER_THREADS + 1),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
  });

  it("sets worker threads, and says how many instances have to cycle for it", async () => {
    gateway.answer("emm", "set-threads", { name: "eqs", threads: 16, runningInstances: 3 });

    const result = await emm.setThreads("eqs", 16);

    assert.deepEqual(gateway.last().json(), { name: "eqs", threads: 16 });
    // A thread count is fixed when a process starts, so this is the work the change costs: three
    // instances to cycle before every one of them runs with it.
    assert.deepEqual([result.threads, result.runningInstances], [16, 3]);
  });
});

// -- logging --------------------------------------------------------------------------------------

describe("logging", () => {
  it("sets a module's level and takes it back", async () => {
    gateway.answer("emm", "set-log-level", { name: "esm", logLevel: "debug", channel: "euclid.module.esm" });

    const turnedUp = await emm.setLogLevel("esm", LOG_DEBUG);
    assert.deepEqual(gateway.last().json(), { name: "esm", level: "debug" });
    assert.deepEqual([turnedUp.logLevel, turnedUp.channel], ["debug", "euclid.module.esm"]);

    // An empty level is how an override is withdrawn rather than merely changed: there is no level
    // name meaning "whatever was configured".
    gateway.answer("emm", "set-log-level", { name: "esm", logLevel: "", channel: "euclid.module.esm" });
    const restored = await emm.resetLogLevel("esm");
    assert.deepEqual(gateway.last().json(), { name: "esm", level: "" });
    assert.equal(restored.logLevel, "");
  });
});

// -- control --------------------------------------------------------------------------------------

describe("stopping, starting and restarting", () => {
  it("records a stop and a start, with the pool as it still stands", async () => {
    gateway.answer("emm", "stop-module", { name: "ets", stopped: true, runningInstances: 2 });

    const stopped = await emm.stopModule("ets");
    assert.deepEqual(gateway.last().json(), { name: "ets" });
    // Two instances still running: the manager stops them on its next reconcile, so this is the count
    // before it has acted.
    assert.deepEqual([stopped.stopped, stopped.runningInstances], [true, 2]);

    gateway.answer("emm", "start-module", { name: "ets", stopped: false, runningInstances: 0 });
    const started = await emm.startModule("ets");
    assert.deepEqual(gateway.last().json(), { name: "ets" });
    assert.equal(started.stopped, false);
  });

  it("leaves the two refusals to the server, which knows which applies", async () => {
    // An application pool's desired state belongs to EAP, and a stop recorded here would be undone by
    // its reconcile within seconds.
    gateway.answer(
      "emm",
      "stop-module",
      { error: 'order-service is not a euclid module - use "eap stop-application" or "ets stop-server" for its own kind' },
      400,
    );
    await assert.rejects(
      () => emm.stopModule("order-service"),
      (error: EuclidServiceError) => {
        assert.match(error.reason, /not a euclid module/);
        return true;
      },
    );

    // And the one that would lock the door behind it.
    gateway.answer("emm", "stop-module", { error: "emm cannot stop itself - there would be nothing left to start it again" }, 400);
    await assert.rejects(
      () => emm.stopModule("emm"),
      (error: EuclidServiceError) => {
        assert.match(error.reason, /nothing left to start it again/);
        return true;
      },
    );
  });

  it("restarts a running module and refuses a stopped one", async () => {
    gateway.answer("emm", "restart-module", { name: "esm", runningInstances: 4 });

    const result = await emm.restartModule("esm");
    assert.deepEqual(gateway.last().json(), { name: "esm" });
    // One instance per reconcile tick, so the module keeps serving out of the rest.
    assert.equal(result.runningInstances, 4);

    gateway.answer("emm", "restart-module", { error: 'ets is stopped - use "emm start-module" to bring it back' }, 400);
    await assert.rejects(
      () => emm.restartModule("ets"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["restart-module", 400]);
        return true;
      },
    );
  });
});

// -- export and import ----------------------------------------------------------------------------

describe("export", () => {
  it("exports named modules in one request", async () => {
    gateway.answer("emm", "export", {
      modules: ["eqs", "esm"],
      full: true,
      exportedAt: "2026-10-10T09:00:00Z",
      collections: { eqs_queue: [{ _id: "1" }], esm_bucket: [{ _id: "2" }, { _id: "3" }] },
    });

    const archive = await emm.exportArchive({ modules: ["eqs", "esm"], full: true });

    assert.deepEqual(gateway.last().json(), { full: true, modules: ["eqs", "esm"] });
    assert.equal(archive.encrypted, false);
    if (archive.encrypted) return;
    assert.deepEqual(Object.keys(archive.collections).sort(), ["eqs_queue", "esm_bucket"]);
    assert.equal(archive.collections["esm_bucket"]?.length, 2);
    assert.deepEqual(archive.modules, ["eqs", "esm"]);
  });

  it("asks for every module in one request, sealed or not", async () => {
    gateway.answer("emm", "export", {
      encrypted: true,
      modules: ["eam", "eqs"],
      full: false,
      exportedAt: "2026-10-10T09:00:00Z",
      kdf: "pbkdf2-sha256",
      iterations: 600000,
      salt: "c2FsdA==",
      cipher: "aes-256-gcm",
      data: "ZnJhbWUtMQ==",
    });

    const archive = await emm.exportArchive({ all: true, passphrase: "hunter2" });

    // all stays a single request even when sealed: there is nothing to tie together.
    assert.deepEqual(gateway.last().json(), { full: false, all: true, passphrase: "hunter2" });
    assert.equal(archive.encrypted, true);
    if (!archive.encrypted) return;
    // One response's payload arrives as "data" and is read back as a single frame, so that what this
    // hands on is the same shape a multi-module archive has.
    assert.deepEqual(archive.frames, ["ZnJhbWUtMQ=="]);
    assert.deepEqual([archive.kdf, archive.iterations, archive.cipher], ["pbkdf2-sha256", 600000, "aes-256-gcm"]);
  });

  it("seals several modules as frames under one key", async () => {
    const bodies: RecordedRequest[] = [];
    let frame = 0;
    gateway.on("emm", "export", (request) => {
      bodies.push(request);
      frame += 1;
      return [
        200,
        {
          encrypted: true,
          // The server names what it exported, which is what lets the file say what is in it.
          modules: [request.json()["modules"] as string[]].flat(),
          full: false,
          exportedAt: "2026-10-10T09:00:00Z",
          kdf: "pbkdf2-sha256",
          iterations: 600000,
          salt: "c2FsdA==",
          cipher: "aes-256-gcm",
          data: `frame-${frame}`,
        },
      ];
    });

    const archive = await emm.exportArchive({ modules: ["eqs", "esm", "eam"], passphrase: "hunter2" });

    // One request per module, and every one after the first carries the salt the first came back with -
    // that is what makes them one archive rather than three files written at the same time.
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies.map((body) => body.json()["modules"]), [["eqs"], ["esm"], ["eam"]]);
    assert.equal(bodies[0]?.json()["salt"], undefined);
    assert.deepEqual(bodies.slice(1).map((body) => body.json()["salt"]), ["c2FsdA==", "c2FsdA=="]);

    assert.equal(archive.encrypted, true);
    if (!archive.encrypted) return;
    assert.deepEqual(archive.frames, ["frame-1", "frame-2", "frame-3"]);
    assert.deepEqual(archive.modules, ["eqs", "esm", "eam"]);
  });

  it("refuses to ask for both every module and some of them, or neither", async () => {
    // Refused here rather than over the wire: the server answers the same way, and this is a mistake
    // in the call rather than anything about the installation.
    await assert.rejects(() => emm.exportArchive({ all: true, modules: ["esm"] }), /exactly one/);
    await assert.rejects(() => emm.exportArchive({}), /exactly one/);
  });

  it("passes the server's refusal of an unsealed ekm export through", async () => {
    gateway.answer("emm", "export", { error: 'exporting ekm requires a "passphrase": it carries the key material itself' }, 400);

    await assert.rejects(
      () => emm.exportArchive({ modules: ["ekm"] }),
      (error: EuclidServiceError) => {
        assert.match(error.reason, /carries the key material/);
        return true;
      },
    );
  });
});

describe("import", () => {
  it("hands an archive back, and reads what landed and what did not", async () => {
    gateway.answer("emm", "import", {
      imported: { esm_bucket: { imported: 2 }, eqs_queue: { imported: 7, failed: 1 } },
      skipped: [{ collection: "ees_event", reason: "unknown collection" }],
    });

    const result = await emm.importArchive({
      encrypted: false,
      modules: ["esm", "eqs"],
      full: false,
      exportedAt: "2026-10-10T09:00:00Z",
      collections: { esm_bucket: [{ _id: "1" }], eqs_queue: [{ _id: "2" }] },
    });

    // "encrypted" is this parser's, not the server's, so it does not go back.
    const sent = gateway.last().json();
    assert.ok(!("encrypted" in sent));
    assert.deepEqual(Object.keys(sent["collections"] as object).sort(), ["eqs_queue", "esm_bucket"]);

    // Flattened and sorted, with failed filled in for the collections that did not report one.
    assert.deepEqual(result.imported, [
      { collection: "eqs_queue", imported: 7, failed: 1 },
      { collection: "esm_bucket", imported: 2, failed: 0 },
    ]);
    // A collection this installation does not recognise is reported rather than refused, which is why
    // the result is worth reading: an import that wrote nothing still succeeds.
    assert.deepEqual(result.skipped, [{ collection: "ees_event", reason: "unknown collection" }]);
  });

  it("carries the passphrase and the module filter", async () => {
    gateway.answer("emm", "import", { imported: {}, skipped: [] });

    await emm.importArchive(
      { encrypted: true, modules: ["esm", "eqs"], full: false, exportedAt: "", kdf: "pbkdf2-sha256", iterations: 600000, salt: "c2FsdA==", cipher: "aes-256-gcm", frames: ["frame-1"] },
      { passphrase: "hunter2", modules: ["esm"] },
    );

    const sent = gateway.last().json();
    assert.deepEqual(sent["frames"], ["frame-1"]);
    assert.equal(sent["salt"], "c2FsdA==");
    assert.equal(sent["passphrase"], "hunter2");
    // The filter is the import's own, and overrides what the file says it holds.
    assert.deepEqual(sent["modules"], ["esm"]);
  });

  it("says the same thing for a wrong passphrase as for an altered file", async () => {
    // GCM authenticates as it decrypts, so neither can be told from the other - and nothing is written
    // when either happens.
    gateway.answer("emm", "import", { error: "cannot open this export: wrong passphrase, or the file has been altered" }, 400);

    await assert.rejects(
      () => emm.importArchive({ frames: ["frame-1"] }, { passphrase: "wrong" }),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["import", 400]);
        return true;
      },
    );
  });
});

// -- behaviour ------------------------------------------------------------------------------------

describe("how EMM behaves", () => {
  it("signs its own target and is the same client each time", async () => {
    gateway.answer("emm", "list-modules", { modules: [] });

    await emm.listModules();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "emm");

    assert.equal(session.emm(), emm);
  });

  it("says who refused an administrator-only action", async () => {
    // Every action here is, and more plainly than elsewhere: between them they expose every module's
    // live process pool and every module's raw collections.
    gateway.answer("emm", "list-modules", { error: "administrator privileges required" }, 403);

    await assert.rejects(
      () => emm.listModules(),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.status], ["emm", 403]);
        assert.equal(error.reason, "administrator privileges required");
        return true;
      },
    );
  });

  it("reaches an action this SDK has not wrapped", async () => {
    gateway.answer("emm", "some-future-action", { ok: true });

    assert.deepEqual(await emm.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });

  it("exports the states an instance reads as", () => {
    // Spelled by hand rather than derived: the server matches them exactly, and a constant that drifted
    // would read perfectly in calling code and be wrong only against a running installation.
    assert.deepEqual([MODULE_RUNNING, MODULE_CRASHED, MODULE_COMPLETED], ["RUNNING", "CRASHED", "COMPLETED"]);
  });
});
