/**
 * ESS, end to end against a fake euclid server.
 *
 * Every action is one request, so what these check is that it carries the fields the server reads and parses
 * the ones it answers with - and that the one call which returns a value is the only one that does. An
 * update's rule is the same one EAP's has: a field left out is not sent, and an empty string is a value
 * somebody may legitimately want stored.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Euclid, type EuclidEss, type EuclidSession } from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

const SECRET = {
  name: "db-password",
  ern: "ern:euclid:ess:eu-central-1:000000000000:secret/db-password",
  description: "the reporting database",
  encryptionKeyErn: "ern:ekm:key/key-1",
  version: 3,
  rotated: "2026-09-01T10:00:00Z",
  tags: { team: "finance" },
  created: "2026-01-01",
  modified: "2026-09-01",
};

let gateway: FakeGateway;
let session: EuclidSession;
let ess: EuclidEss;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-ess-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  ess = session.ess();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

describe("secrets", () => {
  it("answers with metadata only when storing one", async () => {
    gateway.answer("ess", "create-secret", { secret: SECRET });

    const secret = await ess.createSecret("db-password", "hunter2", {
      description: "the reporting database",
      keyErn: "ern:ekm:key/key-1",
    });

    assert.deepEqual(gateway.last().json(), {
      name: "db-password",
      value: "hunter2",
      description: "the reporting database",
      keyErn: "ern:ekm:key/key-1",
    });
    // What came back describes the secret; the value it was just given is not in it.
    assert.deepEqual([secret.name, secret.version, secret.encryptionKeyErn], ["db-password", 3, "ern:ekm:key/key-1"]);
    assert.deepEqual(secret.tags, { team: "finance" });
    assert.equal(Object.keys(secret).includes("value"), false);
  });

  it("returns a value from exactly one call", async () => {
    gateway.answer("ess", "get-secret", { value: "hunter2", secret: SECRET });

    const fetched = await ess.getSecret("db-password");

    assert.deepEqual(gateway.last().json(), { name: "db-password" });
    assert.equal(fetched.value, "hunter2");
    // The metadata comes with it, so a caller that wants to know which key it is under need not ask again.
    assert.equal(fetched.secret.encryptionKeyErn, "ern:ekm:key/key-1");
  });

  it("lists them as metadata", async () => {
    gateway.answer("ess", "list-secrets", {
      total: 2,
      secrets: [SECRET, { name: "api-token" }],
    });

    const listed = await ess.listSecrets({ prefix: "db", pageSize: 25 });

    assert.deepEqual(gateway.last().json(), {
      prefix: "db",
      pageSize: 25,
      pageIndex: 0,
      sortColumn: "name",
      sortDirection: "asc",
    });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map((secret) => secret.name), ["db-password", "api-token"]);
    assert.equal(listed.items[0]?.rotated, "2026-09-01T10:00:00Z");
    // A field the server did not send reads as empty rather than throwing.
    assert.equal(listed.items[1]?.version, 0);
    assert.deepEqual(listed.items[1]?.tags, {});
  });

  it("sends the value and nothing else when rotating", async () => {
    gateway.answer("ess", "update-secret", { secret: { ...SECRET, version: 4 } });

    const rotated = await ess.rotateSecret("db-password", "hunter3");

    assert.deepEqual(gateway.last().json(), { name: "db-password", value: "hunter3" });
    assert.equal(rotated.version, 4);
  });

  it("sends only what an update was given", async () => {
    gateway.answer("ess", "update-secret", { secret: SECRET });

    await ess.updateSecret("db-password", { description: "now the analytics database" });
    assert.deepEqual(gateway.last().json(), { name: "db-password", description: "now the analytics database" });

    // An empty string is a value here rather than "leave it alone", for both of the two that take one.
    await ess.updateSecret("db-password", { description: "" });
    assert.deepEqual(gateway.last().json(), { name: "db-password", description: "" });

    await ess.updateSecret("db-password", { value: "" });
    assert.deepEqual(gateway.last().json(), { name: "db-password", value: "" });

    // Naming a key re-encrypts the value under it, which is how a secret leaves a key being retired.
    await ess.updateSecret("db-password", { keyErn: "ern:ekm:key/key-2" });
    assert.deepEqual(gateway.last().json(), { name: "db-password", keyErn: "ern:ekm:key/key-2" });

    await ess.updateSecret("db-password", { value: "hunter3", description: "rotated", keyErn: "ern:ekm:key/key-2" });
    assert.deepEqual(gateway.last().json(), {
      name: "db-password",
      value: "hunter3",
      description: "rotated",
      keyErn: "ern:ekm:key/key-2",
    });
  });

  it("says an update changes nothing before the round trip", async () => {
    await assert.rejects(() => ess.updateSecret("db-password", {}), /value, a description or a keyErn/);
    await assert.rejects(() => ess.updateSecret("db-password", { keyErn: "" }), /value, a description or a keyErn/);

    assert.deepEqual(gateway.requests.filter((request) => request.target === "ess"), []);
  });

  it("deletes one", async () => {
    gateway.answer("ess", "delete-secret", { name: "db-password", ern: SECRET.ern });

    const deleted = await ess.deleteSecret("db-password");

    assert.deepEqual(gateway.last().json(), { name: "db-password" });
    assert.deepEqual([deleted.name, deleted.ern], ["db-password", SECRET.ern]);
  });

  it("answers a tag change with the secret as it now reads", async () => {
    gateway.answer("ess", "add-secret-tag", { secret: { ...SECRET, tags: { team: "finance" } } });
    gateway.answer("ess", "delete-secret-tag", { secret: { ...SECRET, tags: {} } });

    const tagged = await ess.addSecretTag("db-password", "team", "finance");
    assert.deepEqual(gateway.last().json(), { name: "db-password", key: "team", value: "finance" });
    assert.deepEqual(tagged.tags, { team: "finance" });

    const untagged = await ess.deleteSecretTag("db-password", "team");
    assert.deepEqual(gateway.last().json(), { name: "db-password", key: "team" });
    assert.deepEqual(untagged.tags, {});
  });
});

describe("how ESS behaves", () => {
  it("signs its own target and follows the session", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("ess", "list-secrets", { secrets: [], total: 0 });

    await ess.listSecrets();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "ess");

    await session.changeNamespace("development");
    await ess.listSecrets();
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.equal(session.ess(), ess);
  });

  it("carries the server's reason for a secret that is not there", async () => {
    gateway.answer("ess", "get-secret", { error: "Secret not found: db-password" }, 404);

    await assert.rejects(
      () => ess.getSecret("db-password"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["ess", "get-secret", 404]);
        assert.equal(error.reason, "Secret not found: db-password");
        return true;
      },
    );
  });

  it("asks the listing and never the value when checking a secret exists", async () => {
    // The point of the method. get-secret answers with the decrypted value, so an existence check
    // built on it would need permission to read the password and would leave an audit entry saying
    // somebody did. This asks list-secrets, which never returns a value.
    gateway.answer("ess", "list-secrets", {
      secrets: [{ name: "db-password" }, { name: "db-password-old" }],
      total: 2,
    });

    assert.equal(await ess.existsSecret("db-password"), true);

    const sent = gateway.last().json() as { prefix: string; pageSize: number };
    assert.equal(sent.prefix, "db-password");
    // The whole matching page, or a longer name could crowd the exact one off page one.
    assert.equal(sent.pageSize, 0);
  });

  it("matches a secret name exactly rather than by prefix", async () => {
    gateway.answer("ess", "list-secrets", { secrets: [{ name: "db-password-old" }], total: 1 });

    assert.equal(await ess.existsSecret("db-password"), false);
  });

  it("answers metrics unparsed and reaches unwrapped actions", async () => {
    gateway.answer("ess", "get-metrics", { items: [{ name: "ess-secrets", value: 3 }] });
    gateway.answer("ess", "some-future-action", { ok: true });

    assert.deepEqual(await ess.metrics(), { items: [{ name: "ess-secrets", value: 3 }] });
    assert.deepEqual(await ess.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });
});
