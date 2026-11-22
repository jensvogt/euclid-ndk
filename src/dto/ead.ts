/**
 * The shapes EAD sends back.
 *
 * Parsed the same defensive way as every other module's, with one field left as it came: an event's
 * `parameters` is the request body the command carried, so it arrives as that object rather than being
 * read into a type - different commands carry different things.
 */

import { documents, flag, number, object, text } from "./json.js";

/**
 * One command somebody ran, as the audit trail recorded it.
 *
 * Written by the module that answered the command rather than by EAD - which is the point: an audit
 * whose write path ran through a separate module would be missing entries exactly when that module was
 * down, which is both the likeliest moment for something worth auditing and the easiest thing for
 * somebody to arrange.
 */
export interface AuditEvent {
  accountId: string;
  namespace: string;
  /** Who ran it. */
  userId: string;
  /** Which module answered it: `esm`, `eam`, `eap`. */
  module: string;
  /** The action, as it travelled on the wire: `delete-queue`, `create-user`. */
  command: string;
  /**
   * The request body it carried, with sensitive values already replaced - on the writing side, so
   * there is no path by which a password reaches this collection at all.
   */
  parameters: Record<string, unknown>;
  /** The HTTP status it was answered with, as text. */
  status: string;
  created: string;
}

/**
 * One page of the trail, and how many entries match.
 *
 * `totalExact` is what makes `total` honest. An exact count means reading an index entry per matching
 * event, and on a trail of tens of millions that is seconds of database time spent beside a page of
 * fifty - paid again on every page somebody turns. So a listing counts only as far as a pager needs:
 * `totalExact` false means there are *at least* `total` entries, which is enough to know there is a
 * next page. {@link import("../modules/ead.js").EuclidEad.countEvents} is where the real number is.
 */
export interface AuditEvents {
  total: number;
  totalExact: boolean;
  events: AuditEvent[];
}
// -- parsers ---------------------------------------------------------------------------------------

export function toAuditEvent(document: unknown): AuditEvent {
  return {
    accountId: text(document, "accountId"),
    namespace: text(document, "namespace"),
    userId: text(document, "userId"),
    module: text(document, "module"),
    command: text(document, "command"),
    // The command's own request body, left as it was recorded.
    parameters: object(object(document)["parameters"]),
    status: text(document, "status"),
    created: text(document, "created"),
  };
}

export function toAuditEvents(document: unknown): AuditEvents {
  return {
    total: number(document, "total"),
    // True when the server did not say: a server too old to report it counted exactly, which is what
    // the field was added to stop it doing.
    totalExact: flag(document, "totalExact", true),
    events: documents(document, "events").map(toAuditEvent),
  };
}
