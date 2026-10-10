/**
 * EAP, end to end against a fake euclid server.
 *
 * Every action is one request, so what these check is that it carries the fields the server reads and
 * parses the ones it answers with. Two of those are worth more attention than the rest: a deployment names
 * a bucket and an artifact while the application that comes back describes ERNs, and an update sends only
 * what it was given - where naming an empty list of buckets does not mean "leave them alone" but "revoke
 * them".
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  Euclid,
  LOG_DEBUG,
  RUNTIME_JAVA,
  RUNTIME_JAVA21,
  RUNTIME_JAVA25,
  RUNTIME_PYTHON,
  STATE_RUNNING,
  STATE_STOPPED,
  TYPE_JOB,
  TYPE_PROCESS,
  type EuclidEap,
  type EuclidSession,
} from "../src/index.js";
import { toApplication } from "../src/dto/eap.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

const APPLICATION = {
  applicationId: "order-service",
  runtimeName: "order-service-4k7m2q",
  ern: "ern:eap:application/development/order-service",
  accountId: "000000000000",
  namespace: "development",
  region: "eu-central-1",
  runtime: "JAVA",
  bucketErn: "ern:esm:bucket/artifacts",
  artifactKey: "order-service-1.4.0.jar",
  version: "1.4.0",
  md5Sum: "d41d8cd98f00b204e9800998ecf8427e",
  command: "",
  arguments: ["--server.port=0"],
  environment: { TZ: "Europe/Berlin" },
  resources: ["ern:eqs:queue/orders"],
  nodeLabels: {},
  userId: "app-order-service",
  userExists: true,
  logLevel: "",
  minInstances: 2,
  maxInstances: 5,
  readyTimeoutMs: 30000,
  type: "PROCESS",
  schedule: "",
  nextRunAt: "",
  desiredState: "RUNNING",
  state: "RUNNING",
  instances: 2,
  endpoints: [
    { instanceId: "i-1", pid: 4711, httpPort: 34567 },
    { instanceId: "i-2", pid: 4712, httpPort: 34568 },
  ],
  created: "2026-09-01",
  modified: "2026-09-10",
};

const NODE = {
  name: "worker-01",
  address: "10.0.0.17:5566",
  principal: "worker-01",
  labels: { os: "linux", gpu: "true" },
  cpuCount: 16,
  version: "1.2.20",
  os: "Linux",
  arch: "x86_64",
  drained: false,
  live: true,
  lastSeen: "2026-10-10T08:30:00Z",
};

let gateway: FakeGateway;
let session: EuclidSession;
let eap: EuclidEap;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-eap-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  eap = session.eap();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- deploying ------------------------------------------------------------------------------------

describe("deploying", () => {
  it("names the bucket and the artifact", async () => {
    // Names are what an operator has in hand; the application that comes back describes the ERNs euclid
    // resolved them into.
    gateway.answer("eap", "create-application", {
      ...APPLICATION,
      desiredState: "STOPPED",
      state: "STOPPED",
      instances: 0,
      endpoints: [],
    });

    const application = await eap.createApplication("order-service", RUNTIME_JAVA, "artifacts", "order-service-1.4.0.jar", {
      version: "1.4.0",
      arguments: ["--server.port=0"],
      environment: { TZ: "Europe/Berlin" },
      queues: ["orders"],
      minInstances: 2,
      maxInstances: 5,
    });

    assert.deepEqual(gateway.last().json(), {
      applicationId: "order-service",
      runtime: "JAVA",
      bucket: "artifacts",
      artifact: "order-service-1.4.0.jar",
      version: "1.4.0",
      command: "",
      arguments: ["--server.port=0"],
      environment: { TZ: "Europe/Berlin" },
      buckets: [],
      queues: ["orders"],
      topics: [],
      secrets: [],
      nodeLabels: {},
      user: "",
      minInstances: 2,
      maxInstances: 5,
      readyTimeoutMs: 30000,
      // Both empty, which is what says "a PROCESS, on no schedule" - the server reads these only when
      // they carry something, so a deployment that mentions neither is the one it always was.
      type: "",
      schedule: "",
    });

    assert.equal(application.bucketErn, "ern:esm:bucket/artifacts");
    assert.equal(application.artifactKey, "order-service-1.4.0.jar");
    // An ID is only unique within an account and namespace, so what the host calls this application is a
    // name of its own - and the namespace is the other half of what identifies it.
    assert.equal(application.runtimeName, "order-service-4k7m2q");
    assert.equal(application.namespace, "development");
    assert.deepEqual(application.resources, ["ern:eqs:queue/orders"]);
    // Nothing runs yet: a new application is stopped until somebody starts it.
    assert.deepEqual([application.desiredState, application.state], [STATE_STOPPED, STATE_STOPPED]);
  });

  it("runs as an identity euclid made when none was named", async () => {
    // No password, no login, one access key - so nothing an application leaks is a person's.
    gateway.answer("eap", "create-application", APPLICATION);

    const application = await eap.createApplication("order-service", RUNTIME_PYTHON, "artifacts", "app.py");

    assert.equal(gateway.last().json()["user"], "");
    assert.equal(application.userId, "app-order-service");
  });

  it("copies an application into another namespace", async () => {
    gateway.answer("eap", "copy-application", APPLICATION);

    await eap.copyApplication("order-service", "production");
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", targetNamespace: "production" });

    // Absent rather than empty when unnamed: the server reads an absent targetApplicationId as
    // "the original's name", so sending "" would be asking for an application with no name.
    await eap.copyApplication("order-service", "development", "order-service-next");
    assert.deepEqual(gateway.last().json(), {
      applicationId: "order-service",
      targetNamespace: "development",
      targetApplicationId: "order-service-next",
    });
  });

  it("scales without sending a bound it was not given", async () => {
    gateway.answer("eap", "scale-application", APPLICATION);

    // A ceiling raised on its own must not carry a floor with it - an absent bound is what tells
    // the server to leave that one as it stands.
    await eap.scaleApplication("order-service", { maxInstances: 16 });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", maxInstances: 16 });

    await eap.scaleApplication("order-service", { minInstances: 4 });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", minInstances: 4 });

    // Both together pins the pool, which is a normal thing to ask for.
    await eap.scaleApplication("order-service", { minInstances: 2, maxInstances: 2 });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", minInstances: 2, maxInstances: 2 });
  });

  it("deploys a job on a schedule", async () => {
    gateway.answer("eap", "create-application", {
      ...APPLICATION,
      applicationId: "nightly-import",
      type: "JOB",
      schedule: "0 2 * * *",
      nextRunAt: "2026-10-11T02:00:00Z",
      desiredState: "STOPPED",
      state: "STOPPED",
      instances: 0,
      endpoints: [],
    });

    const job = await eap.createApplication("nightly-import", RUNTIME_JAVA, "artifacts", "import-1.0.0.jar", {
      type: TYPE_JOB,
      schedule: "0 2 * * *",
    });

    const body = gateway.last().json();
    assert.equal(body["type"], "JOB");
    assert.equal(body["schedule"], "0 2 * * *");

    assert.deepEqual([job.type, job.schedule], [TYPE_JOB, "0 2 * * *"]);
    // When it next fires, computed by the server at the moment the schedule was set - which is what
    // decides a job scheduled at noon is next due tonight rather than overdue since midnight.
    assert.equal(job.nextRunAt, "2026-10-11T02:00:00Z");
  });

  it("grants topics and secrets, not only buckets and queues", async () => {
    gateway.answer("eap", "create-application", APPLICATION);
    gateway.answer("eap", "update-application", APPLICATION);

    await eap.createApplication("order-service", RUNTIME_JAVA, "artifacts", "app.jar", {
      buckets: ["artifacts"],
      queues: ["orders"],
      topics: ["order-events"],
      secrets: ["db-password"],
    });
    const created = gateway.last().json();
    assert.deepEqual(created["topics"], ["order-events"]);
    assert.deepEqual(created["secrets"], ["db-password"]);

    // All four on an update, because the server rebuilds the whole resource list from whatever the
    // request carries: sending buckets and queues alone is what revokes the topics and secrets.
    await eap.updateApplication("order-service", {
      buckets: ["artifacts"],
      queues: ["orders"],
      topics: ["order-events"],
      secrets: ["db-password"],
    });
    assert.deepEqual(gateway.last().json(), {
      applicationId: "order-service",
      buckets: ["artifacts"],
      queues: ["orders"],
      topics: ["order-events"],
      secrets: ["db-password"],
    });
  });

  it("asks for a node by label, and clears the ask with an empty set", async () => {
    gateway.answer("eap", "create-application", { ...APPLICATION, nodeLabels: { os: "windows" } });
    gateway.answer("eap", "update-application", APPLICATION);

    const placed = await eap.createApplication("order-service", RUNTIME_JAVA, "artifacts", "app.jar", {
      nodeLabels: { os: "windows" },
    });
    assert.deepEqual(gateway.last().json()["nodeLabels"], { os: "windows" });
    assert.deepEqual(placed.nodeLabels, { os: "windows" });

    // An empty set is a value rather than an omission: it takes the application back to the manager's
    // own host, so it has to reach the server.
    await eap.updateApplication("order-service", { nodeLabels: {} });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", nodeLabels: {} });
  });

  it("sends only what an update was given", async () => {
    gateway.answer("eap", "update-application", APPLICATION);

    await eap.updateApplication("order-service", { minInstances: 3 });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", minInstances: 3 });

    // An empty command is a value here - it hands the artifact back to the runtime's interpreter - so it
    // has to be sendable, which leaving it out is what says "leave it alone".
    await eap.updateApplication("order-service", { command: "" });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", command: "" });

    await eap.updateApplication("order-service", {
      runtime: RUNTIME_JAVA,
      artifact: "order-service-1.5.0.jar",
      version: "1.5.0",
      arguments: ["-Xmx512m"],
      environment: {},
      readyTimeoutMs: 60000,
      namespace: "production",
    });
    assert.deepEqual(gateway.last().json(), {
      applicationId: "order-service",
      runtime: "JAVA",
      artifact: "order-service-1.5.0.jar",
      version: "1.5.0",
      arguments: ["-Xmx512m"],
      environment: {},
      readyTimeoutMs: 60000,
      namespace: "production",
    });
  });

  it("turns a running process into a scheduled job, and back", async () => {
    gateway.answer("eap", "update-application", { ...APPLICATION, type: "JOB", schedule: "@daily" });

    await eap.updateApplication("nightly-import", { type: TYPE_JOB, schedule: "@daily" });
    assert.deepEqual(gateway.last().json(), {
      applicationId: "nightly-import",
      type: "JOB",
      schedule: "@daily",
    });

    // Both in one request going the other way, because the server checks the pair after applying both:
    // a JOB turned back into a PROCESS keeping a schedule would be one that quietly stopped firing.
    await eap.updateApplication("nightly-import", { type: TYPE_PROCESS, schedule: "" });
    assert.deepEqual(gateway.last().json(), {
      applicationId: "nightly-import",
      type: "PROCESS",
      schedule: "",
    });
  });

  it("moves an application between namespaces", async () => {
    // A move rather than a field change: the ERN follows the namespace while the runtime name does not, so
    // nothing on the host moves underneath a running instance.
    gateway.answer("eap", "update-application", {
      ...APPLICATION,
      namespace: "production",
      ern: "ern:eap:application/production/order-service",
    });

    const moved = await eap.updateApplication("order-service", { namespace: "production" });

    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", namespace: "production" });
    assert.equal(moved.namespace, "production");
    assert.equal(moved.runtimeName, "order-service-4k7m2q");

    // Empty is a value here rather than "leave it alone": it moves the application to the account root.
    gateway.answer("eap", "update-application", { ...APPLICATION, namespace: "" });
    const atRoot = await eap.updateApplication("order-service", { namespace: "" });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", namespace: "" });
    assert.equal(atRoot.namespace, "");
  });

  it("refuses a move into a namespace that has that ID", async () => {
    gateway.answer(
      "eap",
      "update-application",
      { error: "Namespace 'production' already has an application called 'order-service'" },
      409,
    );

    await assert.rejects(
      () => eap.updateApplication("order-service", { namespace: "production" }),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 409);
        assert.ok(error.reason.includes("already has an application"));
        return true;
      },
    );
  });

  it("leaves resources out of an update that does not mention them", async () => {
    // The server re-resolves buckets and queues together whenever either is named, so sending an empty pair
    // by default would revoke everything the application was granted.
    gateway.answer("eap", "update-application", APPLICATION);

    await eap.updateApplication("order-service", { minInstances: 3 });
    assert.equal("buckets" in gateway.last().json(), false);
    assert.equal("queues" in gateway.last().json(), false);

    await eap.updateApplication("order-service", { buckets: ["artifacts"], queues: ["orders"] });
    assert.deepEqual(gateway.last().json()["buckets"], ["artifacts"]);
    assert.deepEqual(gateway.last().json()["queues"], ["orders"]);

    // Naming them empty is how they are revoked deliberately.
    await eap.updateApplication("order-service", { buckets: [], queues: [] });
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", buckets: [], queues: [] });
  });

  it("redeploys the artifact already deployed by default", async () => {
    // Which is what a rebuilt artifact stored under the same key wants.
    gateway.answer("eap", "redeploy-application", { ...APPLICATION, version: "1.5.0" });

    await eap.redeployApplication("order-service");
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service" });

    const redeployed = await eap.redeployApplication("order-service", "order-service-1.5.0.jar", "1.5.0");
    assert.deepEqual(gateway.last().json(), {
      applicationId: "order-service",
      artifact: "order-service-1.5.0.jar",
      version: "1.5.0",
    });
    assert.equal(redeployed.version, "1.5.0");
  });

  it("is refused when a redeploy would change nothing", async () => {
    // It would restart the instances for nothing, and usually means the new artifact never reached the
    // bucket.
    gateway.answer("eap", "redeploy-application", { error: "Already at version 1.4.0 with the same artifact" }, 409);

    await assert.rejects(
      () => eap.redeployApplication("order-service"),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 409);
        assert.ok(error.reason.startsWith("Already at version"));
        return true;
      },
    );
  });
});

// -- running --------------------------------------------------------------------------------------

describe("running", () => {
  it("asks rather than waits when starting one", async () => {
    // The desired state changes here and the manager acts on it, so what comes back says what was asked for
    // rather than what has happened.
    gateway.answer("eap", "start-application", {
      ...APPLICATION,
      desiredState: "RUNNING",
      state: "STOPPED",
      instances: 0,
      endpoints: [],
    });
    gateway.answer("eap", "stop-application", { ...APPLICATION, desiredState: "STOPPED" });

    const started = await eap.startApplication("order-service");
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service" });
    assert.deepEqual([started.desiredState, started.state], [STATE_RUNNING, STATE_STOPPED]);

    const stopped = await eap.stopApplication("order-service");
    assert.equal(stopped.desiredState, STATE_STOPPED);
    // Still answering, which is the ordinary picture of an application on its way down.
    assert.equal(stopped.state, STATE_RUNNING);
  });

  it("cycles the pool without changing the desired state when restarting one", async () => {
    // The one way to have every instance start again that does not leave the application stopped if the
    // caller goes away between two calls.
    gateway.answer("eap", "restart-application", {
      applicationId: "order-service",
      restarting: true,
      instances: 3,
    });

    const restarted = await eap.restartApplication("order-service");

    assert.deepEqual(gateway.last().json(), { applicationId: "order-service" });
    assert.equal(restarted.restarting, true);
    assert.equal(restarted.applicationId, "order-service");
    // What is running when the request is answered: the manager has not stopped anything yet.
    assert.equal(restarted.instances, 3);
  });

  it("names what applying a declaration created and what it removed", async () => {
    gateway.answer("eap", "apply-infrastructure", {
      applicationId: "order-service",
      declared: true,
      created: ["ern:eqs:eu-central-1:000000000000:development:queue:orders"],
      deleted: ["ern:eqs:eu-central-1:000000000000:development:queue:retired"],
      granted: ["access-queue-consume"],
      revoked: ["access-queue-produce"],
    });

    const applied = await eap.applyInfrastructure("order-service");

    assert.deepEqual(gateway.last().json(), { applicationId: "order-service" });
    assert.equal(applied.declared, true);
    assert.deepEqual(applied.created, ["ern:eqs:eu-central-1:000000000000:development:queue:orders"]);
    // The half worth reading before trusting a declaration: a reconcile is full, so a resource this
    // application created and the file no longer names is gone, and took its messages with it. Named rather
    // than counted, so a removal nobody intended is visible in the answer.
    assert.deepEqual(applied.deleted, ["ern:eqs:eu-central-1:000000000000:development:queue:retired"]);
    assert.deepEqual(applied.granted, ["access-queue-consume"]);
    assert.deepEqual(applied.revoked, ["access-queue-produce"]);
  });

  it("answers rather than refuses an application with no declaration", async () => {
    // Not an error: an application that provisions its resources by hand reads this way every time, and the
    // four lists come back empty rather than absent.
    gateway.answer("eap", "apply-infrastructure", { applicationId: "order-service", declared: false });

    const applied = await eap.applyInfrastructure("order-service");

    assert.equal(applied.declared, false);
    assert.deepEqual(applied.created, []);
    assert.deepEqual(applied.deleted, []);
    assert.deepEqual(applied.granted, []);
    assert.deepEqual(applied.revoked, []);
  });

  it("reports the instances answering for an application", async () => {
    gateway.answer("eap", "get-application", APPLICATION);

    const application = await eap.getApplication("order-service");

    assert.deepEqual(gateway.last().json(), { applicationId: "order-service" });
    assert.equal(application.instances, 2);
    assert.deepEqual(
      application.endpoints.map((endpoint) => [endpoint.instanceId, endpoint.httpPort]),
      [["i-1", 34567], ["i-2", 34568]],
    );
    assert.equal(application.endpoints[0]?.pid, 4711);
    assert.deepEqual(application.environment, { TZ: "Europe/Berlin" });
  });

  it("lists and deletes them", async () => {
    gateway.answer("eap", "list-applications", { applications: [APPLICATION, { applicationId: "reports" }] });
    gateway.answer("eap", "delete-application", {});

    const applications = await eap.listApplications("order");
    assert.deepEqual(gateway.last().json(), { prefix: "order" });
    assert.deepEqual(applications.map((application) => application.applicationId), ["order-service", "reports"]);
    // A field the server did not send reads as empty rather than throwing - including the two an
    // application deployed before the scope existed has nothing to say about.
    assert.deepEqual(applications[1]?.endpoints, []);
    assert.equal(applications[1]?.minInstances, 0);
    assert.deepEqual([applications[1]?.runtimeName, applications[1]?.namespace], ["", ""]);

    assert.deepEqual(await eap.listApplications(), applications);
    assert.deepEqual(gateway.last().json(), { prefix: "" });

    await eap.deleteApplication("order-service");
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service" });
  });
});

// -- logging --------------------------------------------------------------------------------------

describe("worker nodes", () => {
  it("lists the fleet, live or not", async () => {
    gateway.answer("eap", "list-nodes", {
      total: 2,
      nodes: [NODE, { ...NODE, name: "worker-02", live: false, drained: true, lastSeen: "2026-10-09T22:00:00Z" }],
    });

    const nodes = await eap.listNodes();

    assert.deepEqual(nodes.map((node) => node.name), ["worker-01", "worker-02"]);
    assert.deepEqual(nodes[0]?.labels, { os: "linux", gpu: "true" });
    assert.equal(nodes[0]?.cpuCount, 16);
    // A node that stopped renewing is still registered, and still has whatever it was running on
    // record - which is how an absent host is told from a deregistered one.
    assert.deepEqual([nodes[1]?.live, nodes[1]?.drained], [false, true]);
  });

  it("says what one node is holding slots for", async () => {
    gateway.answer("eap", "get-node", {
      ...NODE,
      applications: [
        {
          applicationId: "order-service",
          runtimeName: "order-service-4k7m2q",
          namespace: "development",
          runtime: "JAVA",
          instances: 4,
          running: 3,
        },
      ],
    });

    const node = await eap.getNode("worker-01");

    assert.deepEqual(gateway.last().json(), { node: "worker-01" });
    assert.equal(node.name, "worker-01");
    // Slots held and slots serving, separately: four held with three running is exactly the state a
    // single count cannot report.
    assert.deepEqual([node.applications[0]?.instances, node.applications[0]?.running], [4, 3]);
    assert.equal(node.applications[0]?.applicationId, "order-service");
  });

  it("drains a node and puts it back", async () => {
    gateway.answer("eap", "drain-node", { node: "worker-01", drained: true });

    const drained = await eap.drainNode("worker-01");
    assert.deepEqual(gateway.last().json(), { node: "worker-01", drained: true });
    assert.equal(drained.drained, true);

    // resumeNode is the same action saying false, because there is no separate undrain to send.
    gateway.answer("eap", "drain-node", { node: "worker-01", drained: false });
    const resumed = await eap.resumeNode("worker-01");
    assert.deepEqual(gateway.last().json(), { node: "worker-01", drained: false });
    assert.equal(resumed.drained, false);
  });

  it("forgets a node that is gone for good", async () => {
    gateway.answer("eap", "delete-node", { node: "worker-02", deleted: true });

    const deleted = await eap.deleteNode("worker-02");

    assert.deepEqual(gateway.last().json(), { node: "worker-02" });
    assert.deepEqual([deleted.node, deleted.deleted], ["worker-02", true]);
  });

  it("rejects when a node is not registered", async () => {
    gateway.answer("eap", "get-node", { error: "Node is not registered, node: worker-09" }, 404);

    await assert.rejects(
      () => eap.getNode("worker-09"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.action, error.status], ["get-node", 404]);
        return true;
      },
    );
  });
});

describe("reporting load", () => {
  it("names the instance, and defaults the rest to zero", async () => {
    gateway.answer("eap", "report-load", { instanceId: "i-1", utilisation: 42, backlog: 0, active: 0 });

    const report = await eap.reportLoad("i-1", 42);

    // applicationId empty is how an application running as its own app-<runtimeName> principal says
    // "me": the server reads the pool off the caller's identity.
    assert.deepEqual(gateway.last().json(), {
      instanceId: "i-1",
      utilisation: 42,
      backlog: 0,
      active: 0,
      applicationId: "",
    });
    assert.deepEqual([report.instanceId, report.utilisation], ["i-1", 42]);
  });

  it("carries a backlog, work in flight, and the application a named user reports for", async () => {
    gateway.answer("eap", "report-load", { instanceId: "i-2", utilisation: 90, backlog: 120, active: 3 });

    const report = await eap.reportLoad("i-2", 90, { backlog: 120, active: 3, applicationId: "parser-dev" });

    assert.deepEqual(gateway.last().json(), {
      instanceId: "i-2",
      utilisation: 90,
      backlog: 120,
      active: 3,
      applicationId: "parser-dev",
    });
    assert.deepEqual([report.backlog, report.active], [120, 3]);
  });

  it("answers with what the server stored rather than what was sent", async () => {
    // Clamped to 0-100 server-side, which is worth reading back: a client reporting 150 learns here
    // that euclid recorded 100.
    gateway.answer("eap", "report-load", { instanceId: "i-1", utilisation: 100, backlog: 0, active: 0 });

    const report = await eap.reportLoad("i-1", 150);

    assert.equal(gateway.last().json()["utilisation"], 150);
    assert.equal(report.utilisation, 100);
  });
});

describe("logging", () => {
  it("sets a level and takes it back", async () => {
    gateway.answer("eap", "set-log-level", {
      applicationId: "order-service",
      logLevel: "debug",
      channel: "application.order-service",
    });

    const result = await eap.setLogLevel("order-service", LOG_DEBUG);
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", level: "debug" });
    assert.deepEqual([result.logLevel, result.channel], ["debug", "application.order-service"]);

    // An empty level removes the override rather than setting one, so the application follows the
    // installation's configuration as it changes from here on.
    gateway.answer("eap", "set-log-level", {
      applicationId: "order-service",
      logLevel: "",
      channel: "application.order-service",
    });
    const reset = await eap.resetLogLevel("order-service");
    assert.deepEqual(gateway.last().json(), { applicationId: "order-service", level: "" });
    assert.equal(reset.logLevel, "");
  });

  it("leaves an unrecognised level to the server to refuse", async () => {
    // Refused rather than defaulted: "warnign" quietly meaning "info" is an application logging more than
    // somebody asked for.
    gateway.answer(
      "eap",
      "set-log-level",
      { error: 'level must be "trace", "debug", "info", "warning", "error", "fatal" or "off": warnign' },
      400,
    );

    await assert.rejects(() => eap.setLogLevel("order-service", "warnign"), EuclidServiceError);
  });
});

// -- everything else ----------------------------------------------------------------------------------

describe("how EAP behaves", () => {
  it("signs its own target and follows the session", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("eap", "list-applications", { applications: [] });

    await eap.listApplications();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "eap");

    await session.changeNamespace("development");
    await eap.listApplications();
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.equal(session.eap(), eap);
  });

  it("says who refused an administrator-only action", async () => {
    gateway.answer("eap", "create-application", { error: "Administrator rights required" }, 403);

    await assert.rejects(
      () => eap.createApplication("order-service", RUNTIME_JAVA, "artifacts", "app.jar"),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["eap", "create-application", 403]);
        assert.equal(error.reason, "Administrator rights required");
        return true;
      },
    );
  });

  it("exports the runtime constants EAP actually accepts", () => {
    // Spelled by hand rather than derived, because the server matches them exactly and refuses
    // anything else with a 400. A constant that drifted to "JAVA-21" would still read perfectly in
    // calling code and fail only against a running installation.
    assert.deepEqual(
      [RUNTIME_JAVA, RUNTIME_JAVA21, RUNTIME_JAVA25],
      ["JAVA", "JAVA21", "JAVA25"],
    );

    // Three distinct runtimes, not one with aliases: a jar built for 25 does not start on 21, so
    // asking for one and getting the other is the failure these exist to prevent.
    assert.equal(new Set([RUNTIME_JAVA, RUNTIME_JAVA21, RUNTIME_JAVA25]).size, 3);
  });

  it("exports the two application types, and reads a missing one as PROCESS", async () => {
    assert.deepEqual([TYPE_PROCESS, TYPE_JOB], ["PROCESS", "JOB"]);

    // What an installation older than the field answers. A PROCESS is what such a definition has
    // always behaved as, so reading it as "" - or guessing JOB - would be this SDK inventing a
    // change of behaviour the server never made.
    const { type, schedule, nextRunAt, userExists } = toApplication({ applicationId: "legacy" });
    assert.deepEqual([type, schedule, nextRunAt], [TYPE_PROCESS, "", ""]);

    // And the one flag here that defaults to true: false is an alarm - the identity this application
    // runs as has been deleted - so a server that did not say must not raise it.
    assert.equal(userExists, true);
    assert.equal(toApplication({ applicationId: "gone", userExists: false }).userExists, false);
  });

  it("answers metrics unparsed and reaches unwrapped actions", async () => {
    gateway.answer("eap", "get-metrics", { items: [{ name: "eap-instances", value: 2 }] });
    gateway.answer("eap", "some-future-action", { ok: true });

    assert.deepEqual(await eap.metrics(), { items: [{ name: "eap-instances", value: 2 }] });
    assert.deepEqual(await eap.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });
});
