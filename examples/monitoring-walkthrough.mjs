#!/usr/bin/env node
/**
 * EMO end to end: meters recorded, published on a step, and read back.
 *
 *   npm run build
 *   node examples/monitoring-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Reports under a module name of its own, named after the moment it started. Metrics are the one thing these
 * walkthroughs cannot clean up after themselves - there is no delete for a row, and they go when EMO's
 * retention takes them - so reporting under a name nothing else uses is how this stays out of your dashboards.
 *
 * Reading rows back is administrator-only. A login without those rights does everything but the last step, and
 * says so rather than failing.
 */

import { Euclid, EuclidAuthenticationError, EuclidServiceError } from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/monitoring-walkthrough.mjs <url> <username> <password>");
  process.exit(2);
}

let session;
try {
  session = await Euclid.forServer(baseUrl)
    .access()
    .credentials(username, password)
    // A development server's certificate is usually its own; drop this line, or point caCertPath() at the real
    // CA, anywhere it matters.
    .verify(false)
    .login();
} catch (error) {
  if (error instanceof EuclidAuthenticationError) {
    console.error(`login refused: ${error.reason || error.message}`);
    process.exit(1);
  }
  throw error;
}

const emo = session.emo();
const module = `ndk-walkthrough-${Math.floor(Date.now() / 1000)}`;

try {
  console.log(`reporting as ${module}, publishing every 2s`);

  // A step of two seconds so that the walkthrough shows something; a real application leaves it at the default
  // minute, which is what euclid's own modules and euclid-jdk publish on.
  const metrics = emo.registry(module, { stepMs: 2000, commonLabels: { sdk: "euclid-ndk" } });
  try {
    await work(metrics);
  } finally {
    // Publishes the step in hand as it goes, which is usually the interesting one.
    await metrics.close();
  }
  console.log(`\n${metrics.publishes} batch(es) pushed, ${metrics.failedPublishes} failed`);

  await readBack(emo, module);
} finally {
  session.close();
}

/** Records a run of work through the meters, the way an application would. */
async function work(metrics) {
  // Kept rather than looked up per use: asking the registry answers the same meter every time, but a handle
  // costs nothing to hold.
  const parsed = metrics.counter("invoices.parsed", { outcome: "ok" });
  const rejected = metrics.counter("invoices.parsed", { outcome: "rejected" });
  const duration = metrics.timer("invoice.parse");

  const backlog = Array.from({ length: 40 }, (_, index) => index + 1);
  // A gauge that reads itself: the depth is something the application already knows, so nothing has to
  // remember to set it.
  metrics.gaugeFrom("backlog.depth", () => backlog.length);

  let ok = 0;
  let bad = 0;
  while (backlog.length > 0) {
    const invoice = backlog.shift();
    // Timed however the call settles - a parse that failed slowly is exactly the one worth having timed.
    const accepted = await duration.time(() => parse(invoice));
    if (accepted) {
      parsed.increment();
      ok += 1;
    } else {
      rejected.increment();
      bad += 1;
    }
  }

  console.log(`  parsed ${ok}, rejected ${bad}, ${duration.count} timing(s) in the step in hand`);
}

/** Work to be measured: parses an invoice, slowly and not always successfully. */
async function parse(invoice) {
  await new Promise((resolve) => setTimeout(resolve, 20 + (invoice % 7) * 10));
  return invoice % 5 !== 0;
}

/** What the rows look like from the other side. Administrator-only, and says so when it is refused. */
async function readBack(emo, module) {
  try {
    const rows = await emo.listMetrics({ name: "invoices.parsed", labels: { module }, limit: 10 });
    console.log(`\n${rows.length} row(s) for invoices.parsed:`);
    for (const row of rows) {
      const labels = Object.entries(row.labels)
        .map(([name, value]) => `${name}=${value}`)
        .join(" ");
      console.log(
        `  ${row.timestamp}  ${String(row.value).padStart(8)}  ` +
          `${row.type.padEnd(5)} ${row.resolution.padEnd(4)} over ${row.samples} sample(s)  ${labels}`,
      );
    }

    // What a dashboard tile asks: one number, weighted by how many samples each row was made of.
    const mean = await emo.average({ name: "invoice.parse.total", labels: { module } });
    console.log(`\nmean invoice.parse.total: ${mean.toFixed(2)} ms per interval`);
  } catch (error) {
    if (!(error instanceof EuclidServiceError)) throw error;
    console.log(`\nreading metrics back: refused (${error.reason || error.message})`);
    console.log("  pushing needs no special rights; reading everybody's numbers is administrator-only");
  }
}
