#!/usr/bin/env node
/**
 * EMM: the processes euclid runs itself.
 *
 *   npm run build
 *   node examples/modules-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *   node examples/modules-walkthrough.mjs https://euclid.example.com:5566 admin admin esm
 *
 * Read-only. Naming a module additionally turns its own logging up and puts it back exactly as it was,
 * which is the one EMM change that is both reversible and free - nothing restarts for a log level.
 *
 * Everything else here is deliberately left out: setting instance limits or thread counts cycles a
 * module's processes, and stopping one takes part of somebody's installation out of service. Those are
 * shown as the calls they would be rather than made against a running server.
 *
 * Administrator-only, all of it: the server refuses every EMM action to anybody else.
 */

import {
  Euclid,
  EuclidAuthenticationError,
  EuclidServiceError,
  LOG_DEBUG,
  MODULE_COMPLETED,
  MODULE_CRASHED,
  MODULE_RUNNING,
  NOTHING_PENDING,
} from "../dist/index.js";

const [, , baseUrl, username, password, moduleName] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/modules-walkthrough.mjs <url> <username> <password> [module]");
  process.exit(2);
}

let session;
try {
  session = await Euclid.forServer(baseUrl)
    .access()
    .credentials(username, password)
    // A development server's certificate is usually its own; drop this line, or point caCertPath() at the
    // real CA, anywhere it matters.
    .verify(false)
    .login();
} catch (error) {
  if (error instanceof EuclidAuthenticationError) {
    console.error(`login refused: ${error.reason || error.message}`);
    process.exit(1);
  }
  throw error;
}

try {
  if (!session.isAdmin) {
    console.error(`${session.userId} is not an administrator - every EMM action would be refused`);
    process.exit(1);
  }

  const emm = session.emm();
  const modules = await emm.listModules();
  core(modules);
  theRest(modules);
  showControlCalls();
  showExportCall();

  if (moduleName) await logLevel(emm, moduleName);
  else console.log("\nname a module as a fourth argument to see its own logging turned up and put back");
} finally {
  session.close();
}

/** euclid's own modules: the pools, their limits, and what each process is doing. */
function core(modules) {
  const own = modules.filter((module) => module.core);
  console.log(`${own.length} euclid module(s):\n`);

  for (const module of own) {
    const running = module.instances.filter((instance) => instance.state === MODULE_RUNNING).length;
    const stopped = module.desiredStopped ? "   <- asked to stay stopped" : "";
    console.log(`  ${module.name.padEnd(6)} ${running}/${module.instances.length} running${stopped}`);
    console.log(`      limits ${module.minInstances}..${module.maxInstances}${pending(module)}`);
    console.log(`      logs at ${module.logLevel || "(the configured default)"}`);
    if (module.lastStartTime) console.log(`      last started ${module.lastStartTime}`);
    else console.log("      never started");

    for (const instance of module.instances) {
      // -1 is "never reported", which is a different thing from reporting no load: a module that does not
      // report, an SDK too old to know how, or a call being refused.
      const load =
        instance.utilisation === NOTHING_PENDING
          ? "load never reported"
          : `load ${instance.utilisation}%, backlog ${instance.backlog}`;
      const where = instance.host ? ` on ${instance.host}` : "";
      const port = instance.httpPort > 0 ? `, port ${instance.httpPort}` : "";
      const restarts = instance.restartCount > 0 ? `, ${instance.restartCount} restart(s)` : "";
      console.log(`        ${instance.instanceId}  pid ${instance.pid}${where}${port}  ${instance.state}${restarts}`);
      console.log(`            ${load}${instance.backgroundTasks > 0 ? `, ${instance.backgroundTasks} background task(s)` : ""}`);
    }
    console.log();
  }
}

/** The limits asked for and not yet reconciled - which is what -1 is for. */
function pending(module) {
  const parts = [];
  if (module.desiredMinInstances !== NOTHING_PENDING) parts.push(`min ${module.desiredMinInstances}`);
  if (module.desiredMaxInstances !== NOTHING_PENDING) parts.push(`max ${module.desiredMaxInstances}`);
  if (module.desiredThreads !== NOTHING_PENDING) parts.push(`${module.desiredThreads} thread(s)`);
  return parts.length === 0 ? "" : `  (asked for: ${parts.join(", ")}, not yet reconciled)`;
}

/** Application pools and transfer servers, which are modules to the manager as well. */
function theRest(modules) {
  const others = modules.filter((module) => !module.core);
  if (others.length === 0) {
    console.log("no application pools or transfer servers running\n");
    return;
  }

  console.log(`${others.length} pool(s) that are not euclid modules - EAP's and ETS's own:\n`);
  for (const module of others) {
    const states = module.instances.map((instance) => instance.state);
    const crashed = states.filter((state) => state === MODULE_CRASHED).length;
    const completed = states.filter((state) => state === MODULE_COMPLETED).length;
    // COMPLETED is terminal and not a fault: a job exiting 0 did what it was started for, and nothing
    // restarts it or counts it as a lost instance.
    const notes = [crashed > 0 ? `${crashed} crashed` : null, completed > 0 ? `${completed} completed` : null]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${module.name.padEnd(28)} ${module.instances.length} instance(s)${notes ? `  (${notes})` : ""}`);
  }
  console.log("\n  stopModule() refuses these - their desired state belongs to EAP and ETS, and anything");
  console.log("  recorded here would be undone on the next reconcile. restartModule() does work on them.");
  console.log();
}

/** What the changes would look like, since this example will not make them to somebody's installation. */
function showControlCalls() {
  console.log("changing a pool looks like this - recorded here, applied by the manager a tick later:\n");
  console.log("    await emm.setInstances('esm', { maxInstances: 8 });  // a floor left out stays as it is");
  console.log("    await emm.setThreads('eqs', 16);                     // cycles the instances to apply it");
  console.log("    await emm.stopModule('ets');                         // core modules only, and not emm");
  console.log("    await emm.restartModule('esm');                      // one instance per reconcile tick");
}

/** And what a backup would look like. */
function showExportCall() {
  console.log("\nand a backup is one call, sealed with a passphrase the server does not keep:\n");
  console.log("    const archive = await emm.exportArchive({ all: true, full: true, passphrase });");
  console.log("    await writeFile('backup.json', JSON.stringify(archive));");
  console.log("\n  exporting ekm *requires* a passphrase: that archive carries the key material itself.");
  console.log("  importArchive() takes the file back, upserting each document by its _id.");
}

/** Turn one module's own logging up, then put it back exactly as it was. */
async function logLevel(emm, name) {
  let module;
  try {
    module = await emm.findModule(name);
  } catch (error) {
    if (!(error instanceof EuclidServiceError)) throw error;
    console.log(`\n${name}: ${error.reason || error.message}`);
    return;
  }
  if (module === null) {
    console.log(`\n${name}: the manager has never heard of that module`);
    return;
  }

  const previous = module.logLevel;
  console.log(`\n${name} logs at ${previous || "(the configured default)"}`);

  const turnedUp = await emm.setLogLevel(name, LOG_DEBUG);
  console.log(`  turned up to ${turnedUp.logLevel} on channel ${turnedUp.channel}`);
  console.log("  nothing restarted: the manager applies it on its next reconcile tick");

  if (previous) {
    const restored = await emm.setLogLevel(name, previous);
    console.log(`  put back to ${restored.logLevel}`);
  } else {
    const restored = await emm.resetLogLevel(name);
    console.log(`  put back under the configured default (${restored.logLevel || "no override"})`);
  }
}
