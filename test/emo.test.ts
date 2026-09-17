/**
 * EMO, end to end against a fake euclid server.
 *
 * The three actions are checked the way every other module's are: what went on the wire, and what came back
 * off it. The registry gets more attention than that, because what it is for only shows itself over a step -
 * a counter that reports what accumulated and then starts again, a gauge that does not, and a timer that
 * records a call however it settled. Every test here drives the step by hand rather than waiting one out.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  Euclid,
  gaugeMetric,
  rateMetric,
  RESOLUTION_HOUR,
  type EuclidEmo,
  type EuclidSession,
  type MeterRegistry,
} from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

let gateway: FakeGateway;
let session: EuclidSession;
let emo: EuclidEmo;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-emo-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  emo = session.emo();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

/** A registry that publishes only when a test says so. */
function registry(module = "invoice-parser", options: Parameters<EuclidEmo["registry"]>[1] = {}): MeterRegistry {
  return emo.registry(module, { stepMs: 0, ...options });
}

/** The items of the most recent push. */
function pushed(): Record<string, unknown>[] {
  return gateway.last().json()["items"] as Record<string, unknown>[];
}

// -- pushing ---------------------------------------------------------------------------------------

describe("pushing metrics", () => {
  it("sends a batch under the name of what is reporting", async () => {
    gateway.answer("emo", "push-metrics", {});

    await emo.pushMetrics("invoice-parser", [
      rateMetric("invoices.parsed", 41, { outcome: "ok" }),
      gaugeMetric("queue.depth", 7),
    ]);

    assert.deepEqual(gateway.last().json(), {
      module: "invoice-parser",
      items: [
        { name: "invoices.parsed", labels: { outcome: "ok" }, value: 41, type: "rate" },
        { name: "queue.depth", labels: {}, value: 7, type: "gauge" },
      ],
    });
  });

  it("stringifies label values, since that is what a dimension is", async () => {
    // A number here would split one series in two on nothing but its JSON spelling.
    gateway.answer("emo", "push-metrics", {});

    await emo.pushMetrics("invoice-parser", [gaugeMetric("queue.depth", 7, { shard: 3, live: true })]);

    assert.deepEqual(pushed()[0]?.["labels"], { shard: "3", live: "true" });
  });

  it("does not send an empty batch at all", async () => {
    // A push usually runs on a timer forever, so a request that says nothing is a round trip for nothing.
    await emo.pushMetrics("invoice-parser", []);

    assert.deepEqual(gateway.requests.filter((request) => request.target === "emo"), []);
  });
});

// -- reading ---------------------------------------------------------------------------------------

describe("reading metrics", () => {
  it("narrows a listing to what the query names, and leaves out what it does not", async () => {
    gateway.answer("emo", "list", {
      items: [
        {
          name: "invoices.parsed",
          labels: { module: "invoice-parser" },
          value: 41.5,
          minValue: 0.5,
          maxValue: 12.25,
          samples: 12,
          type: "RATE",
          resolution: "HOUR",
          timestamp: "2026-09-17T10:00:00Z",
        },
        { name: "queue.depth" },
      ],
    });

    const samples = await emo.listMetrics({
      name: "invoices.parsed",
      labels: { module: "invoice-parser" },
      limit: 50,
      since: "2026-09-17T09:00:00Z",
      resolution: RESOLUTION_HOUR,
    });

    // `from` and `to` on the wire; a field that says nothing is left out rather than sent empty.
    assert.deepEqual(gateway.last().json(), {
      name: "invoices.parsed",
      labels: { module: "invoice-parser" },
      limit: 50,
      from: "2026-09-17T09:00:00Z",
      resolution: "HOUR",
    });

    assert.equal(samples.length, 2);
    // A measurement is a real number: truncating would make every timing under a millisecond read as nothing.
    assert.deepEqual([samples[0]?.value, samples[0]?.minValue, samples[0]?.maxValue], [41.5, 0.5, 12.25]);
    assert.deepEqual([samples[0]?.samples, samples[0]?.type], [12, "RATE"]);
    // A field the server did not send reads as empty rather than throwing.
    assert.deepEqual([samples[1]?.value, samples[1]?.labels], [0, {}]);
  });

  it("takes the most recent of everything when the query names nothing", async () => {
    gateway.answer("emo", "list", { items: [] });

    assert.deepEqual(await emo.listMetrics(), []);
    assert.deepEqual(gateway.last().json(), {});
  });

  it("answers an average as one number", async () => {
    gateway.answer("emo", "average", { average: 17.25 });

    assert.equal(await emo.average({ name: "system-cpu-usage" }), 17.25);
    assert.deepEqual(gateway.last().json(), { name: "system-cpu-usage" });
  });

  it("says who refused a read, since reading everybody's numbers is administrator-only", async () => {
    gateway.answer("emo", "list", { error: "Administrator privileges required" }, 403);

    await assert.rejects(
      () => emo.listMetrics(),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["emo", "list", 403]);
        return true;
      },
    );
  });
});

// -- the registry ----------------------------------------------------------------------------------

describe("the meter registry", () => {
  it("reports a counter as a rate and starts it again", async () => {
    gateway.answer("emo", "push-metrics", {});
    const metrics = registry();

    metrics.counter("invoices.parsed").increment();
    metrics.counter("invoices.parsed").increment(4);
    await metrics.publish();

    assert.deepEqual(gateway.last().json()["module"], "invoice-parser");
    assert.deepEqual(pushed(), [{ name: "invoices.parsed", labels: {}, value: 5, type: "rate" }]);

    // What makes a counter a rate: the next step reports what happened in it, not the total so far.
    metrics.counter("invoices.parsed").increment();
    await metrics.publish();
    assert.equal(pushed()[0]?.["value"], 1);

    await metrics.close();
  });

  it("answers the same meter for the same name and labels, and different ones for different labels", async () => {
    const metrics = registry();

    assert.equal(metrics.counter("invoices.parsed"), metrics.counter("invoices.parsed"));
    // Written in either order, the same labels are the same meter - otherwise a spelling would double the
    // series, one stored row per step forever.
    assert.equal(
      metrics.counter("x", { a: "1", b: "2" }),
      metrics.counter("x", { b: "2", a: "1" }),
    );
    assert.notEqual(metrics.counter("invoices.parsed"), metrics.counter("invoices.parsed", { outcome: "failed" }));

    await metrics.close();
  });

  it("does not reset a gauge, because a gauge is what it is rather than what happened", async () => {
    gateway.answer("emo", "push-metrics", {});
    const metrics = registry();

    metrics.gauge("queue.depth").set(9);
    await metrics.publish();
    assert.equal(pushed()[0]?.["value"], 9);

    await metrics.publish();
    assert.deepEqual(pushed(), [{ name: "queue.depth", labels: {}, value: 9, type: "gauge" }]);

    await metrics.close();
  });

  it("publishes a timer as a count, a total and a maximum, in milliseconds", async () => {
    gateway.answer("emo", "push-metrics", {});
    const metrics = registry();

    metrics.timer("invoice.parse").record(0.25);
    metrics.timer("invoice.parse").record(0.75);
    await metrics.publish();

    const byName = Object.fromEntries(pushed().map((item) => [item["name"], item]));
    // Given in seconds, published in milliseconds - the unit euclid-jdk and euclid's own modules use, so the
    // same operation is comparable across them.
    assert.deepEqual(byName["invoice.parse.count"], {
      name: "invoice.parse.count",
      labels: {},
      value: 2,
      type: "rate",
    });
    assert.equal(byName["invoice.parse.total"]?.["value"], 1000);
    assert.deepEqual(byName["invoice.parse.max"], {
      name: "invoice.parse.max",
      labels: {},
      value: 750,
      type: "gauge",
    });

    await metrics.close();
  });

  it("times a call however it settles", async () => {
    const metrics = registry();
    const timer = metrics.timer("invoice.parse");

    assert.equal(await timer.time(() => 17), 17);
    await assert.rejects(() => timer.time(async () => { throw new Error("no"); }), /no/);

    // A call that failed slowly is exactly the one worth having timed.
    assert.equal(timer.count, 2);
    await metrics.close();
  });

  it("records a span once however often it is stopped", async () => {
    const metrics = registry();
    const timer = metrics.timer("invoice.parse");

    const stop = timer.start();
    stop();
    stop();

    assert.equal(timer.count, 1);
    await metrics.close();
  });

  it("asks a self-reading gauge at every publish, and survives one that throws", async () => {
    gateway.answer("emo", "push-metrics", {});
    const metrics = registry();

    let depth = 3;
    metrics.gaugeFrom("queue.depth", () => depth);
    metrics.gaugeFrom("broken", () => {
      throw new Error("cannot read");
    });
    metrics.counter("invoices.parsed").increment();

    await metrics.publish();
    let names = pushed().map((item) => item["name"]);
    assert.deepEqual(names.sort(), ["invoices.parsed", "queue.depth"]);

    depth = 8;
    await metrics.publish();
    const depths = pushed().filter((item) => item["name"] === "queue.depth");
    assert.equal(depths[0]?.["value"], 8);

    await metrics.close();
  });

  it("skips a value no rollup could average", async () => {
    // What a gauge over an empty collection reads, which would poison every rollup it landed in.
    gateway.answer("emo", "push-metrics", {});
    const metrics = registry();

    metrics.gauge("empty.average").set(Number.NaN);
    metrics.gaugeFrom("infinite", () => Number.POSITIVE_INFINITY);
    metrics.counter("invoices.parsed").increment();

    await metrics.publish();

    assert.deepEqual(pushed().map((item) => item["name"]), ["invoices.parsed"]);
    await metrics.close();
  });

  it("lays a meter's own labels over the registry's", async () => {
    gateway.answer("emo", "push-metrics", {});
    const metrics = registry("invoice-parser", { commonLabels: { host: "laptop", instance: "1" } });

    metrics.counter("invoices.parsed", { instance: "2" }).increment();
    await metrics.publish();

    assert.deepEqual(pushed()[0]?.["labels"], { host: "laptop", instance: "2" });
    await metrics.close();
  });

  it("counts a failed push rather than raising at the application", async () => {
    // A process does not stop because it could not say how it was doing - and a rate is not retried, since
    // one sent twice is counted twice.
    gateway.answer("emo", "push-metrics", { error: "monitoring is down" }, 500);
    const metrics = registry();

    metrics.counter("invoices.parsed").increment();
    await metrics.publish();

    assert.deepEqual([metrics.publishes, metrics.failedPublishes], [0, 1]);

    gateway.answer("emo", "push-metrics", {});
    metrics.counter("invoices.parsed").increment();
    await metrics.publish();
    assert.deepEqual([metrics.publishes, metrics.failedPublishes], [1, 1]);

    await metrics.close();
  });

  it("publishes the step in hand when it closes, and only once", async () => {
    gateway.answer("emo", "push-metrics", {});
    const metrics = registry();

    metrics.counter("invoices.parsed").increment(3);
    await metrics.close();
    assert.equal(pushed()[0]?.["value"], 3);

    const pushes = gateway.requests.filter((request) => request.action === "push-metrics").length;
    await metrics.close();
    assert.equal(gateway.requests.filter((request) => request.action === "push-metrics").length, pushes);
  });

  it("drops the step in hand when told to", async () => {
    const metrics = registry("invoice-parser", { publishOnClose: false });

    metrics.counter("invoices.parsed").increment();
    await metrics.close();

    assert.deepEqual(gateway.requests.filter((request) => request.action === "push-metrics"), []);
  });

  it("publishes on a step of its own when given one", async () => {
    gateway.answer("emo", "push-metrics", {});
    const metrics = emo.registry("invoice-parser", { stepMs: 20 });

    metrics.counter("invoices.parsed").increment();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.ok(metrics.publishes >= 1, `expected at least one publish, got ${metrics.publishes}`);
    await metrics.close();
  });

  it("refuses a registry that does not say what is reporting", () => {
    // The server refuses a batch that does not, and this is cheaper than finding out over the wire.
    assert.throws(() => emo.registry(""), /what is reporting/);
  });
});
