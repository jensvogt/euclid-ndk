#!/usr/bin/env node
/**
 * EAG end to end: what the gateway publishes, and the ports it publishes it on.
 *
 *   npm run build
 *   node examples/gateway-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Administrator-only, all of it - the server refuses every action here to anybody else. Publishes one module
 * route of its own, named after the moment it started, and deletes it again at the end, so it is safe to
 * point at a running server. An application route is only described, not created: that would need an
 * application to point at.
 */

import { Euclid, EuclidAuthenticationError, EuclidServiceError, ROUTE_AUTH_EUCLID } from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/gateway-walkthrough.mjs <url> <username> <password>");
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
    console.error(`${session.userId} is not an administrator - every EAG action would be refused`);
    process.exit(1);
  }

  const eag = session.eag();
  await listeners(eag);

  const routeId = `ndk-walkthrough-${Math.floor(Date.now() / 1000)}`;
  try {
    await walk(eag, routeId);
  } finally {
    try {
      await eag.deleteRoute(routeId);
      console.log(`\ndeleted route ${routeId}`);
    } catch (error) {
      if (!(error instanceof EuclidServiceError)) throw error;
      console.log(`\ncould not delete route ${routeId}: ${error.reason || error.message}`);
    }
  }
} finally {
  session.close();
}

/** What the gateway was configured to serve, and whether it is serving it. */
async function listeners(eag) {
  const result = await eag.listListeners();
  console.log(`${result.total} listener(s), gateway serving: ${result.serving}`);

  for (const listener of result.items) {
    const scope = listener.namespace || "(every namespace)";
    console.log(`  ${listener.protocol}:${String(listener.port).padEnd(6)} ${scope}`);

    if (listener.protocol !== "https") continue;
    const named = listener.certificateConfigured ? "named in the configuration" : "the conventional one";
    console.log(`      certificate "${listener.certificateName}" (${named})`);

    const seal = listener.certificate;
    if (seal === null) {
      // For an HTTPS listener this is what a port that never came up looks like: the certificate is
      // generated when it starts.
      console.log("      no certificate found - this port is not serving anything");
      continue;
    }
    const origin = seal.generated ? "self-signed by euclid" : `issued by ${seal.issuer}`;
    console.log(`      ${seal.subject}, ${origin}`);
    console.log(`      valid ${seal.notBefore} to ${seal.notAfter}${seal.expired ? "  (EXPIRED)" : ""}`);
    if (seal.subjectAltNames.length > 0) console.log(`      also valid for ${JSON.stringify(seal.subjectAltNames)}`);
  }
}

/** Publishing a path, changing it, and taking it out of service. */
async function walk(eag, routeId) {
  // A module route rather than an application route: it needs nothing deployed to point at. This is what a
  // browser uses to log in before it can call anything else.
  const route = await eag.createModuleRoute(routeId, `/${routeId}/login`, "eam", "login", { methods: ["POST"] });
  console.log(`\npublished ${route.path} -> ${route.moduleTarget}/${route.moduleAction}`);
  console.log(`  ern: ${route.ern}`);
  console.log(
    `  scope: ${route.namespace || "(none)"}/${route.region}, authentication: ${route.authentication}, ` +
      `methods: ${route.methods.length > 0 ? route.methods.join(",") : "every method"}`,
  );

  // Only what is named changes: the path, the module and the methods stay as they are.
  const protectedRoute = await eag.updateRoute(routeId, { authentication: ROUTE_AUTH_EUCLID });
  console.log(`\nrequired a euclid credential: authentication is now ${protectedRoute.authentication}`);

  // How something stops being exposed in a hurry - the route stays exactly as it was.
  const stopped = await eag.setRouteActive(routeId, false);
  console.log(`took it out of service: active=${stopped.active}, and the path is still ${stopped.path}`);
  console.log(`put it back: active=${(await eag.setRouteActive(routeId, true)).active}`);

  console.log(`\nread back by ID: ${(await eag.getRoute(routeId)).path}`);

  const published = await eag.listRoutes();
  console.log(`\n${published.length} route(s) published:`);
  for (const listed of published) {
    const where = listed.moduleTarget ? `${listed.moduleTarget}/${listed.moduleAction}` : listed.applicationId;
    const methods = listed.methods.length > 0 ? listed.methods.join(",") : "ANY";
    console.log(
      `  ${listed.path.padEnd(40)} ${methods.padEnd(20)} -> ${where.padEnd(24)} ` +
        `${listed.authentication.padEnd(7)} ${listed.active ? "" : "(inactive)"}`,
    );
  }

  const under = await eag.listRoutes(`/${routeId}`);
  console.log(`\npublished under /${routeId}: ${JSON.stringify(under.map((entry) => entry.path))}`);
}
