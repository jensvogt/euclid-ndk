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

import { Euclid, EuclidAuthenticationError, EuclidServiceError, LOG_DEBUG, RUNTIME_JAVA } from "../dist/index.js";

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

    if (application.resources.length > 0) console.log(`      may reach ${JSON.stringify(application.resources)}`);
    if (application.command) console.log(`      command ${application.command} ${application.arguments.join(" ")}`);
    else if (application.arguments.length > 0) console.log(`      arguments ${JSON.stringify(application.arguments)}`);
    const environment = Object.keys(application.environment);
    if (environment.length > 0) console.log(`      environment ${JSON.stringify(environment.sort())}`);
    console.log(`      logs at ${application.logLevel || "(the configured default)"}`);
    console.log();
  }
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
