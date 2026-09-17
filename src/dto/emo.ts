/**
 * The shapes EMO takes and sends back.
 *
 * The type of a metric is the one field here worth reading twice. It is not decoration: EMO rolls
 * five-minute rows into hourly ones and hourly into daily, and the type is what says whether that is a sum or
 * a mean. A counter pushed as a gauge is averaged into nonsense, and a gauge pushed as a rate is summed into
 * more of it - which is why {@link gaugeMetric} and {@link rateMetric} are how a metric is built rather than
 * filling the field in by hand.
 *
 * The same two types are spelled two ways, which is the server's doing rather than this SDK's: a push sends
 * `gauge` or `rate` in lower case - and reads anything that is not exactly `rate` as a gauge - while a listing
 * answers with `GAUGE` or `RATE` in upper case. Both spellings are named below, and neither is converted into
 * the other, so what this SDK says matches what euclid-cli sees.
 */

import { number, stringMap, text } from "./json.js";

/** What a push calls the two types. */
export const GAUGE = "gauge";
export const RATE = "rate";

/** What a listing calls them back. */
export const STORED_GAUGE = "GAUGE";
export const STORED_RATE = "RATE";

/**
 * Which rows a query reads: the five-minute ones as they were recorded, or a rollup of them.
 *
 * A graph of the last hour wants {@link RESOLUTION_RAW}; a year of them wants {@link RESOLUTION_DAY}, because
 * the raw rows behind it are both more than a chart can draw and more than EMO keeps.
 */
export const RESOLUTION_RAW = "RAW";
export const RESOLUTION_HOUR = "HOUR";
export const RESOLUTION_DAY = "DAY";

/** One measurement, on its way to EMO. */
export interface Metric {
  name: string;
  labels: Record<string, string>;
  value: number;
  /** {@link GAUGE} or {@link RATE}; the server reads anything that is not exactly `rate` as a gauge. */
  type: string;
}

/**
 * One row a listing answered with: what a series read, and over how many samples.
 *
 * `value` is the mean for a gauge and the sum for a rate, which is what `type` on the row is for. `minValue`
 * and `maxValue` are the extremes those samples reached and survive a rollup, so an hourly row still knows the
 * worst five minutes inside it.
 */
export interface MetricSample {
  name: string;
  labels: Record<string, string>;
  value: number;
  minValue: number;
  maxValue: number;
  samples: number;
  /** {@link STORED_GAUGE} or {@link STORED_RATE} - upper case, as a listing spells it. */
  type: string;
  resolution: string;
  timestamp: string;
}

/**
 * Which rows a listing or an average reads.
 *
 * Everything is optional and narrows what is read: a query that names nothing takes the most recent rows of
 * every series, which is what a first look at an installation wants and not what a graph does.
 */
export interface MetricQuery {
  name?: string;
  labels?: Record<string, string>;
  /** The most rows to answer with; none means the server's own limit. */
  limit?: number;
  /** The start of the window, as an ISO 8601 timestamp. */
  since?: string;
  /** The end of it. */
  until?: string;
  /** {@link RESOLUTION_RAW}, {@link RESOLUTION_HOUR} or {@link RESOLUTION_DAY}. */
  resolution?: string;
}

/**
 * Labels as the server reads them: an object of strings.
 *
 * Values are stringified rather than passed through, because that is what a dimension is. A number here would
 * split one series in two on nothing but its JSON spelling.
 */
export function metricLabels(labels: Record<string, unknown> | undefined): Record<string, string> {
  if (labels === undefined) return {};
  return Object.fromEntries(Object.entries(labels).map(([name, value]) => [name, String(value)]));
}

/** A value that stands on its own at the moment it was read. */
export function gaugeMetric(name: string, value: number, labels?: Record<string, unknown>): Metric {
  return { name, labels: metricLabels(labels), value, type: GAUGE };
}

/** A value accumulated over the interval this push covers. */
export function rateMetric(name: string, value: number, labels?: Record<string, unknown>): Metric {
  return { name, labels: metricLabels(labels), value, type: RATE };
}

/**
 * A query as a request body.
 *
 * Each field is left out entirely when it says nothing: the server reads an absent field as "do not narrow by
 * this", and an empty string as a name that matches nothing.
 */
export function metricQueryToJson(query: MetricQuery = {}): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  if (query.name) document["name"] = query.name;
  if (query.labels !== undefined && Object.keys(query.labels).length > 0) {
    document["labels"] = metricLabels(query.labels);
  }
  if (query.limit !== undefined && query.limit > 0) document["limit"] = query.limit;
  // `from` and `to` on the wire, `since` and `until` here: `from` is a reserved word in enough contexts to be
  // worth not making a caller write, and the pair reads as a window rather than as two unrelated fields.
  if (query.since) document["from"] = query.since;
  if (query.until) document["to"] = query.until;
  if (query.resolution) document["resolution"] = query.resolution;
  return document;
}

export function toMetricSample(document: unknown): MetricSample {
  return {
    name: text(document, "name"),
    labels: stringMap(document, "labels"),
    value: number(document, "value"),
    minValue: number(document, "minValue"),
    maxValue: number(document, "maxValue"),
    samples: number(document, "samples"),
    type: text(document, "type"),
    resolution: text(document, "resolution"),
    timestamp: text(document, "timestamp"),
  };
}
