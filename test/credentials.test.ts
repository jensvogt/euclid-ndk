/**
 * The `~/.euclid/credentials` file.
 *
 * The field names are a wire format shared with euclid-cli, euclid-jdk and euclid-pdk, so the tests
 * that matter here are the ones that pin them: a file this SDK writes has to be one the others can
 * read, and vice versa.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  credentialsPath,
  emptyCredentials,
  isTokenValid,
  load,
  save,
  updateNamespace,
} from "../src/credentials.js";

let previous: string | undefined;
let path = "";

beforeEach(async () => {
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  const directory = await mkdtemp(join(tmpdir(), "euclid-ndk-"));
  path = join(directory, "credentials");
  process.env["EUCLID_CREDENTIALS_FILE"] = path;
});

afterEach(() => {
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

/** A JWT with the given lifetime. Only the payload matters - nothing here verifies a signature. */
function token(expiresInSeconds = 3600): string {
  const segment = (payload: object): string => Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${segment({ alg: "HS256" })}.${segment({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds })}.sig`;
}

describe("where the file lives", () => {
  it("follows EUCLID_CREDENTIALS_FILE, which is how euclid hands an application its own", () => {
    assert.equal(credentialsPath(), path);
  });
});

describe("reading and writing", () => {
  it("writes the field names euclid-cli reads", async () => {
    await save({ ...emptyCredentials(), token: "t", userId: "jens", baseUrl: "https://euclid.example.com" });

    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(document).sort(), [
      "accessKeyId",
      "accountId",
      "baseUrl",
      "isAdmin",
      "namespace",
      "region",
      "secretAccessKey",
      "token",
      "userId",
    ]);
    // Not "nameSpace", and an empty string rather than null, because that is what the CLI's string
    // reader can take.
    assert.equal(document["namespace"], "");
  });

  it("round-trips what it wrote", async () => {
    const written = {
      ...emptyCredentials(),
      token: "t",
      userId: "jens",
      accountId: "000000000000",
      region: "eu-central-1",
      accessKeyId: "AKIA",
      secretAccessKey: "s3cret",
      isAdmin: true,
      baseUrl: "https://euclid.example.com",
      namespace: "development",
    };
    await save(written);

    const read = await load();
    assert.ok(read !== null);
    assert.equal(read.userId, "jens");
    assert.equal(read.isAdmin, true);
    assert.equal(read.namespace, "development");
  });

  it("answers null rather than throwing when there is nothing readable", async () => {
    assert.equal(await load(), null);

    await writeFile(path, "not json at all", "utf8");
    assert.equal(await load(), null);

    await writeFile(path, '["a list"]', "utf8");
    assert.equal(await load(), null);
  });

  it("keeps fields a later euclid added that this one does not name", async () => {
    await writeFile(path, JSON.stringify({ token: "t", baseUrl: "u", somethingNew: 42 }), "utf8");

    const read = await load();
    assert.equal(read?.raw["somethingNew"], 42);
  });
});

describe("updateNamespace", () => {
  it("patches the namespace of the cached session for that server", async () => {
    await save({ ...emptyCredentials(), token: "t", baseUrl: "https://euclid.example.com" });

    await updateNamespace("https://euclid.example.com", "production");

    assert.equal((await load())?.namespace, "production");
  });

  it("leaves a cache belonging to another server alone", async () => {
    await save({ ...emptyCredentials(), token: "t", baseUrl: "https://euclid.example.com", namespace: "development" });

    await updateNamespace("https://elsewhere.example.com", "production");

    assert.equal((await load())?.namespace, "development");
  });

  it("does nothing when nothing is cached, since recording a namespace is best-effort", async () => {
    await updateNamespace("https://euclid.example.com", "production");
    assert.equal(await load(), null);
  });
});

describe("a managed application's credentials", () => {
  it("reads the server from the key the manager writes it under", async () => {
    // The file a euclid-managed application is handed, which the manager writes: the server is
    // called "endpoint" there and "baseUrl" in a file this SDK wrote. Reading only "baseUrl" left an
    // application with a valid token and nowhere to send it - the one field it cannot do without.
    await writeFile(
      path,
      JSON.stringify({
        token: token(),
        expiresAt: "2026-09-24T15:07:36.000Z",
        userId: "app-echo-worker",
        accountId: "000000000000",
        region: "eu-central-1",
        namespace: "development",
        endpoint: "https://localhost:5566",
      }),
    );

    const loaded = await load();
    assert.ok(loaded);
    assert.equal(loaded.baseUrl, "https://localhost:5566");
    assert.equal(loaded.userId, "app-echo-worker");
    assert.equal(loaded.namespace, "development");
    // No access key at all: a technical principal's secret never leaves EAM, so the token is the
    // whole of what the process holds.
    assert.equal(loaded.accessKeyId, "");
  });

  it("prefers baseUrl when the file carries both", async () => {
    await writeFile(
      path,
      JSON.stringify({ token: token(), baseUrl: "https://euclid.example.com", endpoint: "https://localhost:5566" }),
    );

    const loaded = await load();
    assert.ok(loaded);
    assert.equal(loaded.baseUrl, "https://euclid.example.com");
  });
});

describe("isTokenValid", () => {
  it("accepts a token whose exp is still ahead", () => {
    assert.equal(isTokenValid(token(3600)), true);
  });

  it("refuses one that has expired", () => {
    assert.equal(isTokenValid(token(-10)), false);
  });

  it("refuses anything that is not a JWT with a readable payload", () => {
    assert.equal(isTokenValid(""), false);
    assert.equal(isTokenValid("not.a.jwt"), false);
    assert.equal(isTokenValid("onlyonepart"), false);
  });

  it("refuses a payload with no exp at all rather than assuming one", () => {
    const noExpiry = `${Buffer.from("{}", "utf8").toString("base64url")}.${Buffer.from('{"sub":"jens"}', "utf8").toString("base64url")}.sig`;
    assert.equal(isTokenValid(noExpiry), false);
  });
});
