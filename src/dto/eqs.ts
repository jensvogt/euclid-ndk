/**
 * The shapes EQS sends back.
 *
 * Parsed the same defensive way as every other module's - see {@link import("./json.js")}. Field names
 * are the server's (`dto/include/euclid/dto/eqs`), converted to camelCase where they differ.
 *
 * Everything about a message is prefixed `Queue` here, because ENS has the same words for different
 * things: a topic's message has no receipt handle and no visibility, since nothing leases it. The
 * server keeps the two apart, so this does too.
 */

import { toVariant, toVariantMap, type Variant } from "./com.js";
import { documents, flag, number, object, stringMap, text } from "./json.js";

// -- resources -----------------------------------------------------------------------------------

/**
 * A queue, and the counters that say what is in it.
 *
 * The three counts are the states a message can be in: `available` is waiting to be received,
 * `invisible` is out with a consumer whose visibility timeout has not expired, and `delayed` is not
 * yet due. They are what a consumer's backlog actually looks like - `size` is bytes.
 */
export interface Queue {
  name: string;
  owner: string;
  ern: string;
  tags: Record<string, string>;
  size: number;
  delay: number;
  available: number;
  delayed: number;
  invisible: number;
  visibility: number;
  maxMessageLength: number;
  maxReceiveCount: number;
  /**
   * The dead letter queue messages go to once they have been received `maxReceiveCount` times. Sent as
   * `deadLetterQueueArn` - an "arn" the server has never renamed.
   */
  deadLetterQueueErn: string;
  priority: string;
  /**
   * `AVAILABLE` or `STOPPED`; a stopped queue hands nothing out - see
   * {@link import("../modules/eqs.js").EuclidEqs.stopQueue}.
   */
  status: string;
  /** One of euclid's own queues rather than somebody's. Left out of a listing unless asked for. */
  internal: boolean;
  created: string;
  modified: string;
}

/**
 * One message on a queue.
 *
 * `receiptHandle` is the lease a receive hands out: it is what
 * {@link import("../modules/eqs.js").EuclidEqs.deleteMessage} takes, and it stops working once the
 * visibility timeout expires and the message goes back on the queue.
 *
 * Two attribute maps, as everywhere in euclid: `attributes` are the sender's own, and
 * `systemAttributes` are euclid's envelope, which is how a message that has hopped through a bucket or
 * a topic still carries what it was sent with.
 */
export interface QueueMessage {
  ern: string;
  queueErn: string;
  messageId: string;
  status: string;
  priority: string;
  body: string;
  receiptHandle: string;
  size: number;
  receivedCount: number;
  contentType: string;
  attributes: Record<string, Variant>;
  systemAttributes: Record<string, Variant>;
  lastReceived: string;
  created: string;
  modified: string;
}

/** One attribute of one message, as the server stored it. */
export interface QueueMessageAttribute {
  messageId: string;
  name: string;
  value: Variant;
}

// -- what the actions answer with ------------------------------------------------------------------

/** A newly created queue: its name, and the ERN everything else names it by. */
export interface CreateQueueResult {
  name: string;
  ern: string;
}

/** Where a queue lives and how much is in it. */
export interface QueueMetadata {
  region: string;
  accountId: string;
  owner: string;
  namespace: string;
  name: string;
  ern: string;
  size: number;
  messages: number;
}

/** How many messages a queue holds, by the state they are in. */
export interface QueueMessageCount {
  ern: string;
  available: number;
  delayed: number;
  invisible: number;
  total: number;
}

/**
 * Everything about one message except its body.
 *
 * `receivedCount` against the queue's `maxReceiveCount` is what decides when a message is moved to the
 * dead letter queue, so this is where a message that keeps coming back explains itself.
 */
export interface QueueMessageMetadata {
  messageId: string;
  queueErn: string;
  receiptHandle: string;
  status: string;
  priority: string;
  size: number;
  receivedCount: number;
  visibilityTimeout: number;
  contentType: string;
  created: string;
  modified: string;
}

/** A queue's delay after setting it, in seconds. What it holds back is sent from then on, not before. */
export interface QueueDelayResult {
  ern: string;
  delay: number;
}

/**
 * A queue's message-size limit after setting it, in bytes.
 *
 * Two numbers because zero is a value: `maxMessageLength` is what the queue now holds, and
 * `effectiveMaxMessageLength` is what a send is actually measured against - the installation's figure when
 * the queue carries no limit of its own.
 */
export interface QueueMaxMessageLengthResult {
  ern: string;
  maxMessageLength: number;
  effectiveMaxMessageLength: number;
}

/** A queue's status after starting or stopping it, and how many messages are waiting on it. */
export interface QueueStatusResult {
  ern: string;
  status: string;
  available: number;
}

/** One queue a redrive put messages back on, and how many went there. */
export interface RedriveTarget {
  queueErn: string;
  messages: number;
}

/**
 * What a redrive moved, where it went, and what it left behind.
 *
 * `remaining` is not a failure: several queues can share a dead letter queue, and a message that
 * predates the recording of its origin has no answer to the question of where it came from. It is left
 * alone rather than guessed at, and `note` is the server saying so.
 */
export interface RedriveDlqResult {
  ern: string;
  messages: number;
  remaining: number;
  targets: RedriveTarget[];
  note: string;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toQueue(document: unknown): Queue {
  return {
    name: text(document, "name"),
    owner: text(document, "owner"),
    ern: text(document, "ern"),
    tags: stringMap(document, "tags"),
    size: number(document, "size"),
    delay: number(document, "delay"),
    available: number(document, "available"),
    delayed: number(document, "delayed"),
    invisible: number(document, "invisible"),
    visibility: number(document, "visibility"),
    maxMessageLength: number(document, "maxMessageLength"),
    maxReceiveCount: number(document, "maxReceiveCount"),
    deadLetterQueueErn: text(document, "deadLetterQueueArn"),
    priority: text(document, "priority"),
    status: text(document, "status"),
    internal: flag(document, "internal"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toQueueMessage(document: unknown): QueueMessage {
  return {
    ern: text(document, "ern"),
    queueErn: text(document, "queueErn"),
    messageId: text(document, "messageId"),
    status: text(document, "status"),
    priority: text(document, "priority"),
    body: text(document, "body"),
    receiptHandle: text(document, "receiptHandle"),
    size: number(document, "size"),
    receivedCount: number(document, "receivedCount"),
    contentType: text(document, "contentType"),
    attributes: toVariantMap(object(document)["attributes"]),
    systemAttributes: toVariantMap(object(document)["systemAttributes"]),
    lastReceived: text(document, "lastReceived"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toQueueMessageAttribute(document: unknown): QueueMessageAttribute {
  return {
    messageId: text(document, "messageId"),
    name: text(document, "name"),
    value: toVariant(object(document)["value"]),
  };
}

export function toCreateQueueResult(document: unknown): CreateQueueResult {
  return { name: text(document, "name"), ern: text(document, "ern") };
}

export function toQueueMetadata(document: unknown): QueueMetadata {
  return {
    region: text(document, "region"),
    accountId: text(document, "accountId"),
    owner: text(document, "owner"),
    namespace: text(document, "nameSpace"),
    name: text(document, "name"),
    ern: text(document, "ern"),
    size: number(document, "size"),
    messages: number(document, "messages"),
  };
}

export function toQueueMessageCount(document: unknown): QueueMessageCount {
  return {
    ern: text(document, "ern"),
    available: number(document, "available"),
    delayed: number(document, "delayed"),
    invisible: number(document, "invisible"),
    total: number(document, "total"),
  };
}

export function toQueueMessageMetadata(document: unknown): QueueMessageMetadata {
  return {
    messageId: text(document, "messageId"),
    queueErn: text(document, "queueErn"),
    receiptHandle: text(document, "receiptHandle"),
    status: text(document, "status"),
    priority: text(document, "priority"),
    size: number(document, "size"),
    receivedCount: number(document, "receivedCount"),
    visibilityTimeout: number(document, "visibilityTimeout"),
    contentType: text(document, "contentType"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toQueueDelayResult(document: unknown): QueueDelayResult {
  return { ern: text(document, "ern"), delay: number(document, "delay") };
}

export function toQueueMaxMessageLengthResult(document: unknown): QueueMaxMessageLengthResult {
  return {
    ern: text(document, "ern"),
    maxMessageLength: number(document, "maxMessageLength"),
    effectiveMaxMessageLength: number(document, "effectiveMaxMessageLength"),
  };
}

export function toQueueStatusResult(document: unknown): QueueStatusResult {
  return {
    ern: text(document, "ern"),
    status: text(document, "status"),
    available: number(document, "available"),
  };
}

export function toRedriveTarget(document: unknown): RedriveTarget {
  return { queueErn: text(document, "queueErn"), messages: number(document, "messages") };
}

export function toRedriveDlqResult(document: unknown): RedriveDlqResult {
  return {
    ern: text(document, "ern"),
    messages: number(document, "messages"),
    remaining: number(document, "remaining"),
    targets: documents(document, "targets").map(toRedriveTarget),
    note: text(document, "note"),
  };
}
