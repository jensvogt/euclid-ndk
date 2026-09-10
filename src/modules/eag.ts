/**
 * EAG - euclid's API gateway: the paths it publishes, and the ports it publishes them on.
 *
 * One object, {@link EuclidEag}, built from a session that has already logged in:
 *
 * ```ts
 * const eag = session.eag();
 *
 * await eag.createRoute("orders", "/api/orders", { applicationId: "order-service" });
 * await eag.createModuleRoute("login", "/euclid/login", "eam", "login");
 * ```
 *
 * A route publishes a path prefix and says where everything beneath it goes: to an application euclid runs,
 * or to one action of a euclid module. It is one or the other, never both and never neither - those are
 * reached in entirely different ways, and a route that named both would leave which one wins up to the
 * proxy.
 *
 * Module routes are the way in for something outside euclid that needs euclid itself - a browser that has to
 * log in before it can call anything. Without one, a front end would talk to the API gateway for the
 * application and to euclid's own gateway for its credentials: two ports, two origins, and CORS between
 * them.
 *
 * Every action here is administrator-only, server-side. {@link EuclidSession.isAdmin} says whether the
 * logged-in user is one, though the server enforces it regardless.
 */

import {
  toListListenersResult,
  toRoute,
  type ListListenersResult,
  type Route,
} from "../dto/eag.js";
import { ModuleClient } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "eag";

/** Proxied as it arrives: whatever the application requires, it enforces itself. */
export const ROUTE_AUTH_NONE = "NONE";
/**
 * A euclid credential is required and verified before anything is forwarded - whatever euclid's own gateway
 * accepts, which is a bearer token, an RFC 9421 signature or SigV4.
 */
export const ROUTE_AUTH_EUCLID = "EUCLID";
/**
 * HTTP Basic against a euclid user's password, for the callers a euclid credential does not suit: a browser,
 * which prompts when it is answered with `WWW-Authenticate`, and a script with nothing but curl.
 */
export const ROUTE_AUTH_BASIC = "BASIC";

/** What a listener speaks, as {@link import("../dto/eag.js").Listener} reports it. */
export const PROTOCOL_HTTP = "http";
export const PROTOCOL_HTTPS = "https";

/** Where a route sends what it carries, and on what terms. */
export interface CreateRouteOptions {
  /** The application requests are sent to, which has to exist already. */
  applicationId?: string;
  /**
   * The euclid module to reach instead, e.g. `"eam"` - see {@link EuclidEag.createModuleRoute}, which is
   * this with the pair spelled out.
   */
  moduleTarget?: string;
  /** The one action that module answers for on this route. */
  moduleAction?: string;
  /** The HTTP methods this route answers for; none means every method. */
  methods?: Iterable<string>;
  /** {@link ROUTE_AUTH_NONE}, {@link ROUTE_AUTH_EUCLID} or {@link ROUTE_AUTH_BASIC}. */
  authentication?: string;
  /** Whether the gateway serves it from the start. */
  active?: boolean;
  /**
   * The namespace requests carried by this route act in. Left empty, the session's own - which is almost
   * always what is meant, and nameable because it is not always: a route published for one namespace should
   * not act in another just because an administrator of the first happened to configure it.
   */
  namespace?: string;
  /** Likewise, defaulting to the session's. */
  region?: string;
}

/** The same, minus the pair {@link EuclidEag.createModuleRoute} supplies itself. */
export type CreateModuleRouteOptions = Omit<CreateRouteOptions, "applicationId" | "moduleTarget" | "moduleAction">;

/**
 * What an update changes - and only what it names.
 *
 * The distinction the server draws is between a field being sent and not being sent, rather than between its
 * values, so leaving `path` out leaves the stored path alone. Moving a route to an application clears its
 * module target and the other way round, since leaving both set would make which one wins depend on the
 * proxy.
 */
export interface UpdateRouteChanges {
  path?: string;
  applicationId?: string;
  moduleTarget?: string;
  moduleAction?: string;
  methods?: Iterable<string>;
  authentication?: string;
  active?: boolean;
  namespace?: string;
  region?: string;
}

/** The fields an update sends when - and only when - it was given them. */
const UPDATABLE = [
  "path",
  "applicationId",
  "moduleTarget",
  "moduleAction",
  "methods",
  "authentication",
  "active",
  "namespace",
  "region",
] as const satisfies readonly (keyof UpdateRouteChanges)[];

/**
 * EAG's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.eag} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEag extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  // -- routes ----------------------------------------------------------------------------------

  /**
   * Publishes a path, and sends everything beneath it to an application or to a module.
   *
   * Refused with HTTP 409 if the route ID is taken, or if another route already answers for this path and
   * one of these methods. An application that does not exist is refused with 404 rather than becoming a
   * route that answers 503 for every request - which looks like an application that is down rather than one
   * that was never deployed.
   *
   * @param routeId the name to manage this route under, unique across the installation.
   * @param path the path prefix to publish, which has to start with `/`.
   * @param options request options
   * @throws {Error} if neither an application nor a module was named, or both were. The server refuses that
   *   too; this just says so before the round trip.
   */
  async createRoute(routeId: string, path: string, options: CreateRouteOptions = {}): Promise<Route> {
    const applicationId = options.applicationId ?? "";
    const moduleTarget = options.moduleTarget ?? "";
    if (Boolean(applicationId) === Boolean(moduleTarget)) {
      throw new Error("name either an applicationId or a moduleTarget, not both and not neither");
    }
    if (moduleTarget && !options.moduleAction) {
      throw new Error("moduleAction is required when a moduleTarget is named");
    }

    const payload: Record<string, unknown> = {
      routeId,
      path,
      methods: [...(options.methods ?? [])],
      authentication: options.authentication ?? ROUTE_AUTH_NONE,
      active: options.active ?? true,
    };
    // Only when the caller named one: the server reads an empty string as the empty namespace rather than
    // as "unspecified", so sending one would scope the route to nothing.
    if (applicationId) payload["applicationId"] = applicationId;
    if (moduleTarget) {
      payload["moduleTarget"] = moduleTarget;
      payload["moduleAction"] = options.moduleAction;
    }
    if (options.namespace) payload["namespace"] = options.namespace;
    if (options.region) payload["region"] = options.region;
    return toRoute(await this.call("create-route", payload));
  }

  /**
   * Publishes a path that reaches one action of a euclid module rather than an application.
   *
   * The same call as {@link createRoute} with the module pair required rather than optional, because that
   * pair is what makes a module route: a target with no action gives the gateway nothing to dispatch on, and
   * would answer 400 for every request the route ever carries.
   */
  async createModuleRoute(
    routeId: string,
    path: string,
    moduleTarget: string,
    moduleAction: string,
    options: CreateModuleRouteOptions = {},
  ): Promise<Route> {
    return this.createRoute(routeId, path, { ...options, moduleTarget, moduleAction });
  }

  /**
   * Changes a route that already exists. Only what `changes` names changes - see
   * {@link UpdateRouteChanges}.
   */
  async updateRoute(routeId: string, changes: UpdateRouteChanges = {}): Promise<Route> {
    const payload: Record<string, unknown> = { routeId };
    for (const field of UPDATABLE) {
      const value = changes[field];
      if (value === undefined) continue;
      payload[field] = field === "methods" ? [...(value as Iterable<string>)] : value;
    }
    return toRoute(await this.call("update-route", payload));
  }

  /**
   * Takes a route out of service, or puts it back, without changing anything else about it.
   *
   * This is how something stops being exposed in a hurry: the route stays exactly as it was and comes back
   * the same when it is reactivated, which deleting and recreating it would not guarantee.
   */
  async setRouteActive(routeId: string, active: boolean): Promise<Route> {
    return this.updateRoute(routeId, { active });
  }

  /**
   * The routes whose path starts with a prefix - what somebody asking "what is published under `/api`"
   * wants. An empty prefix lists them all.
   *
   * The prefix filters on the path rather than on the route ID, and is matched literally rather than as a
   * pattern, so `/api/v1.0` does not also match `/api/v1X0`.
   */
  async listRoutes(pathPrefix = ""): Promise<Route[]> {
    const response = await this.call("list-routes", { prefix: pathPrefix });
    const routes = response["routes"];
    return Array.isArray(routes) ? routes.map(toRoute) : [];
  }

  /** One route, by its ID. */
  async getRoute(routeId: string): Promise<Route> {
    return toRoute(await this.call("get-route", { routeId }));
  }

  /**
   * Deletes a route, which stops the gateway serving its path.
   *
   * Deleting is not how something is taken out of service temporarily - see {@link setRouteActive}, which
   * leaves the route as it was so it returns exactly the same.
   */
  async deleteRoute(routeId: string): Promise<void> {
    await this.call("delete-route", { routeId });
  }

  // -- listeners -------------------------------------------------------------------------------

  /**
   * The ports the gateway was configured to answer on, and whether it is answering.
   *
   * A listener whose port was taken, or whose certificate could not be loaded, is still listed - it is the
   * one somebody is looking for - and `serving` is what says whether anything is bound. For an HTTPS
   * listener the certificate comes with it, including whether euclid minted it itself.
   */
  async listListeners(): Promise<ListListenersResult> {
    return toListListenersResult(await this.call("list-listeners"));
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * EAG's own metrics, as the server collects them. Answered unparsed - the shape belongs to the monitoring
   * module rather than to EAG.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}
