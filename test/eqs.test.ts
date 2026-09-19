/**
 * EQS, end to end against a fake euclid server.
 *
 * The queue actions are checked the way EAM's and ESM's are: what went on the wire, and what came back
 * off it. Receiving is checked against a queue stand-in that really leases messages out
 * (`fake-queues.ts`), because the two things a queue client can get wrong - taking a message twice and
 * abandoning a long poll the server is still honouring - are invisible to a test whose server always
 * answers immediately.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  Euclid,
  INSTALLATION_MAX_MESSAGE_LENGTH,
  MAX_QUEUE_DELAY,
  PRIORITY_HIGH,
  type EuclidEqs,
  type EuclidSession,
} from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";
import { FakeQueues, queueErn } from "./fake-queues.js";

const QUEUE = queueErn("orders");

let gateway: FakeGateway;
let queues: FakeQueues;
let session: EuclidSession;
let eqs: EuclidEqs;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  queues = new FakeQueues().install(gateway);
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-eqs-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  eqs = session.eqs();
  // Polls without the waiting. The backoff is what makes a retry kind to a server short of threads, and
  // what would make this suite take seconds to tell us the same thing.
  eqs.slotsBusyBackoffMs = 10;
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

/** Every request of one action, in the order they were sent. */
function requestsFor(action: string) {
  return gateway.requests.filter((request) => request.action === action);
}

// -- queues ------------------------------------------------------------------------------------

describe("queues", () => {

  it("describes one queue the way a listing describes each", async () => {
    gateway.answer("eqs", "get-queue", {
      queue: {
        name: "orders",
        ern: QUEUE,
        owner: "jens",
        available: 7,
        delayed: 1,
        invisible: 2,
        visibility: 45,
        tags: { team: "fulfilment" },
      },
    });

    const queue = await eqs.getQueue("orders");

    assert.deepEqual(gateway.last().json(), { name: "orders" });
    assert.equal(queue.ern, QUEUE);
    assert.equal(queue.available, 7);
    assert.equal(queue.invisible, 2);
    assert.deepEqual(queue.tags, { team: "fulfilment" });
  });

  it("asks for a queue by ERN as well as by name", async () => {
    gateway.answer("eqs", "get-queue", { queue: { name: "orders", ern: QUEUE } });

    await eqs.getQueue(QUEUE);

    assert.deepEqual(gateway.last().json(), { ern: QUEUE });
  });

  it("asks for a message by id rather than by receipt handle", async () => {
    // A receipt handle is void once its delivery's claim expires; the id names the message for as
    // long as it exists, which is what asking about one after the fact needs.
    gateway.answer("eqs", "get-message", {
      message: { messageId: "m-1", queueErn: QUEUE, body: "hello", status: "AVAILABLE", receivedCount: 2 },
    });

    const message = await eqs.getMessage("m-1");

    assert.deepEqual(gateway.last().json(), { messageId: "m-1" });
    assert.equal(message.body, "hello");
    assert.equal(message.receivedCount, 2);
  });
  it("creates and lists them", async () => {
    gateway.answer("eqs", "create-queue", { name: "orders", ern: QUEUE });
    gateway.answer("eqs", "list-queues", {
      total: 2,
      queues: [
        {
          name: "orders",
          ern: QUEUE,
          owner: "jens",
          tags: { team: "sales" },
          size: 2048,
          available: 3,
          delayed: 1,
          invisible: 2,
          visibility: 60,
          maxMessageLength: 262144,
          maxReceiveCount: 5,
          deadLetterQueueArn: queueErn("orders-dlq"),
          priority: "MEDIUM",
          status: "AVAILABLE",
          created: "2026-01-01",
        },
        { name: "euclid-delivery", internal: true },
      ],
    });

    const created = await eqs.createQueue("orders", {
      visibility: 60,
      maxRetries: 5,
      maxMessageLength: 262144,
      dlqName: "orders-dlq",
      delay: 5,
      priority: PRIORITY_HIGH,
    });
    assert.deepEqual([created.name, created.ern], ["orders", QUEUE]);
    assert.deepEqual(gateway.last().json(), {
      name: "orders",
      visibility: 60,
      maxRetries: 5,
      maxMessageLength: 262144,
      dlqName: "orders-dlq",
      delay: 5,
      priority: "HIGH",
      internal: false,
    });

    const listed = await eqs.listQueues({ prefix: "or", pageSize: 25, includeInternal: true });
    assert.deepEqual(gateway.last().json(), {
      prefix: "or",
      pageSize: 25,
      pageIndex: 0,
      sortColumn: "name",
      sortDirection: "asc",
      includeInternal: true,
    });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map((queue) => queue.name), ["orders", "euclid-delivery"]);
    const queue = listed.items[0]!;
    assert.deepEqual([queue.available, queue.delayed, queue.invisible], [3, 1, 2]);
    assert.equal(queue.deadLetterQueueErn, queueErn("orders-dlq"));
    assert.deepEqual([queue.status, queue.internal], ["AVAILABLE", false]);
    assert.equal(listed.items[1]?.internal, true);
    // A field the server did not send reads as empty rather than throwing.
    assert.deepEqual(listed.items[1]?.tags, {});
    assert.equal(listed.items[1]?.visibility, 0);
  });

  it("answers with the ERN, the metadata and the tags", async () => {
    gateway.answer("eqs", "get-queue-ern", { name: "orders", ern: QUEUE });
    gateway.answer("eqs", "get-queue-metadata", {
      region: "eu-central-1",
      accountId: "000000000000",
      owner: "jens",
      nameSpace: "development",
      name: "orders",
      ern: QUEUE,
      size: 2048,
      messages: 6,
    });
    gateway.answer("eqs", "add-queue-tag", {});
    gateway.answer("eqs", "set-queue-tag", {});
    gateway.answer("eqs", "delete-queue-tag", {});

    assert.equal(await eqs.getQueueErn("orders"), QUEUE);
    assert.deepEqual(gateway.last().json(), { name: "orders" });

    const metadata = await eqs.getQueueMetadata(QUEUE);
    assert.deepEqual([metadata.namespace, metadata.messages, metadata.size], ["development", 6, 2048]);

    await eqs.addQueueTag(QUEUE, "team", "sales");
    assert.deepEqual(gateway.last().json(), { ern: QUEUE, key: "team", value: "sales" });
    await eqs.setQueueTag(QUEUE, "team", "ops");
    await eqs.deleteQueueTag(QUEUE, "team");
    assert.deepEqual(gateway.last().json(), { ern: QUEUE, key: "team" });
  });

  it("stops and starts one", async () => {
    gateway.answer("eqs", "stop-queue", { ern: QUEUE, status: "STOPPED", available: 4 });
    gateway.answer("eqs", "start-queue", { ern: QUEUE, status: "AVAILABLE", available: 4 });

    const stopped = await eqs.stopQueue(QUEUE);
    assert.deepEqual([stopped.status, stopped.available], ["STOPPED", 4]);
    assert.deepEqual(gateway.last().json(), { ern: QUEUE });

    assert.equal((await eqs.startQueue(QUEUE)).status, "AVAILABLE");
  });

  it("answers a changed visibility with the value it now has", async () => {
    gateway.answer("eqs", "set-queue-visibility", { ern: QUEUE, visibility: 120 });

    assert.equal(await eqs.setQueueVisibility(QUEUE, 120), 120);
    assert.deepEqual(gateway.last().json(), { ern: QUEUE, visibility: 120 });
  });

  it("changes how long a sent message is held back", async () => {
    // What is sent from here on: a message already waiting had its delay turned into a timestamp when it
    // arrived, and moving that would release it early or hold back one promised sooner.
    gateway.answer("eqs", "set-queue-delay", { ern: QUEUE, delay: 30 });

    const result = await eqs.setQueueDelay(QUEUE, 30);

    assert.deepEqual(gateway.last().json(), { ern: QUEUE, delay: 30 });
    assert.deepEqual([result.ern, result.delay], [QUEUE, 30]);
  });

  it("refuses a delay outside the bound before the round trip", async () => {
    // A quarter of an hour is the bound SQS holds DelaySeconds to: a delay smooths a burst, it does not
    // schedule.
    await assert.rejects(() => eqs.setQueueDelay(QUEUE, -1), /between 0 and 900/);
    await assert.rejects(() => eqs.setQueueDelay(QUEUE, MAX_QUEUE_DELAY + 1), /between 0 and 900/);

    assert.deepEqual(requestsFor("set-queue-delay"), []);
  });

  it("changes the largest message the queue accepts, and says what a send is measured against", async () => {
    gateway.answer("eqs", "set-queue-max-message-length", {
      ern: QUEUE,
      maxMessageLength: 262144,
      effectiveMaxMessageLength: 262144,
    });

    const result = await eqs.setQueueMaxMessageLength(QUEUE, 262144);

    assert.deepEqual(gateway.last().json(), { ern: QUEUE, maxMessageLength: 262144 });
    assert.deepEqual([result.maxMessageLength, result.effectiveMaxMessageLength], [262144, 262144]);
  });

  it("takes zero to mean no limit of the queue's own", async () => {
    // Not "accept nothing": such a queue is measured against the installation's figure instead, which is what
    // the second number in the answer is for.
    gateway.answer("eqs", "set-queue-max-message-length", {
      ern: QUEUE,
      maxMessageLength: 0,
      effectiveMaxMessageLength: 1048576,
    });

    const result = await eqs.setQueueMaxMessageLength(QUEUE, INSTALLATION_MAX_MESSAGE_LENGTH);

    assert.deepEqual(gateway.last().json(), { ern: QUEUE, maxMessageLength: 0 });
    assert.deepEqual([result.maxMessageLength, result.effectiveMaxMessageLength], [0, 1048576]);
  });

  it("refuses a negative message length before the round trip", async () => {
    await assert.rejects(() => eqs.setQueueMaxMessageLength(QUEUE, -1), /cannot be negative/);

    assert.deepEqual(requestsFor("set-queue-max-message-length"), []);
  });

  it("purges every namespace of the session's own account unless told otherwise", async () => {
    // An empty namespace is what the server reads as "all of them", and this call has emptied the account
    // since it existed - so narrowing it by default would quietly spare queues a caller meant to purge.
    gateway.answer("eqs", "purge-all-queues", {});

    await eqs.purgeAllQueues();

    assert.deepEqual(gateway.last().json(), {
      region: "eu-central-1",
      accountId: "000000000000",
      nameSpace: "",
    });
  });

  it("narrows a blanket purge to one namespace when asked", async () => {
    gateway.answer("eqs", "purge-all-queues", {});

    await eqs.purgeAllQueues({ namespace: "development", accountId: "111", region: "eu-west-1" });

    assert.deepEqual(gateway.last().json(), {
      region: "eu-west-1",
      accountId: "111",
      nameSpace: "development",
    });
  });

  it("redrives a dead letter queue", async () => {
    // What it moved, where it went, and what it left behind - which is not a failure: a message whose
    // origin was never recorded is left alone rather than guessed at.
    gateway.answer("eqs", "redrive-dlq", {
      ern: queueErn("orders-dlq"),
      messages: 7,
      remaining: 2,
      targets: [
        { queueErn: QUEUE, messages: 5 },
        { queueErn: queueErn("refunds"), messages: 2 },
      ],
      note: "Messages remain in the dead letter queue because no source queue is recorded for them.",
    });

    const result = await eqs.redriveDlq(queueErn("orders-dlq"));

    assert.deepEqual(gateway.last().json(), { ern: queueErn("orders-dlq"), targetErn: "" });
    assert.deepEqual([result.messages, result.remaining], [7, 2]);
    assert.deepEqual(
      result.targets.map((target) => [target.queueErn, target.messages]),
      [[QUEUE, 5], [queueErn("refunds"), 2]],
    );
    assert.ok(result.note.startsWith("Messages remain"));
  });
});

// -- messages ------------------------------------------------------------------------------------

describe("messages", () => {
  it("sends, receives and deletes one", async () => {
    const messageId = await eqs.sendMessage(QUEUE, '{"order": 17}', {
      attributes: { tenant: "acme", retries: 3 },
      priority: PRIORITY_HIGH,
    });

    assert.equal(messageId, "message-1");
    assert.deepEqual(gateway.last().json(), {
      ern: QUEUE,
      body: '{"order": 17}',
      priority: "HIGH",
      attributes: { tenant: { type: "string", value: "acme" }, retries: { type: "long", value: 3 } },
    });

    const received = await eqs.receiveMessages(QUEUE);
    assert.deepEqual(received.items.map((message) => message.body), ['{"order": 17}']);
    const message = received.items[0]!;
    assert.ok(message.receiptHandle);
    assert.equal(message.receivedCount, 1);
    assert.deepEqual(message.attributes["tenant"], { type: "string", value: "acme" });

    // The lease is what makes a second consumer see nothing while the first is still working.
    assert.deepEqual((await eqs.receiveMessages(QUEUE)).items, []);

    await eqs.deleteMessage(message.receiptHandle);
    assert.equal((await eqs.getMessageCount(QUEUE)).total, 0);
  });

  it("sends the envelope separately from the sender's attributes", async () => {
    await eqs.sendMessage(QUEUE, "body", {
      attributes: { tenant: "acme" },
      systemAttributes: { priority: "LOW", origin: "esm" },
    });

    assert.deepEqual(gateway.last().json()["attributes"], { tenant: { type: "string", value: "acme" } });
    assert.deepEqual(gateway.last().json()["systemAttributes"], {
      priority: { type: "string", value: "LOW" },
      origin: { type: "string", value: "esm" },
    });
  });

  it("carries the server's reason for a message the queue will not take", async () => {
    // Measured on the body alone - the same number `size` reports - so attributes travel alongside it rather
    // than against the limit.
    gateway.answer("eqs", "send-message", { error: "message is 2048 bytes, and this queue accepts 1024" }, 400);

    await assert.rejects(
      () => eqs.sendMessage(QUEUE, "x".repeat(2048)),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["eqs", "send-message", 400]);
        assert.ok(error.reason.startsWith("message is 2048 bytes"));
        return true;
      },
    );
  });

  it("says nothing about what it has nothing to say about", async () => {
    // No priority and no envelope: the fields are left out rather than sent empty, so the queue's own
    // default is what applies.
    await eqs.sendMessage(QUEUE, "body");

    assert.deepEqual(gateway.last().json(), { ern: QUEUE, body: "body", attributes: {} });
  });

  it("deletes a message nobody received", async () => {
    // By ID rather than by receipt handle - a euclid extension, and the only way to remove a message
    // nobody has taken.
    const messageId = await eqs.sendMessage(QUEUE, "body");

    await eqs.deleteMessageById(messageId);

    assert.deepEqual(gateway.last().json(), { messageId });
    assert.equal((await eqs.getMessageCount(QUEUE)).total, 0);
  });

  it("lists them without leasing them", async () => {
    await eqs.sendMessage(QUEUE, "body");

    const listed = await eqs.listMessages(QUEUE, { pageSize: 50, sortDirection: "desc" });

    assert.deepEqual(gateway.last().json(), {
      queueErn: QUEUE,
      pageSize: 50,
      pageIndex: 0,
      sortColumn: "created",
      sortDirection: "desc",
    });
    assert.deepEqual(listed.items.map((message) => message.body), ["body"]);
    // Still there to be received, which is the whole difference between listing and receiving.
    assert.equal((await eqs.getMessageCount(QUEUE)).available, 1);
  });

  it("drains a queue in batches", async () => {
    for (let index = 0; index < 5; index += 1) await eqs.sendMessage(QUEUE, "body");

    const messages = await eqs.receiveAllMessages(QUEUE, 2);

    assert.equal(messages.length, 5);
    assert.equal(new Set(messages.map((message) => message.receiptHandle)).size, 5);
  });

  it("reads a message's metadata and extends its lease", async () => {
    gateway.answer("eqs", "get-message-metadata", {
      messageId: "message-1",
      queueErn: QUEUE,
      receiptHandle: "receipt-1",
      status: "INVISIBLE",
      priority: "MEDIUM",
      size: 13,
      receivedCount: 2,
      visibilityTimeout: 30,
      contentType: "application/json",
    });
    gateway.answer("eqs", "set-message-visibility", {});

    const metadata = await eqs.getMessageMetadata("message-1");
    assert.deepEqual([metadata.receivedCount, metadata.visibilityTimeout, metadata.status], [2, 30, "INVISIBLE"]);

    await eqs.setMessageVisibility("message-1", 120);
    assert.equal(gateway.last().action, "set-message-visibility");
    assert.deepEqual(gateway.last().json(), { messageId: "message-1", visibility: 120 });
  });

  it("types attributes and keeps the server's own field names", async () => {
    // `name` on the way in, `key` on the way out: the server's asymmetry, reproduced rather than
    // papered over.
    gateway.answer("eqs", "get-message-attribute", {
      messageId: "message-1",
      name: "tenant",
      value: { type: "string", value: "acme" },
    });
    gateway.answer("eqs", "set-message-attribute", {
      messageId: "message-1",
      name: "retries",
      value: { type: "long", value: 3 },
    });

    const attribute = await eqs.getMessageAttribute("message-1", "tenant");
    assert.deepEqual(gateway.last().json(), { messageId: "message-1", name: "tenant" });
    assert.deepEqual(attribute.value, { type: "string", value: "acme" });

    const updated = await eqs.setMessageAttribute("message-1", "retries", 3);
    assert.deepEqual(gateway.last().json(), {
      messageId: "message-1",
      key: "retries",
      value: { type: "long", value: 3 },
    });
    assert.deepEqual(updated.value, { type: "long", value: 3 });
  });
});

// -- long polling ----------------------------------------------------------------------------------

describe("long polling", () => {
  it("costs no receive at all on an empty queue", async () => {
    // A receive is a write; one that takes nothing is work the server did for nothing, so with no wait
    // asked for the depth is checked first.
    assert.deepEqual((await eqs.receiveMessages(QUEUE)).items, []);

    assert.deepEqual(
      gateway.requests.filter((request) => request.target === "eqs").map((request) => request.action),
      ["get-message-count"],
    );
  });

  it("is one request when the server honours the wait", async () => {
    const result = await eqs.receiveMessages(QUEUE, { waitTimeSeconds: 1 });

    assert.deepEqual(result.items, []);
    assert.deepEqual(queues.waits, [1]);
    assert.equal(requestsFor("receive-messages").length, 1);
  });

  it("asks again when the server declines to wait", async () => {
    // With no slot free the server answers at once rather than waiting, which comes back empty with time
    // still on the clock. The answer is to pause and ask again - asking again immediately is what a
    // server short of threads does not need.
    queues.declineWaits = 2;
    await eqs.sendMessage(QUEUE, "body");

    const result = await eqs.receiveMessages(QUEUE, { waitTimeSeconds: 5 });

    assert.deepEqual(result.items.map((message) => message.body), ["body"]);
    assert.equal(queues.waits.length, 3);
    // Each attempt asks for what is left of the caller's window, not for the whole of it again.
    assert.equal(queues.waits[0], 5);
    assert.ok(queues.waits.at(-1)! <= 5);
  });

  it("outlives the session's ordinary timeout", async () => {
    // The request is meant to take as long as the server was asked to hold it, so it gets its own
    // deadline; the client-wide one is sized for an answer that comes straight back.
    const impatient = await Euclid.forServer(gateway.baseUrl).login("jens", "secret", { timeoutMs: 300 });
    queues.maxHoldMs = 1000;
    try {
      // Held for a second, which is more than three times the timeout every other call gets.
      assert.deepEqual((await impatient.eqs().receiveMessages(QUEUE, { waitTimeSeconds: 2 })).items, []);
    } finally {
      impatient.close();
    }
  });
});

// -- everything else --------------------------------------------------------------------------------

describe("how EQS authenticates", () => {
  it("marks internal traffic as such", async () => {
    // The same get-message-count is a user's question one moment and a metric collector's poll the next,
    // so the caller says which it is rather than the server guessing from a rate.
    const internal = eqs.asInternal();

    await internal.getMessageCount(QUEUE);
    assert.equal(gateway.last().headers["x-euclid-internal"], "true");

    // The view is separate, so nothing has to remember to set the flag back.
    await eqs.getMessageCount(QUEUE);
    assert.equal(gateway.last().headers["x-euclid-internal"], undefined);
  });

  it("signs its own target and follows the session", async () => {
    gateway.answer("eam", "change-namespace", {});

    await eqs.getMessageCount(QUEUE);
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "eqs");
    assert.equal(gateway.last().headers["x-euclid-namespace"], undefined);

    await session.changeNamespace("development");
    await eqs.getMessageCount(QUEUE);
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.equal(session.eqs(), eqs);
  });

  it("carries the server's reason when a call is refused", async () => {
    gateway.answer("eqs", "receive-messages", { error: `Queue is stopped, ern: ${QUEUE}` }, 409);

    await assert.rejects(
      () => eqs.receiveMessages(QUEUE, { waitTimeSeconds: 1 }),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["eqs", "receive-messages", 409]);
        assert.ok(error.reason.startsWith("Queue is stopped"));
        return true;
      },
    );
  });

  it("reaches an action this SDK does not wrap, and its metrics", async () => {
    gateway.answer("eqs", "get-metrics", { items: [{ name: "eqs-messages", value: 3 }] });
    gateway.answer("eqs", "some-future-action", { ok: true });

    assert.deepEqual(await eqs.metrics(), { items: [{ name: "eqs-messages", value: 3 }] });
    assert.deepEqual(await eqs.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });
});
