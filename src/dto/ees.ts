/**
 * The shapes EES sends back.
 *
 * Parsed the same defensive way as every other module's. One field here is deliberately left alone:
 * an event's `payload` is whatever module published it, so it arrives as the object it was published
 * as rather than being read into a type this SDK made up.
 */

import { documents, number, object, text } from "./json.js";

/**
 * One subscription: a subscriber name, and one event type it wants.
 *
 * A subscriber is a *name* rather than a connection. Two instances of one application share a name and
 * so share its backlog - exactly one of them gets each event - while two applications watching the
 * same thing use two names and each get their own copy. Nothing is created per bucket or per topic to
 * arrange that; the bus already fans out per subscriber.
 */
export interface EventSubscription {
  subscriber: string;
  /** The event type this row asks for - `esm.object.created` and its kind. */
  eventType: string;
  /**
   * What narrows it, as the filter was given. Empty means every event of this type, which is what
   * keeps a backlog proportional to how busy the installation is rather than to what was asked for.
   */
  filter: Record<string, unknown>;
  accountId: string;
  /** `durable` or `live` - see {@link import("../modules/ees.js").DELIVERY_LIVE}. */
  mode: string;
  created: string;
  /** When this subscriber last asked for events, which is how a name nobody uses is recognised. */
  lastSeen: string;
}

/**
 * A subscriber's subscriptions, and how much is waiting for it.
 *
 * `waiting` is counted here and nowhere else: counting is a scan of the whole backlog, so the hot path
 * - acknowledging - does not pay for it, and this call, which an operator or a refresh makes, does.
 */
export interface EventSubscriptions {
  subscriptions: EventSubscription[];
  waiting: number;
}

/**
 * One event, as it was published.
 *
 * `payload` is the publishing module's own object, untouched: a bucket event's body, a key's details.
 * {@link import("./esm.js").toBucketEvent} reads an ESM one, and anything else is the module's to
 * describe.
 *
 * `attempts` is how many times this event has been handed out, which is 1 the first time. Anything
 * higher means a previous claim was never acknowledged and its lease ran out - the one thing that
 * tells a redelivery from a first delivery, and what a consumer watches to find work it cannot finish.
 */
export interface Event {
  eventId: string;
  eventType: string;
  /** The module that published it: `esm`, `eqs`, `eam`. */
  sourceModule: string;
  payload: Record<string, unknown>;
  attempts: number;
  created: string;
}

/** What a receive came back with. `total` is how many events are in this answer, not how many wait. */
export interface ReceivedEvents {
  total: number;
  events: Event[];
}

/** What an acknowledgement removed. */
export interface AckResult {
  subscriber: string;
  /**
   * How many of the named events were still there to remove.
   *
   * Fewer than were named is **not** an error: a redelivery acknowledged twice and an event whose
   * retention ran out both end here, and both mean the same thing to a caller - it is gone.
   */
  acknowledged: number;
}

/** What an unsubscribe removed: how many subscription rows went. */
export interface UnsubscribeResult {
  subscriber: string;
  removed: number;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toEventSubscription(document: unknown): EventSubscription {
  return {
    subscriber: text(document, "subscriber"),
    eventType: text(document, "eventType"),
    filter: object(object(document)["filter"]),
    accountId: text(document, "accountId"),
    mode: text(document, "mode"),
    created: text(document, "created"),
    lastSeen: text(document, "lastSeen"),
  };
}

export function toEventSubscriptions(document: unknown): EventSubscriptions {
  return {
    subscriptions: documents(document, "subscriptions").map(toEventSubscription),
    waiting: number(document, "waiting"),
  };
}

export function toEvent(document: unknown): Event {
  return {
    eventId: text(document, "eventId"),
    eventType: text(document, "eventType"),
    sourceModule: text(document, "sourceModule"),
    // Left as the publishing module wrote it: this SDK has no business reading another module's
    // payload into a shape of its own.
    payload: object(object(document)["payload"]),
    attempts: number(document, "attempts"),
    created: text(document, "created"),
  };
}

export function toReceivedEvents(document: unknown): ReceivedEvents {
  return {
    total: number(document, "total"),
    events: documents(document, "events").map(toEvent),
  };
}

export function toAckResult(document: unknown): AckResult {
  return { subscriber: text(document, "subscriber"), acknowledged: number(document, "acknowledged") };
}

export function toUnsubscribeResult(document: unknown): UnsubscribeResult {
  return { subscriber: text(document, "subscriber"), removed: number(document, "removed") };
}
