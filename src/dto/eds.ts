/**
 * The shapes EDS sends back.
 *
 * Parsed the same defensive way as every other module's. The thing to know about the names in here is
 * that DNS has its own: a record's `name` is the fully qualified owner name the server stored, not the
 * short label a caller wrote - `www` in the zone `example.com` comes back as `www.example.com`. So a
 * caller that wrote a label and compares it with what comes back has to compare against the qualified
 * form, which is why this parser never shortens one.
 */

import { documents, flag, number, strings, text } from "./json.js";

/**
 * One hosted zone: a domain EDS answers for authoritatively.
 *
 * `serial` is derived from the zone's modification time rather than counted, so it rises whenever the
 * zone or its records change and never needs an operator to bump it. That is what a secondary would
 * compare, and it is why editing a record is enough to make one re-transfer.
 */
export interface HostedZone {
  /** The zone's own name, normalised - lower case, and without the trailing dot. */
  name: string;
  ern: string;
  namespace: string;
  /**
   * The TTL records of this zone are given when they carry none of their own, in seconds. A zone
   * created without one gets {@link import("../modules/eds.js").DEFAULT_ZONE_TTL}.
   */
  ttl: number;
  description: string;
  /** How many record sets the zone holds. Counted when asked for rather than stored on the zone. */
  recordCount: number;
  serial: number;
  created: string;
  modified: string;
}

/**
 * One record set: every value stored at one name for one type.
 *
 * A record in DNS is a *set* rather than a row - three A values at one name are one answer with three
 * addresses, not three answers - which is why `values` is a list and why writing one replaces all of
 * them. See {@link import("../modules/eds.js").EuclidEds.putRecord}.
 */
export interface DnsRecord {
  /** The zone this set belongs to. */
  zone: string;
  /** The fully qualified owner name, which for the zone's own apex is the zone name itself. */
  name: string;
  /** `A`, `AAAA`, `CNAME`, `MX`, `NS`, `PTR`, `SRV` or `TXT`. */
  type: string;
  /** This set's own TTL in seconds, or 0 to follow the zone's. */
  ttl: number;
  /**
   * The values, in the zone-file presentation form without the quoting: `192.0.2.1` for an A,
   * `10 mail.example.com` for an MX, `10 5 8080 host.example.com` for an SRV.
   */
  values: string[];
  created: string;
  modified: string;
}

/**
 * One record as an answer carries it: a single value rather than a set.
 *
 * A resolver answers record by record, so a set of three addresses arrives here as three entries that
 * share a name and a type - the opposite of how {@link DnsRecord} stores them.
 */
export interface AnswerRecord {
  name: string;
  type: string;
  ttl: number;
  value: string;
}

/**
 * What EDS would answer a DNS query with, without a DNS client.
 *
 * `authoritative` false means the name is in no zone of this account's, and `rcode` is then `REFUSED`:
 * the DNS port would forward such a query upstream or refuse it, and this says which zone is missing
 * rather than guessing. `NXDOMAIN` is the other kind of nothing - the zone is EDS's, and the name in it
 * does not exist.
 *
 * `authority` carries what a real answer would put in its authority section: the zone's NS records for
 * a delegation, or its SOA for an NXDOMAIN - which is where a resolver reads the negative-caching TTL.
 */
export interface DnsAnswer {
  name: string;
  type: string;
  authoritative: boolean;
  /** The zone that answered, empty when none did. */
  zone: string;
  /** `NOERROR`, `NXDOMAIN`, `SERVFAIL` or `REFUSED`. */
  rcode: string;
  answers: AnswerRecord[];
  authority: AnswerRecord[];
}

// -- parsers ---------------------------------------------------------------------------------------

export function toHostedZone(document: unknown): HostedZone {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    namespace: text(document, "namespace"),
    ttl: number(document, "ttl"),
    description: text(document, "description"),
    recordCount: number(document, "recordCount"),
    serial: number(document, "serial"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toDnsRecord(document: unknown): DnsRecord {
  return {
    zone: text(document, "zone"),
    name: text(document, "name"),
    type: text(document, "type"),
    ttl: number(document, "ttl"),
    values: strings(document, "values"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toAnswerRecord(document: unknown): AnswerRecord {
  return {
    name: text(document, "name"),
    type: text(document, "type"),
    ttl: number(document, "ttl"),
    value: text(document, "value"),
  };
}

export function toDnsAnswer(document: unknown): DnsAnswer {
  return {
    name: text(document, "name"),
    type: text(document, "type"),
    authoritative: flag(document, "authoritative"),
    zone: text(document, "zone"),
    rcode: text(document, "rcode"),
    answers: documents(document, "answers").map(toAnswerRecord),
    authority: documents(document, "authority").map(toAnswerRecord),
  };
}
