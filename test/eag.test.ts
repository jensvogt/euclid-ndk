/**
 * EAG, end to end against a fake euclid server.
 *
 * Every action here is one request, so what these check is that it carries the fields the server reads and
 * parses the ones it answers with. Two of those matter more than the rest: an optional field that travels as
 * an empty string is not "unspecified" to this server - it is the empty value - and a listener's certificate
 * arrives flat, as a dozen fields alongside the listener's own, which the client has to gather back up.
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  Euclid,
  PROTOCOL_HTTPS,
  ROUTE_AUTH_BASIC,
  ROUTE_AUTH_EUCLID,
  ROUTE_AUTH_NONE,
  type EuclidEag,
  type EuclidSession,
} from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";

const ROUTE = {
  routeId: "orders",
  ern: "ern:eag:route/orders",
  accountId: "000000000000",
  region: "eu-central-1",
  namespace: "development",
  path: "/api/orders",
  applicationId: "order-service",
  moduleTarget: "",
  moduleAction: "",
  methods: ["GET", "POST"],
  authentication: "EUCLID",
  active: true,
  created: "2026-09-10",
  modified: "2026-09-10",
};

const MODULE_ROUTE = {
  ...ROUTE,
  routeId: "login",
  path: "/euclid/login",
  applicationId: "",
  moduleTarget: "eam",
  moduleAction: "login",
  authentication: "NONE",
};

const LISTENER = {
  namespace: "development",
  port: 8443,
  protocol: "https",
  serving: true,
  certificate: "development-gateway",
  certificateConfigured: "",
  certificateFound: true,
  certificateErn: "ern:ekm:certificate/development-gateway",
  certificateSubject: "CN=euclid.example.com",
  certificateIssuer: "CN=euclid.example.com",
  certificateSerialNumber: "01",
  certificateFingerprint: "ab:cd",
  certificateSubjectAltNames: ["euclid.example.com", "localhost"],
  certificateGenerated: true,
  certificateNotBefore: "2026-01-01",
  certificateNotAfter: "2028-04-05",
  certificateExpired: false,
};

const PLAIN_LISTENER = {
  namespace: "",
  port: 8080,
  protocol: "http",
  serving: true,
  certificate: "",
  certificateConfigured: "",
  certificateFound: false,
};

let gateway: FakeGateway;
let session: EuclidSession;
let eag: EuclidEag;
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  process.env["EUCLID_CREDENTIALS_FILE"] = join(await mkdtemp(join(tmpdir(), "euclid-ndk-eag-")), "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  eag = session.eag();
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

// -- routes ---------------------------------------------------------------------------------------

describe("routes", () => {
  it("publishes a path to an application", async () => {
    gateway.answer("eag", "create-route", ROUTE);

    const route = await eag.createRoute("orders", "/api/orders", {
      applicationId: "order-service",
      methods: ["GET", "POST"],
      authentication: ROUTE_AUTH_EUCLID,
    });

    assert.deepEqual(gateway.last().json(), {
      routeId: "orders",
      path: "/api/orders",
      methods: ["GET", "POST"],
      authentication: "EUCLID",
      active: true,
      applicationId: "order-service",
    });
    assert.deepEqual([route.path, route.applicationId], ["/api/orders", "order-service"]);
    assert.deepEqual(route.methods, ["GET", "POST"]);
    assert.equal(route.active, true);
    // An empty module target is what says this one goes to an application.
    assert.equal(route.moduleTarget, "");
  });

  it("publishes a path to a euclid module", async () => {
    // The way in for something outside euclid that needs euclid itself - a browser that has to log in before
    // it can call anything.
    gateway.answer("eag", "create-route", MODULE_ROUTE);

    const route = await eag.createModuleRoute("login", "/euclid/login", "eam", "login", { methods: ["POST"] });

    assert.deepEqual(gateway.last().json(), {
      routeId: "login",
      path: "/euclid/login",
      methods: ["POST"],
      authentication: "NONE",
      active: true,
      moduleTarget: "eam",
      moduleAction: "login",
    });
    assert.deepEqual([route.moduleTarget, route.moduleAction], ["eam", "login"]);
    assert.equal(route.applicationId, "");
  });

  it("goes to one thing or the other", async () => {
    // Never both and never neither: those are reached in entirely different ways, and a route that named both
    // would leave which one wins up to the proxy.
    await assert.rejects(() => eag.createRoute("orders", "/api/orders"), /not both and not neither/);
    await assert.rejects(
      () => eag.createRoute("orders", "/api/orders", { applicationId: "order-service", moduleTarget: "eam", moduleAction: "login" }),
      /not both and not neither/,
    );
    await assert.rejects(
      () => eag.createRoute("login", "/euclid/login", { moduleTarget: "eam" }),
      /moduleAction is required/,
    );

    assert.deepEqual(gateway.requests.filter((request) => request.target === "eag"), []);
  });

  it("leaves the optional scope out rather than sending it empty", async () => {
    // The server reads an empty namespace as the empty namespace rather than as "unspecified", so sending one
    // would scope the route to nothing instead of to the session.
    gateway.answer("eag", "create-route", ROUTE);

    await eag.createRoute("orders", "/api/orders", { applicationId: "order-service" });
    assert.equal("namespace" in gateway.last().json(), false);
    assert.equal("region" in gateway.last().json(), false);

    await eag.createRoute("orders", "/api/orders", {
      applicationId: "order-service",
      namespace: "production",
      region: "eu-west-1",
    });
    assert.equal(gateway.last().json()["namespace"], "production");
    assert.equal(gateway.last().json()["region"], "eu-west-1");
  });

  it("takes no methods to mean every method", async () => {
    gateway.answer("eag", "create-route", { ...ROUTE, methods: [] });

    const route = await eag.createRoute("orders", "/api/orders", { applicationId: "order-service" });

    assert.deepEqual(gateway.last().json()["methods"], []);
    assert.deepEqual(route.methods, []);
  });

  it("sends only what an update was given", async () => {
    gateway.answer("eag", "update-route", ROUTE);

    await eag.updateRoute("orders", { path: "/api/v2/orders" });
    assert.deepEqual(gateway.last().json(), { routeId: "orders", path: "/api/v2/orders" });

    await eag.updateRoute("orders", { authentication: ROUTE_AUTH_BASIC, methods: ["GET"] });
    assert.deepEqual(gateway.last().json(), { routeId: "orders", authentication: "BASIC", methods: ["GET"] });

    // Moving a route to an application clears its module target, which is the server's doing - the client just
    // has to be able to say "this one field".
    await eag.updateRoute("orders", { applicationId: "order-service-v2" });
    assert.deepEqual(gateway.last().json(), { routeId: "orders", applicationId: "order-service-v2" });

    // An empty string is a value here rather than "leave it alone", and has to be sendable.
    await eag.updateRoute("orders", { moduleAction: "" });
    assert.deepEqual(gateway.last().json(), { routeId: "orders", moduleAction: "" });
  });

  it("changes nothing else when taking a route out of service", async () => {
    // Which is what makes it different from deleting and recreating it.
    gateway.answer("eag", "update-route", { ...ROUTE, active: false });

    const route = await eag.setRouteActive("orders", false);

    assert.deepEqual(gateway.last().json(), { routeId: "orders", active: false });
    assert.equal(route.active, false);
  });

  it("lists, gets and deletes them", async () => {
    gateway.answer("eag", "list-routes", { routes: [ROUTE, MODULE_ROUTE] });
    gateway.answer("eag", "get-route", ROUTE);
    gateway.answer("eag", "delete-route", {});

    const routes = await eag.listRoutes("/api");
    assert.deepEqual(gateway.last().json(), { prefix: "/api" });
    assert.deepEqual(routes.map((route) => route.routeId), ["orders", "login"]);
    assert.deepEqual(routes.map((route) => route.moduleTarget !== ""), [false, true]);

    assert.deepEqual(await eag.listRoutes(), routes);
    assert.deepEqual(gateway.last().json(), { prefix: "" });

    assert.equal((await eag.getRoute("orders")).path, "/api/orders");
    assert.deepEqual(gateway.last().json(), { routeId: "orders" });

    await eag.deleteRoute("orders");
    assert.deepEqual(gateway.last().json(), { routeId: "orders" });
  });

  it("carries the server's reason when a path is taken", async () => {
    gateway.answer("eag", "create-route", { error: "Path and method are already routed by routeId: orders" }, 409);

    await assert.rejects(
      () => eag.createRoute("orders-2", "/api/orders", { applicationId: "order-service" }),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["eag", "create-route", 409]);
        assert.ok(error.reason.startsWith("Path and method are already routed"));
        return true;
      },
    );
  });

  it("reads a route the server described sparsely", async () => {
    gateway.answer("eag", "get-route", { routeId: "orders", path: "/api/orders" });

    const route = await eag.getRoute("orders");

    assert.deepEqual(route.methods, []);
    assert.equal(route.authentication, "");
    // Absent means serving, which is the server's default for a stored route.
    assert.equal(route.active, true);
  });
});

// -- listeners --------------------------------------------------------------------------------------

describe("listeners", () => {
  it("gathers a flat certificate back up", async () => {
    gateway.answer("eag", "list-listeners", { listeners: [LISTENER, PLAIN_LISTENER], total: 2, serving: true });

    const result = await eag.listListeners();

    assert.deepEqual(gateway.last().json(), {});
    assert.deepEqual([result.total, result.serving], [2, true]);

    const [https, plain] = result.items;
    assert.deepEqual([https?.port, https?.protocol, https?.namespace], [8443, PROTOCOL_HTTPS, "development"]);
    assert.notEqual(https?.certificate, null);
    assert.equal(https?.certificate?.subject, "CN=euclid.example.com");
    assert.deepEqual(https?.certificate?.subjectAltNames, ["euclid.example.com", "localhost"]);
    // Whether euclid minted it itself, which is what decides whether the port works for anybody who has not
    // been told about it.
    assert.deepEqual([https?.certificate?.generated, https?.certificate?.expired], [true, false]);

    // This listener took the conventional certificate for its namespace rather than naming one.
    assert.equal(https?.certificateName, "development-gateway");
    assert.equal(https?.certificateConfigured, "");

    // A plain HTTP listener has no certificate to be missing, and reporting one as absent would read as a
    // fault rather than a setting.
    assert.equal(plain?.certificate, null);
  });

  it("says when a listener named its certificate", async () => {
    gateway.answer("eag", "list-listeners", {
      listeners: [{ ...LISTENER, certificateConfigured: "wildcard-2026" }],
      total: 1,
      serving: true,
    });

    const listener = (await eag.listListeners()).items[0];

    assert.equal(listener?.certificateConfigured, "wildcard-2026");
  });

  it("still lists a port that never came up", async () => {
    // It is the one somebody is looking for - and an HTTPS listener with no certificate is what that looks
    // like.
    gateway.answer("eag", "list-listeners", {
      listeners: [{ ...LISTENER, serving: false, certificateFound: false }],
      total: 1,
      serving: false,
    });

    const result = await eag.listListeners();

    assert.equal(result.serving, false);
    assert.equal(result.items[0]?.protocol, PROTOCOL_HTTPS);
    assert.equal(result.items[0]?.certificate, null);
  });
});

// -- everything else ----------------------------------------------------------------------------------

describe("how EAG behaves", () => {
  it("signs its own target and follows the session", async () => {
    gateway.answer("eam", "change-namespace", {});
    gateway.answer("eag", "list-routes", { routes: [] });

    await eag.listRoutes();
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "eag");

    await session.changeNamespace("development");
    await eag.listRoutes();
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    assert.equal(session.eag(), eag);
  });

  it("says who refused an administrator-only action", async () => {
    // Every EAG action is administrator-only server-side, and the server enforces it whatever the session
    // believes about itself.
    gateway.answer("eag", "create-route", { error: "Administrator rights required" }, 403);

    await assert.rejects(
      () => eag.createRoute("orders", "/api/orders", { applicationId: "order-service", authentication: ROUTE_AUTH_NONE }),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 403);
        assert.equal(error.reason, "Administrator rights required");
        return true;
      },
    );
  });

  it("answers metrics unparsed and reaches unwrapped actions", async () => {
    gateway.answer("eag", "get-metrics", { items: [{ name: "eag-requests", value: 3 }] });
    gateway.answer("eag", "some-future-action", { ok: true });

    assert.deepEqual(await eag.metrics(), { items: [{ name: "eag-requests", value: 3 }] });
    assert.deepEqual(await eag.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
  });
});
