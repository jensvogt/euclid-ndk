/**
 * EKV - euclid's key-value store: tables of items, read by key rather than searched.
 *
 * One object, {@link EuclidEkv}, built from a session that has already logged in:
 *
 * ```ts
 * const ekv = session.ekv();
 * await ekv.createTable("sessions", "userId", { sortKey: "startedAt", sortKeyType: KEY_NUMBER });
 *
 * await ekv.putItem("sessions", { userId: "jens", startedAt: 1757462400, host: "laptop" });
 * const recent = await ekv.query("sessions", "jens", { sortOperator: SORT_GE, sortValue: 1757462400 });
 * ```
 *
 * A table is keyed on one attribute, or on two: a partition key that identifies an item, and optionally a
 * sort key that orders the items sharing a partition key - which is what makes a partition readable as a
 * range. The key attributes have declared types, and those are what make a range mean what it should: a
 * {@link KEY_NUMBER} sort key orders 2, 9, 10, 100 rather than putting "10" before "9". They cannot be
 * changed after the table is created.
 *
 * An item's other attributes are free-form documents - scalars, arrays, nested objects - and are not
 * declared anywhere. They are also not typed the way a queue message's attributes are: EKV stores what JSON
 * can express, so nothing here takes a {@link import("../dto/com.js").Variant}.
 */

import { toPage, type Page } from "../dto/eam.js";
import {
  toItem,
  toQueryResult,
  toScanResult,
  toTableDescription,
  type Item,
  type QueryResult,
  type ScanResult,
  type TableDescription,
} from "../dto/ekv.js";
import { EuclidServiceError } from "../errors.js";
import { listPayload, ModuleClient, type ListOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ekv";

/**
 * The types a key attribute can have. A table's keys are the only attributes with a declared type, and the
 * type is what a comparison is made under.
 */
export const KEY_STRING = "string";
export const KEY_NUMBER = "number";
export const KEY_BINARY = "binary";

/**
 * How {@link EuclidEkv.query} narrows by sort key. The default takes the whole partition; the rest need a
 * table that declares a sort key, and asking one that does not is refused with HTTP 400.
 */
export const WHOLE_PARTITION = "";
export const SORT_EQ = "eq";
export const SORT_LT = "lt";
export const SORT_LE = "le";
export const SORT_GT = "gt";
export const SORT_GE = "ge";
/** Takes a lower and an upper bound, both inclusive - see {@link EuclidEkv.query}. */
export const SORT_BETWEEN = "between";
/**
 * The one operator that is not a comparison, and so the one that applies to a string sort key only: a prefix
 * of a number or of a blob is not a thing.
 */
export const SORT_BEGINS_WITH = "begins-with";

/** HTTP 404, which is how a read says the item is not there - see {@link EuclidEkv.findItem}. */
const NOT_FOUND = 404;

/** What a table is keyed on, beyond the partition key every table has. */
export interface CreateTableOptions {
  /** {@link KEY_STRING}, {@link KEY_NUMBER} or {@link KEY_BINARY}. */
  partitionKeyType?: string;
  /**
   * The attribute items sharing a partition key are ordered by, which is what makes a partition readable as
   * a range. Left empty, the table has none and {@link EuclidEkv.query} can only take whole partitions.
   */
  sortKey?: string;
  /** The sort key's type, which decides what its ordering means. */
  sortKeyType?: string;
}

/** How a query narrows a partition, and in what order and quantity it reads it. */
export interface QueryOptions {
  /**
   * {@link SORT_EQ}, {@link SORT_LT}, {@link SORT_LE}, {@link SORT_GT}, {@link SORT_GE},
   * {@link SORT_BETWEEN} or {@link SORT_BEGINS_WITH}, or {@link WHOLE_PARTITION} for all of it.
   */
  sortOperator?: string;
  /** What to compare the sort key against - the lower bound for {@link SORT_BETWEEN}. */
  sortValue?: unknown;
  /** The upper bound, for {@link SORT_BETWEEN} only. */
  sortUpper?: unknown;
  /**
   * Whether to read in ascending sort-key order. Always sent, because the server reads an absent flag as
   * descending rather than as "unspecified".
   */
  forward?: boolean;
  /** The most items to return; 0 means no limit. */
  pageSize?: number;
  /** The zero-based page, applied when `pageSize` is set. */
  pageIndex?: number;
}

/** How much of a table a scan reads at a time. */
export interface ScanOptions {
  pageSize?: number;
  pageIndex?: number;
}

/**
 * EKV's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.ekv} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEkv extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  // -- tables ----------------------------------------------------------------------------------

  /**
   * Creates a table, and answers with it as it was created - with an item count of zero.
   *
   * Refused with HTTP 409 if a table of that name already exists, and with HTTP 400 if a key attribute is
   * empty, starts with `$`, contains `.`, or if the sort key names the same attribute as the partition key.
   *
   * @param name name of the table
   * @param partitionKey the attribute every item is identified by.
   * @param options table options
   */
  async createTable(
    name: string,
    partitionKey: string,
    options: CreateTableOptions = {},
  ): Promise<TableDescription> {
    return toTableDescription(
      await this.call("create-table", {
        name,
        partitionKey,
        partitionKeyType: options.partitionKeyType ?? KEY_STRING,
        sortKey: options.sortKey ?? "",
        sortKeyType: options.sortKeyType ?? KEY_STRING,
      }),
    );
  }

  /**
   * A table's key, and how many items it holds.
   *
   * The count is counted rather than looked up, so this is not free on a large table.
   */
  async describeTable(name: string): Promise<TableDescription> {
    return toTableDescription(await this.call("describe-table", { name }));
  }

  /** One page of tables, each described as {@link describeTable} would describe it. */
  async listTables(options: ListOptions = {}): Promise<Page<TableDescription>> {
    const response = await this.call("list-tables", listPayload(options, "name"));
    return toPage(response, "tables", toTableDescription);
  }

  /**
   * Deletes a table and every item in it, and answers with how many items went with it.
   *
   * There is no confirmation and nothing is kept.
   */
  async deleteTable(name: string): Promise<number> {
    return this.numberOf("delete-table", { name }, "deletedItems");
  }

  // -- items -----------------------------------------------------------------------------------

  /**
   * Writes an item, replacing whatever was stored under its key.
   *
   * It replaces rather than merges: an item written with two attributes has two attributes afterwards,
   * whatever it had before. So changing one field means reading the item, changing it and writing the whole
   * thing back - which is why {@link import("../dto/ekv.js").Item} keeps the server's timestamps out of its
   * attributes, where they would otherwise be written back as two attributes of the caller's own.
   *
   * The item has to carry the table's key attributes with the types the table declared for them, and no
   * attribute name may be empty, start with `$` or contain `.`.
   */
  async putItem(table: string, item: Record<string, unknown>): Promise<Item> {
    return toItem(await this.call("put-item", { table, item }));
  }

  /**
   * Reads one item by its key.
   *
   * The key names the table's key attributes and only those - the partition key alone where the table has no
   * sort key, both where it has one.
   *
   * An item that is not there is HTTP 404, and so a {@link EuclidServiceError} rather than an empty item:
   * "there is no such item" and "here is an item with nothing in it" are different, and a caller should not
   * have to tell them apart. Where a miss is an ordinary outcome, use {@link findItem}.
   */
  async getItem(table: string, key: Record<string, unknown>): Promise<Item> {
    return toItem(await this.call("get-item", { table, key }));
  }

  /**
   * The same read as {@link getItem}, answering null rather than throwing when there is no such item.
   *
   * Only a 404 becomes null. A refusal, a malformed key or a table that does not exist still throws, because
   * none of those mean "not there".
   */
  async findItem(table: string, key: Record<string, unknown>): Promise<Item | null> {
    try {
      return await this.getItem(table, key);
    } catch (error) {
      if (error instanceof EuclidServiceError && error.status === NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * Removes one item by its key, and says whether there was one to remove.
   *
   * False rather than an error for a key that names nothing: deleting what is not there has already achieved
   * what the caller asked for.
   */
  async deleteItem(table: string, key: Record<string, unknown>): Promise<boolean> {
    const response = await this.call("delete-item", { table, key });
    return response["deleted"] === true;
  }

  // -- reading many ----------------------------------------------------------------------------

  /**
   * Reads the items of one partition, in sort-key order.
   *
   * This is the lookup EKV is for: it addresses a partition by key rather than reading the table. Narrowing
   * by sort key needs a table that declares one, and asking one that does not for anything but
   * {@link WHOLE_PARTITION} is refused with HTTP 400.
   *
   * @param table name of the table
   * @param partitionKey the partition key's value, of the type the table declared for it.
   * @param options table options
   * @throws {Error} if {@link SORT_BETWEEN} was asked for without both bounds, which the server refuses
   *   anyway - this just says so before the round trip.
   */
  async query(table: string, partitionKey: unknown, options: QueryOptions = {}): Promise<QueryResult> {
    const sortOperator = options.sortOperator ?? WHOLE_PARTITION;
    if (sortOperator === SORT_BETWEEN && (options.sortValue === undefined || options.sortUpper === undefined)) {
      throw new Error("between needs both a sortValue and a sortUpper");
    }

    // Null rather than absent for the two bounds: JSON.stringify drops an undefined field altogether, and
    // the server reads the pair as sent rather than as defaulted.
    return toQueryResult(
      await this.call("query", {
        table,
        partitionKey,
        sortOperator,
        sortValue: options.sortValue ?? null,
        sortUpper: options.sortUpper ?? null,
        forward: options.forward ?? true,
        pageSize: options.pageSize ?? 0,
        pageIndex: options.pageIndex ?? 0,
      }),
    );
  }

  /**
   * Reads a table's items without regard to their key.
   *
   * This reads the table rather than an index: fine for a small table or an export, the wrong tool for a
   * lookup - {@link query} is that. A `pageSize` of 0 means no limit, so a scan of a large table with no
   * paging brings all of it back.
   */
  async scan(table: string, options: ScanOptions = {}): Promise<ScanResult> {
    const payload = { table, pageSize: options.pageSize ?? 0, pageIndex: options.pageIndex ?? 0 };
    return toScanResult(await this.call("scan", payload));
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * EKV's own metrics, as the server collects them. Answered unparsed - the shape belongs to the monitoring
   * module rather than to EKV.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}
