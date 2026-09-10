/**
 * The shapes ENS sends back.
 *
 * Parsed the same defensive way as every other module's. Where a type here looks like one in
 * {@link import("./eqs.js")}, it is not the same type: a topic's message has no receipt handle and no
 * visibility, because nothing leases it - it is delivered to the topic's subscribers and kept as a
 * record of that. The server keeps them apart for the same reason, so this does too.
 *
 * A subscription is the exception, and lives in {@link import("./com.js")}: ENS and ESM describe one
 * the same way.
 */

import { toVariant, toVariantMap, type Variant } from "./com.js";
import { number, object, stringMap, text } from "./json.js";

// -- resources -----------------------------------------------------------------------------------

/** A topic: what a publisher publishes to, and what subscriptions hang off. */
export interface Topic {
  name: string;
  owner: string;
  ern: string;
  tags: Record<string, string>;
  size: number;
  messages: number;
  maxMessageLength: number;
  created: string;
  modified: string;
}

/** One message published to a topic. */
export interface TopicMessage {
  ern: string;
  topicErn: string;
  messageId: string;
  status: string;
  body: string;
  contentType: string;
  attributes: Record<string, Variant>;
  lastReceived: string;
  created: string;
  modified: string;
}

/**
 * One attribute of one published message.
 *
 * The wire field is `key` here and `name` in EQS - the same thing under two names, which this SDK
 * reproduces rather than papers over, so that a request built from this documentation matches what the
 * server and euclid-cli exchange.
 */
export interface TopicMessageAttribute {
  messageId: string;
  key: string;
  value: Variant;
}

// -- what the actions answer with ------------------------------------------------------------------

/** A newly created topic: its name, and the ERN everything else names it by. */
export interface CreateTopicResult {
  name: string;
  ern: string;
}

/** Where a topic lives and how much has been published to it. */
export interface TopicMetadata {
  region: string;
  accountId: string;
  owner: string;
  namespace: string;
  name: string;
  ern: string;
  size: number;
  messages: number;
}

/**
 * A topic's message counters - the server's own three, which are not a queue's.
 *
 * A topic does not hold a backlog the way a queue does, so these count delivery rather than state: what
 * is on the topic, what has gone out to subscribers, and what had to go out again.
 */
export interface TopicMessageCount {
  ern: string;
  available: number;
  send: number;
  resend: number;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toTopic(document: unknown): Topic {
  return {
    name: text(document, "name"),
    owner: text(document, "owner"),
    ern: text(document, "ern"),
    tags: stringMap(document, "tags"),
    size: number(document, "size"),
    messages: number(document, "messages"),
    maxMessageLength: number(document, "maxMessageLength"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toTopicMessage(document: unknown): TopicMessage {
  return {
    ern: text(document, "ern"),
    topicErn: text(document, "topicErn"),
    messageId: text(document, "messageId"),
    status: text(document, "status"),
    body: text(document, "body"),
    contentType: text(document, "contentType"),
    attributes: toVariantMap(object(document)["attributes"]),
    lastReceived: text(document, "lastReceived"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toTopicMessageAttribute(document: unknown): TopicMessageAttribute {
  return {
    messageId: text(document, "messageId"),
    key: text(document, "key"),
    value: toVariant(object(document)["value"]),
  };
}

export function toCreateTopicResult(document: unknown): CreateTopicResult {
  return { name: text(document, "name"), ern: text(document, "ern") };
}

export function toTopicMetadata(document: unknown): TopicMetadata {
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

export function toTopicMessageCount(document: unknown): TopicMessageCount {
  return {
    ern: text(document, "ern"),
    available: number(document, "available"),
    send: number(document, "send"),
    resend: number(document, "resend"),
  };
}
