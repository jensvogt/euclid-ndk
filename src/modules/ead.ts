/**
 * EAD - euclid's audit module: what was run, by whom, and how it was answered.
 *
 * One object, {@link EuclidEad}, built from a session that has already logged in:
 *
 * ```ts
 * const ead = session.ead();
 *
 * const page = await ead.listEvents({ module: "esm", command: "delete-bucket", pageSize: 50 });
 * for (const event of page.events) console.log(event.created, event.userId, event.status);
 * ```
 *
 * **EAD only reads.** Every module records its own commands as it answers them, and that split is
 * deliberate: an audit whose write path ran through a separate module would be missing entries exactly
 * when that module was down - which is both the likeliest moment for something worth auditing and the
 * easiest thing for somebody to arrange.
 *
 * What the trail holds is the account, namespace, user, module and command, the parameters it carried
 * and the status it was answered with. Parameters have their sensitive values replaced *on the writing
 * side*, so there is no path by which a password reaches this collection at all.
 *
 * What it does not hold is worth knowing before reading a gap as a missing entry. Successful **reads**
 * are left out unless the installation's `euclid.modules.ead.audit-reads` asks for them: on a working
 * installation they outnumber everything else by orders of magnitude, and a trail that large buries
 * what it was kept for. And what flows *through* a resource rather than being one - a message, an
 * object, an item, an event, a part - is left out when the command succeeded, because the trail is
 * about the things somebody manages ("admin deleted queue X") while the traffic through them arrives at
 * a rate measured in tens of thousands. A **failure** is recorded whatever it was acting on.
 */

import { toAuditEvents, type AuditEvents } from "../dto/ead.js";
import { ModuleClient, type PageOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ead";

/**
 * How far a listing counts before it stops.
 *
 * A listing whose `total` is this and whose `totalExact` is false has at least this many matches - ask
 * {@link EuclidEad.countEvents} for the real figure.
 */
export const LIST_TOTAL_LIMIT = 100000;

/** What narrows a look at the trail. Naming nothing reads the whole of this account's. */
export interface AuditQuery extends PageOptions {
  /** One user's commands. */
  userId?: string;
  /** One module's: `esm`, `eam`, `eap`. */
  module?: string;
  /** One command, as it travels on the wire: `delete-bucket`. */
  command?: string;
}

/**
 * EAD's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.ead} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEad extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  /**
   * One page of the trail, newest first, scoped to this session's account.
   *
   * `total` is counted only as far as a pager needs it - see
   * {@link import("../dto/ead.js").AuditEvents.totalExact}, which says whether it is the real number
   * or a floor. {@link countEvents} is the exact one, and costs what an exact count costs.
   *
   * The page size defaults to the server's own ten rather than to everything, because a trail is the
   * one collection in euclid that only grows.
   */
  async listEvents(query: AuditQuery = {}): Promise<AuditEvents> {
    return toAuditEvents(await this.call("list-events", queryPayload(query)));
  }

  /**
   * How many entries match - the exact figure, however long it takes.
   *
   * The counterpart to a listing's capped `total`: this reads an index entry per match, so on a long
   * trail it is seconds of database time. Worth asking once for a figure somebody is going to read,
   * and not worth asking on every page somebody turns.
   */
  async countEvents(query: AuditQuery = {}): Promise<number> {
    return this.numberOf("count-events", queryPayload(query), "count");
  }

  /**
   * Removes every entry older than `olderThanDays`, and answers how many went.
   *
   * **Installation-wide, and not scoped to this account** - unlike {@link listEvents} and
   * {@link countEvents}, which only ever show the caller's own. This prunes the collection itself.
   *
   * A window is required and has to be positive: the server refuses a purge with none rather than
   * reading it as "everything", because a command that removed the whole trail by being called with no
   * arguments is the one mistake this call must not make easy.
   *
   * The purge is itself audited. A command that removes audit records is exactly the kind of thing an
   * audit is kept for, and its own entry lands in the trail it just pruned.
   */
  async purgeEvents(olderThanDays: number): Promise<number> {
    return this.numberOf("purge-events", { olderThanDays }, "removed");
  }

  /**
   * EAD's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to EAD.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}

/** A query as a request body, carrying only what narrows it. */
function queryPayload(query: AuditQuery): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (query.userId) payload["userId"] = query.userId;
  if (query.module) payload["module"] = query.module;
  if (query.command) payload["command"] = query.command;
  if (query.pageSize !== undefined) payload["pageSize"] = query.pageSize;
  if (query.pageIndex !== undefined) payload["pageIndex"] = query.pageIndex;
  return payload;
}
