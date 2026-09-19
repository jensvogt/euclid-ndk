/**
 * EQS - euclid's queue module: queues, messages, leases, dead letter queues.
 *
 * One object, {@link EuclidEqs}, built from a session that has already logged in:
 *
 * ```ts
 * const eqs = (await Euclid.forServer(url).login("jens", "secret")).eqs();
 * const queue = await eqs.createQueue("orders");
 *
 * await eqs.sendMessage(queue.ern, JSON.stringify({ order: 17 }));
 * for (const message of (await eqs.receiveMessages(queue.ern, { waitTimeSeconds: 20 })).items) {
 *   await handle(message.body);
 *   await eqs.deleteMessage(message.receiptHandle);
 * }
 * ```
 *
 * Receiving is a lease rather than a read: a message a consumer takes is invisible to every other
 * consumer until its visibility timeout expires, and deleting it with the receipt handle is what says
 * the work was done. A consumer that dies instead simply stops holding the lease, and the message comes
 * back - which is why the delete belongs after the work rather than before it.
 */

import { EVERY_NAMESPACE, variantMapToJson, variantOf, variantToJson, type VariantInput } from "../dto/com.js";
import { toPage, type Page } from "../dto/eam.js";
import {
  toCreateQueueResult,
  toQueue,
  toQueueDelayResult,
  toQueueMaxMessageLengthResult,
  toQueueMessage,
  toQueueMessageAttribute,
  toQueueMessageCount,
  toQueueMessageMetadata,
  toQueueMetadata,
  toQueueStatusResult,
  toRedriveDlqResult,
  type CreateQueueResult,
  type Queue,
  type QueueDelayResult,
  type QueueMaxMessageLengthResult,
  type QueueMessage,
  type QueueMessageAttribute,
  type QueueMessageCount,
  type QueueMessageMetadata,
  type QueueMetadata,
  type QueueStatusResult,
  type RedriveDlqResult,
} from "../dto/eqs.js";
import type { EuclidHttpClient } from "../http/client.js";
import { listPayload, ModuleClient, pagePayload, type ListOptions, type PageOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "eqs";

/** How long a received message stays invisible before it goes back on the queue, in seconds. */
export const DEFAULT_VISIBILITY = 30;

/** How many times a message may be received before it goes to the dead letter queue. */
export const DEFAULT_MAX_RETRIES = 3;

/** The largest message a queue accepts, in bytes, unless it is given a limit of its own. */
export const DEFAULT_MAX_MESSAGE_LENGTH = 1024 * 1024;

/**
 * The message-size limit that means "no limit of this queue's own".
 *
 * Zero rather than a number of bytes, and not "accept nothing": a send against such a queue is measured
 * against the installation's figure - {@link DEFAULT_MAX_MESSAGE_LENGTH} - instead, which is what a queue
 * created before the limit meant anything holds. See {@link EuclidEqs.setQueueMaxMessageLength}.
 */
export const INSTALLATION_MAX_MESSAGE_LENGTH = 0;

/**
 * The longest delay a queue may hold a sent message for, in seconds.
 *
 * The bound AWS SQS holds `DelaySeconds` to, and euclid keeps: a delay is for smoothing a burst or letting a
 * writer finish, not for scheduling - something that has to wait a quarter of an hour wants a timestamp of its
 * own rather than a queue that holds everything back.
 */
export const MAX_QUEUE_DELAY = 900;

/**
 * How long to pause, in milliseconds, before asking again when the server answered a long poll
 * immediately because it had no slot free to wait in. Only reached when the server is short of threads,
 * which is the moment to ask less often rather than more.
 */
export const SLOTS_BUSY_BACKOFF_MS = 500;

/**
 * How close to its deadline a long poll may come back and still count as having been waited out rather
 * than answered early. Absorbs the jitter between the server's clock and this one, so an honoured wait
 * is not followed by a pointless extra request for the last few milliseconds.
 */
export const HONOURED_WAIT_TOLERANCE_MS = 250;

/**
 * Added to a long poll's wait to give the response time to travel: the server answers at the end of the
 * window it was asked for, so a timeout of exactly that window would race the network.
 */
export const LONG_POLL_RESPONSE_MARGIN_MS = 10_000;

/** What a queue is created with. Every field has a server-side default. */
export interface CreateQueueOptions {
  /** How long a received message stays invisible, in seconds, unless a receive says otherwise. */
  visibility?: number;
  /**
   * How many times a message may be received before it is moved to `dlqName`. A queue without a dead
   * letter queue keeps redelivering.
   */
  maxRetries?: number;
  /**
   * The largest message this queue accepts, in bytes - changeable later with
   * {@link EuclidEqs.setQueueMaxMessageLength}. {@link INSTALLATION_MAX_MESSAGE_LENGTH} carries no limit of
   * the queue's own.
   */
  maxMessageLength?: number;
  /** The name of the queue that failed messages end up on. */
  dlqName?: string;
  /**
   * How long a sent message waits before it can be received at all, in seconds, to a maximum of
   * {@link MAX_QUEUE_DELAY} - changeable later with {@link EuclidEqs.setQueueDelay}.
   */
  delay?: number;
  /**
   * The priority every message of this queue gets unless a send overrides it -
   * {@link import("../dto/com.js").PRIORITY_LOW} and its siblings, or the server's default when left
   * empty.
   */
  priority?: string;
  /** Marks the queue as euclid's own plumbing, which leaves it out of an ordinary listing. */
  internal?: boolean;
}

/** How a queue listing is paged, and whether euclid's own queues are in it. */
export interface ListQueuesOptions extends ListOptions {
  includeInternal?: boolean;
}

/** What a message carries besides its body. */
export interface SendMessageOptions {
  /** The sender's own attributes, which come back on the received message. */
  attributes?: Record<string, VariantInput>;
  /**
   * euclid's envelope, which travels with the message across every hop - what lets a service pass on
   * what it received rather than what it happens to know.
   */
  systemAttributes?: Record<string, VariantInput>;
  /** `LOW`, `MEDIUM` or `HIGH`; left empty, the message takes the queue's own default. */
  priority?: string;
}

/** How many messages a receive takes, and how long it is willing to wait for them. */
export interface ReceiveMessagesOptions {
  maxMessages?: number;
  /** How long the server may hold the request open, in seconds. Zero does not wait at all. */
  waitTimeSeconds?: number;
}

/** Which queues a blanket purge applies to. The account and region default to the session's own. */
export interface PurgeAllQueuesOptions {
  region?: string;
  accountId?: string;
  /**
   * The namespace to narrow it to. Left out - or named as
   * {@link import("../dto/com.js").EVERY_NAMESPACE} - it purges every namespace of the account, which is
   * what this call has always done.
   */
  namespace?: string;
}

/**
 * EQS's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.eqs} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEqs extends ModuleClient {
  /**
   * How long to pause before asking again when the server declined to wait out a long poll.
   *
   * A field rather than a constant because it is the one part of the polling a caller may reasonably
   * want to change - and because nothing in a test suite wants to sit out a backoff that exists to be
   * kind to a server short of threads.
   */
  slotsBusyBackoffMs = SLOTS_BUSY_BACKOFF_MS;

  constructor(session: EuclidSession, options: { client?: EuclidHttpClient; headers?: Record<string, string> } = {}) {
    super(session, { target: TARGET, ...options });
  }

  // -- queues ----------------------------------------------------------------------------------

  /** Creates a queue, and answers with the ERN everything else names it by. */
  async createQueue(name: string, options: CreateQueueOptions = {}): Promise<CreateQueueResult> {
    return toCreateQueueResult(
      await this.call("create-queue", {
        name,
        visibility: options.visibility ?? DEFAULT_VISIBILITY,
        maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
        maxMessageLength: options.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH,
        dlqName: options.dlqName ?? "",
        delay: options.delay ?? 0,
        priority: options.priority ?? "",
        internal: options.internal ?? false,
      }),
    );
  }

  /** Deletes a queue and everything on it. */
  async deleteQueue(ern: string): Promise<void> {
    await this.call("delete-queue", { ern });
  }

  /**
   * One page of queues, and how many exist in total.
   *
   * euclid's own queues - the delivery queue behind a bucket listener, say - are left out unless
   * `includeInternal` asks for them, so a listing shows what a person would recognise. A component
   * looking for the queues it created has to ask.
   */
  async listQueues(options: ListQueuesOptions = {}): Promise<Page<Queue>> {
    const payload = { ...listPayload(options, "name"), includeInternal: options.includeInternal ?? false };
    return toPage(await this.call("list-queues", payload), "queues", toQueue);
  }

  /** The ERN of the queue of this name, in the session's account and namespace. */
  /**
   * One queue, by name or by ERN.
   *
   * What comes back is exactly what {@link listQueues} describes each of its own with - the ERN,
   * the owner, visibility, delay and retention, the dead letter queue, tags, and how many messages
   * are available, delayed and in flight - so this is the single-queue form of a listing rather
   * than another view of one.
   *
   * A value starting with `ern:` is taken as an ERN and names one queue in the installation;
   * anything else is a name and is resolved in the session's own account and namespace, the way
   * {@link getQueueErn} resolves one.
   */
  async getQueue(nameOrErn: string): Promise<Queue> {
    const payload = nameOrErn.startsWith("ern:") ? { ern: nameOrErn } : { name: nameOrErn };
    return toQueue((await this.call("get-queue", payload)).queue);
  }

  /**
   * One message, by its id.
   *
   * The message id, not a receipt handle: a receipt handle belongs to one delivery and is void once
   * that delivery's claim has expired, while the id names the message for as long as it exists -
   * and asking about a message is something one does after the fact.
   */
  async getMessage(messageId: string): Promise<QueueMessage> {
    return toQueueMessage((await this.call("get-message", { messageId })).message);
  }

  async getQueueErn(name: string): Promise<string> {
    return this.textOf("get-queue-ern", { name }, "ern");
  }

  /** Where a queue lives and how much is in it. */
  async getQueueMetadata(ern: string): Promise<QueueMetadata> {
    return toQueueMetadata(await this.call("get-queue-metadata", { ern }));
  }

  /** Deletes every message on a queue, leaving the queue itself in place. */
  async purgeQueue(ern: string): Promise<void> {
    await this.call("purge-queue", { ern });
  }

  /**
   * Deletes every message on every queue of an account, which defaults to this session's own.
   *
   * Exactly as blunt as it sounds, and there is no undo: it exists for a test environment between runs
   * rather than for anything that has consumers attached.
   *
   * Every namespace of that account unless `namespace` narrows it - the opposite default to
   * {@link import("./ens.js").EuclidEns.purgeAllTopics}, which follows the session. Neither is wrong: this
   * one has purged the account since it existed, and narrowing it silently would quietly spare queues a
   * caller meant to empty.
   */
  async purgeAllQueues(options: PurgeAllQueuesOptions = {}): Promise<void> {
    await this.call("purge-all-queues", {
      region: options.region || this.session.region,
      accountId: options.accountId || this.session.accountId,
      nameSpace: options.namespace ?? EVERY_NAMESPACE,
    });
  }

  /**
   * Stops a queue, so it hands no more messages out.
   *
   * Messages already in flight are left alone: their consumer took them before the queue was stopped
   * and is still entitled to finish, so deleting one still works. Only new receives are refused, with
   * HTTP 409.
   */
  async stopQueue(ern: string): Promise<QueueStatusResult> {
    return this.#setQueueStatus("stop-queue", ern);
  }

  /** Starts a queue that was stopped, so it hands messages out again. */
  async startQueue(ern: string): Promise<QueueStatusResult> {
    return this.#setQueueStatus("start-queue", ern);
  }

  /**
   * Changes a queue's default visibility timeout, and answers with the one it now has.
   *
   * Only the default changes. Messages already in flight keep the window they were given when they were
   * received, so this can neither expire a lease a consumer is still working on nor hold back a message
   * its consumer has already given up on.
   */
  async setQueueVisibility(ern: string, visibility: number): Promise<number> {
    return this.numberOf("set-queue-visibility", { ern, visibility }, "visibility");
  }

  /**
   * Changes how long a queue holds a sent message back before it can be received, in seconds.
   *
   * What is sent from here on, and nothing else: a message already waiting had its delay turned into a
   * timestamp when it arrived, and moving that now would either release it early or hold back one that was
   * promised sooner.
   *
   * @param delay seconds, from none to {@link MAX_QUEUE_DELAY}.
   * @throws {Error} if the delay is outside that range, which the server refuses anyway - this just says so
   *   before the round trip.
   */
  async setQueueDelay(ern: string, delay: number): Promise<QueueDelayResult> {
    if (delay < 0 || delay > MAX_QUEUE_DELAY) {
      throw new Error(`delay must be between 0 and ${MAX_QUEUE_DELAY} seconds`);
    }
    return toQueueDelayResult(await this.call("set-queue-delay", { ern, delay }));
  }

  /**
   * Changes the largest message a queue accepts, in bytes.
   *
   * What is sent from here on: a message already on the queue was measured against the limit in force when it
   * arrived, and lowering this is not a reason to go back and reject it. A send that exceeds the limit is
   * refused with HTTP 400 - see {@link sendMessage} for what exactly is measured.
   *
   * @param maxMessageLength bytes, or {@link INSTALLATION_MAX_MESSAGE_LENGTH} to carry no limit of this
   *   queue's own and be measured against the installation's figure instead. The result says which of the two
   *   a send will actually be held to.
   * @throws {Error} if the length is negative, which the server refuses anyway - this just says so before the
   *   round trip.
   */
  async setQueueMaxMessageLength(ern: string, maxMessageLength: number): Promise<QueueMaxMessageLengthResult> {
    if (maxMessageLength < 0) {
      throw new Error(
        `maxMessageLength cannot be negative; zero follows the installation default of ${DEFAULT_MAX_MESSAGE_LENGTH} bytes`,
      );
    }
    const response = await this.call("set-queue-max-message-length", { ern, maxMessageLength });
    return toQueueMaxMessageLengthResult(response);
  }

  /**
   * Moves messages out of a dead letter queue and back onto the queues they came from.
   *
   * `ern` has to name a queue that some other queue points at as its dead letter queue; an ordinary
   * queue is refused rather than redriven into itself. A named `targetErn` has to be one of the queues
   * that feed it, since anything else would be a move rather than a redrive.
   *
   * Left unnamed, each message goes back where it came from - and a message whose origin was never
   * recorded is left alone rather than guessed at. The result says how many, so a caller can name a
   * target and deal with them deliberately.
   */
  async redriveDlq(ern: string, targetErn = ""): Promise<RedriveDlqResult> {
    return toRedriveDlqResult(await this.call("redrive-dlq", { ern, targetErn }));
  }

  /** Tags a queue. */
  async addQueueTag(ern: string, key: string, value: string): Promise<void> {
    await this.call("add-queue-tag", { ern, key, value });
  }

  /** Sets the value of a tag the queue already has. */
  async setQueueTag(ern: string, key: string, value: string): Promise<void> {
    await this.call("set-queue-tag", { ern, key, value });
  }

  /** Removes a tag from a queue. */
  async deleteQueueTag(ern: string, key: string): Promise<void> {
    await this.call("delete-queue-tag", { ern, key });
  }

  /** stop-queue and start-queue take the same request and differ only in what they record. */
  async #setQueueStatus(action: string, ern: string): Promise<QueueStatusResult> {
    return toQueueStatusResult(await this.call(action, { ern }));
  }

  // -- messages --------------------------------------------------------------------------------

  /**
   * Puts a message on a queue, and answers with the ID the server gave it.
   *
   * The envelope and the priority are left out of the request entirely when there is nothing to say
   * about them, so the queue's own defaults are what apply rather than an empty string the server would
   * have to interpret.
   *
   * A body longer than the queue accepts is refused with HTTP 400 saying both figures. What counts is the
   * body alone - the same number `size` reports - so attributes travel alongside it rather than against the
   * limit; {@link setQueueMaxMessageLength} is what changes that limit.
   */
  async sendMessage(queueErn: string, body: string, options: SendMessageOptions = {}): Promise<string> {
    const payload: Record<string, unknown> = {
      ern: queueErn,
      body,
      attributes: variantMapToJson(options.attributes),
    };
    if (options.systemAttributes !== undefined && Object.keys(options.systemAttributes).length > 0) {
      payload["systemAttributes"] = variantMapToJson(options.systemAttributes);
    }
    if (options.priority) payload["priority"] = options.priority;
    return this.textOf("send-message", payload, "messageId");
  }

  /**
   * Takes up to `maxMessages` messages off a queue, waiting up to `waitTimeSeconds` for them.
   *
   * The waiting is the server's, not this client's: it holds the request open until a message lands or
   * the time runs out, so an idle queue costs one request for the whole window rather than one per poll
   * tick, and a message comes back the instant it is sent.
   *
   * The one case that loops is the server declining to wait. It keeps a bounded number of long-poll
   * slots - one fewer than it has threads - so that consumers sitting in a wait cannot starve the
   * producers trying to send to them; with none free it answers at once with whatever is on the queue.
   * That comes back empty with time still on the clock, and the answer is to wait a moment and ask
   * again rather than immediately, since asking again at once is what a server short of threads does not
   * need.
   *
   * With no wait asked for, the queue's depth is checked first and an empty queue costs no receive at
   * all - a receive is a write, and one that takes nothing is work the server did for nothing.
   */
  async receiveMessages(queueErn: string, options: ReceiveMessagesOptions = {}): Promise<Page<QueueMessage>> {
    const maxMessages = options.maxMessages ?? 10;
    const waitSeconds = options.waitTimeSeconds ?? 0;

    if (waitSeconds <= 0) {
      if ((await this.getMessageCount(queueErn)).available <= 0) return { total: 0, items: [] };
      return this.#receive(queueErn, maxMessages, 0);
    }

    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      // Rounded up rather than truncated: the wait travels in whole seconds, and a caller who asked
      // for five would otherwise be given four and a round trip to ask for the fifth.
      const wait = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      const result = await this.#receive(queueErn, maxMessages, wait);
      if (result.items.length > 0) return result;

      const remaining = deadline - Date.now();
      if (remaining <= HONOURED_WAIT_TOLERANCE_MS) return result;
      await delay(Math.min(this.slotsBusyBackoffMs, remaining));
    }
  }

  /**
   * Takes everything off a queue, a batch at a time, until it comes back empty.
   *
   * For draining a queue rather than for consuming one: every message comes back on a lease, so a caller
   * that does not delete them will see them all again once the visibility timeout expires.
   */
  async receiveAllMessages(queueErn: string, batchSize = 10): Promise<QueueMessage[]> {
    const messages: QueueMessage[] = [];
    for (;;) {
      const batch = await this.receiveMessages(queueErn, { maxMessages: batchSize });
      if (batch.items.length === 0) return messages;
      messages.push(...batch.items);
    }
  }

  /**
   * One page of a queue's messages, without receiving them.
   *
   * A read rather than a lease: nothing here becomes invisible, nothing counts as a delivery, and
   * nothing can be deleted by receipt handle afterwards. It is how a queue is inspected, not how it is
   * consumed.
   */
  async listMessages(queueErn: string, options: PageOptions = {}): Promise<Page<QueueMessage>> {
    const payload = { queueErn, ...pagePayload(options, "created") };
    return toPage(await this.call("list-messages", payload), "messages", toQueueMessage);
  }

  /**
   * Deletes a received message, by the handle the receive handed out.
   *
   * The handle is a lease: this works while the message's visibility timeout is still running and fails
   * once it has expired and the message has gone back on the queue.
   */
  async deleteMessage(receiptHandle: string): Promise<void> {
    await this.call("delete-message", { receiptHandle });
  }

  /**
   * Deletes a message by its ID, including one nobody has received.
   *
   * Bypasses the lease {@link deleteMessage} goes through, which is what makes it able to remove a
   * message that is still waiting or still delayed. A euclid extension with no SQS equivalent.
   */
  async deleteMessageById(messageId: string): Promise<void> {
    await this.call("delete-message", { messageId });
  }

  /** How many messages a queue holds, by the state they are in. */
  async getMessageCount(ern: string): Promise<QueueMessageCount> {
    return toQueueMessageCount(await this.call("get-message-count", { ern }));
  }

  /** Everything about one message except its body. */
  async getMessageMetadata(messageId: string): Promise<QueueMessageMetadata> {
    return toQueueMessageMetadata(await this.call("get-message-metadata", { messageId }));
  }

  /**
   * Changes how long one message stays invisible - extending a lease a consumer needs longer.
   *
   * Sent as `set-message-visibility`, the name that says what it changes and pairs with
   * {@link setQueueVisibility}. euclid answers to `set-visibility` as well, which is what euclid-jdk
   * sends and what a server older than the newer name knows it by; such a server refuses this with
   * HTTP 404, and {@link ModuleClient.call} is the way round that.
   */
  async setMessageVisibility(messageId: string, visibility: number): Promise<void> {
    await this.call("set-message-visibility", { messageId, visibility });
  }

  /** One attribute of one message. */
  async getMessageAttribute(messageId: string, name: string): Promise<QueueMessageAttribute> {
    return toQueueMessageAttribute(await this.call("get-message-attribute", { messageId, name }));
  }

  /**
   * Sets one attribute of one message, creating it if it was not there.
   *
   * The attribute's name travels as `key` on this action and as `name` on the one that reads it back -
   * the server's own asymmetry, reproduced rather than papered over, so that a request built from this
   * SDK matches what euclid-cli and euclid-jdk send.
   */
  async setMessageAttribute(
    messageId: string,
    name: string,
    value: VariantInput,
  ): Promise<QueueMessageAttribute> {
    const payload = { messageId, key: name, value: variantToJson(variantOf(value)) };
    return toQueueMessageAttribute(await this.call("set-message-attribute", payload));
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * EQS's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to EQS.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }

  /**
   * A view of this client whose requests are marked as euclid's own traffic.
   *
   * Some calls observe the system rather than use it: reading a queue's depth to report it, polling for
   * a heartbeat. They are indistinguishable from real work by their action alone - the same
   * `get-message-count` is a user's question one moment and a metric collector's poll the next - so the
   * caller says which it is, and the server logs and scales accordingly. Instrumentation that polls
   * every few seconds would otherwise keep a pool permanently awake and make an idle module look busy:
   * the monitoring preventing the thing it exists to measure.
   *
   * A separate client rather than a flag on this one, so that no call has to remember to set it back -
   * but the same connection, since two clients that differ by a header have no reason to differ by a
   * socket. Closing either closes both, which the owning session does anyway.
   */
  asInternal(): EuclidEqs {
    return new EuclidEqs(this.session, { client: this.client, headers: { "x-euclid-internal": "true" } });
  }

  // -- transport -------------------------------------------------------------------------------

  /**
   * One receive-messages request, held open by the server for `waitSeconds`.
   *
   * The client's own timeout is sized for an answer that comes straight back, so a long poll gets its
   * own: the request is meant to take as long as the server was asked to hold it, and abandoning it at
   * the usual deadline would abandon a request being served correctly.
   */
  async #receive(queueErn: string, maxMessages: number, waitSeconds: number): Promise<Page<QueueMessage>> {
    const timeoutMs = waitSeconds > 0 ? waitSeconds * 1000 + LONG_POLL_RESPONSE_MARGIN_MS : undefined;
    const payload = { ern: queueErn, maxCount: maxMessages, waitTime: waitSeconds };
    return toPage(await this.call("receive-messages", payload, timeoutMs), "messages", toQueueMessage);
  }
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}
