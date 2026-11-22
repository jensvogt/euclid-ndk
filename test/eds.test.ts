/**
 * EDS, end to end against a fake euclid server.
 *
 * Every action is one request, so what these check is that it carries the fields the server reads and
 * parses the ones it answers with. Two things here are worth more than that: a record is a *set*, so a
 * write replaces its values rather than adding to them, and an answer's "not ours" is a 200 with
 * REFUSED rather than an error - which is what a caller polling for a change has to read correctly.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DEFAULT_ZONE_TTL,
  Euclid,
  RCODE_NXDOMAIN,
  RCODE_REFUSED,
  RECORD_A,
  RECORD_CNAME,
  RECORD_MX,
  ZONE_APEX,
  type EuclidEds,
  type EuclidSession,
} from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

const ZONE = {
  name: "example.com",
  ern: "ern:euclid:eds:eu-central-1:000000000000:zone/example.com",
  namespace: "development",
  ttl: 300,
  description: "the public zone",
  recordCount: 4,
  serial: 1764000000,
  created: "2026-11-20",
  modified: "2026-11-22",
};

let gateway: FakeGateway;
let session: EuclidSession;
let eds: EuclidEds;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-eds-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  eds = session.eds();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- zones ----------------------------------------------------------------------------------------

describe("zones", () => {
  it("creates one, and sends a ttl of zero for the server's own default", async () => {
    gateway.answer("eds", "create-zone", ZONE);

    const zone = await eds.createZone("example.com", { description: "the public zone" });

    // Zero is what says "use the zone default", which the server stores as 300.
    assert.deepEqual(gateway.last().json(), { name: "example.com", ttl: 0, description: "the public zone" });
    assert.equal(zone.ttl, DEFAULT_ZONE_TTL);
    // Derived from the modification time rather than counted, so a record edit raises it.
    assert.equal(zone.serial, 1764000000);

    await eds.createZone("example.com", { ttl: 60 });
    assert.deepEqual(gateway.last().json(), { name: "example.com", ttl: 60, description: "" });
  });

  it("leaves the service domain and a duplicate to the server to refuse", async () => {
    // euclid gives what it runs names under the service domain, and a zone over them would shadow
    // the thing it is named after.
    gateway.answer(
      "eds",
      "create-zone",
      { error: "'euclid.internal' holds the names euclid gives what it runs, and cannot have zones of its own" },
      400,
    );
    await assert.rejects(
      () => eds.createZone("svc.euclid.internal"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["create-zone", 400]);
        return true;
      },
    );

    gateway.answer("eds", "create-zone", { error: "Zone exists already: example.com" }, 409);
    await assert.rejects(
      () => eds.createZone("example.com"),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  it("reads one, lists a page of them, and deletes one with its records", async () => {
    gateway.answer("eds", "get-zone", ZONE);
    gateway.answer("eds", "list-zones", { total: 2, zones: [ZONE, { name: "internal.example.com" }] });
    gateway.answer("eds", "delete-zone", { deletedRecords: 17 });

    assert.equal((await eds.getZone("example.com")).recordCount, 4);
    assert.deepEqual(gateway.last().json(), { name: "example.com" });

    const listed = await eds.listZones({ prefix: "ex", pageSize: 25 });
    // Zones take a prefix and paging and nothing else: no sort column is sent, because the server
    // reads none.
    assert.deepEqual(gateway.last().json(), { prefix: "ex", pageSize: 25, pageIndex: 0 });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map((zone) => zone.name), ["example.com", "internal.example.com"]);

    // A zone goes with its records or not at all, and the count is what went.
    assert.equal(await eds.deleteZone("example.com"), 17);
    assert.deepEqual(gateway.last().json(), { name: "example.com" });
  });

  it("answers a zone of another account as a miss", async () => {
    // 404 rather than 403, the way a listing would not have shown it either.
    gateway.answer("eds", "get-zone", { error: "Zone does not exist: somebody.else" }, 404);

    await assert.rejects(
      () => eds.getZone("somebody.else"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["get-zone", 404]);
        return true;
      },
    );
  });
});

// -- records --------------------------------------------------------------------------------------

describe("records", () => {
  it("writes a set, with every value it should have afterwards", async () => {
    gateway.answer("eds", "put-record", {
      zone: "example.com",
      name: "www.example.com",
      type: "A",
      ttl: 60,
      values: ["192.0.2.10", "192.0.2.11"],
      created: "2026-11-22",
      modified: "2026-11-22",
    });

    const record = await eds.putRecord("example.com", "www", RECORD_A, ["192.0.2.10", "192.0.2.11"], 60);

    assert.deepEqual(gateway.last().json(), {
      zone: "example.com",
      name: "www",
      type: "A",
      ttl: 60,
      values: ["192.0.2.10", "192.0.2.11"],
    });
    // A label goes out, the qualified owner name comes back - so a caller comparing the two has to
    // compare against the qualified form.
    assert.equal(record.name, "www.example.com");
    assert.deepEqual(record.values, ["192.0.2.10", "192.0.2.11"]);
  });

  it("writes at the apex, and sends a zero ttl to follow the zone's", async () => {
    gateway.answer("eds", "put-record", {
      zone: "example.com",
      name: "example.com",
      type: "MX",
      ttl: 0,
      values: ["10 mail.example.com"],
    });

    const apex = await eds.putRecord("example.com", ZONE_APEX, RECORD_MX, ["10 mail.example.com"]);

    assert.deepEqual(gateway.last().json(), {
      zone: "example.com",
      name: "@",
      type: "MX",
      ttl: 0,
      values: ["10 mail.example.com"],
    });
    // The apex is the zone itself, which is what "@" writes out as.
    assert.equal(apex.name, "example.com");
    assert.equal(apex.ttl, 0);
  });

  it("leaves the protocol's own refusals to the server", async () => {
    // Both are DNS's rules rather than euclid's: a CNAME has one value, and the apex cannot be one
    // at all, because it holds the zone's SOA and NS records.
    gateway.answer("eds", "put-record", { error: "a CNAME has exactly one value" }, 400);
    await assert.rejects(
      () => eds.putRecord("example.com", "alias", RECORD_CNAME, ["a.example.com", "b.example.com"]),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 400);
        return true;
      },
    );

    gateway.answer(
      "eds",
      "put-record",
      { error: "the zone apex cannot be a CNAME; it holds the zone's SOA and NS" },
      400,
    );
    await assert.rejects(
      () => eds.putRecord("example.com", ZONE_APEX, RECORD_CNAME, ["a.example.com"]),
      (error: EuclidServiceError) => {
        assert.match(error.reason, /apex cannot be a CNAME/);
        return true;
      },
    );

    // An empty list is not a delete, and the server says which call that is.
    gateway.answer("eds", "put-record", { error: "values is required; delete-record removes a record set" }, 400);
    await assert.rejects(
      () => eds.putRecord("example.com", "www", RECORD_A, []),
      (error: EuclidServiceError) => {
        assert.match(error.reason, /delete-record/);
        return true;
      },
    );
  });

  it("lists a zone's records, narrowed or whole", async () => {
    gateway.answer("eds", "list-records", {
      total: 1,
      records: [{ zone: "example.com", name: "www.example.com", type: "A", ttl: 60, values: ["192.0.2.10"] }],
    });

    const narrowed = await eds.listRecords("example.com", { name: "www", type: RECORD_A, pageSize: 10 });
    assert.deepEqual(gateway.last().json(), {
      zone: "example.com",
      name: "www",
      type: "A",
      pageSize: 10,
      pageIndex: 0,
    });
    assert.equal(narrowed.items[0]?.values.length, 1);

    await eds.listRecords("example.com");
    assert.deepEqual(gateway.last().json(), { zone: "example.com", name: "", type: "", pageSize: 0, pageIndex: 0 });
  });

  it("deletes a set, and needs the type to do it", async () => {
    gateway.answer("eds", "delete-record", { deleted: true });

    await eds.deleteRecord("example.com", "www", RECORD_A);
    assert.deepEqual(gateway.last().json(), { zone: "example.com", name: "www", type: "A" });

    // A name usually holds more than one type, so nothing there is a 404 rather than a success that
    // removed nothing.
    gateway.answer("eds", "delete-record", { error: "No AAAA records at www.example.com" }, 404);
    await assert.rejects(
      () => eds.deleteRecord("example.com", "www", "AAAA"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["delete-record", 404]);
        return true;
      },
    );
  });
});

// -- resolving ------------------------------------------------------------------------------------

describe("resolving", () => {
  it("answers from the catalogue the DNS side serves", async () => {
    gateway.answer("eds", "get-answer", {
      name: "www.example.com",
      type: "A",
      authoritative: true,
      zone: "example.com",
      rcode: "NOERROR",
      answers: [
        { name: "www.example.com", type: "A", ttl: 60, value: "192.0.2.10" },
        { name: "www.example.com", type: "A", ttl: 60, value: "192.0.2.11" },
      ],
      authority: [],
    });

    const answer = await eds.getAnswer("www.example.com");

    // The type is left for the server to default to A, as a resolver's own default is.
    assert.deepEqual(gateway.last().json(), { name: "www.example.com", type: "" });
    assert.deepEqual([answer.authoritative, answer.rcode, answer.zone], [true, "NOERROR", "example.com"]);
    // A set of two addresses arrives as two records that share a name - the opposite of how
    // put-record stores them.
    assert.equal(answer.answers.length, 2);
    assert.deepEqual(answer.answers.map((record) => record.value), ["192.0.2.10", "192.0.2.11"]);
  });

  it("tells a name in no zone of ours from a name that does not exist", async () => {
    // Not ours: 200 with REFUSED, because the DNS port would have forwarded it upstream. A caller
    // that read this as an error would be wrong about whose problem it is.
    gateway.answer("eds", "get-answer", {
      name: "www.elsewhere.test",
      type: "A",
      authoritative: false,
      rcode: "REFUSED",
      answers: [],
    });

    const refused = await eds.getAnswer("www.elsewhere.test");
    assert.deepEqual([refused.authoritative, refused.rcode], [false, RCODE_REFUSED]);
    assert.deepEqual(refused.answers, []);
    assert.equal(refused.zone, "");

    // Ours, and empty: the authority section carries the SOA a resolver caches the negative answer
    // against.
    gateway.answer("eds", "get-answer", {
      name: "nothing.example.com",
      type: "A",
      authoritative: true,
      zone: "example.com",
      rcode: "NXDOMAIN",
      answers: [],
      authority: [{ name: "example.com", type: "SOA", ttl: 300, value: "ns1.example.com hostmaster.example.com 1 2 3 4 5" }],
    });

    const missing = await eds.getAnswer("nothing.example.com", RECORD_A);
    assert.deepEqual([missing.authoritative, missing.rcode], [true, RCODE_NXDOMAIN]);
    assert.equal(missing.authority[0]?.type, "SOA");
  });
});

// -- behaviour ------------------------------------------------------------------------------------

describe("how EDS behaves", () => {
  it("signs its own target and is the same client each time", async () => {
    gateway.answer("eds", "list-zones", { total: 0, zones: [] });

    await eds.listZones();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "eds");

    assert.equal(session.eds(), eds);
  });

  it("follows the session's namespace", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("eds", "list-zones", { total: 0, zones: [] });

    await session.changeNamespace("production");
    await eds.listZones();

    assert.equal(gateway.last().headers["x-euclid-namespace"], "production");
  });

  it("answers metrics unparsed and reaches an action this SDK does not wrap", async () => {
    gateway.answer("eds", "get-metrics", { items: [{ name: "eds-queries", value: 12 }] });
    gateway.answer("eds", "some-future-action", { ok: true });

    assert.deepEqual(await eds.metrics(), { items: [{ name: "eds-queries", value: 12 }] });
    assert.deepEqual(await eds.call("some-future-action", { x: 1 }), { ok: true });
  });
});
