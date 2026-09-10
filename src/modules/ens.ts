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
  type CreateTopicResult,
  type Topic,
  type TopicMessage,
  type TopicMessageAttribute,
  type TopicMessageCount,
  type TopicMetadata,
} from "../dto/ens.js";
import { listPayload, ModuleClient, pagePayload, type ListOptions, type PageOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ens";

/** The largest message a topic accepts, in bytes. */
export const DEFAULT_MAX_MESSAGE_LENGTH = 1024 * 1024;

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

  /** Where a topic lives and how much has been published to it. */
  async getTopicMetadata(ern: string): Promise<TopicMetadata> {
    return toTopicMetadata(await this.call("get-topic-metadata", { ern }));
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
