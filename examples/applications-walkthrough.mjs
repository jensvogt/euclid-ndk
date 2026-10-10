#!/usr/bin/env node
/**
 * EAP: what euclid is running, from what, and as whom.
 *
 *   npm run build
 *   node examples/applications-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *   node examples/applications-walkthrough.mjs https://euclid.example.com:5566 admin admin order-service
 *
 * Read-only unless an application is named. Deploying one needs an artifact already in a bucket, which is
 * not something an example should invent on somebody's server - so this reads what is deployed, and shows
 * what the deployment call would have looked like. Naming an application additionally turns its log level
 * up and puts it back exactly as it was, which is the one EAP change that is both reversible and free.
 *
 * Administrator-only, all of it: the server refuses every EAP action to anybody else.
 */

import {
  Euclid,
  EuclidAuthenticationError,
  EuclidServiceError,
  LOG_DEBUG,
  RUNTIME_JAVA,
  TYPE_JOB,
} from "../dist/index.js";

const [, , baseUrl, username, password, applicationId] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/applications-walkthrough.mjs <url> <username> <password> [application]");
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
    console.error(`${session.userId} is not an administrator - every EAP action would be refused`);
    process.exit(1);
  }

  const eap = session.eap();
  await deployed(eap);
  await nodes(eap);
  showDeploymentCall();

  if (applicationId) await logLevel(eap, applicationId);
  else console.log("\nname an application as a fourth argument to see its log level turned up and put back");
} finally {
  session.close();
}

/** What is deployed, what was asked of it, and what is actually answering. */
async function deployed(eap) {
  const applications = await eap.listApplications();
  console.log(`${applications.length} application(s) deployed:\n`);

  for (const application of applications) {
    // The two differing is the ordinary picture of an application starting up. The two differing for long
    // is one that cannot.
    const agreement =
      application.desiredState === application.state ? "" : "   <- asked for one thing, doing another";
    console.log(`  ${application.applicationId}  (${application.runtime} ${application.version})`);
    console.log(`      desired ${application.desiredState}, actually ${application.state}${agreement}`);
    console.log(
      `      pool ${application.minInstances}..${application.maxInstances}, ` +
        `${application.instances} instance(s) answering`,
    );

    for (const endpoint of application.endpoints) {
      console.log(`        ${endpoint.instanceId}  pid ${endpoint.pid}  port ${endpoint.httpPort}`);
    }

    // The artifact it was deployed from, by ERN and key: names are what an operator deploys with, and these
    // are what euclid stored.
    console.log(`      from ${application.bucketErn} / ${application.artifactKey}`);
    // ESM's checksum of the artifact, which is what a redeploy has to differ from.
    console.log(`      md5 ${application.md5Sum}`);
    const made = application.userId.startsWith("app-") ? " (a principal euclid made for it)" : "";
    console.log(`      runs as ${application.userId}${made}`);
    // False is the answer worth seeing: the user is checked when the application is created and never
    // again, so this is a definition that will start, authenticate as nobody and be refused everything.
    if (!application.userExists) console.log("        <- that identity no longer exists");

    // A JOB runs to completion and is not restarted for exiting; a PROCESS is kept up. Only a JOB can
    // carry a schedule, and nextRunAt is empty rather than 1970 when there is none.
    if (application.type === TYPE_JOB) {
      const when = application.schedule
        ? `on "${application.schedule}", next at ${application.nextRunAt}`
        : "on demand only";
      console.log(`      a JOB, ${when}`);
    }

    const labels = Object.entries(application.nodeLabels);
    if (labels.length > 0) {
      console.log(`      placed on a node carrying ${labels.map(([key, value]) => `${key}=${value}`).join(", ")}`);
    }

    if (application.resources.length > 0) console.log(`      may reach ${JSON.stringify(application.resources)}`);
    if (application.command) console.log(`      command ${application.command} ${application.arguments.join(" ")}`);
    else if (application.arguments.length > 0) console.log(`      arguments ${JSON.stringify(application.arguments)}`);
    const environment = Object.keys(application.environment);
    if (environment.length > 0) console.log(`      environment ${JSON.stringify(environment.sort())}`);
    console.log(`      logs at ${application.logLevel || "(the configured default)"}`);
    console.log();
  }
}

/**
 * The worker nodes, if any are registered.
 *
 * An installation with no workers runs everything on the manager's own host and lists none, which is the
 * ordinary case rather than a problem - so this says so and moves on.
 */
async function nodes(eap) {
  const registered = await eap.listNodes();
  if (registered.length === 0) {
    console.log("no worker nodes registered - the manager runs everything on its own host\n");
    return;
  }

  console.log(`${registered.length} worker node(s):\n`);
  for (const node of registered) {
    // A node that stopped renewing its lease is still registered, and still has what it was running on
    // record: that is how an absent host is told from a deregistered one.
    const state = [node.live ? "live" : `not seen since ${node.lastSeen}`, node.drained ? "drained" : null]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${node.name}  ${node.address}  ${node.cpuCount} cpu  ${node.os}/${node.arch}  (${state})`);
    const labels = Object.entries(node.labels);
    if (labels.length > 0) console.log(`      offers ${labels.map(([key, value]) => `${key}=${value}`).join(", ")}`);
  }

  // Only get-node answers what a node is running: working it out means walking every pool, so a listing
  // does not. Asked for the first one here rather than all of them, for the same reason.
  const first = registered[0];
  const detail = await eap.getNode(first.name);
  console.log(`\n  ${detail.name} is holding slots for ${detail.applications.length} application(s):`);
  for (const application of detail.applications) {
    console.log(`      ${application.applicationId}  ${application.running}/${application.instances} running`);
  }
  console.log("  drainNode() stops new instances being placed there and lets the rest leave as they are");
  console.log("  replaced - not a stop: the node keeps running what it has, and keeps renewing\n");
}

/** What deploying one looks like, since this example will not do it to somebody's server. */
function showDeploymentCall() {
  console.log("deploying looks like this - the artifact has to be in the bucket already:\n");
  console.log("    await esm.uploadFile(bucketErn, 'order-service-1.4.0.jar', 'target/order-service.jar');");
  console.log(`    await eap.createApplication('order-service', ${JSON.stringify(RUNTIME_JAVA)}, 'artifacts',`);
  console.log("                                'order-service-1.4.0.jar',");
  console.log("                                { queues: ['orders'], minInstances: 2, maxInstances: 5 });");
  console.log("    await eap.startApplication('order-service');");
  console.log("\n  ...and a new build of the same thing is a redeploy rather than an update:");
  console.log("    await eap.redeployApplication('order-service', '', '1.4.1');");
  console.log("\n  something that runs to completion is a JOB, which is what keeps euclid from");
  console.log("  restarting it every time it finishes:");
  console.log(`    await eap.createApplication('nightly-import', ${JSON.stringify(RUNTIME_JAVA)}, 'artifacts',`);
  console.log("                                'import-1.0.0.jar',");
  console.log(`                                { type: ${JSON.stringify(TYPE_JOB)}, schedule: '0 2 * * *' });`);
}

/** Turn one application's logging up, then put it back exactly as it was. */
async function logLevel(eap, applicationId) {
  let application;
  try {
    application = await eap.getApplication(applicationId);
  } catch (error) {
    if (!(error instanceof EuclidServiceError)) throw error;
    console.log(`\n${applicationId}: ${error.reason || error.message}`);
    return;
  }

  const previous = application.logLevel;
  console.log(`\n${applicationId} logs at ${previous || "(the configured default)"}`);

  const turnedUp = await eap.setLogLevel(applicationId, LOG_DEBUG);
  console.log(`  turned up to ${turnedUp.logLevel} on channel ${turnedUp.channel}`);
  console.log("  no restart, no redeploy - the running instances pick it up");

  if (previous) {
    const restored = await eap.setLogLevel(applicationId, previous);
    console.log(`  put back to ${restored.logLevel}`);
  } else {
    // Back under the installation's configuration, rather than pinned to whatever it says now.
    const restored = await eap.resetLogLevel(applicationId);
    console.log(`  put back under the configured default (${restored.logLevel || "no override"})`);
  }
}
