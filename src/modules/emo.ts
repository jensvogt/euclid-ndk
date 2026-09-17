/**
 * EMO - euclid's monitoring module: the metrics an installation keeps, and the way an application adds its own
 * to them.
 *
 * One object, {@link EuclidEmo}, built from a session that has already logged in:
 *
 * ```ts
 * const emo = session.emo();
 * await emo.pushMetrics("invoice-parser", [rateMetric("invoices.parsed", 41), gaugeMetric("queue.depth", 7)]);
 * ```
 *
 * euclid's own modules push their samples here on their own schedule rather than being polled, because a
 * module the autoscaler is tearing down cannot answer a poll - it simply stops pushing. An application is in
 * the same position, and pushing puts the decision about what is worth publishing where it belongs: in the
 * application, which is the only thing that knows.
 *
 * What lands here lands in the same rows EMO's own collectors write, and therefore in the same rollups, the
 * same retention and the same graphs as CPU, memory and the module gauges.
 *
 * **Measuring rather than pushing.** {@link EuclidEmo.pushMetrics} takes numbers that are already final. An
 * application that wants to count requests and time them wants {@link MeterRegistry} instead, which
 * accumulates meters in the process and pushes them on a step - what a Micrometer registry does in euclid-jdk,
 * what euclid-pdk's registry does, and what euclid's own C++ modules do with `Core::Monitoring`.
 *
 * {@link EuclidEmo.listMetrics} and {@link EuclidEmo.average} are administrator-only, server-side: an
 * application publishes its own numbers without special rights, and reading everybody's is a different
 * question.
 */

import {
  gaugeMetric,
  metricQueryToJson,
  rateMetric,
  toMetricSample,
  type Metric,
  type MetricQuery,
  type MetricSample,
} from "../dto/emo.js";
import { documents } from "../dto/json.js";
import { ModuleClient } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "emo";

/** How long a step is unless one is given, in milliseconds - the minute euclid-jdk's registry defaults to. */
export const DEFAULT_STEP_MS = 60_000;

/** What a registry is built with beyond the name it reports under. */
export interface RegistryOptions {
  /**
   * How long a step is, in milliseconds: how much a counter accumulates before it is published and started
   * again. Zero starts no timer at all and leaves publishing to whoever calls {@link MeterRegistry.publish} -
   * for an application with a loop of its own, and for a test.
   */
  stepMs?: number;
  /**
   * Labels added to every metric this registry publishes - the host, the instance, the version. A label on a
   * meter of the same name wins.
   */
  commonLabels?: Record<string, unknown>;
  /** Whether closing publishes the step in hand rather than dropping it. */
  publishOnClose?: boolean;
}

/**
 * EMO's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.emo} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEmo extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  /**
   * Pushes a batch of measurements, reported under one name.
   *
   * An empty batch is not sent at all: there is nothing to record, and a request that says so is a round trip
   * for nothing - which matters here more than elsewhere, since a push usually runs on a timer forever.
   *
   * @param module what is reporting. An application's own ID is the useful value: it is how a reader tells one
   *   pool's numbers from another's, and it is what a listing filters on.
   * @param metrics the batch. Every metric's type decides how it is rolled up - a rate is summed and a gauge
   *   averaged - so a counter pushed as a gauge is averaged into nonsense.
   */
  async pushMetrics(module: string, metrics: Iterable<Metric>): Promise<void> {
    const items = [...metrics];
    if (items.length === 0) return;
    await this.call("push-metrics", { module, items });
  }

  /**
   * The rows a query matches, most recent first. Administrator-only, server-side.
   *
   * Sent as `list`, which is the action's name on the wire; spelled out here because a listing of metrics is
   * what it is, and because {@link ModuleClient.call} is there for the wire name.
   */
  async listMetrics(query: MetricQuery = {}): Promise<MetricSample[]> {
    const response = await this.call("list", metricQueryToJson(query));
    return documents(response, "items").map(toMetricSample);
  }

  /**
   * The mean of the values a query matches, over the window it names.
   *
   * One number rather than the rows behind it, for the question a dashboard tile asks. It is weighted by how
   * many samples each row was made of, so an hourly row of six hundred counts for more than a raw one of one.
   * Administrator-only, as {@link listMetrics} is.
   */
  async average(query: MetricQuery = {}): Promise<number> {
    const value = (await this.call("average", metricQueryToJson(query)))["average"];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /**
   * A {@link MeterRegistry} publishing through this client.
   *
   * The way in, rather than building one by hand: an application that measures anything wants meters and a
   * step, not a batch of final numbers.
   */
  registry(module: string, options: RegistryOptions = {}): MeterRegistry {
    return new MeterRegistry(this, module, options);
  }

  /**
   * EMO's own metrics, as the server collects them. Answered unparsed - the shape belongs to the monitoring
   * module rather than to a caller of it.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}

// -- meters ------------------------------------------------------------------------------------------
//
// What an application records into, between one publish and the next. No locking anywhere in here, which is
// not an omission: node runs this on one thread, so `+= 1` cannot interleave with another increment the way it
// can in euclid-jdk and euclid-pdk, where the same meters are written with a lock.

/**
 * A count of things that happened, reported per step and then started again.
 *
 * A handle rather than the meter itself: the registry owns what this points at, so asking for the same name
 * and labels twice gives two handles onto one count.
 */
export class Counter {
  #value = 0;

  /** Counts one more, or `amount` more. */
  increment(amount = 1): void {
    this.#value += amount;
  }

  /** What has accumulated since the last publish. For a test or a log line - the registry reads and resets it. */
  get count(): number {
    return this.#value;
  }

  /** What accumulated, and start again - which is what makes a counter a rate. */
  take(): number {
    const value = this.#value;
    this.#value = 0;
    return value;
  }
}

/**
 * A value that stands on its own whenever it is read - a queue depth, a pool size.
 *
 * Not reset by a publish, because a gauge is what it is rather than what happened: a depth of nine is still
 * nine after somebody has looked at it.
 */
export class Gauge {
  #value = 0;

  /** Sets what this gauge reads now. */
  set(value: number): void {
    this.#value = value;
  }

  /** What it last read. */
  get value(): number {
    return this.#value;
  }
}

/**
 * How long something took, and how often it was done.
 *
 * Three ways to record one, and the last two are why this is worth having over a stopwatch written by hand - a
 * timing taken after the work is a timing that is not taken when the work throws:
 *
 * ```ts
 * timer.record(elapsedSeconds);                 // a duration something else measured
 * await timer.time(() => parse(invoice));       // this call, however it settles
 *
 * const stop = timer.start();                   // a span that ends somewhere else
 * try { parse(invoice); } finally { stop(); }
 * ```
 *
 * Published as three series, named the way euclid-jdk's Micrometer registry names them so that a Node
 * application's timings graph beside a Java one's: `<name>.count` and `<name>.total` as rates, and
 * `<name>.max` as a gauge.
 *
 * **Durations are given in seconds and published in milliseconds.** Seconds because that is what a duration is
 * in most of what an application measures; milliseconds because that is the base unit euclid-jdk publishes in
 * and the one euclid's own modules time in, and two SDKs reporting the same operation in different units would
 * not be comparable.
 *
 * There are no percentiles, which is a property of where this goes rather than an omission: EMO stores one
 * value per series per interval, so a p99 would have to be computed here and pushed as a series of its own.
 * The count, the total and the worst case are what the JDK registry publishes too.
 */
export class Timer {
  #count = 0;
  #total = 0;
  #max = 0;

  /** Records one timing, in **seconds**. */
  record(elapsedSeconds: number): void {
    const milliseconds = elapsedSeconds * 1000;
    this.#count += 1;
    this.#total += milliseconds;
    this.#max = Math.max(this.#max, milliseconds);
  }

  /**
   * Starts a span, and answers with what ends it. Calling that twice records once: a span that has already
   * been closed has nothing left to measure.
   */
  start(): () => void {
    const started = performance.now();
    let recorded = false;
    return () => {
      if (recorded) return;
      recorded = true;
      this.record((performance.now() - started) / 1000);
    };
  }

  /**
   * Times one piece of work, whether it returns a value or a promise, and records it however it settles - a
   * call that failed slowly is exactly the one worth having timed, so a rejection is timed and then rethrown.
   */
  async time<T>(work: () => T | Promise<T>): Promise<T> {
    const stop = this.start();
    try {
      return await work();
    } finally {
      stop();
    }
  }

  /** How many timings since the last publish. */
  get count(): number {
    return this.#count;
  }

  /** Count, total and worst case in milliseconds, and start again. */
  take(): { count: number; total: number; max: number } {
    const taken = { count: this.#count, total: this.#total, max: this.#max };
    this.#count = 0;
    this.#total = 0;
    this.#max = 0;
    return taken;
  }
}

/**
 * The meters an application keeps, and the timer that pushes them to EMO.
 *
 * ```ts
 * const metrics = session.emo().registry("invoice-parser", { commonLabels: { host } });
 * const parsed = metrics.counter("invoices.parsed");
 * const failed = metrics.counter("invoices.parsed", { outcome: "failed" });
 * const duration = metrics.timer("invoice.parse");
 * metrics.gaugeFrom("queue.depth", () => queue.length);
 *
 * try {
 *   for (const invoice of incoming) {
 *     await duration.time(async () => ((await parse(invoice)) ? parsed : failed).increment());
 *   }
 * } finally {
 *   await metrics.close();
 * }
 * ```
 *
 * **What a step means.** A counter and a timer report what accumulated since the last publish and start again,
 * which is what makes them rates to EMO - the thing a rollup sums. A gauge reports what it reads at the moment
 * of publishing and is not reset. Every registered meter is published every step, including the ones that did
 * not move: a zero is a fact, and a gap in a graph is not.
 *
 * **What it costs.** Every meter is one stored row per step, forever - so the number of label combinations is
 * the number of series, and a label carrying a request ID or a customer name is how a monitoring database is
 * filled up. Decide the labels where the meter is created, which is the one place that can.
 *
 * **Failure.** A push that fails is counted in {@link failedPublishes} and the batch is dropped. It is not
 * retried: a rate sent twice is counted twice, and a monitoring system that lies about throughput is worse
 * than one with a gap in it. Nothing here rejects at the application - a process does not stop because it
 * could not say how it was doing.
 */
export class MeterRegistry {
  readonly #emo: EuclidEmo;
  readonly #module: string;
  readonly #commonLabels: Record<string, string>;
  readonly #counters = new Map<string, { labels: Record<string, string>; meter: Counter }>();
  readonly #gauges = new Map<string, { labels: Record<string, string>; meter: Gauge }>();
  readonly #timers = new Map<string, { labels: Record<string, string>; meter: Timer }>();
  readonly #suppliers = new Map<string, { labels: Record<string, string>; name: string; read: () => number }>();

  #publishOnClose: boolean;
  #timer: ReturnType<typeof setInterval> | null = null;
  #publishes = 0;
  #failed = 0;

  /**
   * @param emo the client the batches are pushed through.
   * @param module what this reports under - an application's own ID.
   * @throws {Error} if no module name is given. A batch has to say what is reporting, and the server refuses
   *   one that does not.
   */
  constructor(emo: EuclidEmo, module: string, options: RegistryOptions = {}) {
    if (!module) throw new Error("a metrics registry has to say what is reporting - give it a module name");

    this.#emo = emo;
    this.#module = module;
    this.#commonLabels = labelsOf(options.commonLabels);
    this.#publishOnClose = options.publishOnClose ?? true;

    const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
    if (stepMs > 0) {
      this.#timer = setInterval(() => void this.publish(), stepMs);
      // Publishing is not a reason for a process to stay alive: a script that has finished its work should
      // exit, and a server that is shutting down should not wait out a step first.
      this.#timer.unref();
    }
  }

  /**
   * The counter of this name and these labels, creating it the first time.
   *
   * Asking again for the same pair answers the same meter, so a handle need not be passed around - though
   * keeping one is cheaper than looking it up on a hot path.
   */
  counter(name: string, labels?: Record<string, unknown>): Counter {
    return meterOf(this.#counters, name, labels, () => new Counter());
  }

  /** The gauge of this name and these labels, creating it the first time. */
  gauge(name: string, labels?: Record<string, unknown>): Gauge {
    return meterOf(this.#gauges, name, labels, () => new Gauge());
  }

  /** The timer of this name and these labels, creating it the first time. */
  timer(name: string, labels?: Record<string, unknown>): Timer {
    return meterOf(this.#timers, name, labels, () => new Timer());
  }

  /**
   * A gauge that reads itself, by asking at every publish.
   *
   * For what something already knows - a queue's depth, a pool's size - where setting a gauge would mean
   * remembering to. The supplier is called while the batch is being collected, so it should answer at once and
   * not throw; one that throws is skipped for that step and the rest of the batch goes.
   */
  gaugeFrom(name: string, read: () => number, labels?: Record<string, unknown>): void {
    const resolved = labelsOf(labels);
    this.#suppliers.set(keyOf(name, resolved), { labels: resolved, name, read });
  }

  /**
   * The step in hand, as metrics - which takes counters and timers and starts them again.
   *
   * {@link publish} is this plus the push. Public because it is what a test asserts on, and what an
   * application that would rather send the batch itself asks for.
   */
  collect(): Metric[] {
    const batch: Metric[] = [];

    for (const [key, { labels, meter }] of this.#counters) {
      const value = meter.take();
      if (publishable(value)) batch.push(rateMetric(nameOf(key), value, this.#labelsFor(labels)));
    }

    for (const [key, { labels, meter }] of this.#timers) {
      const { count, total, max } = meter.take();
      const merged = this.#labelsFor(labels);
      const name = nameOf(key);
      if (publishable(count)) batch.push(rateMetric(`${name}.count`, count, merged));
      if (publishable(total)) batch.push(rateMetric(`${name}.total`, total, merged));
      if (publishable(max)) batch.push(gaugeMetric(`${name}.max`, max, merged));
    }

    for (const [key, { labels, meter }] of this.#gauges) {
      if (publishable(meter.value)) batch.push(gaugeMetric(nameOf(key), meter.value, this.#labelsFor(labels)));
    }

    for (const { labels, name, read } of this.#suppliers.values()) {
      let value: number;
      try {
        value = read();
      } catch {
        // One gauge that could not read itself is not a reason to lose the batch it was in.
        continue;
      }
      if (publishable(value)) batch.push(gaugeMetric(name, value, this.#labelsFor(labels)));
    }

    return batch;
  }

  /** Collects the step in hand and pushes it. Never rejects: a failure is counted and dropped. */
  async publish(): Promise<void> {
    const batch = this.collect();
    if (batch.length === 0) return;
    try {
      await this.#emo.pushMetrics(this.#module, batch);
      this.#publishes += 1;
    } catch {
      this.#failed += 1;
    }
  }

  /**
   * How many batches have been pushed.
   *
   * With {@link failedPublishes}, the answer to "is the monitoring working" - which nothing else here can
   * give, since a metric about pushing metrics cannot be pushed.
   */
  get publishes(): number {
    return this.#publishes;
  }

  /** How many batches failed to be pushed. */
  get failedPublishes(): number {
    return this.#failed;
  }

  /**
   * Stops the timer, publishing the step in hand unless told not to.
   *
   * Safe to call twice, and worth calling in a `finally`: the last step is usually the interesting one, and it
   * is the one a process that simply exits would drop.
   */
  async close(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#publishOnClose) {
      this.#publishOnClose = false;
      await this.publish();
    }
  }

  /**
   * The common labels, with a meter's own laid over them, so a meter that names a label the registry also
   * names keeps its own answer.
   */
  #labelsFor(labels: Record<string, string>): Record<string, string> {
    return { ...this.#commonLabels, ...labels };
  }
}

/**
 * Whether a value is worth pushing.
 *
 * A NaN or an infinity is what a gauge over an empty collection reads, and it would poison every rollup that
 * averaged it afterwards. Skipped here rather than stored.
 */
function publishable(value: number): boolean {
  return Number.isFinite(value);
}

function labelsOf(labels: Record<string, unknown> | undefined): Record<string, string> {
  if (labels === undefined) return {};
  return Object.fromEntries(Object.entries(labels).map(([name, value]) => [name, String(value)]));
}

/**
 * What identifies a meter: its name and the labels it was created with.
 *
 * The labels are sorted into the key so that the same pair written in either order is the same meter - two
 * series that differ by nothing but the spelling of a request would otherwise be two rows per step forever.
 */
function keyOf(name: string, labels: Record<string, string>): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((label) => `${label}=${labels[label]}`)
    .join(",");
  return `${name} ${sorted}`;
}

function nameOf(key: string): string {
  return key.slice(0, key.indexOf(" "));
}

function meterOf<T>(
  meters: Map<string, { labels: Record<string, string>; meter: T }>,
  name: string,
  labels: Record<string, unknown> | undefined,
  create: () => T,
): T {
  const resolved = labelsOf(labels);
  const key = keyOf(name, resolved);
  const existing = meters.get(key);
  if (existing !== undefined) return existing.meter;
  const meter = create();
  meters.set(key, { labels: resolved, meter });
  return meter;
}
