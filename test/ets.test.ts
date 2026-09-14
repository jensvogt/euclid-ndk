/**
 * ETS, end to end against a fake euclid server.
 *
 * Every action is one request, so what these check is that it carries the fields the server reads and parses
 * the ones it answers with. The two worth more attention: a create fills in the defaults a deployment usually
 * wants rather than sending zeros, and an update sends only what it was given - where an empty string is a
 * value and an empty list revokes.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  Euclid,
  MAX_PORT,
  PROTOCOL_FTP,
  PROTOCOL_SFTP,
  STATE_RUNNING,
  STATE_STOPPED,
  type EuclidEts,
  type EuclidSession,
} from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

const SERVER = {
  serverId: "drop-box",
  runtimeName: "drop-box-7h2k9p",
  ern: "ern:euclid:ets:eu-central-1:000000000000:server/development/drop-box",
  accountId: "000000000000",
  namespace: "development",
  region: "eu-central-1",
  protocol: "SFTP",
  address: "0.0.0.0",
  port: 2222,
  bucketName: "incoming",
  bucketErn: "ern:esm:bucket/incoming",
  homeDirectory: "partners/acme",
  userIds: ["jens"],
  userGroups: ["partners"],
  directories: ["inbox", "outbox"],
  desiredState: "STOPPED",
  state: "STOPPED",
  hostKey: "drop-box-key",
  pasvMin: 6000,
  pasvMax: 6100,
  created: "2026-09-01",
  modified: "2026-09-13",
};

let gateway: FakeGateway;
let session: EuclidSession;
let ets: EuclidEts;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-ets-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  ets = session.ets();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- servers ---------------------------------------------------------------------------------------

describe("transfer servers", () => {
  it("defines one in front of a bucket, stopped", async () => {
    gateway.answer("ets", "create-server", SERVER);

    const server = await ets.createServer("drop-box", "incoming", 2222, {
      homeDirectory: "partners/acme",
      userIds: ["jens"],
      userGroups: ["partners"],
      directories: ["inbox", "outbox"],
      hostKey: "drop-box-key",
    });

    // SFTP, every interface and the usual passive range unless the deployment says otherwise.
    assert.deepEqual(gateway.last().json(), {
      serverId: "drop-box",
      bucket: "incoming",
      port: 2222,
      protocol: "SFTP",
      address: "0.0.0.0",
      homeDirectory: "partners/acme",
      userIds: ["jens"],
      userGroups: ["partners"],
      directories: ["inbox", "outbox"],
      hostKey: "drop-box-key",
      pasvMin: 6000,
      pasvMax: 6100,
    });

    assert.equal(server.bucketErn, "ern:esm:bucket/incoming");
    // Its own name on the host, as an EAP application has: a server ID is unique only within a namespace.
    assert.equal(server.runtimeName, "drop-box-7h2k9p");
    assert.equal(server.namespace, "development");
    // Nothing listens yet.
    assert.deepEqual([server.desiredState, server.state], [STATE_STOPPED, STATE_STOPPED]);
    // A bucket has no directories of its own, so these are what a client is told exist.
    assert.deepEqual(server.directories, ["inbox", "outbox"]);
  });

  it("takes FTP and a narrowed address when asked", async () => {
    gateway.answer("ets", "create-server", { ...SERVER, protocol: "FTP", address: "10.0.0.5", port: 21 });

    const server = await ets.createServer("legacy", "incoming", 21, {
      protocol: PROTOCOL_FTP,
      address: "10.0.0.5",
      pasvMin: 50000,
      pasvMax: 50100,
    });

    assert.deepEqual(
      [gateway.last().json()["protocol"], gateway.last().json()["address"], gateway.last().json()["pasvMin"]],
      [PROTOCOL_FTP, "10.0.0.5", 50000],
    );
    assert.equal(server.protocol, PROTOCOL_FTP);
  });

  it("refuses a port outside the range before the round trip", async () => {
    await assert.rejects(() => ets.createServer("drop-box", "incoming", 0), /between 1 and 65535/);
    await assert.rejects(() => ets.createServer("drop-box", "incoming", MAX_PORT + 1), /between 1 and 65535/);
    await assert.rejects(() => ets.updateServer("drop-box", { port: -1 }), /between 1 and 65535/);

    assert.deepEqual(gateway.requests.filter((request) => request.target === "ets"), []);
  });

  it("carries the server's reason when the port is taken", async () => {
    // A TCP port is not partitioned by account or namespace, so that check crosses both.
    gateway.answer(
      "ets",
      "create-server",
      { error: "port 2222 is already used by transfer server 'drop-box'" },
      409,
    );

    await assert.rejects(
      () => ets.createServer("other", "incoming", 2222),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["ets", "create-server", 409]);
        assert.ok(error.reason.startsWith("port 2222 is already used"));
        return true;
      },
    );
  });

  it("sends only what an update was given", async () => {
    gateway.answer("ets", "update-server", SERVER);

    await ets.updateServer("drop-box", { directories: ["inbox", "outbox", "archive"] });
    assert.deepEqual(gateway.last().json(), {
      serverId: "drop-box",
      directories: ["inbox", "outbox", "archive"],
    });

    // An empty string is a value here - it puts sessions back at the root of the bucket - and an empty list
    // revokes rather than leaving the stored one alone.
    await ets.updateServer("drop-box", { homeDirectory: "", userGroups: [] });
    assert.deepEqual(gateway.last().json(), { serverId: "drop-box", homeDirectory: "", userGroups: [] });

    await ets.updateServer("drop-box", { bucket: "archive", port: 2223, hostKey: "rotated" });
    assert.deepEqual(gateway.last().json(), {
      serverId: "drop-box",
      bucket: "archive",
      port: 2223,
      hostKey: "rotated",
    });
  });

  it("gets, lists and deletes them", async () => {
    gateway.answer("ets", "get-server", SERVER);
    gateway.answer("ets", "list-servers", { servers: [SERVER, { serverId: "legacy" }] });
    gateway.answer("ets", "delete-server", { serverId: "drop-box", deleted: true });

    assert.equal((await ets.getServer("drop-box")).port, 2222);
    assert.deepEqual(gateway.last().json(), { serverId: "drop-box" });

    const servers = await ets.listServers("drop");
    assert.deepEqual(gateway.last().json(), { prefix: "drop" });
    assert.deepEqual(servers.map((server) => server.serverId), ["drop-box", "legacy"]);
    // A field the server did not send reads as empty rather than throwing.
    assert.deepEqual([servers[1]?.port, servers[1]?.directories], [0, []]);

    assert.deepEqual(await ets.listServers(), servers);
    assert.deepEqual(gateway.last().json(), { prefix: "" });

    const deleted = await ets.deleteServer("drop-box");
    assert.deepEqual(gateway.last().json(), { serverId: "drop-box" });
    assert.deepEqual([deleted.serverId, deleted.deleted], ["drop-box", true]);
  });
});

// -- running ---------------------------------------------------------------------------------------

describe("running", () => {
  it("asks rather than waits when starting one", async () => {
    // As in EAP: the desired state changes here and the manager acts on it, so what comes back says what was
    // asked for rather than what has happened.
    gateway.answer("ets", "start-server", { ...SERVER, desiredState: "RUNNING", state: "STOPPED" });
    gateway.answer("ets", "stop-server", { ...SERVER, desiredState: "STOPPED", state: "RUNNING" });

    const started = await ets.startServer("drop-box");
    assert.deepEqual(gateway.last().json(), { serverId: "drop-box" });
    assert.deepEqual([started.desiredState, started.state], [STATE_RUNNING, STATE_STOPPED]);

    const stopped = await ets.stopServer("drop-box");
    // Still listening, which is the ordinary picture of a server on its way down.
    assert.deepEqual([stopped.desiredState, stopped.state], [STATE_STOPPED, STATE_RUNNING]);
  });
});

// -- everything else -------------------------------------------------------------------------------

describe("how ETS behaves", () => {
  it("signs its own target and follows the session", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("ets", "list-servers", { servers: [] });

    await ets.listServers();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "ets");

    await session.changeNamespace("development");
    await ets.listServers();
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.equal(session.ets(), ets);
  });

  it("says who refused an administrator-only action", async () => {
    gateway.answer("ets", "create-server", { error: "Administrator privileges required" }, 403);

    await assert.rejects(
      () => ets.createServer("drop-box", "incoming", 2222, { protocol: PROTOCOL_SFTP }),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 403);
        assert.equal(error.reason, "Administrator privileges required");
        return true;
      },
    );
  });

  it("answers metrics unparsed and reaches unwrapped actions", async () => {
    gateway.answer("ets", "get-metrics", { items: [{ name: "ets-sessions", value: 2 }] });
    gateway.answer("ets", "some-future-action", { ok: true });

    assert.deepEqual(await ets.metrics(), { items: [{ name: "ets-sessions", value: 2 }] });
    assert.deepEqual(await ets.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });
});
