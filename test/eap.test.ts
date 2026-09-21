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
  RUNTIME_PYTHON,
  STATE_RUNNING,
  STATE_STOPPED,
  type EuclidEap,
  type EuclidSession,
} from "../src/index.js";
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
  userId: "app-order-service",
  logLevel: "",
  minInstances: 2,
  maxInstances: 5,
  readyTimeoutMs: 30000,
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
      user: "",
      minInstances: 2,
      maxInstances: 5,
      readyTimeoutMs: 30000,
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

  it("answers metrics unparsed and reaches unwrapped actions", async () => {
    gateway.answer("eap", "get-metrics", { items: [{ name: "eap-instances", value: 2 }] });
    gateway.answer("eap", "some-future-action", { ok: true });

    assert.deepEqual(await eap.metrics(), { items: [{ name: "eap-instances", value: 2 }] });
    assert.deepEqual(await eap.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });
});
