/**
 * EKV, end to end against a fake euclid server.
 *
 * The table actions are checked the way the other modules' are: what went on the wire, and what came back off
 * it. The item actions are checked against a stand-in that really stores what it is sent (`FakeTables` below),
 * because the two things this client rearranges - lifting an item's timestamps out of its attributes, and a
 * write replacing rather than merging - only show themselves when an item is read back after being written.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  CREATED_ATTRIBUTE,
  Euclid,
  KEY_NUMBER,
  MODIFIED_ATTRIBUTE,
  SORT_BEGINS_WITH,
  SORT_BETWEEN,
  SORT_GE,
  WHOLE_PARTITION,
  type EuclidEkv,
  type EuclidSession,
} from "../src/index.js";
import { toItem } from "../src/dto/ekv.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin, type RecordedRequest } from "./fake-gateway.js";

const TABLE = "sessions";

/**
 * A key-value store that keeps items rather than pretending to.
 *
 * One table, keyed on `userId` and ordered by `startedAt`, which is enough for the round trips that matter.
 * Timestamps are stored as the server stores them - two ordinary attributes - because the client's job of
 * taking them back out is the thing being tested.
 */
class FakeTables {
  /** "partition key sort key" -> the item's attributes as stored. */
  readonly items = new Map<string, Record<string, unknown>>();

  install(gateway: FakeGateway): this {
    gateway.on("ekv", "put-item", (request) => this.#putItem(request));
    gateway.on("ekv", "get-item", (request) => this.#getItem(request));
    gateway.on("ekv", "delete-item", (request) => this.#deleteItem(request));
    gateway.on("ekv", "query", (request) => this.#query(request));
    gateway.on("ekv", "scan", (request) => this.#scan(request));
    return this;
  }

  #putItem(request: RecordedRequest): [number, unknown] {
    const item = { ...(request.json()["item"] as Record<string, unknown>) };
    const stored = this.items.get(keyOf(item));
    item[CREATED_ATTRIBUTE] = stored?.[CREATED_ATTRIBUTE] ?? "2026-09-10T09:00:00Z";
    item[MODIFIED_ATTRIBUTE] = "2026-09-10T10:00:00Z";
    // Replaces rather than merges, exactly as the server does.
    this.items.set(keyOf(item), item);
    return [200, item];
  }

  #getItem(request: RecordedRequest): [number, unknown] {
    const item = this.items.get(keyOf(request.json()["key"] as Record<string, unknown>));
    return item === undefined ? [404, { error: "Item not found" }] : [200, item];
  }

  #deleteItem(request: RecordedRequest): [number, unknown] {
    return [200, { deleted: this.items.delete(keyOf(request.json()["key"] as Record<string, unknown>)) }];
  }

  #query(request: RecordedRequest): [number, unknown] {
    const body = request.json();
    const matching = [...this.items.values()]
      .filter((item) => item["userId"] === body["partitionKey"])
      .sort((left, right) => Number(left["startedAt"] ?? 0) - Number(right["startedAt"] ?? 0));
    if (body["forward"] === false) matching.reverse();
    return [200, { items: matching, count: matching.length }];
  }

  #scan(request: RecordedRequest): [number, unknown] {
    const items = [...this.items.values()];
    const pageSize = Number(request.json()["pageSize"] ?? 0);
    const page = pageSize > 0 ? items.slice(0, pageSize) : items;
    return [200, { items: page, count: page.length, total: items.length }];
  }
}

function keyOf(attributes: Record<string, unknown>): string {
  return `${String(attributes["userId"])} ${String(attributes["startedAt"])}`;
}

let gateway: FakeGateway;
let tables: FakeTables;
let session: EuclidSession;
let ekv: EuclidEkv;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  tables = new FakeTables().install(gateway);
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-ekv-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  ekv = session.ekv();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- tables ---------------------------------------------------------------------------------------

describe("tables", () => {
  it("names its key and the types of it", async () => {
    // The types are what make a range mean what it should: a number sort key orders 2, 9, 10, 100 rather than
    // putting "10" before "9".
    gateway.answer("ekv", "create-table", {
      name: TABLE,
      ern: "ern:ekv:table/sessions",
      partitionKey: "userId",
      partitionKeyType: "string",
      sortKey: "startedAt",
      sortKeyType: "number",
      itemCount: 0,
      created: "2026-09-10",
    });

    const table = await ekv.createTable(TABLE, "userId", { sortKey: "startedAt", sortKeyType: KEY_NUMBER });

    assert.deepEqual(gateway.last().json(), {
      name: TABLE,
      partitionKey: "userId",
      partitionKeyType: "string",
      sortKey: "startedAt",
      sortKeyType: "number",
    });
    assert.deepEqual([table.partitionKey, table.sortKeyType, table.itemCount], ["userId", "number", 0]);
  });

  it("leaves the sort key empty for a table that has none", async () => {
    gateway.answer("ekv", "create-table", {
      name: "profiles",
      partitionKey: "userId",
      partitionKeyType: "string",
      sortKey: "",
      sortKeyType: "",
    });

    const table = await ekv.createTable("profiles", "userId");

    assert.equal(gateway.last().json()["sortKey"], "");
    assert.deepEqual([table.sortKey, table.sortKeyType], ["", ""]);
  });

  it("describes, lists and deletes them", async () => {
    gateway.answer("ekv", "describe-table", { name: TABLE, partitionKey: "userId", itemCount: 42 });
    gateway.answer("ekv", "list-tables", {
      total: 2,
      tables: [{ name: TABLE, partitionKey: "userId", sortKey: "startedAt", itemCount: 42 }, { name: "profiles" }],
    });
    gateway.answer("ekv", "delete-table", { deletedItems: 42 });

    assert.equal((await ekv.describeTable(TABLE)).itemCount, 42);
    assert.deepEqual(gateway.last().json(), { name: TABLE });

    const listed = await ekv.listTables({ prefix: "ses", pageSize: 25, sortDirection: "desc" });
    assert.deepEqual(gateway.last().json(), {
      prefix: "ses",
      pageSize: 25,
      pageIndex: 0,
      sortColumn: "name",
      sortDirection: "desc",
    });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map((table) => table.name), [TABLE, "profiles"]);
    // A field the server did not send reads as empty rather than throwing.
    assert.equal(listed.items[1]?.itemCount, 0);

    assert.equal(await ekv.deleteTable(TABLE), 42);
    assert.deepEqual(gateway.last().json(), { name: TABLE });
  });
});

// -- items ----------------------------------------------------------------------------------------

describe("items", () => {
  it("writes and reads one", async () => {
    const written = await ekv.putItem(TABLE, {
      userId: "jens",
      startedAt: 1757462400,
      host: "laptop",
      tags: ["work", "eu"],
      meta: { agent: "ndk" },
    });

    assert.deepEqual(gateway.last().json(), {
      table: TABLE,
      item: { userId: "jens", startedAt: 1757462400, host: "laptop", tags: ["work", "eu"], meta: { agent: "ndk" } },
    });
    // Scalars, arrays and nested objects, stored as themselves - no typed variant in sight.
    assert.deepEqual(written.attributes["tags"], ["work", "eu"]);
    assert.deepEqual(written.attributes["meta"], { agent: "ndk" });

    const read = await ekv.getItem(TABLE, { userId: "jens", startedAt: 1757462400 });
    assert.deepEqual(gateway.last().json(), { table: TABLE, key: { userId: "jens", startedAt: 1757462400 } });
    assert.deepEqual(read.attributes, written.attributes);
    assert.equal(read.attributes["nothing"], undefined);
  });

  it("lifts the timestamps out of the attributes", async () => {
    // Where the server keeps them - and where they would become the caller's own attributes on the next
    // write, since a write replaces rather than merges.
    const item = await ekv.putItem(TABLE, { userId: "jens", startedAt: 1, host: "laptop" });

    assert.deepEqual([item.created, item.modified], ["2026-09-10T09:00:00Z", "2026-09-10T10:00:00Z"]);
    assert.deepEqual(Object.keys(item.attributes).sort(), ["host", "startedAt", "userId"]);
  });

  it("does not grow an item that is read, changed and written back", async () => {
    // The whole reason the timestamps are lifted: this is the ordinary way to change one field of an item, and
    // it has to be a no-op for every other field.
    await ekv.putItem(TABLE, { userId: "jens", startedAt: 1, host: "laptop" });

    const item = await ekv.getItem(TABLE, { userId: "jens", startedAt: 1 });
    await ekv.putItem(TABLE, { ...item.attributes, host: "desktop" });

    const stored = await ekv.getItem(TABLE, { userId: "jens", startedAt: 1 });
    assert.deepEqual(stored.attributes, { userId: "jens", startedAt: 1, host: "desktop" });
    assert.equal(stored.created, "2026-09-10T09:00:00Z");
  });

  it("replaces rather than merges on a write", async () => {
    await ekv.putItem(TABLE, { userId: "jens", startedAt: 1, host: "laptop", agent: "ndk" });
    await ekv.putItem(TABLE, { userId: "jens", startedAt: 1, host: "desktop" });

    const stored = await ekv.getItem(TABLE, { userId: "jens", startedAt: 1 });
    assert.equal("agent" in stored.attributes, false);
  });

  it("throws on a missing item, and findItem answers null", async () => {
    // "There is no such item" and "here is an item with nothing in it" are different, so the read that cannot
    // tell them apart is the one that has to say which it meant.
    const key = { userId: "nobody", startedAt: 1 };

    await assert.rejects(
      () => ekv.getItem(TABLE, key),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 404);
        return true;
      },
    );

    assert.equal(await ekv.findItem(TABLE, key), null);
  });

  it("only swallows a miss in findItem", async () => {
    // A malformed key or a table that does not exist is not "not there", and still throws.
    gateway.answer("ekv", "get-item", { error: "'sessions' is keyed on userId" }, 400);

    await assert.rejects(
      () => ekv.findItem(TABLE, { wrong: "key" }),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
  });

  it("says whether there was an item to delete", async () => {
    await ekv.putItem(TABLE, { userId: "jens", startedAt: 1 });

    assert.equal(await ekv.deleteItem(TABLE, { userId: "jens", startedAt: 1 }), true);
    assert.deepEqual(gateway.last().json(), { table: TABLE, key: { userId: "jens", startedAt: 1 } });
    // Deleting what is not there has already achieved what the caller asked for.
    assert.equal(await ekv.deleteItem(TABLE, { userId: "jens", startedAt: 1 }), false);
  });
});

// -- reading many ------------------------------------------------------------------------------------

describe("reading many", () => {
  it("reads a partition in sort-key order", async () => {
    for (const startedAt of [3, 1, 2]) await ekv.putItem(TABLE, { userId: "jens", startedAt });
    await ekv.putItem(TABLE, { userId: "alice", startedAt: 1 });

    const result = await ekv.query(TABLE, "jens");

    assert.deepEqual(result.items.map((item) => item.attributes["startedAt"]), [1, 2, 3]);
    assert.equal(result.count, 3);
  });

  it("always says which direction it wants", async () => {
    // The server reads an absent `forward` as descending rather than as unspecified, so leaving it out would
    // silently reverse every query this SDK makes.
    await ekv.query(TABLE, "jens");

    assert.deepEqual(gateway.last().json(), {
      table: TABLE,
      partitionKey: "jens",
      sortOperator: "",
      sortValue: null,
      sortUpper: null,
      forward: true,
      pageSize: 0,
      pageIndex: 0,
    });

    await ekv.query(TABLE, "jens", { forward: false });
    assert.equal(gateway.last().json()["forward"], false);
  });

  it("narrows by sort key", async () => {
    await ekv.query(TABLE, "jens", { sortOperator: SORT_GE, sortValue: 1757462400, pageSize: 50, pageIndex: 1 });

    assert.deepEqual(gateway.last().json(), {
      table: TABLE,
      partitionKey: "jens",
      sortOperator: "ge",
      sortValue: 1757462400,
      sortUpper: null,
      forward: true,
      pageSize: 50,
      pageIndex: 1,
    });

    await ekv.query(TABLE, "jens", { sortOperator: SORT_BETWEEN, sortValue: 1, sortUpper: 10 });
    assert.equal(gateway.last().json()["sortUpper"], 10);

    await ekv.query(TABLE, "jens", { sortOperator: SORT_BEGINS_WITH, sortValue: "2026-" });
    assert.equal(gateway.last().json()["sortValue"], "2026-");

    assert.equal((await ekv.query(TABLE, "jens", { sortOperator: WHOLE_PARTITION })).count, 0);
  });

  it("refuses a between without both bounds before the round trip", async () => {
    await assert.rejects(
      () => ekv.query(TABLE, "jens", { sortOperator: SORT_BETWEEN, sortValue: 1 }),
      /both a sortValue and a sortUpper/,
    );

    assert.deepEqual(gateway.requests.filter((request) => request.action === "query"), []);
  });

  it("scans the table and says how much there is", async () => {
    for (let startedAt = 0; startedAt < 5; startedAt += 1) await ekv.putItem(TABLE, { userId: "jens", startedAt });

    const scanned = await ekv.scan(TABLE, { pageSize: 2 });

    assert.deepEqual(gateway.last().json(), { table: TABLE, pageSize: 2, pageIndex: 0 });
    assert.deepEqual([scanned.items.length, scanned.count, scanned.total], [2, 2, 5]);
    // No paging at all means the whole table, which is what a page size of zero says.
    assert.equal((await ekv.scan(TABLE)).count, 5);
    assert.equal(tables.items.size, 5);
  });
});

// -- everything else ------------------------------------------------------------------------------------

describe("how EKV behaves", () => {
  it("signs its own target and follows the session", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("ekv", "list-tables", { tables: [], total: 0 });

    await ekv.listTables();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "ekv");

    await session.changeNamespace("development");
    await ekv.listTables();
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.equal(session.ekv(), ekv);
  });

  it("answers metrics unparsed and reaches unwrapped actions", async () => {
    gateway.answer("ekv", "get-metrics", { items: [{ name: "ekv-items", value: 3 }] });
    gateway.answer("ekv", "some-future-action", { ok: true });

    assert.deepEqual(await ekv.metrics(), { items: [{ name: "ekv-items", value: 3 }] });
    assert.deepEqual(await ekv.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });

  it("parses an item that carries only timestamps", async () => {
    // The parse is defensive in both directions: nothing but the timestamps, and nothing at all.
    const item = toItem({ [CREATED_ATTRIBUTE]: "2026-09-10", [MODIFIED_ATTRIBUTE]: "2026-09-11" });
    assert.deepEqual(item, { attributes: {}, created: "2026-09-10", modified: "2026-09-11" });

    assert.deepEqual(toItem(null), { attributes: {}, created: "", modified: "" });
  });
});
