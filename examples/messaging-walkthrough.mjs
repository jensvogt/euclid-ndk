#!/usr/bin/env node
/**
 * EQS and ENS end to end: a topic, a queue subscribed to it, and a message that travels.
 *
 *   npm run build
 *   node examples/messaging-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Works in a queue and a topic of its own, named after the moment it started, and deletes both again at
 * the end - so it is safe to point at a running server, and a run that dies halfway leaves two obviously
 * disposable resources behind rather than touching anything of yours.
 */

import { Euclid, EuclidAuthenticationError, PRIORITY_HIGH } from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/messaging-walkthrough.mjs <url> <username> <password>");
  process.exit(2);
}

let session;
try {
  session = await Euclid.forServer(baseUrl)
    .access()
    .credentials(username, password)
    // A development server's certificate is usually its own; drop this line, or point caCertPath() at
    // the real CA, anywhere it matters.
    .verify(false)
    .login();
} catch (error) {
  if (error instanceof EuclidAuthenticationError) {
    console.error(`login refused: ${error.reason || error.message}`);
    process.exit(1);
  }
  throw error;
}

const eqs = session.eqs();
const ens = session.ens();
const name = `ndk-walkthrough-${Math.floor(Date.now() / 1000)}`;

try {
  const queue = await eqs.createQueue(name, { visibility: 30 });
  const topic = await ens.createTopic(name);
  console.log(`created queue ${queue.name}\n  ${queue.ern}`);
  console.log(`created topic ${topic.name}\n  ${topic.ern}`);

  try {
    await walk(eqs, ens, queue.ern, topic.ern);
  } finally {
    await ens.deleteTopic(topic.ern);
    await eqs.purgeQueue(queue.ern);
    await eqs.deleteQueue(queue.ern);
    console.log(`\ndeleted queue and topic ${name} again`);
  }
} finally {
  session.close();
}

/** Everything between creating the two and deleting them. */
async function walk(eqs, ens, queueErn, topicErn) {
  // Sent straight to the queue: one message, one consumer, and the lease below is what makes it exactly
  // one.
  const messageId = await eqs.sendMessage(queueErn, JSON.stringify({ order: 17 }), {
    attributes: { tenant: "acme" },
    priority: PRIORITY_HIGH,
  });
  console.log(`\nsent    ${messageId} to the queue`);

  // Published to the topic instead, which delivers a copy to every subscription on it.
  const subscription = await ens.subscribe(topicErn, queueErn);
  console.log(`subscribed the queue to the topic as ${subscription.ern}`);
  await ens.publishMessage(topicErn, JSON.stringify({ order: 18 }), { attributes: { tenant: "acme" } });
  console.log("published one message to the topic, which delivers it to the queue");

  const counts = await eqs.getMessageCount(queueErn);
  console.log(
    `\nqueue holds ${counts.total}: ${counts.available} available, ${counts.delayed} delayed, ` +
      `${counts.invisible} in flight`,
  );

  // A long poll: the server holds this open until something lands or the window runs out, so the delivery
  // from the topic is waited for rather than polled for.
  const received = await eqs.receiveMessages(queueErn, { maxMessages: 10, waitTimeSeconds: 10 });
  console.log(`\nreceived ${received.items.length} message(s):`);
  for (const message of received.items) {
    const attributes = Object.fromEntries(
      Object.entries(message.attributes).map(([key, variant]) => [key, variant.value]),
    );
    console.log(`  ${message.messageId.padEnd(38)} ${message.priority.padEnd(7)} ${message.body}`);
    console.log(`      attributes: ${JSON.stringify(attributes)}`);
    // After the work, not before: a consumer that dies instead simply stops holding the lease, and the
    // message comes back for somebody else.
    await eqs.deleteMessage(message.receiptHandle);
    console.log("      deleted with its receipt handle");
  }

  // Holding delivery: a stopped topic still accepts what is published to it, which is what makes this a way
  // of pausing a subscriber rather than a way of losing messages.
  const stopped = await ens.stopTopic(topicErn);
  console.log(`\nstopped the topic: status ${stopped.status}`);
  await ens.publishMessage(topicErn, JSON.stringify({ order: 19 }));
  await ens.publishMessage(topicErn, JSON.stringify({ order: 20 }));
  const waiting = await ens.getTopicMetadata(topicErn);
  console.log(`  published 2 more: ${waiting.held} message(s) held, nothing on the queue yet`);

  // The fan-out happens inside this call, oldest first, and `released` is what went.
  const restarted = await ens.startTopic(topicErn);
  console.log(`started it again: status ${restarted.status}, released ${restarted.released} held message(s)`);
  console.log(`  queue now holds ${(await eqs.getMessageCount(queueErn)).available} available message(s)`);

  // Worth setting on any topic that is published to regularly: a topic is fanned out at publish time, so
  // nothing else ever removes what it keeps.
  const retention = await ens.setTopicRetention(topicErn, 7 * 24 * 60 * 60);
  console.log(`\nretention set to ${retention.retentionPeriod}s - applies to what is published from now on`);

  console.log(`\ntopic counters: ${JSON.stringify(await ens.getMessageCount(topicErn))}`);
  const subscriptions = await ens.listSubscriptions(topicErn);
  console.log(`subscriptions:  ${JSON.stringify(subscriptions.map((entry) => entry.targetErn))}`);

  await ens.unsubscribe(subscription.ern);
  console.log(`unsubscribed ${subscription.ern}`);

  console.log(`\nqueue now holds ${(await eqs.getMessageCount(queueErn)).total} message(s)`);
}
