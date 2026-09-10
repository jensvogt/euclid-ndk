/**
 * ENS - euclid's notification module: topics, published messages, and the subscriptions that deliver
 * them onward.
 *
 * One object, {@link EuclidEns}, built from a session that has already logged in:
 *
 * ```ts
 * const ens = session.ens();
 * const topic = await ens.createTopic("order-events");
 *
 * await ens.subscribe(topic.ern, await session.eqs().getQueueErn("orders"));
 * await ens.publishMessage(topic.ern, JSON.stringify({ order: 17 }));
 * ```
 *
 * The difference from EQS is what happens to a message once it is there. A queue holds a message until
 * a consumer takes it; a topic hands each message to every subscriber and keeps it as a record of having
 * done so. So there is no receive here, and no receipt handle: a subscriber consumes from its own queue,
 * which is where the message was delivered.
 *
 * Two things about a topic can be changed while it is in service. {@link EuclidEns.stopTopic} holds delivery
 * without refusing publishers - what arrives meanwhile is kept and fanned out when the topic is started
 * again - which is what a subscriber being redeployed asks for. And {@link EuclidEns.setTopicRetention} says
 * how long a published message is kept at all, since a topic is fanned out at publish time and nothing else
 * would ever remove it.
 */

import {
  QUEUE,
  toSubscribeResult,
  toSubscription,
  variantMapToJson,
  variantOf,
  variantToJson,
  type SubscribeResult,
  type Subscription,
  type VariantInput,
} from "../dto/com.js";
import { toPage, type Page } from "../dto/eam.js";
import {
  toCreateTopicResult,
  toTopic,
  toTopicMessage,
  toTopicMessageAttribute,
  toTopicMessageCount,
  toTopicMetadata,
  toTopicRetentionResult,
  toTopicStateResult,
  type CreateTopicResult,
  type Topic,
  type TopicMessage,
  type TopicMessageAttribute,
  type TopicMessageCount,
  type TopicMetadata,
  type TopicRetentionResult,
  type TopicStateResult,
} from "../dto/ens.js";
import { listPayload, ModuleClient, pagePayload, type ListOptions, type PageOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ens";

/** The largest message a topic accepts, in bytes. */
export const DEFAULT_MAX_MESSAGE_LENGTH = 1024 * 1024;

/** What a topic's `status` reads as: delivering what is published to it... */
export const TOPIC_RUNNING = "RUNNING";
/** ...or holding it until somebody starts the topic again. */
export const TOPIC_STOPPED = "STOPPED";

/**
 * The retention period that means "whatever the installation says", rather than a number of seconds of this
 * topic's own - see {@link EuclidEns.setTopicRetention}.
 */
export const INSTALLATION_RETENTION = 0;

/** What a published message carries besides its body. */
export interface PublishMessageOptions {
  /** The publisher's own attributes, which travel onto the queues the message is delivered to. */
  attributes?: Record<string, VariantInput>;
  /** `LOW`, `MIDDLE` or `HIGH`; left empty, the topic's own default applies. */
  priority?: string;
}

/** Which account's topics a blanket purge applies to. All three default to the session's own. */
export interface PurgeAllTopicsOptions {
  region?: string;
  accountId?: string;
  namespace?: string;
}

/**
 * ENS's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.ens} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEns extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  // -- topics ----------------------------------------------------------------------------------

  /** Creates a topic, and answers with the ERN everything else names it by. */
  async createTopic(name: string, maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH): Promise<CreateTopicResult> {
    return toCreateTopicResult(await this.call("create-topic", { name, maxMessageLength }));
  }

  /** Deletes a topic, its messages and its subscriptions. */
  async deleteTopic(ern: string): Promise<void> {
    await this.call("delete-topic", { ern });
  }

  /** One page of topics, and how many exist in total. */
  async listTopics(options: ListOptions = {}): Promise<Page<Topic>> {
    return toPage(await this.call("list-topics", listPayload(options, "name")), "topics", toTopic);
  }

  /** The ERN of the topic of this name, in the session's account and namespace. */
  async getTopicErn(name: string): Promise<string> {
    return this.textOf("get-topic-ern", { name }, "ern");
  }

  /**
   * Where a topic lives, how much has been published to it, and whether it is delivering.
   *
   * `held` is the useful half of a stopped topic: it says how much has piled up waiting for
   * {@link startTopic}, which is what decides whether starting it is a moment's work or a fan-out of a
   * fortnight's traffic.
   */
  async getTopicMetadata(ern: string): Promise<TopicMetadata> {
    return toTopicMetadata(await this.call("get-topic-metadata", { ern }));
  }

  /**
   * Stops a topic delivering, without stopping it accepting.
   *
   * A stopped topic still takes what is published to it and stores it - it simply does not fan it out. That
   * is the point: a subscriber being redeployed, or a downstream system taken down for the evening, is a
   * reason to hold delivery rather than to lose what arrives meanwhile. Those messages are kept and
   * delivered oldest first when {@link startTopic} runs.
   *
   * Nothing already delivered is affected: a message on a subscriber's queue belongs to that queue, and this
   * is about what happens next.
   */
  async stopTopic(ern: string): Promise<TopicStateResult> {
    return toTopicStateResult(await this.call("stop-topic", { ern }));
  }

  /**
   * Starts a topic delivering again, and hands its subscribers everything it held.
   *
   * The backlog goes out oldest first as part of this call, so a topic that collected a fortnight of traffic
   * is a fortnight of fan-out here - the result's `released` says how many messages went. The server works a
   * page at a time and marks each message as it goes, so a start that is interrupted has delivered a prefix
   * rather than nothing, and running it again picks up where it stopped.
   *
   * Starting a topic that was never stopped is not an error: there is nothing held, nothing is released, and
   * the status simply reads {@link TOPIC_RUNNING}.
   */
  async startTopic(ern: string): Promise<TopicStateResult> {
    return toTopicStateResult(await this.call("start-topic", { ern }));
  }

  /**
   * Sets how long a message published to this topic is kept, in seconds.
   *
   * Worth setting. A topic is fanned out at publish time, so nothing ever consumes its messages and nothing
   * else removes them: without a retention period the collection only grows, and because every topic shares
   * it, one busy topic is paid for by every publish in the installation.
   *
   * The change applies to messages published afterwards; the ones already stored keep the expiry they were
   * given, since that is stamped on each message rather than looked up when it is read.
   *
   * @param retentionPeriod seconds, or {@link INSTALLATION_RETENTION} to follow
   *   `euclid.modules.ens.retention-period` as it changes rather than freezing a copy of what it says today.
   * @throws {Error} if the period is negative, which the server refuses anyway - this just says so before the
   *   round trip.
   */
  async setTopicRetention(ern: string, retentionPeriod: number): Promise<TopicRetentionResult> {
    if (retentionPeriod < 0) {
      throw new Error("retentionPeriod cannot be negative; zero follows the installation default");
    }
    return toTopicRetentionResult(await this.call("set-topic-retention", { ern, retentionPeriod }));
  }

  /**
   * Deletes every message a topic has kept, leaving the topic and its subscriptions in place.
   *
   * It does not un-deliver anything: a message already handed to a subscriber is on that subscriber's
   * queue and belongs to it now.
   */
  async purgeTopic(ern: string): Promise<void> {
    await this.call("purge-topic", { ern });
  }

  /**
   * Purges every topic of an account, which defaults to this session's own.
   *
   * As blunt as it sounds, and there is no undo: it exists for a test environment between runs.
   */
  async purgeAllTopics(options: PurgeAllTopicsOptions = {}): Promise<void> {
    await this.call("purge-all-topics", {
      region: options.region || this.session.region,
      accountId: options.accountId || this.session.accountId,
      nameSpace: options.namespace || this.session.namespace,
    });
  }

  /** Tags a topic. */
  async addTopicTag(ern: string, key: string, value: string): Promise<void> {
    await this.call("add-topic-tag", { ern, key, value });
  }

  /** Sets the value of a tag the topic already has. */
  async setTopicTag(ern: string, key: string, value: string): Promise<void> {
    await this.call("set-topic-tag", { ern, key, value });
  }

  /** Removes a tag from a topic. */
  async deleteTopicTag(ern: string, key: string): Promise<void> {
    await this.call("delete-topic-tag", { ern, key });
  }

  // -- messages --------------------------------------------------------------------------------

  /**
   * Publishes a message to a topic, and answers with the ID the server gave it.
   *
   * Every subscription on the topic gets a copy, each on its own queue and each consumed independently:
   * a subscriber that is slow or stopped delays nobody else, and a message already delivered is not
   * withdrawn if the subscription is later removed.
   */
  async publishMessage(topicErn: string, body: string, options: PublishMessageOptions = {}): Promise<string> {
    const payload: Record<string, unknown> = {
      ern: topicErn,
      body,
      attributes: variantMapToJson(options.attributes),
    };
    if (options.priority) payload["priority"] = options.priority;
    return this.textOf("publish-message", payload, "messageId");
  }

  /** One page of the messages a topic has kept, and how many it holds in total. */
  async listMessages(topicErn: string, options: PageOptions = {}): Promise<Page<TopicMessage>> {
    const payload = { topicErn, ...pagePayload(options, "created") };
    return toPage(await this.call("list-messages", payload), "messages", toTopicMessage);
  }

  /** A topic's message counters: what is on it, what went out, and what had to go out again. */
  async getMessageCount(ern: string): Promise<TopicMessageCount> {
    return toTopicMessageCount(await this.call("get-message-count", { ern }));
  }

  /**
   * One attribute of one published message.
   *
   * The attribute's name travels as `key` throughout ENS and as `name` in most of EQS - the server's own
   * asymmetry, reproduced rather than papered over.
   */
  async getMessageAttribute(messageId: string, key: string): Promise<TopicMessageAttribute> {
    return toTopicMessageAttribute(await this.call("get-message-attribute", { messageId, key }));
  }

  /** Sets one attribute of one published message, creating it if it was not there. */
  async setMessageAttribute(
    messageId: string,
    key: string,
    value: VariantInput,
  ): Promise<TopicMessageAttribute> {
    const payload = { messageId, key, value: variantToJson(variantOf(value)) };
    return toTopicMessageAttribute(await this.call("set-message-attribute", payload));
  }

  // -- subscriptions ---------------------------------------------------------------------------

  /**
   * Delivers a topic's messages onward to a queue from now on.
   *
   * Only {@link QUEUE} is a target type so far, so `targetErn` names an EQS queue. A message published
   * before this call is not delivered retrospectively - a subscription says what happens next.
   *
   * Not idempotent: a second call registers a second subscription and the queue then receives every
   * message twice, so a caller that may run twice checks {@link listSubscriptions} first.
   */
  async subscribe(topicErn: string, targetErn: string, targetType = QUEUE): Promise<SubscribeResult> {
    return toSubscribeResult(
      await this.call("subscribe", { sourceErn: topicErn, type: targetType, targetErn }),
    );
  }

  /**
   * Removes a subscription, by the ERN {@link subscribe} answered with - not the topic's, and not the
   * queue's.
   */
  async unsubscribe(ern: string): Promise<void> {
    await this.call("unsubscribe", { ern });
  }

  /** Every subscription currently registered on a topic. */
  async listSubscriptions(topicErn: string): Promise<Subscription[]> {
    const response = await this.call("list-subscriptions", { topicErn });
    const subscriptions = response["subscriptions"];
    return Array.isArray(subscriptions) ? subscriptions.map(toSubscription) : [];
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * ENS's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to ENS.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}
