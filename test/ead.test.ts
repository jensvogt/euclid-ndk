/**
 * EAD, end to end against a fake euclid server.
 *
 * Four actions, three of which are one request each. What is worth checking beyond the fields is the
 * capped total a listing answers with - `totalExact` is what makes it honest rather than wrong - and
 * that a purge refuses to run without a window.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Euclid, LIST_TOTAL_LIMIT, type EuclidEad, type EuclidSession } from "../src/index.js";
import { toAuditEvents } from "../src/dto/ead.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

const EVENT = {
  accountId: "000000000000",
  namespace: "development",
  userId: "jens",
  module: "esm",
  command: "delete-bucket",
  parameters: { ern: "ern:esm:bucket/reports", async: false },
  status: "200",
  created: "2026-11-22T09:00:00Z",
};

let gateway: FakeGateway;
let session: EuclidSession;
let ead: EuclidEad;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-ead-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  ead = session.ead();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

describe("reading the trail", () => {
  it("narrows by user, module and command, and sends nothing else", async () => {
    gateway.answer("ead", "list-events", { total: 1, totalExact: true, events: [EVENT] });

    const page = await ead.listEvents({ module: "esm", command: "delete-bucket", pageSize: 50 });

    assert.deepEqual(gateway.last().json(), { module: "esm", command: "delete-bucket", pageSize: 50 });
    assert.equal(page.events[0]?.userId, "jens");
    // The command's own request body, left as it was recorded - with its sensitive values already
    // replaced on the writing side, so no password was ever stored to read back.
    assert.deepEqual(page.events[0]?.parameters, { ern: "ern:esm:bucket/reports", async: false });
    assert.equal(page.events[0]?.status, "200");

    await ead.listEvents();
    assert.deepEqual(gateway.last().json(), {});
  });

  it("says when a listing's total is a floor rather than the number", async () => {
    // An exact count reads an index entry per match, so a listing stops counting at the cap. False
    // means "at least this many", which is all a pager needs to know there is a next page.
    gateway.answer("ead", "list-events", { total: LIST_TOTAL_LIMIT, totalExact: false, events: [EVENT] });

    const capped = await ead.listEvents();
    assert.deepEqual([capped.total, capped.totalExact], [LIST_TOTAL_LIMIT, false]);

    // And a server too old to report it counted exactly, which is what the field was added to stop.
    assert.equal(toAuditEvents({ total: 7, events: [] }).totalExact, true);
  });

  it("counts exactly when asked to", async () => {
    gateway.answer("ead", "count-events", { count: 183_402 });

    assert.equal(await ead.countEvents({ userId: "jens" }), 183_402);
    assert.deepEqual(gateway.last().json(), { userId: "jens" });
  });
});

describe("purging", () => {
  it("removes entries older than a window and answers how many went", async () => {
    gateway.answer("ead", "purge-events", { removed: 412_000 });

    assert.equal(await ead.purgeEvents(90), 412_000);
    assert.deepEqual(gateway.last().json(), { olderThanDays: 90 });
  });

  it("leaves a purge with no window to the server to refuse", async () => {
    // The one mistake this call must not make easy: a command that removed the whole trail by being
    // called with no arguments.
    gateway.answer(
      "ead",
      "purge-events",
      { error: "olderThanDays is required and must be positive - a purge with no window would remove the whole trail" },
      400,
    );

    await assert.rejects(
      () => ead.purgeEvents(0),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["purge-events", 400]);
        assert.match(error.reason, /whole trail/);
        return true;
      },
    );
  });
});

describe("how EAD behaves", () => {
  it("signs its own target and is the same client each time", async () => {
    gateway.answer("ead", "list-events", { total: 0, totalExact: true, events: [] });

    await ead.listEvents();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "ead");

    assert.equal(session.ead(), ead);
  });

  it("answers metrics unparsed and reaches an action this SDK does not wrap", async () => {
    gateway.answer("ead", "get-metrics", { items: [{ name: "ead-events", value: 9 }] });
    gateway.answer("ead", "some-future-action", { ok: true });

    assert.deepEqual(await ead.metrics(), { items: [{ name: "ead-events", value: 9 }] });
    assert.deepEqual(await ead.call("some-future-action", { x: 1 }), { ok: true });
  });
});
