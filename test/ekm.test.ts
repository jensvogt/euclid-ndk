/**
 * EKM, end to end against a fake euclid server.
 *
 * The key and certificate actions are checked the way the other modules' are: what went on the wire, and
 * what came back off it. Encrypt and decrypt are checked against a stand-in that really transforms the
 * bytes and hands them back as bytes, because those two are the only actions in this module whose request
 * is not JSON - and a client that sent them as JSON, or decoded the answer as JSON, would pass every test
 * whose server only ever speaks JSON.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Euclid, type EuclidEkm, type EuclidSession } from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { AUTH_SIGNATURE } from "../src/index.js";
import { FakeGateway, prepareLogin, type RecordedRequest } from "./fake-gateway.js";

const KEY = "ern:euclid:ekm:eu-central-1:000000000000:key/key-1";
const MASK = 0x5a;

/**
 * A key module that transforms bytes rather than pretending to.
 *
 * The transform is a XOR, which is not encryption - what is being tested is that the client sends the
 * caller's bytes and answers with the server's, unchanged in both directions.
 */
class FakeKeys {
  /** The key each byte-carrying request named, in order. */
  readonly keyIds: string[] = [];

  install(gateway: FakeGateway): this {
    gateway.on("ekm", "encrypt", (request) => [200, Buffer.concat([Buffer.from("IV"), this.#mask(request)])]);
    gateway.on("ekm", "decrypt", (request) => [200, this.#mask(request, 2)]);
    return this;
  }

  #mask(request: RecordedRequest, offset = 0): Buffer {
    this.keyIds.push(request.headers["x-euclid-key-id"] ?? "");
    return Buffer.from(request.body.subarray(offset).map((byte) => byte ^ MASK));
  }
}

let gateway: FakeGateway;
let keys: FakeKeys;
let session: EuclidSession;
let ekm: EuclidEkm;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  keys = new FakeKeys().install(gateway);
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-ekm-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  ekm = session.ekm();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- keys ----------------------------------------------------------------------------------------

describe("keys", () => {
  it("asks for AES-256 unless told otherwise", async () => {
    // euclid-jdk's no-argument createKey() mints 128 bits; this one mints what euclid itself creates when
    // a bucket asks to be encrypted.
    gateway.answer("ekm", "create-key", {
      name: "key-1",
      ern: KEY,
      description: "exports",
      algorithm: "AES",
      length: 256,
      status: "AVAILABLE",
    });

    const created = await ekm.createKey({ description: "exports" });

    assert.deepEqual(gateway.last().json(), { algorithm: "AES", length: 256, description: "exports" });
    assert.deepEqual([created.name, created.length, created.status], ["key-1", 256, "AVAILABLE"]);
    // The name is the ID the server minted, and the handle that encrypts; the ERN administers.
    assert.equal(created.ern, KEY);
  });

  it("lists them without ever carrying material", async () => {
    gateway.answer("ekm", "list-keys", {
      total: 2,
      keys: [
        {
          name: "key-1",
          ern: KEY,
          description: "exports",
          algorithm: "AES",
          length: 256,
          status: "AVAILABLE",
          tags: { team: "finance" },
          created: "2026-01-01",
        },
        { name: "key-2", status: "PENDING_DELETION", deletionDate: "2026-09-15T00:00:00Z" },
      ],
    });

    const listed = await ekm.listKeys({ prefix: "key", pageSize: 25, sortDirection: "desc" });

    assert.deepEqual(gateway.last().json(), {
      prefix: "key",
      pageSize: 25,
      pageIndex: 0,
      sortColumn: "name",
      sortDirection: "desc",
    });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map((key) => key.name), ["key-1", "key-2"]);
    assert.deepEqual(listed.items[0]?.tags, { team: "finance" });
    assert.equal(listed.items[0]?.length, 256);
    // Only present on a key scheduled for deletion; empty on one that is not.
    assert.equal(listed.items[1]?.deletionDate, "2026-09-15T00:00:00Z");
    assert.equal(listed.items[0]?.deletionDate, "");
    assert.deepEqual(Object.keys(listed.items[0]!).filter((name) => name.includes("material")), []);
  });

  it("gets one key by name, and never its material", async () => {
    gateway.answer("ekm", "get-key", {
      key: {
        name: "key-1",
        ern: KEY,
        description: "exports",
        algorithm: "AES",
        length: 256,
        status: "AVAILABLE",
        tags: { team: "finance" },
        created: "2026-01-01",
      },
    });

    const key = await ekm.getKey("key-1");

    assert.deepEqual(gateway.last().json(), { name: "key-1" });
    assert.deepEqual([key.name, key.ern, key.length], ["key-1", KEY, 256]);
    assert.deepEqual(key.tags, { team: "finance" });
    // What this returns is the key's description; the material never leaves the module, so there
    // is no field here that could carry it.
    assert.deepEqual(Object.keys(key).filter((name) => name.includes("material")), []);
  });

  it("gets a key by ERN when given one", async () => {
    gateway.answer("ekm", "get-key", { key: { name: "key-1", ern: KEY } });

    await ekm.getKey(KEY);

    assert.deepEqual(gateway.last().json(), { ern: KEY });
  });

  it("schedules a deletion rather than performing one", async () => {
    // It is the one action here that no other can undo, so the window is the chance to notice.
    gateway.answer("ekm", "delete-key", {
      name: "key-1",
      ern: KEY,
      status: "PENDING_DELETION",
      deletionDate: "2026-09-15T00:00:00Z",
    });

    const scheduled = await ekm.deleteKey("key-1");

    assert.deepEqual(gateway.last().json(), { keyId: "key-1", pendingWindowInDays: 7 });
    assert.deepEqual([scheduled.status, scheduled.deletionDate], ["PENDING_DELETION", "2026-09-15T00:00:00Z"]);

    await ekm.deleteKey("key-1", 30);
    assert.equal(gateway.last().json()["pendingWindowInDays"], 30);
  });

  it("takes the ERN to revoke and to describe", async () => {
    // Where encrypt and delete take the key's ID - the server's own split, and the one thing about EKM
    // worth remembering.
    gateway.answer("ekm", "revoke-key", { name: "key-1", ern: KEY, status: "REVOKED" });
    gateway.answer("ekm", "set-key-description", {
      name: "key-1",
      ern: KEY,
      description: "retired after the 2026 audit",
    });

    assert.equal((await ekm.revokeKey(KEY)).status, "REVOKED");
    assert.deepEqual(gateway.last().json(), { ern: KEY });

    const described = await ekm.setKeyDescription(KEY, "retired after the 2026 audit");
    assert.deepEqual(gateway.last().json(), { ern: KEY, description: "retired after the 2026 audit" });
    assert.equal(described.description, "retired after the 2026 audit");
  });

  it("tags them", async () => {
    gateway.answer("ekm", "add-key-tag", {});
    gateway.answer("ekm", "delete-key-tag", {});

    await ekm.addKeyTag(KEY, "team", "finance");
    assert.deepEqual(gateway.last().json(), { ern: KEY, key: "team", value: "finance" });

    await ekm.deleteKeyTag(KEY, "team");
    assert.deepEqual(gateway.last().json(), { ern: KEY, key: "team" });
  });
});

// -- using a key ------------------------------------------------------------------------------------

describe("using a key", () => {
  it("round-trips the bytes through encrypt and decrypt", async () => {
    const plaintext = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

    const sealed = await ekm.encrypt("key-1", plaintext);

    assert.ok(sealed.subarray(0, 2).equals(Buffer.from("IV")));
    assert.ok(!sealed.equals(plaintext));
    assert.equal(gateway.last().headers["x-euclid-key-id"], "key-1");
    assert.equal(gateway.last().headers["content-type"], "application/octet-stream");
    // The plaintext went over the wire as bytes, not as base64 inside a JSON field.
    assert.deepEqual(gateway.last().body, plaintext);

    assert.deepEqual(await ekm.decrypt("key-1", sealed), plaintext);
    assert.deepEqual(keys.keyIds, ["key-1", "key-1"]);
  });

  it("encrypts a string as its UTF-8 bytes", async () => {
    const sealed = await ekm.encrypt("key-1", "account 4711");

    assert.deepEqual(gateway.last().body, Buffer.from("account 4711", "utf8"));
    assert.deepEqual(await ekm.decrypt("key-1", sealed), Buffer.from("account 4711", "utf8"));
  });

  it("presents the token for the byte actions and signs the rest", async () => {
    gateway.answer("ekm", "list-keys", { keys: [], total: 0 });

    await ekm.listKeys();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "ekm");

    await ekm.encrypt("key-1", "secret");
    assert.equal(gateway.last().auth, "bearer");
  });

  it("signs the bytes too when the session asked for signatures", async () => {
    const signing = await Euclid.forServer(gateway.baseUrl).login("jens", "secret", { auth: AUTH_SIGNATURE });
    try {
      const sealed = await signing.ekm().encrypt("key-1", "secret");
      assert.ok(sealed.subarray(0, 2).equals(Buffer.from("IV")));
    } finally {
      signing.close();
    }

    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().subject, "jens");
  });

  it("says so when a key may not encrypt", async () => {
    // A revoked key, or one scheduled for deletion: the answer is a JSON error even though the request
    // carried bytes, and the reason is the server's own.
    gateway.answer("ekm", "encrypt", { error: "Key 'key-1' is not available, status: REVOKED" }, 403);

    await assert.rejects(
      () => ekm.encrypt("key-1", "secret"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["ekm", "encrypt", 403]);
        assert.ok(error.reason.startsWith("Key 'key-1' is not available"));
        return true;
      },
    );
  });
});

// -- certificates ------------------------------------------------------------------------------------

const CERTIFICATE = {
  name: "gateway",
  ern: "ern:ekm:certificate/gateway",
  description: "the listener",
  certificate: "-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----\n",
  subject: "CN=euclid.example.com",
  issuer: "CN=euclid.example.com",
  serialNumber: "01",
  fingerprint: "ab:cd",
  generated: true,
  subjectAltNames: ["euclid.example.com", "localhost"],
  notBefore: "2026-01-01",
  notAfter: "2028-04-05",
  tags: {},
};

describe("certificates", () => {
  it("sends both halves when importing one", async () => {
    // The server checks them against each other; a mismatch here beats a handshake that fails for every
    // caller later.
    gateway.answer("ekm", "import-certificate", { certificate: CERTIFICATE });

    const certificate = await ekm.importCertificate("gateway", "PEM-CERT", "PEM-KEY", "the listener");

    assert.deepEqual(gateway.last().json(), {
      name: "gateway",
      description: "the listener",
      certificate: "PEM-CERT",
      privateKey: "PEM-KEY",
    });
    assert.equal(certificate.subject, "CN=euclid.example.com");
    assert.deepEqual(certificate.subjectAltNames, ["euclid.example.com", "localhost"]);
    // The private key went in and does not come back - there is no field for it.
    assert.equal(Object.keys(certificate).includes("privateKey"), false);
  });

  it("leaves the server's defaults alone when generating one", async () => {
    gateway.answer("ekm", "create-certificate", { certificate: CERTIFICATE });

    const generated = await ekm.createCertificate("gateway");

    assert.deepEqual(gateway.last().json(), {
      name: "gateway",
      description: "",
      commonName: "",
      subjectAltNames: [],
    });
    // Nobody vouched for it, and the certificate says so.
    assert.equal(generated.generated, true);

    await ekm.createCertificate("gateway", {
      commonName: "euclid.example.com",
      subjectAltNames: ["localhost"],
      validDays: 90,
      keyBits: 4096,
    });
    assert.deepEqual(gateway.last().json(), {
      name: "gateway",
      description: "",
      commonName: "euclid.example.com",
      subjectAltNames: ["localhost"],
      validDays: 90,
      keyBits: 4096,
    });
  });

  it("gets, lists and deletes them", async () => {
    gateway.answer("ekm", "get-certificate", { certificate: CERTIFICATE });
    gateway.answer("ekm", "list-certificates", { total: 1, certificates: [CERTIFICATE] });
    gateway.answer("ekm", "delete-certificate", { name: "gateway", ern: "ern:ekm:certificate/gateway" });

    assert.equal((await ekm.getCertificate("gateway")).fingerprint, "ab:cd");
    assert.deepEqual(gateway.last().json(), { name: "gateway" });

    const listed = await ekm.listCertificates({ prefix: "gate" });
    assert.equal(listed.total, 1);
    assert.deepEqual(listed.items.map((certificate) => certificate.name), ["gateway"]);

    const deleted = await ekm.deleteCertificate("gateway");
    assert.deepEqual([deleted.name, deleted.ern], ["gateway", "ern:ekm:certificate/gateway"]);
  });
});

// -- everything else ------------------------------------------------------------------------------------

describe("how EKM behaves", () => {
  it("follows the session and reaches unwrapped actions", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("ekm", "list-keys", { keys: [], total: 0 });
    gateway.answer("ekm", "some-future-action", { ok: true });

    await ekm.listKeys();
    assert.equal(gateway.last().headers["x-euclid-namespace"], undefined);

    await session.changeNamespace("development");
    await ekm.listKeys();
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.deepEqual(await ekm.call("some-future-action", { x: 1 }), { ok: true });
    assert.equal(session.ekm(), ekm);
  });
});
