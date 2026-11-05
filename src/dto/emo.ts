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

import { documents, flag, number, object, stringMap, strings, text } from "./json.js";

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

// -- the metric catalog ----------------------------------------------------------------------------

/**
 * One metric the installation knows about, rather than one reading of it.
 *
 * `series` is how many distinct label combinations have been seen under this name, which is the figure
 * that decides what a metric costs: every series is its own stored row per step, forever. `labelNames`
 * says which labels those combinations are made of.
 */
export interface MetricCatalogEntry {
  name: string;
  /** `RATE` or `GAUGE`, in upper case, as a stored row spells it. */
  type: string;
  series: number;
  labelNames: string[];
  lastSeen: string;
}

/** What metrics exist, and how many there are in all. */
export interface MetricCatalog {
  total: number;
  items: MetricCatalogEntry[];
}

// -- alerts ----------------------------------------------------------------------------------------

/**
 * A threshold rule on one metric.
 *
 * `warning` and `critical` are `null` when the rule carries no threshold of that kind - at least one of
 * them is always set, and `null` is not zero: a rule alerting above 0 is a different thing from one with
 * no warning level at all.
 *
 * `resolution` is always `RAW`. A rule on the hourly or daily tier would be judging a rollup computed
 * minutes or hours after the fact, which is a report rather than an alert, and the server refuses it.
 */
export interface AlertRule {
  ruleId: string;
  /** The metric this rule judges. */
  name: string;
  /** The series it narrows to; empty watches every series of that metric. */
  labels: Record<string, string>;
  resolution: string;
  /** Which of a row's three figures is judged - see {@link import("../modules/emo.js").STATISTIC_MAX}. */
  statistic: string;
  /** Which side of the threshold is the wrong one - `ABOVE` or `BELOW`. */
  comparison: string;
  warning: number | null;
  critical: number | null;
  /** How many consecutive periods must breach before the alert fires, and how many must clear it. */
  forPeriods: number;
  clearPeriods: number;
  /** After how many silent periods a series counts as `NODATA`; zero never raises that. */
  noDataAfterPeriods: number;
  enabled: boolean;
  description: string;
  accountId: string;
  namespace: string;
  created: string;
  modified: string;
}

/**
 * Where one series stands against its rule, now.
 *
 * `state` is `OK`, `WARNING`, `CRITICAL` or `NODATA`, and `severity` is the server's own ordering of
 * those - worth sorting on rather than deriving, so a client and the server agree on what is worse.
 * `since` is when the series entered this state, which is what makes an alert that has been firing for
 * an hour tell itself apart from one that fired a moment ago.
 */
export interface Alert {
  ruleId: string;
  name: string;
  labels: Record<string, string>;
  state: string;
  severity: number;
  since: string;
  /** The reading that put it here. */
  value: number;
  lastSeen: string;
  statistic: string;
  comparison: string;
  warning: number | null;
  critical: number | null;
  description: string;
  namespace: string;
}

/**
 * One move from one state to another, as the history kept it.
 *
 * `previous` and `state` are the two ends of the move, `threshold` the figure that was crossed - `null`
 * for a transition no threshold caused, such as a series going quiet - and `reason` the server's own
 * words for why.
 */
export interface AlertTransition {
  ruleId: string;
  name: string;
  labels: Record<string, string>;
  previous: string;
  state: string;
  severity: number;
  value: number;
  threshold: number | null;
  statistic: string;
  reason: string;
  timestamp: string;
  accountId: string;
  namespace: string;
}

// -- dashboards ------------------------------------------------------------------------------------

/**
 * One saved dashboard layout.
 *
 * `dashboard` is opaque to this SDK and to euclid: whatever object a client saved is what it gets back,
 * stored as one JSON object and nothing more. Dashboards belong to the user who saved them.
 */
export interface Dashboard {
  name: string;
  dashboard: Record<string, unknown>;
  created: string;
  modified: string;
}

/** One dashboard in a listing - the name and the dates, without the panels. */
export interface DashboardSummary {
  name: string;
  created: string;
  modified: string;
}

/** A dashboard as it was saved: the name it is under, whose it is, and when it last changed. */
export interface SavedDashboard {
  name: string;
  userId: string;
  modified: string;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toMetricCatalogEntry(document: unknown): MetricCatalogEntry {
  return {
    name: text(document, "name"),
    type: text(document, "type"),
    series: number(document, "series"),
    labelNames: strings(document, "labelNames"),
    lastSeen: text(document, "lastSeen"),
  };
}

export function toMetricCatalog(document: unknown): MetricCatalog {
  return {
    total: number(document, "total"),
    items: documents(document, "items").map(toMetricCatalogEntry),
  };
}

export function toAlertRule(document: unknown): AlertRule {
  return {
    ruleId: text(document, "ruleId"),
    name: text(document, "name"),
    labels: stringMap(document, "labels"),
    resolution: text(document, "resolution"),
    statistic: text(document, "statistic"),
    comparison: text(document, "comparison"),
    warning: threshold(document, "warning"),
    critical: threshold(document, "critical"),
    forPeriods: number(document, "forPeriods"),
    clearPeriods: number(document, "clearPeriods"),
    noDataAfterPeriods: number(document, "noDataAfterPeriods"),
    // A rule is in force unless it says otherwise, which is what the server stores by default.
    enabled: flag(document, "enabled", true),
    description: text(document, "description"),
    accountId: text(document, "accountId"),
    namespace: text(document, "namespace"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toAlert(document: unknown): Alert {
  return {
    ruleId: text(document, "ruleId"),
    name: text(document, "name"),
    labels: stringMap(document, "labels"),
    state: text(document, "state"),
    severity: number(document, "severity"),
    since: text(document, "since"),
    value: number(document, "value"),
    lastSeen: text(document, "lastSeen"),
    statistic: text(document, "statistic"),
    comparison: text(document, "comparison"),
    warning: threshold(document, "warning"),
    critical: threshold(document, "critical"),
    description: text(document, "description"),
    namespace: text(document, "namespace"),
  };
}

export function toAlertTransition(document: unknown): AlertTransition {
  return {
    ruleId: text(document, "ruleId"),
    name: text(document, "name"),
    labels: stringMap(document, "labels"),
    previous: text(document, "previous"),
    state: text(document, "state"),
    severity: number(document, "severity"),
    value: number(document, "value"),
    threshold: threshold(document, "threshold"),
    statistic: text(document, "statistic"),
    reason: text(document, "reason"),
    timestamp: text(document, "timestamp"),
    accountId: text(document, "accountId"),
    namespace: text(document, "namespace"),
  };
}

export function toDashboard(document: unknown): Dashboard {
  return {
    name: text(document, "name"),
    dashboard: object(object(document)["dashboard"]),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toDashboardSummary(document: unknown): DashboardSummary {
  return {
    name: text(document, "name"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toSavedDashboard(document: unknown): SavedDashboard {
  return {
    name: text(document, "name"),
    userId: text(document, "userId"),
    modified: text(document, "modified"),
  };
}

/**
 * A threshold field: a number, or `null` for one the rule does not carry.
 *
 * Null rather than zero, because zero is a threshold somebody may well have set - a rule alerting above 0
 * is a different thing from a rule with no warning level - and `number()` could not tell them apart.
 */
function threshold(document: unknown, name: string): number | null {
  const value = object(document)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
