/**
 * A euclid queue module small enough to read, for the EQS tests.
 *
 * Messages in an array, and the two things about a queue that a client can get wrong implemented rather
 * than stubbed: a receive hands out a receipt handle and makes the message invisible to the next one,
 * and a long poll is either held open for the window it was asked for or declined outright. Those are
 * what {@link import("../src/modules/eqs.js").EuclidEqs.receiveMessages} is written against, so they
 * are what a test of it has to have.
 *
 * Registered on a {@link FakeGateway}, which authenticates the requests before any of this is reached.
 */

import { type FakeGateway, type Handler, type RecordedRequest } from "./fake-gateway.js";

/** The ERN a queue of this name would have, in the account the stubbed login logs into. */
export function queueErn(name: string): string {
  return `ern:euclid:eqs:eu-central-1:000000000000:queue/${name}`;
}

interface StoredMessage extends Record<string, unknown> {
  queueErn: string;
  messageId: string;
  status: string;
  receiptHandle: string;
  receivedCount: number;
}

/** The state a queue module keeps, and the actions that read and write it. */
export class FakeQueues {
  /** queue ERN -> the messages on it, in the order they were sent. */
  readonly messages = new Map<string, StoredMessage[]>();
  /** The `waitTime` of every receive-messages request, in order. */
  readonly waits: number[] = [];
  /**
   * How many of the next long polls to decline - answer at once rather than wait, as the server does
   * when it has no long-poll slot free.
   */
  declineWaits = 0;
  /**
   * The longest a held long poll actually waits here, in milliseconds. The client's window is what is
   * being tested, not the wall clock, so the stand-in never holds one for more than this.
   */
  maxHoldMs = 1000;

  #sent = 0;

  /** Registers every action this stand-in implements. */
  install(gateway: FakeGateway): this {
    const handlers: Record<string, Handler> = {
      "send-message": (request) => this.#sendMessage(request),
      "receive-messages": (request) => this.#receiveMessages(request),
      "delete-message": (request) => this.#deleteMessage(request),
      "get-message-count": (request) => this.#getMessageCount(request),
      "list-messages": (request) => this.#listMessages(request),
      "purge-queue": (request) => this.#purgeQueue(request),
    };
    for (const [action, handler] of Object.entries(handlers)) gateway.on("eqs", action, handler);
    return this;
  }

  /** The messages currently on a queue, whatever state they are in. */
  on(ern: string): StoredMessage[] {
    return this.messages.get(ern) ?? [];
  }

  // -- actions -----------------------------------------------------------------------------------

  #sendMessage(request: RecordedRequest): [number, unknown] {
    const body = request.json();
    const ern = String(body["ern"] ?? "");
    this.#sent += 1;
    const message: StoredMessage = {
      ern: `${ern}/message/${this.#sent}`,
      queueErn: ern,
      messageId: `message-${this.#sent}`,
      status: "AVAILABLE",
      priority: body["priority"] ?? "MEDIUM",
      body: body["body"] ?? "",
      receiptHandle: "",
      size: String(body["body"] ?? "").length,
      receivedCount: 0,
      contentType: "application/json",
      attributes: body["attributes"] ?? {},
      systemAttributes: body["systemAttributes"] ?? {},
    };
    const queue = this.messages.get(ern);
    if (queue === undefined) this.messages.set(ern, [message]);
    else queue.push(message);
    return [200, { messageId: message.messageId }];
  }

  async #receiveMessages(request: RecordedRequest): Promise<[number, unknown]> {
    const body = request.json();
    const wait = Number(body["waitTime"] ?? 0);
    this.waits.push(wait);

    if (this.declineWaits > 0) {
      // No slot free: whatever is on the queue comes back at once rather than the request queueing
      // behind the waiters. Here, that is nothing.
      this.declineWaits -= 1;
      return [200, { messages: [], total: 0 }];
    }

    const available = this.on(String(body["ern"] ?? "")).filter((message) => message.status === "AVAILABLE");
    const taken = available.slice(0, Number(body["maxCount"] ?? 10));
    taken.forEach((message, index) => {
      message.status = "INVISIBLE";
      message.receiptHandle = `receipt-${message.messageId}-${index}`;
      message.receivedCount += 1;
    });

    if (taken.length === 0 && wait > 0) {
      // The server holding the request open for the window it was asked for, which is what a client
      // must not abandon at its ordinary timeout.
      await delay(Math.min(wait * 1000, this.maxHoldMs));
    }
    return [200, { messages: taken, total: taken.length }];
  }

  #deleteMessage(request: RecordedRequest): [number, unknown] {
    const body = request.json();
    const handle = body["receiptHandle"];
    const messageId = body["messageId"];
    for (const [ern, messages] of this.messages) {
      const index = messages.findIndex(
        (message) =>
          (typeof handle === "string" && handle !== "" && message.receiptHandle === handle) ||
          (typeof messageId === "string" && messageId !== "" && message.messageId === messageId),
      );
      if (index >= 0) {
        const [removed] = messages.splice(index, 1);
        return [200, { messageId: removed!.messageId, queueErn: ern }];
      }
    }
    return [404, { error: "Message not found" }];
  }

  #getMessageCount(request: RecordedRequest): [number, unknown] {
    const ern = String(request.json()["ern"] ?? "");
    const messages = this.on(ern);
    const inState = (status: string): number => messages.filter((message) => message.status === status).length;
    return [
      200,
      {
        ern,
        available: inState("AVAILABLE"),
        delayed: inState("DELAYED"),
        invisible: inState("INVISIBLE"),
        total: messages.length,
      },
    ];
  }

  #listMessages(request: RecordedRequest): [number, unknown] {
    const messages = this.on(String(request.json()["queueErn"] ?? ""));
    return [200, { messages, total: messages.length }];
  }

  #purgeQueue(request: RecordedRequest): [number, unknown] {
    this.messages.delete(String(request.json()["ern"] ?? ""));
    return [200, {}];
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
