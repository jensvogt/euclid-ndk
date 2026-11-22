/**
 * EES, end to end against a fake euclid server.
 *
 * Every action is one request, so what these check is that it carries the fields the server reads and
 * parses the ones it answers with. Three things here are worth more than that, and are what the awkward
 * cases below are about: a subscribe is additive and answers with every subscription the name has, a
 * received event is claimed rather than consumed - so `attempts` is what tells a redelivery apart - and
 * acknowledging fewer events than were named is an answer rather than an error.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  DEFAULT_EVENT_VISIBILITY,
  DELIVERY_LIVE,
  Euclid,
  MAX_WAIT_TIME,
  parseBucketEvent,
  type EuclidEes,
  type EuclidSession,
} from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

const SUBSCRIPTION = {
  subscriber: "reporting",
  eventType: "esm.object.created",
  filter: { bucketName: "reports" },
  accountId: "000000000000",
  mode: "durable",
  created: "2026-11-20",
  lastSeen: "2026-11-22T09:00:00Z",
};

let gateway: FakeGateway;
let session: EuclidSession;
let ees: EuclidEes;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-ees-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  ees = session.ees();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- subscribing ----------------------------------------------------------------------------------

describe("subscribing", () => {
  it("takes several types at once, and sends only what it was given", async () => {
    gateway.answer("ees", "subscribe-events", { subscriptions: [SUBSCRIPTION] });

    await ees.subscribeEvents("reporting", ["esm.object.created", "esm.object.deleted"]);
    // Nothing about a filter, a mode or ephemerality: the server's own defaults decide, and sending
    // an empty filter would be the same request anyway while sending "durable" would hard-code what
    // the server chooses.
    assert.deepEqual(gateway.last().json(), {
      name: "reporting",
      eventTypes: ["esm.object.created", "esm.object.deleted"],
    });

    await ees.subscribeEvents("console", ["esm.object.created"], {
      filter: { bucketName: "reports" },
      mode: DELIVERY_LIVE,
      ephemeral: true,
    });
    assert.deepEqual(gateway.last().json(), {
      name: "console",
      eventTypes: ["esm.object.created"],
      filter: { bucketName: "reports" },
      mode: "live",
      ephemeral: true,
    });
  });

  it("answers with every subscription the name now has", async () => {
    // Additive rather than a replacement: what comes back includes rows from earlier calls, which is
    // how a caller sees what the name is actually watching.
    gateway.answer("ees", "subscribe-events", {
      subscriptions: [SUBSCRIPTION, { ...SUBSCRIPTION, eventType: "esm.object.deleted" }],
    });

    const result = await ees.subscribeEvents("reporting", ["esm.object.deleted"]);

    assert.deepEqual(result.subscriptions.map((row) => row.eventType), [
      "esm.object.created",
      "esm.object.deleted",
    ]);
    assert.deepEqual(result.subscriptions[0]?.filter, { bucketName: "reports" });
  });

  it("leaves an empty type list to the server to refuse", async () => {
    // A subscriber that asked for everything on a busy installation is a backlog nobody drains, so
    // the server refuses rather than reading nothing as everything.
    gateway.answer("ees", "subscribe-events", { error: "eventTypes is required" }, 400);

    await assert.rejects(
      () => ees.subscribeEvents("reporting", []),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["subscribe-events", 400]);
        return true;
      },
    );
  });

  it("lists what a subscriber watches, with the backlog counted", async () => {
    gateway.answer("ees", "list-subscriptions", { subscriptions: [SUBSCRIPTION], waiting: 42 });

    const listed = await ees.listSubscriptions("reporting");

    assert.deepEqual(gateway.last().json(), { name: "reporting" });
    // The only call that counts: acknowledging deliberately does not pay for a scan of the backlog.
    assert.equal(listed.waiting, 42);
  });

  it("unsubscribes one type, or every one", async () => {
    gateway.answer("ees", "unsubscribe-events", { subscriber: "reporting", removed: 1 });

    const one = await ees.unsubscribeEvents("reporting", "esm.object.deleted");
    assert.deepEqual(gateway.last().json(), { name: "reporting", eventType: "esm.object.deleted" });
    assert.equal(one.removed, 1);

    // An empty type is how every subscription of the name goes, so it is sent rather than left out.
    gateway.answer("ees", "unsubscribe-events", { subscriber: "reporting", removed: 2 });
    await ees.unsubscribeEvents("reporting");
    assert.deepEqual(gateway.last().json(), { name: "reporting", eventType: "" });
  });
});

// -- receiving ------------------------------------------------------------------------------------

describe("receiving", () => {
  it("waits for events, and keeps the payload as the module published it", async () => {
    const body = JSON.stringify({ eventType: "esm.object.created", key: "q3.pdf", size: 8 });
    gateway.answer("ees", "receive-events", {
      total: 1,
      events: [
        {
          eventId: "e-1",
          eventType: "esm.object.created",
          sourceModule: "esm",
          payload: { body, bucketName: "reports" },
          attempts: 1,
          created: "2026-11-22T09:00:00Z",
        },
      ],
    });

    const received = await ees.receiveEvents("reporting", {
      maxEvents: 5,
      waitTime: MAX_WAIT_TIME,
      visibilityTimeout: DEFAULT_EVENT_VISIBILITY,
    });

    assert.deepEqual(gateway.last().json(), {
      name: "reporting",
      maxEvents: 5,
      waitTime: 20,
      visibilityTimeout: 300,
    });
    assert.equal(received.total, 1);
    // Left as the publishing module wrote it, so an ESM event's own body still parses as one.
    assert.equal(parseBucketEvent(received.events[0]?.payload["body"] as string).key, "q3.pdf");
    assert.equal(received.events[0]?.sourceModule, "esm");
  });

  it("asks for nothing it was not given, and reads an empty answer as ordinary", async () => {
    gateway.answer("ees", "receive-events", { total: 0, events: [] });

    const received = await ees.receiveEvents("reporting");

    // The server's own defaults for all three: ten events, no wait, five minutes of visibility.
    assert.deepEqual(gateway.last().json(), { name: "reporting" });
    // Nothing arrived in the time it waited, which is not an error and not an empty backlog either.
    assert.deepEqual([received.total, received.events], [0, []]);
  });

  it("shows a redelivery as one", async () => {
    // attempts above 1 is the one thing that tells a redelivery from a first delivery, and watching
    // it is how a consumer finds work it cannot finish rather than retrying it forever.
    gateway.answer("ees", "receive-events", {
      total: 1,
      events: [{ eventId: "e-1", eventType: "esm.object.created", attempts: 4 }],
    });

    assert.equal((await ees.receiveEvents("reporting")).events[0]?.attempts, 4);
  });

  it("acknowledges, and reads fewer than it named as an answer", async () => {
    gateway.answer("ees", "ack-events", { subscriber: "reporting", acknowledged: 2 });

    // Three named, two removed: a redelivery acknowledged twice and an event whose retention ran out
    // both end here, and both mean the same thing to the caller.
    const result = await ees.ackEvents("reporting", ["e-1", "e-2", "e-3"]);

    assert.deepEqual(gateway.last().json(), { name: "reporting", eventIds: ["e-1", "e-2", "e-3"] });
    assert.equal(result.acknowledged, 2);

    gateway.answer("ees", "ack-events", { error: "eventIds is required" }, 400);
    await assert.rejects(
      () => ees.ackEvents("reporting", []),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
  });
});

// -- behaviour ------------------------------------------------------------------------------------

describe("how EES behaves", () => {
  it("signs its own target and is the same client each time", async () => {
    gateway.answer("ees", "list-subscriptions", { subscriptions: [], waiting: 0 });

    await ees.listSubscriptions("reporting");
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "ees");

    assert.equal(session.ees(), ees);
  });

  it("answers metrics unparsed and reaches an action this SDK does not wrap", async () => {
    gateway.answer("ees", "get-metrics", { items: [{ name: "ees-events", value: 3 }] });
    gateway.answer("ees", "some-future-action", { ok: true });

    assert.deepEqual(await ees.metrics(), { items: [{ name: "ees-events", value: 3 }] });
    assert.deepEqual(await ees.call("some-future-action", { x: 1 }), { ok: true });
  });
});
