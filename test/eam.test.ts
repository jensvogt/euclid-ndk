/**
 * Login and EAM operations, end to end against a fake euclid server.
 *
 * These are the tests that would catch a client that signs one thing and sends another: the gateway
 * verifies every signed request with the same rules euclid's `HttpActionServer` applies, so a
 * mismatch between the Host header a signature covers and the one that goes on the wire fails here
 * rather than in production.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { RFC9421 } from "../src/index.js";
import { save } from "../src/credentials.js";
import { Euclid } from "../src/index.js";
import { AUTH_BEARER, AUTH_SIGNATURE } from "../src/index.js";
import { EuclidAuthenticationError, EuclidServiceError } from "../src/errors.js";
import { ACCESS_KEY_ID, FakeGateway, prepareLogin, token, type RecordedRequest } from "./fake-gateway.js";

let gateway: FakeGateway;
let credentialsFile = "";
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  // Every test gets its own credentials file, without exception: logging in writes the cache as a
  // side effect, and a test that forgot this would overwrite the credentials of whoever ran the
  // suite - on the machine of the person least expecting it.
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  credentialsFile = join(await mkdtemp(join(tmpdir(), "euclid-ndk-")), "credentials");
  process.env["EUCLID_CREDENTIALS_FILE"] = credentialsFile;
});

afterEach(async () => {
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

/** A gateway that answers login and knows the credentials that login hands out. */
function prepared(options: { withKey?: boolean; theToken?: string } = {}): string {
  return prepareLogin(gateway, { withKey: options.withKey, token: options.theToken });
}

// -- login -------------------------------------------------------------------------------------

describe("login", () => {
  it("sends one identifier and answers with a session", async () => {
    prepared();

    const session = await Euclid.forServer(gateway.baseUrl).access().credentials("jens", "secret").login();

    assert.deepEqual(gateway.last().json(), { userId: "jens", password: "secret", email: "" });
    assert.equal(gateway.last().headers["x-euclid-target"], "eam");
    assert.equal(gateway.last().headers["x-euclid-action"], "login");
    assert.deepEqual([session.userId, session.accountId, session.region], ["jens", "000000000000", "eu-central-1"]);
    assert.equal(session.accessKeyId, ACCESS_KEY_ID);
    assert.equal(session.isAdmin, true);
    session.close();
  });

  it("sends the email instead when there is no user ID", async () => {
    // The server resolves by user ID first, so sending both would silently ignore the email.
    prepared();

    const session = await Euclid.forServer(gateway.baseUrl).access().email("jens@example.com").password("s").login();

    assert.deepEqual(gateway.last().json(), { userId: "", password: "s", email: "jens@example.com" });
    session.close();
  });

  it("is unauthenticated, as it has to be: it is where the credentials come from", async () => {
    prepared();

    (await Euclid.forServer(gateway.baseUrl).login("jens", "secret")).close();

    assert.equal(gateway.last().headers["authorization"], undefined);
    assert.equal(gateway.last().headers["signature"], undefined);
  });

  it("throws with the server's reason when it is refused", async () => {
    gateway.answer("eam", "login", { error: "Invalid password" }, 401);

    await assert.rejects(
      () => Euclid.forServer(gateway.baseUrl).login("jens", "wrong"),
      (error: EuclidAuthenticationError) => {
        assert.equal(error.status, 401);
        assert.equal(error.reason, "Invalid password");
        return true;
      },
    );
  });

  it("says what is missing before making any request", async () => {
    await assert.rejects(() => Euclid.forServer(gateway.baseUrl).access().login(), /username or email/);
    await assert.rejects(() => Euclid.forServer(gateway.baseUrl).access().username("jens").login(), /password/);
    assert.equal(gateway.requests.length, 0);
  });
});

// -- the credentials cache ------------------------------------------------------------------------

describe("the credentials cache", () => {
  it("reuses a cached login rather than authenticating again", async () => {
    prepared();
    const server = Euclid.forServer(gateway.baseUrl);

    (await server.access().credentials("jens", "secret").login()).close();
    assert.equal(gateway.requests.length, 1);

    // No second login request: the cached token is still valid, so there is nothing to ask.
    const second = await server.access().login();
    assert.equal(gateway.requests.length, 1);
    assert.equal(second.userId, "jens");
    assert.equal(second.accessKeyId, ACCESS_KEY_ID);
    second.close();

    const cached = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    assert.equal(cached["baseUrl"], gateway.baseUrl);
  });

  it("does not reuse an expired cached token", async () => {
    prepared({ theToken: token(3600) });
    const server = Euclid.forServer(gateway.baseUrl);
    (await server.access().credentials("jens", "secret").login()).close();

    await save({
      token: token(-10),
      userId: "",
      accountId: "",
      region: "",
      accessKeyId: "",
      secretAccessKey: "",
      isAdmin: false,
      baseUrl: gateway.baseUrl,
      namespace: "",
      raw: {},
    });

    (await server.access().credentials("jens", "secret").login()).close();
    assert.equal(gateway.requests.length, 2);
  });

  it("neither reads nor writes the cache when told not to", async () => {
    prepared();
    const server = Euclid.forServer(gateway.baseUrl);

    (await server.access().credentials("jens", "secret").useCache(false).login()).close();
    await assert.rejects(() => readFile(credentialsFile, "utf8"));

    (await server.access().credentials("jens", "secret").useCache(false).login()).close();
    assert.equal(gateway.requests.length, 2);
  });
});

// -- authentication of session calls ---------------------------------------------------------------

describe("how a session authenticates", () => {
  it("signs with SigV4 by default", async () => {
    prepared();
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    await session.listUsers();
    session.close();

    const request = gateway.last();
    assert.equal(request.auth, "sigv4");
    assert.equal(request.subject, "jens");
    assert.ok(request.headers["authorization"]?.startsWith("AWS4-HMAC-SHA256 "));
  });

  it("signs with RFC 9421 when asked to", async () => {
    prepared();
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    const session = await Euclid.forServer(gateway.baseUrl)
      .access()
      .credentials("jens", "secret")
      .signingScheme(RFC9421)
      .login();
    await session.listUsers();
    session.close();

    const request = gateway.last();
    assert.equal(request.auth, "rfc9421");
    assert.equal(request.subject, "jens");
    // The two schemes do not collide: this one leaves Authorization alone.
    assert.equal(request.headers["authorization"], undefined);
    assert.ok(request.headers["signature-input"]);
    assert.ok(request.headers["content-digest"]);
  });

  it("falls back to the bearer token when the login returned no access key", async () => {
    prepared({ withKey: false });
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    await session.listUsers();
    session.close();

    assert.equal(gateway.last().auth, "bearer");
  });

  it("presents the token when asked to, even with a key available", async () => {
    prepared();
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret", { auth: AUTH_BEARER });
    await session.listUsers();
    session.close();

    assert.equal(gateway.last().auth, "bearer");
  });

  it("fails loudly when signatures were asked for and there is no key", async () => {
    // Rather than quietly sending a token, which is not what the caller asked for.
    prepared({ withKey: false });
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret", { auth: AUTH_SIGNATURE });
    await assert.rejects(() => session.listUsers(), /no access key/);
    session.close();
  });

  it("is rejected by the server when the body is changed after signing", async () => {
    // Proof the signature covers the body: re-sending a signed request with a different body must
    // not authenticate, or none of the rest of this means anything.
    prepared();
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    await session.listUsers();
    session.close();
    const signed = gateway.last();

    const headers: Record<string, string> = { ...signed.headers };
    delete headers["content-length"];
    const response = await fetch(`${gateway.baseUrl}/`, {
      method: "POST",
      headers,
      body: '{"prefix":"pwned","pageSize":10,"pageIndex":0,"sortColumn":"userId","sortDirection":"asc"}',
    });

    assert.equal(response.status, 403);
  });
});

// -- operations -------------------------------------------------------------------------------------

describe("operations", () => {
  it("parses a page of users", async () => {
    prepared();
    gateway.answer("eam", "list-users", {
      total: 2,
      users: [
        {
          userId: "jens",
          ern: "ern:eam:user/jens",
          email: "jens@example.com",
          accountId: "000000000000",
          region: "eu-central-1",
          created: "2026-01-01",
          accountGrants: [
            { accountId: "000000000000", namespaces: ["development"], isAdmin: true, granted: "2026-01-01" },
          ],
        },
        { userId: "alice" },
      ],
    });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    const result = await session.listUsers({ prefix: "j", pageSize: 25, pageIndex: 1, sortDirection: "desc" });
    session.close();

    assert.deepEqual(gateway.last().json(), {
      prefix: "j",
      pageSize: 25,
      pageIndex: 1,
      sortColumn: "userId",
      sortDirection: "desc",
    });
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((user) => user.userId), ["jens", "alice"]);
    assert.deepEqual(result.items[0]?.accountGrants[0]?.namespaces, ["development"]);
    assert.equal(result.items[0]?.accountGrants[0]?.isAdmin, true);
    // A field the server did not send reads as empty rather than throwing.
    assert.equal(result.items[1]?.email, "");
    assert.deepEqual(result.items[1]?.accountGrants, []);
  });

  it("round-trips accounts, groups and namespaces", async () => {
    prepared();
    gateway.answer("eam", "create-account", { account: { accountId: "111", name: "acme", ern: "ern:eam:account/111" } });
    gateway.answer("eam", "create-namespace", { namespace: { accountId: "111", name: "prod" } });
    gateway.answer("eam", "create-user-group", { userGroup: { name: "ops", userIds: ["jens"] } });
    gateway.answer("eam", "list-accounts", { accounts: [{ accountId: "111" }], total: 1 });
    gateway.answer("eam", "list-namespaces", { namespaces: [{ name: "prod" }], total: 1 });
    gateway.answer("eam", "list-user-groups", { userGroups: [{ name: "ops" }], total: 1 });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    assert.equal((await session.createAccount("111", "acme", "an account")).accountId, "111");
    assert.equal((await session.createNamespace("111", "prod")).name, "prod");
    assert.deepEqual((await session.createUserGroup("ops", "operations")).userIds, ["jens"]);
    assert.equal((await session.listAccounts()).total, 1);
    assert.equal((await session.listNamespaces("111")).items[0]?.name, "prod");
    assert.equal((await session.listUserGroups()).items[0]?.name, "ops");
    session.close();
  });

  it("creates, lists and deletes access keys", async () => {
    prepared();
    gateway.answer("eam", "create-access-key", {
      accessKeyId: "AKIANEW",
      secretAccessKey: "s3cret",
      createdAt: "2026-09-10",
    });
    gateway.answer("eam", "list-access-keys", { accessKeys: [{ accessKeyId: "AKIANEW", active: true }] });
    gateway.answer("eam", "delete-access-key", {});

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    const created = await session.createAccessKey();
    assert.deepEqual([created.accessKeyId, created.secretAccessKey], ["AKIANEW", "s3cret"]);
    assert.deepEqual((await session.listAccessKeys()).map((key) => key.accessKeyId), ["AKIANEW"]);
    await session.deleteAccessKey("AKIANEW");
    session.close();

    assert.deepEqual(gateway.last().json(), { accessKeyId: "AKIANEW" });
  });

  it("checks the status even of the actions that answer with nothing", async () => {
    prepared();
    gateway.answer("eam", "delete-user", { error: "User not found" }, 404);

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    await assert.rejects(
      () => session.deleteUser("nobody"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["eam", "delete-user", 404]);
        assert.equal(error.reason, "User not found");
        return true;
      },
    );
    session.close();
  });
});

// -- namespace scoping --------------------------------------------------------------------------------

describe("namespace scoping", () => {
  it("scopes later calls and keeps the cache in step", async () => {
    prepared();
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    assert.equal(gateway.last().headers["x-euclid-namespace"], undefined);

    await session.changeNamespace("development");
    await session.listUsers();
    session.close();

    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");
    const cached = JSON.parse(await readFile(credentialsFile, "utf8")) as Record<string, unknown>;
    assert.equal(cached["namespace"], "development");
  });

  it("applies a namespace asked for at login to a cached session", async () => {
    // A cached session may predate the namespace being asked for, or be scoped to another.
    prepared();
    gateway.answer("eam", "change-namespace", {});
    const server = Euclid.forServer(gateway.baseUrl);

    (await server.access().credentials("jens", "secret").login()).close();
    const session = await server.access().namespace("production").login();

    assert.equal(session.namespace, "production");
    assert.equal(gateway.last().action, "change-namespace");
    assert.deepEqual(gateway.last().json(), { namespace: "production" });
    session.close();
  });
});

// -- credential refresh ---------------------------------------------------------------------------------

describe("credential refresh", () => {
  it("retries an expired token once with a fresh one", async () => {
    // A long-lived process holds credentials that do not: one round trip turns a 401 that says
    // "expired" into the answer the request would have got a moment earlier.
    const stale = token();
    prepared({ withKey: false, theToken: stale });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    gateway.answer("eam", "list-users", { users: [], total: 0 });

    // The server forgets the token the session is holding, then a rotation hands out a new one.
    gateway.tokens.delete(stale);
    const refreshed = token(7200);
    gateway.tokens.set(refreshed, "jens");

    // Stands in for a credentials file that gets rewritten between the two attempts, which is what
    // euclid actually does to an application's token.
    const rotating = [stale, refreshed];
    session.tokenProvider = () => rotating.shift() ?? refreshed;

    assert.equal((await session.listUsers()).total, 0);
    session.close();

    // Two attempts for the one call: the rejected one, then the one that carried the new token.
    const attempts = gateway.requests.filter((request: RecordedRequest) => request.action === "list-users");
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.auth, "");
    assert.equal(attempts[1]?.auth, "bearer");
  });

  it("does not retry a rejection that is not an expiry", async () => {
    // Narrow on purpose: a wrong password or a missing permission is answered once, as before.
    prepared();
    gateway.answer("eam", "list-users", { error: "Not authorized for this namespace" }, 401);

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    await assert.rejects(() => session.listUsers(), EuclidServiceError);
    session.close();

    assert.equal(gateway.requests.filter((request) => request.action === "list-users").length, 1);
  });
});

// -- escape hatch ----------------------------------------------------------------------------------------

describe("call", () => {
  it("reaches an action this SDK does not wrap", async () => {
    prepared();
    gateway.answer("eam", "some-future-action", { ok: true });

    const session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
    assert.deepEqual(await session.call("some-future-action", { x: 1 }), { ok: true });
    session.close();

    assert.deepEqual(gateway.last().json(), { x: 1 });
    assert.equal(gateway.last().auth, "sigv4");
  });
});
