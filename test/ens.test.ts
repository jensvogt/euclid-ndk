/**
 * ENS, end to end against a fake euclid server.
 *
 * Topics have no receive and no lease, so there is nothing here that needs a stateful stand-in the way
 * EQS's long poll does: every action is one request, and what these check is that it carries the fields
 * the server reads and parses the ones it answers with.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  Euclid,
  EVERY_NAMESPACE,
  INSTALLATION_RETENTION,
  PRIORITY_HIGH,
  RETENTION_FOREVER,
  QUEUE as QUEUE_TYPE,
  TOPIC_RUNNING,
  TOPIC_STOPPED,
  type EuclidEns,
  type EuclidSession,
} from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";
import { queueErn } from "./fake-queues.js";

const TOPIC = "ern:euclid:ens:eu-central-1:000000000000:topic/order-events";
const QUEUE = queueErn("orders");

let gateway: FakeGateway;
let session: EuclidSession;
let ens: EuclidEns;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-ens-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  ens = session.ens();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- topics ------------------------------------------------------------------------------------

describe("topics", () => {
  it("creates and lists them", async () => {
    gateway.answer("ens", "create-topic", { name: "order-events", ern: TOPIC });
    gateway.answer("ens", "list-topics", {
      total: 2,
      topics: [
        {
          name: "order-events",
          ern: TOPIC,
          owner: "jens",
          tags: { team: "sales" },
          size: 4096,
          messages: 12,
          maxMessageLength: 262144,
          status: "STOPPED",
          retentionPeriod: 604800,
          created: "2026-01-01",
        },
        { name: "audit" },
      ],
    });

    const created = await ens.createTopic("order-events", 262144);
    assert.deepEqual([created.name, created.ern], ["order-events", TOPIC]);
    assert.deepEqual(gateway.last().json(), { name: "order-events", maxMessageLength: 262144 });

    const listed = await ens.listTopics({ prefix: "order", pageSize: 25, sortDirection: "desc" });
    assert.deepEqual(gateway.last().json(), {
      prefix: "order",
      pageSize: 25,
      pageIndex: 0,
      sortColumn: "name",
      sortDirection: "desc",
    });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map((topic) => topic.name), ["order-events", "audit"]);
    assert.deepEqual(listed.items[0]?.tags, { team: "sales" });
    assert.equal(listed.items[0]?.messages, 12);
    // A listed topic says whether it is delivering and how long it keeps what it is given.
    assert.equal(listed.items[0]?.status, TOPIC_STOPPED);
    assert.equal(listed.items[0]?.retentionPeriod, 604800);
    // A field the server did not send reads as empty rather than throwing.
    assert.equal(listed.items[1]?.owner, "");
    assert.equal(listed.items[1]?.maxMessageLength, 0);
    assert.equal(listed.items[1]?.retentionPeriod, 0);
  });

  it("answers with the ERN, the metadata and the tags", async () => {
    gateway.answer("ens", "get-topic-ern", { name: "order-events", ern: TOPIC });
    gateway.answer("ens", "get-topic-metadata", {
      region: "eu-central-1",
      accountId: "000000000000",
      owner: "jens",
      nameSpace: "development",
      name: "order-events",
      ern: TOPIC,
      size: 4096,
      messages: 12,
      status: "STOPPED",
      retentionPeriod: 604800,
      held: 7,
    });
    gateway.answer("ens", "add-topic-tag", {});
    gateway.answer("ens", "set-topic-tag", {});
    gateway.answer("ens", "delete-topic-tag", {});

    assert.equal(await ens.getTopicErn("order-events"), TOPIC);
    assert.deepEqual(gateway.last().json(), { name: "order-events" });

    const metadata = await ens.getTopicMetadata(TOPIC);
    assert.deepEqual([metadata.namespace, metadata.messages, metadata.size], ["development", 12, 4096]);
    // The useful half of a stopped topic: how much has piled up waiting for it to be started.
    assert.deepEqual([metadata.status, metadata.retentionPeriod, metadata.held], [TOPIC_STOPPED, 604800, 7]);

    await ens.addTopicTag(TOPIC, "team", "sales");
    assert.deepEqual(gateway.last().json(), { ern: TOPIC, key: "team", value: "sales" });
    await ens.setTopicTag(TOPIC, "team", "ops");
    await ens.deleteTopicTag(TOPIC, "team");
    assert.deepEqual(gateway.last().json(), { ern: TOPIC, key: "team" });
  });

  it("follows the session's namespace on a blanket purge, and takes every namespace when told", async () => {
    // The server reads an empty namespace as every namespace of the account, so an explicit empty string has
    // to survive rather than fall back to the session's - which is the whole difference between the two.
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("ens", "purge-all-topics", {});

    await session.changeNamespace("development");

    await ens.purgeAllTopics();
    assert.equal(gateway.last().json()["nameSpace"], "development");

    await ens.purgeAllTopics({ namespace: EVERY_NAMESPACE });
    assert.equal(gateway.last().json()["nameSpace"], "");
  });

  it("purges and deletes them", async () => {
    gateway.answer("ens", "purge-topic", {});
    gateway.answer("ens", "purge-all-topics", {});
    gateway.answer("ens", "delete-topic", {});

    await ens.purgeTopic(TOPIC);
    assert.deepEqual(gateway.last().json(), { ern: TOPIC });

    // Defaults to the session's own account, region and namespace.
    await ens.purgeAllTopics();
    assert.deepEqual(gateway.last().json(), {
      region: "eu-central-1",
      accountId: "000000000000",
      nameSpace: "",
    });

    await ens.deleteTopic(TOPIC);
    assert.equal(gateway.last().action, "delete-topic");
  });
});

// -- holding delivery ----------------------------------------------------------------------------

describe("stopping and starting a topic", () => {
  it("holds delivery without refusing publishers", async () => {
    gateway.answer("ens", "stop-topic", { ern: TOPIC, status: "STOPPED", released: 0 });
    gateway.answer("ens", "publish-message", { messageId: "message-1" });

    const stopped = await ens.stopTopic(TOPIC);

    assert.deepEqual(gateway.last().json(), { ern: TOPIC });
    assert.deepEqual([stopped.status, stopped.released], [TOPIC_STOPPED, 0]);

    // Still accepting: what arrives while it is stopped is kept rather than refused or lost.
    assert.equal(await ens.publishMessage(TOPIC, "held while stopped"), "message-1");
  });

  it("hands over what it held when started again", async () => {
    // The backlog goes out as part of this call, so `released` is delivery rather than a promise of it.
    gateway.answer("ens", "start-topic", { ern: TOPIC, status: "RUNNING", released: 42 });

    const started = await ens.startTopic(TOPIC);

    assert.deepEqual(gateway.last().json(), { ern: TOPIC });
    assert.deepEqual([started.ern, started.status, started.released], [TOPIC, TOPIC_RUNNING, 42]);
  });

  it("starts a topic that was never stopped without complaint", async () => {
    gateway.answer("ens", "start-topic", { ern: TOPIC, status: "RUNNING", released: 0 });

    const started = await ens.startTopic(TOPIC);

    assert.deepEqual([started.status, started.released], [TOPIC_RUNNING, 0]);
  });

  it("carries the server's reason for a topic that is not there", async () => {
    gateway.answer("ens", "stop-topic", { error: `Topic not found, ern: ${TOPIC}` }, 404);

    await assert.rejects(
      () => ens.stopTopic(TOPIC),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["ens", "stop-topic", 404]);
        return true;
      },
    );
  });
});

// -- message size --------------------------------------------------------------------------------

describe("message size", () => {
  it("changes the largest message the topic accepts", async () => {
    // What is published from here on: a message already in the topic was accepted under the rule in force
    // when it arrived.
    gateway.answer("ens", "set-topic-max-message-length", { ern: TOPIC, maxMessageLength: 262144 });

    const result = await ens.setTopicMaxMessageLength(TOPIC, 262144);

    assert.deepEqual(gateway.last().json(), { ern: TOPIC, maxMessageLength: 262144 });
    assert.deepEqual([result.ern, result.maxMessageLength], [TOPIC, 262144]);
  });

  it("refuses a length that is not positive before the round trip", async () => {
    // Where a queue takes zero to mean "no limit of my own", a topic has no such notion - and one accepting
    // nothing is stopTopic said irreversibly.
    await assert.rejects(() => ens.setTopicMaxMessageLength(TOPIC, 0), /positive number of bytes/);
    await assert.rejects(() => ens.setTopicMaxMessageLength(TOPIC, -1), /positive number of bytes/);

    assert.deepEqual(gateway.requests.filter((request) => request.action === "set-topic-max-message-length"), []);
  });

  it("carries the server's reason for a message the topic will not take", async () => {
    gateway.answer(
      "ens",
      "publish-message",
      { error: "message is 2048 bytes, and this topic accepts 1024 - see set-topic-max-message-length" },
      400,
    );

    await assert.rejects(
      () => ens.publishMessage(TOPIC, "x".repeat(2048)),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["ens", "publish-message", 400]);
        assert.ok(error.reason.startsWith("message is 2048 bytes"));
        return true;
      },
    );
  });
});

// -- retention -----------------------------------------------------------------------------------

describe("retention", () => {
  it("sets how long a published message is kept", async () => {
    gateway.answer("ens", "set-topic-retention", { ern: TOPIC, retentionPeriod: 604800 });

    const result = await ens.setTopicRetention(TOPIC, 604800);

    assert.deepEqual(gateway.last().json(), { ern: TOPIC, retentionPeriod: 604800 });
    assert.deepEqual([result.ern, result.retentionPeriod], [TOPIC, 604800]);
  });

  it("takes zero to mean the installation's own period", async () => {
    // Rather than freezing a copy of whatever that default says today.
    gateway.answer("ens", "set-topic-retention", { ern: TOPIC, retentionPeriod: 0 });

    const result = await ens.setTopicRetention(TOPIC, INSTALLATION_RETENTION);

    assert.deepEqual(gateway.last().json(), { ern: TOPIC, retentionPeriod: 0 });
    assert.equal(result.retentionPeriod, 0);
  });

  it("takes minus one to mean keep everything", async () => {
    // The one negative that means something: the server stores such a message with no expiry at all rather
    // than with a very distant one, so nothing ever removes it.
    gateway.answer("ens", "set-topic-retention", { ern: TOPIC, retentionPeriod: -1 });

    const result = await ens.setTopicRetention(TOPIC, RETENTION_FOREVER);

    assert.deepEqual(gateway.last().json(), { ern: TOPIC, retentionPeriod: -1 });
    assert.equal(result.retentionPeriod, RETENTION_FOREVER);
  });

  it("refuses a period below minus one before the round trip", async () => {
    await assert.rejects(() => ens.setTopicRetention(TOPIC, -2), /keep messages forever/);

    assert.deepEqual(gateway.requests.filter((request) => request.action === "set-topic-retention"), []);
  });
});

// -- messages ------------------------------------------------------------------------------------

describe("published messages", () => {
  it("answers with the ID the server gave the message", async () => {
    gateway.answer("ens", "publish-message", { messageId: "message-1" });

    const messageId = await ens.publishMessage(TOPIC, '{"order": 17}', {
      attributes: { tenant: "acme", retries: 3 },
      priority: PRIORITY_HIGH,
    });

    assert.equal(messageId, "message-1");
    assert.deepEqual(gateway.last().json(), {
      ern: TOPIC,
      body: '{"order": 17}',
      priority: "HIGH",
      attributes: { tenant: { type: "string", value: "acme" }, retries: { type: "long", value: 3 } },
    });
  });

  it("leaves the priority out when there is none", async () => {
    // So the topic's own default applies rather than an empty string the server would refuse.
    gateway.answer("ens", "publish-message", { messageId: "message-1" });

    await ens.publishMessage(TOPIC, "body");

    assert.deepEqual(gateway.last().json(), { ern: TOPIC, body: "body", attributes: {} });
  });

  it("lists a topic's messages", async () => {
    gateway.answer("ens", "list-messages", {
      total: 1,
      messages: [
        {
          ern: `${TOPIC}/message/1`,
          topicErn: TOPIC,
          messageId: "message-1",
          status: "SENT",
          body: '{"order": 17}',
          contentType: "application/json",
          attributes: { tenant: { type: "string", value: "acme" } },
          created: "2026-01-01",
        },
      ],
    });

    const listed = await ens.listMessages(TOPIC, { pageSize: 50 });

    assert.deepEqual(gateway.last().json(), {
      topicErn: TOPIC,
      pageSize: 50,
      pageIndex: 0,
      sortColumn: "created",
      sortDirection: "asc",
    });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0]?.topicErn, TOPIC);
    assert.deepEqual(listed.items[0]?.attributes["tenant"], { type: "string", value: "acme" });
  });

  it("counts delivery rather than a backlog", async () => {
    // A topic does not hold one, so its three counters are what is on it, what went out, and what had to
    // go out again.
    gateway.answer("ens", "get-message-count", { ern: TOPIC, available: 12, send: 30, resend: 2 });

    const count = await ens.getMessageCount(TOPIC);

    assert.deepEqual([count.available, count.send, count.resend], [12, 30, 2]);
  });

  it("carries attributes under the key ENS uses", async () => {
    // `key` throughout ENS, where EQS mostly says `name` - the server's own asymmetry.
    gateway.answer("ens", "get-message-attribute", {
      messageId: "message-1",
      key: "tenant",
      value: { type: "string", value: "acme" },
    });
    gateway.answer("ens", "set-message-attribute", {
      messageId: "message-1",
      key: "retries",
      value: { type: "long", value: 3 },
    });

    const attribute = await ens.getMessageAttribute("message-1", "tenant");
    assert.deepEqual(gateway.last().json(), { messageId: "message-1", key: "tenant" });
    assert.equal(attribute.key, "tenant");
    assert.deepEqual(attribute.value, { type: "string", value: "acme" });

    const updated = await ens.setMessageAttribute("message-1", "retries", 3);
    assert.deepEqual(gateway.last().json(), {
      messageId: "message-1",
      key: "retries",
      value: { type: "long", value: 3 },
    });
    assert.deepEqual(updated.value, { type: "long", value: 3 });
  });
});

// -- subscriptions ----------------------------------------------------------------------------------

describe("subscriptions", () => {
  it("subscribes a queue to a topic", async () => {
    gateway.answer("ens", "subscribe", {
      ern: "ern:ens:subscription/1",
      sourceErn: TOPIC,
      type: "SQS",
      targetErn: QUEUE,
    });
    gateway.answer("ens", "list-subscriptions", {
      total: 1,
      subscriptions: [
        { ern: "ern:ens:subscription/1", sourceErn: TOPIC, type: "SQS", targetErn: QUEUE, created: "2026-01-01" },
      ],
    });
    gateway.answer("ens", "unsubscribe", {});

    const created = await ens.subscribe(TOPIC, QUEUE);

    assert.deepEqual(gateway.last().json(), { sourceErn: TOPIC, type: "SQS", targetErn: QUEUE });
    assert.equal(created.targetErn, QUEUE);

    const subscriptions = await ens.listSubscriptions(TOPIC);
    assert.deepEqual(subscriptions.map((subscription) => subscription.targetErn), [QUEUE]);
    assert.deepEqual(gateway.last().json(), { topicErn: TOPIC });

    // The subscription's own ERN, not the topic's and not the queue's.
    await ens.unsubscribe(created.ern);
    assert.deepEqual(gateway.last().json(), { ern: "ern:ens:subscription/1" });
  });

  it("lets the delivery protocol be named", async () => {
    gateway.answer("ens", "subscribe", { ern: "ern:ens:subscription/1", type: "SQS" });

    await ens.subscribe(TOPIC, QUEUE, QUEUE_TYPE);

    assert.equal(gateway.last().json()["type"], "SQS");
  });
});

// -- everything else ----------------------------------------------------------------------------------

describe("how ENS authenticates", () => {
  it("signs its own target and follows the session", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("ens", "get-topic-ern", { ern: TOPIC });

    await ens.getTopicErn("order-events");
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "ens");

    await session.changeNamespace("development");
    await ens.getTopicErn("order-events");
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.equal(session.ens(), ens);
  });

  it("gives each module of one session its own client", async () => {
    // Three modules, three clients, one session - and one call each proves they route to their own target
    // rather than to whichever was asked for first.
    gateway.answer("ens", "get-topic-ern", { ern: TOPIC });
    gateway.answer("eqs", "get-queue-ern", { ern: QUEUE });
    gateway.answer("esm", "get-bucket-ern", { ern: "ern:esm:bucket/reports" });

    await session.ens().getTopicErn("order-events");
    await session.eqs().getQueueErn("orders");
    await session.esm().getBucketErn("reports");

    const sent = gateway.requests.filter((request) => request.target !== "eam");
    assert.deepEqual(sent.map((request) => request.target), ["ens", "eqs", "esm"]);
    // Each signed for its own module: the target is signed, so a client signing for another one would
    // have been refused by the gateway rather than answered.
    assert.deepEqual(new Set(sent.map((request) => request.auth)), new Set(["sigv4"]));
  });

  it("carries the server's reason when a call is refused", async () => {
    gateway.answer("ens", "publish-message", { error: "Message too long" }, 400);

    await assert.rejects(
      () => ens.publishMessage(TOPIC, "x".repeat(10)),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["ens", "publish-message", 400]);
        assert.equal(error.reason, "Message too long");
        return true;
      },
    );
  });

  it("reaches an action this SDK does not wrap", async () => {
    gateway.answer("ens", "some-future-action", { ok: true });

    assert.deepEqual(await ens.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });
});
