/**
 * EES - euclid's event service: being a consumer of euclid's own events without being a euclid module.
 *
 * One object, {@link EuclidEes}, built from a session that has already logged in:
 *
 * ```ts
 * const ees = session.ees();
 *
 * await ees.subscribeEvents("reporting", ["esm.object.created"]);
 * const received = await ees.receiveEvents("reporting", { waitTime: 20 });
 * await ees.ackEvents("reporting", received.events.map((event) => event.eventId));
 * ```
 *
 * Everything euclid's modules publish already goes onto an internal bus that persists each delivery,
 * hands it to one consumer at a time and keeps it until that consumer says it is done. What was missing
 * was a way to *be* one of those consumers from outside, and this is it: subscribe under a name,
 * receive, acknowledge.
 *
 * **A subscriber is a name, not a connection.** Two instances of one application share a name and so
 * share one backlog - exactly one of them gets each event - while two applications watching the same
 * thing use two names and each get their own copy. Nothing has to be created per bucket or per topic to
 * arrange that, because the bus already fans out per subscriber.
 *
 * Delivery is at-least-once and unordered, the same guarantees a queue gives: a received event is
 * invisible to other claimers until its lease expires, comes back if it is never acknowledged, and is
 * deleted when it is. An event nobody claims is expired by the bus after its retention period, so a
 * consumer that never comes back cannot fill the database.
 *
 * The difference from a bucket or topic subscription - {@link import("./esm.js").EuclidEsm.subscribe}
 * and its ENS sibling - is where the event ends up. Those deliver into a queue or a topic, which is
 * what an application that already consumes one wants. This hands the event straight to a client, with
 * nothing created in EQS or ENS to carry it.
 */

import {
  toAckResult,
  toEventSubscriptions,
  toReceivedEvents,
  toUnsubscribeResult,
  type AckResult,
  type EventSubscriptions,
  type ReceivedEvents,
  type UnsubscribeResult,
} from "../dto/ees.js";
import { ModuleClient } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ees";

/**
 * Keep an event for a subscriber that is not asking right now - the default, and what a consumer that
 * must not miss anything wants.
 */
export const DELIVERY_DURABLE = "durable";
/**
 * Hand an event over only while the subscriber is actually receiving, and drop it otherwise.
 *
 * For something watching rather than processing - a console, a tail - where an event nobody was there
 * to see is of no use later and a backlog nobody drains is a cost for nothing.
 */
export const DELIVERY_LIVE = "live";

/** How long a received event stays invisible to other claimers, in seconds, unless one is given. */
export const DEFAULT_EVENT_VISIBILITY = 300;

/** How many events a receive takes unless it asks for another number. */
export const DEFAULT_MAX_EVENTS = 10;

/**
 * The longest a receive will wait for an event to arrive, in seconds.
 *
 * Bounded because the wait holds a gateway worker thread, and the number of waiting requests is capped
 * for the same reason - so that clients waiting for events can never take the last thread from a client
 * with something to do. A receive that cannot get a waiting slot answers with whatever is there now,
 * which is what a long poll returns anyway when nothing arrives.
 */
export const MAX_WAIT_TIME = 20;

/** What a subscription asks for beyond its event types. */
export interface SubscribeEventsOptions {
  /**
   * What narrows the events of those types - matched against the payload by equality. Empty, the
   * default, really does mean every event of these types, which makes the backlog proportional to how
   * busy the installation is rather than to what this subscriber can use.
   */
  filter?: Record<string, unknown>;
  /** {@link DELIVERY_DURABLE} - the default - or {@link DELIVERY_LIVE}. */
  mode?: string;
  /**
   * Whether the subscription belongs to one connection and should not outlive it.
   *
   * What the API gateway sets for a websocket's own subscription: it is removed when that connection
   * ends, and any that survive a crash are cleared when the gateway next starts. A client may set it,
   * and nothing goes wrong if one does - the subscription simply does not outlive the gateway process.
   */
  ephemeral?: boolean;
}

/** How a receive asks, and for how long it waits. */
export interface ReceiveEventsOptions {
  /** How many events at most; {@link DEFAULT_MAX_EVENTS} unless given, and at least 1. */
  maxEvents?: number;
  /**
   * How long to wait for one to arrive, in seconds - up to {@link MAX_WAIT_TIME}, and 0 to take what
   * is there and answer.
   *
   * Worth setting. An empty answer that took twenty seconds beats a client asking again every hundred
   * milliseconds, and the wait is a wake-up rather than a poll: the bus hands over the moment an event
   * is published.
   */
  waitTime?: number;
  /**
   * How long the events this takes stay invisible to other claimers, in seconds.
   * {@link DEFAULT_EVENT_VISIBILITY} unless given.
   *
   * It is a lease on the work rather than a deadline for the call: an event not acknowledged within it
   * comes back to the subscriber, and one whose consumer is still working on it comes back too. Long
   * enough to cover the slowest handling, then.
   */
  visibilityTimeout?: number;
}

/**
 * EES's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.ees} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEes extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  /**
   * Asks for events of these types to be kept for this subscriber.
   *
   * One call takes several types and writes one subscription per type, and the answer is every
   * subscription the name now has - including ones from an earlier call, which is what makes this
   * additive rather than a replacement. Subscribing again for a type that is already subscribed is how
   * its filter or mode is changed.
   *
   * The name is the thing to choose carefully: it is what the backlog belongs to. Two instances of one
   * application share a name on purpose; two different consumers must not, or they will take each
   * other's events.
   *
   * @param name the subscriber name this backlog belongs to
   * @param eventTypes at least one - `esm.object.created`, `eqs.message.sent`. An empty list is
   *   refused rather than read as "everything", since a subscriber that asked for everything on a busy
   *   installation is a backlog nobody drains.
   * @param options the filter, the delivery mode, and whether it outlives this connection
   */
  async subscribeEvents(
    name: string,
    eventTypes: readonly string[],
    options: SubscribeEventsOptions = {},
  ): Promise<EventSubscriptions> {
    const payload: Record<string, unknown> = { name, eventTypes: [...eventTypes] };
    if (options.filter !== undefined) payload["filter"] = options.filter;
    if (options.mode !== undefined) payload["mode"] = options.mode;
    if (options.ephemeral !== undefined) payload["ephemeral"] = options.ephemeral;
    return toEventSubscriptions(await this.call("subscribe-events", payload));
  }

  /**
   * Takes up to `maxEvents` events for this subscriber, waiting up to `waitTime` for one.
   *
   * What comes back is claimed rather than consumed: each event is invisible to other claimers for the
   * visibility timeout, comes back to the subscriber if it is not acknowledged within it, and goes for
   * good when it is. So {@link ackEvents} is what says the work was done, and it belongs *after* the
   * work rather than before it.
   *
   * An empty answer is ordinary - it means nothing arrived in the time it waited - and `total` is how
   * many events this answer carries rather than how many are waiting. {@link listSubscriptions} is
   * where the backlog is counted.
   *
   * An event's `attempts` above 1 means a previous claim was never acknowledged. That is the one thing
   * that tells a redelivery from a first delivery, and watching it is how a consumer finds the work it
   * cannot finish rather than retrying it forever.
   */
  async receiveEvents(name: string, options: ReceiveEventsOptions = {}): Promise<ReceivedEvents> {
    const payload: Record<string, unknown> = { name };
    if (options.maxEvents !== undefined) payload["maxEvents"] = options.maxEvents;
    if (options.waitTime !== undefined) payload["waitTime"] = options.waitTime;
    if (options.visibilityTimeout !== undefined) payload["visibilityTimeout"] = options.visibilityTimeout;
    return toReceivedEvents(await this.call("receive-events", payload));
  }

  /**
   * Says these events are done with, and removes them.
   *
   * Acknowledging fewer than were named is not an error, and the result says how many were still there:
   * a redelivery acknowledged twice and an event whose retention ran out both end here, and both mean
   * the same thing to the caller.
   *
   * @param name the subscriber whose events these are
   * @param eventIds at least one; an empty list is refused rather than treated as a call that does
   *   nothing
   */
  async ackEvents(name: string, eventIds: readonly string[]): Promise<AckResult> {
    return toAckResult(await this.call("ack-events", { name, eventIds: [...eventIds] }));
  }

  /**
   * This subscriber's subscriptions, and how much is waiting for it.
   *
   * The only call that counts the backlog. Counting is a scan of it, so acknowledging - the hottest
   * call a busy consumer makes - deliberately does not pay for it, and this one, which a console's
   * refresh or an operator makes, does.
   */
  async listSubscriptions(name: string): Promise<EventSubscriptions> {
    return toEventSubscriptions(await this.call("list-subscriptions", { name }));
  }

  /**
   * Stops keeping events for this subscriber - one type of them, or all.
   *
   * What goes is the subscription rather than the backlog: events already kept for this name stay until
   * they are received and acknowledged, or until the bus expires them. A name that is subscribed to
   * nothing collects nothing new.
   *
   * @param name the subscriber
   * @param eventType one type to stop; empty removes every subscription this name has
   */
  async unsubscribeEvents(name: string, eventType = ""): Promise<UnsubscribeResult> {
    return toUnsubscribeResult(await this.call("unsubscribe-events", { name, eventType }));
  }

  /**
   * EES's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to EES.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}
