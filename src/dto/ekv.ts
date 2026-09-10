/**
 * The shapes EKV sends back.
 *
 * Parsed the same defensive way as every other module's. One thing is not just parsed but rearranged: the
 * server stores an item's timestamps as two ordinary attributes, `_created` and `_modified`, and
 * {@link toItem} lifts them out. Leaving them in would mean an item read, changed and written back acquires
 * two attributes it never had - and since a write replaces rather than merges, they would stick.
 */

import { documents, number, object, text } from "./json.js";

/** The attributes the server keeps an item's timestamps in, and which {@link toItem} takes back out. */
export const CREATED_ATTRIBUTE = "_created";
export const MODIFIED_ATTRIBUTE = "_modified";

/**
 * One stored item: its attributes, and when it was written.
 *
 * The attributes are plain values - strings, numbers, booleans, arrays, nested objects - not the tagged
 * {@link import("./com.js").Variant} that EQS, ENS and ESM attributes use. EKV stores documents rather than
 * typed attribute maps, and only a table's key attributes have a declared type.
 *
 * `attributes` is the object itself, which is what to pass back to
 * {@link import("../modules/ekv.js").EuclidEkv.putItem} - the timestamps are deliberately not in it.
 */
export interface Item {
  attributes: Record<string, unknown>;
  created: string;
  modified: string;
}

/**
 * A table: what it is keyed on, and how many items it holds.
 *
 * `sortKey` is empty for a table that has none, which is also what says that
 * {@link import("../modules/ekv.js").EuclidEkv.query} cannot narrow by sort key on this table.
 *
 * `itemCount` is counted rather than looked up, so describing a large table is not free.
 */
export interface TableDescription {
  name: string;
  ern: string;
  partitionKey: string;
  /** `string`, `number` or `binary` - see {@link import("../modules/ekv.js")}. */
  partitionKeyType: string;
  sortKey: string;
  sortKeyType: string;
  itemCount: number;
  created: string;
  modified: string;
}

/**
 * The items of one partition that matched, in the order they were asked for.
 *
 * `count` is how many came back rather than how many exist, which is why this is not one of the pages the
 * rest of this SDK answers listings with: a query knows what it returned and the server does not count the
 * partition to tell you what it did not.
 */
export interface QueryResult {
  items: Item[];
  count: number;
}

/**
 * A page of a table's items, and how many the table holds in total.
 *
 * `count` is what came back and `total` what there is - the pair a caller pages against.
 */
export interface ScanResult {
  items: Item[];
  count: number;
  total: number;
}

// -- parsers ---------------------------------------------------------------------------------------

/** One item, with its two timestamp attributes lifted out of the rest. */
export function toItem(document: unknown): Item {
  const attributes = { ...object(document) };
  const created = text(document, CREATED_ATTRIBUTE);
  const modified = text(document, MODIFIED_ATTRIBUTE);
  delete attributes[CREATED_ATTRIBUTE];
  delete attributes[MODIFIED_ATTRIBUTE];
  return { attributes, created, modified };
}

export function toTableDescription(document: unknown): TableDescription {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    partitionKey: text(document, "partitionKey"),
    partitionKeyType: text(document, "partitionKeyType"),
    sortKey: text(document, "sortKey"),
    sortKeyType: text(document, "sortKeyType"),
    itemCount: number(document, "itemCount"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toQueryResult(document: unknown): QueryResult {
  const items = documents(document, "items").map(toItem);
  // Falling back to what arrived keeps a sparse answer self-consistent.
  return { items, count: number(document, "count") || items.length };
}

export function toScanResult(document: unknown): ScanResult {
  const items = documents(document, "items").map(toItem);
  return { items, count: number(document, "count") || items.length, total: number(document, "total") };
}
