/**
 * EDS - euclid's domain name service: the zones it answers for, and the records in them.
 *
 * One object, {@link EuclidEds}, built from a session that has already logged in:
 *
 * ```ts
 * const eds = session.eds();
 *
 * const zone = await eds.createZone("example.com", { description: "the public zone" });
 * await eds.putRecord("example.com", "www", RECORD_A, ["192.0.2.10"]);
 * ```
 *
 * Two servers in one process, and only one of them is here. The module API - this client - manages zones
 * and records with the usual credentials and grants. The DNS side listens on a UDP and a TCP port and
 * answers anybody who asks, because DNS has no credentials: it serves these zones, the names euclid
 * gives what it runs, and forwards everything else upstream for the networks allowed to recurse.
 *
 * **A write here is not immediately a write there.** The DNS side never reads the database on a query -
 * it answers from a catalogue it holds in memory - so a record written through this client is answered
 * within a moment on the instance that took the write, and within the installation's
 * `euclid.modules.eds.refresh-seconds` on any other. {@link EuclidEds.getAnswer} asks the catalogue
 * rather than the database, which is what makes it the way to check whether a change has landed.
 *
 * Zones and records belong to the session's account, and a zone of another account's is a 404 rather
 * than a refusal - the way a listing would not have shown it either.
 */

import {
  toDnsAnswer,
  toDnsRecord,
  toHostedZone,
  type DnsAnswer,
  type DnsRecord,
  type HostedZone,
} from "../dto/eds.js";
import { toPage, type Page } from "../dto/eam.js";
import { ModuleClient, type PageOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "eds";

/**
 * The record types EDS stores. Matched case-insensitively by the server, and anything else is refused.
 *
 * What a value looks like is the type's business, and the forms are the zone-file ones without the
 * quoting: an address for {@link RECORD_A} and {@link RECORD_AAAA}, a target name for
 * {@link RECORD_CNAME}, {@link RECORD_NS} and {@link RECORD_PTR}, `"10 mail.example.com"` for
 * {@link RECORD_MX}, `"10 5 8080 host.example.com"` - priority, weight, port, target - for
 * {@link RECORD_SRV}, and any text for {@link RECORD_TXT}, which the server splits into 255-byte
 * strings when it is longer than one.
 */
export const RECORD_A = "A";
export const RECORD_AAAA = "AAAA";
export const RECORD_CNAME = "CNAME";
export const RECORD_MX = "MX";
export const RECORD_NS = "NS";
export const RECORD_PTR = "PTR";
export const RECORD_SRV = "SRV";
export const RECORD_TXT = "TXT";

/**
 * The owner name that means the zone itself - its apex.
 *
 * `""` means the same thing, and both are written out as the zone's own name. A record at the apex is
 * what an `example.com` with no label in front of it resolves to.
 */
export const ZONE_APEX = "@";

/** The TTL a zone created without one is given, in seconds. */
export const DEFAULT_ZONE_TTL = 300;

/** The longest TTL RFC 2181 §8 allows, which is what the server refuses anything above. */
export const MAX_TTL = 2147483647;

/** What a {@link DnsAnswer} says happened. */
export const RCODE_NOERROR = "NOERROR";
/** The zone is EDS's, and the name in it does not exist. */
export const RCODE_NXDOMAIN = "NXDOMAIN";
export const RCODE_SERVFAIL = "SERVFAIL";
/** The name is in no zone of this account's: not an error, just not ours to answer. */
export const RCODE_REFUSED = "REFUSED";

/** What a zone says beyond its name. */
export interface CreateZoneOptions {
  /**
   * The TTL its records follow when they carry none of their own, in seconds. Zero - the default -
   * stores {@link DEFAULT_ZONE_TTL}; anything above {@link MAX_TTL} is refused.
   */
  ttl?: number;
  description?: string;
}

/** How a zone listing is narrowed and paged. */
export interface ListZonesOptions extends PageOptions {
  /** Only the zones whose name starts with this. */
  prefix?: string;
}

/** Which of a zone's records to list. Naming neither lists the whole zone. */
export interface ListRecordsOptions extends PageOptions {
  /** One owner name - a label, a qualified name, or {@link ZONE_APEX} for the zone itself. */
  name?: string;
  /** One record type. */
  type?: string;
}

/**
 * EDS's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.eds} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEds extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  // -- zones -----------------------------------------------------------------------------------

  /**
   * Creates a zone this account answers for.
   *
   * The name is normalised - lower-cased, and the trailing dot dropped - so `Example.COM.` and
   * `example.com` are the same zone, and the second is what comes back. One that already exists is
   * HTTP 409, and one that is not a domain name at all is 400 rather than a zone nothing can resolve.
   *
   * **The service domain is not available.** euclid gives what it runs names of its own under
   * `euclid.modules.eds.service-domain` - `euclid.internal` unless an installation changed it - and a
   * zone inside that is refused with 400: those names are answered from what the manager is running,
   * and a zone over them would shadow the thing it is named after.
   *
   * A new zone holds no records. Its SOA and its NS records at the apex are the server's own and are
   * not stored here, which is also why {@link putRecord} refuses a CNAME at the apex.
   */
  async createZone(name: string, options: CreateZoneOptions = {}): Promise<HostedZone> {
    return toHostedZone(
      await this.call("create-zone", {
        name,
        ttl: options.ttl ?? 0,
        description: options.description ?? "",
      }),
    );
  }

  /** One zone, with how many record sets it holds. A zone of another account is HTTP 404. */
  async getZone(name: string): Promise<HostedZone> {
    return toHostedZone(await this.call("get-zone", { name }));
  }

  /**
   * One page of this account's zones, in this session's namespace, and how many there are in total.
   *
   * Each entry carries its own `recordCount`, which the server counts per zone as it lists them - so a
   * listing of an installation with very large zones costs more than a listing of one without.
   */
  async listZones(options: ListZonesOptions = {}): Promise<Page<HostedZone>> {
    const payload = {
      prefix: options.prefix ?? "",
      pageSize: options.pageSize ?? 0,
      pageIndex: options.pageIndex ?? 0,
    };
    return toPage(await this.call("list-zones", payload), "zones", toHostedZone);
  }

  /**
   * Deletes a zone and every record in it, and answers with how many records went.
   *
   * There is no "only if empty" here: a zone is deleted with its records or not at all. The count is
   * what was removed, which is the only figure anybody can be given afterwards - and the number to
   * look at twice before deleting a zone somebody is resolving against.
   */
  async deleteZone(name: string): Promise<number> {
    return this.numberOf("delete-zone", { name }, "deletedRecords");
  }

  // -- records ---------------------------------------------------------------------------------

  /**
   * Writes one record set: every value at one name for one type.
   *
   * **This replaces the set rather than adding to it.** Three A values at one name are one answer with
   * three addresses, so writing one value where three were stored leaves one - which is what a caller
   * adding an address has to allow for by sending the whole list. An empty list is refused rather than
   * read as a delete; {@link deleteRecord} is that.
   *
   * `name` may be a label, a qualified name or {@link ZONE_APEX}. A label is completed with the zone -
   * `www` in `example.com` becomes `www.example.com` - and a qualified name outside the zone is
   * refused rather than silently re-homed. What comes back is always the qualified form.
   *
   * Two refusals are the protocol's rather than euclid's: a CNAME has exactly one value, and the zone
   * apex cannot be one at all, because the apex holds the zone's SOA and NS records and a CNAME beside
   * them would make the zone unanswerable.
   *
   * @param zone the zone to write in
   * @param name the owner name, or {@link ZONE_APEX} for the zone itself
   * @param type {@link RECORD_A} and its siblings
   * @param values every value this set should have afterwards, in presentation form
   * @param ttl this set's own TTL in seconds; 0 follows the zone's
   */
  async putRecord(
    zone: string,
    name: string,
    type: string,
    values: readonly string[],
    ttl = 0,
  ): Promise<DnsRecord> {
    return toDnsRecord(await this.call("put-record", { zone, name, type, ttl, values: [...values] }));
  }

  /**
   * One page of a zone's records, and how many match in total.
   *
   * `name` and `type` narrow it; naming neither lists the zone. A name is completed with the zone the
   * way {@link putRecord} completes one.
   */
  async listRecords(zone: string, options: ListRecordsOptions = {}): Promise<Page<DnsRecord>> {
    const payload = {
      zone,
      name: options.name ?? "",
      type: options.type ?? "",
      pageSize: options.pageSize ?? 0,
      pageIndex: options.pageIndex ?? 0,
    };
    return toPage(await this.call("list-records", payload), "records", toDnsRecord);
  }

  /**
   * Removes one record set - every value at that name for that type.
   *
   * The type is required: a name usually holds more than one type, and a delete that took a name alone
   * would remove more than whoever wrote it meant. A name and type holding nothing is HTTP 404 rather
   * than a success that removed nothing.
   */
  async deleteRecord(zone: string, name: string, type: string): Promise<void> {
    await this.call("delete-record", { zone, name, type });
  }

  // -- resolving -------------------------------------------------------------------------------

  /**
   * What EDS would answer a DNS query with - asked over the module API, without a DNS client.
   *
   * This reads the **catalogue the DNS side serves from**, not the database, which is what makes it
   * the way to check that a change has landed: a record written a moment ago is in it on this instance
   * and not yet on another, exactly as a resolver would find.
   *
   * It is also the way to read what is not stored anywhere: the zone's own SOA and NS records, and the
   * names euclid gives what it runs. Nothing is forwarded upstream here - `authoritative: false` with
   * `rcode: REFUSED` is what a name in no zone of this account's answers, where the DNS port would
   * have forwarded it for a client allowed to recurse.
   *
   * @param name the name to resolve, qualified
   * @param type the type to ask for; `A` when left out, as a resolver's default is
   */
  async getAnswer(name: string, type = ""): Promise<DnsAnswer> {
    return toDnsAnswer(await this.call("get-answer", { name, type }));
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * EDS's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to EDS.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}
