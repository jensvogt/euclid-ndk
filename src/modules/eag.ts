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
 * An **upload** route is the exception, and the difference is not which backend but who reads the body: a
 * proxied request is buffered whole and handed on, while an upload is streamed straight into ESM in parts
 * and never held in memory. So it forwards to nothing and names a bucket instead of a backend - see
 * {@link EuclidEag.createUploadRoute}.
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

/**
 * What the gateway does with a request a route matches.
 *
 * {@link ROUTE_PROXY} forwards it, which is what almost every route is and what a route with no type
 * stored still is. {@link ROUTE_UPLOAD} terminates it here and writes the body into a bucket.
 */
export const ROUTE_PROXY = "PROXY";
export const ROUTE_UPLOAD = "UPLOAD";

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

/** How much a part of a streamed upload is, unless the route says otherwise. */
export const DEFAULT_UPLOAD_PART_SIZE = 5 * 1024 * 1024;

/** What an upload route accepts, beyond the bucket it writes into. */
export interface CreateUploadRouteOptions extends Omit<CreateRouteOptions, "applicationId" | "moduleTarget" | "moduleAction"> {
  /**
   * Prefixed to the key every upload is stored under, which is otherwise the path below the route. A
   * trailing slash is added if it is missing and leading ones are dropped, so `"inbox"` and `"/inbox/"`
   * name the same prefix.
   */
  keyPrefix?: string;
  /**
   * The largest body this route accepts, in bytes; zero - the default - accepts any size. A
   * `Content-Length` over it is refused with 413 before a byte of the body is read, and a body that turns
   * out to be longer than it claimed is cut off at the same limit: the header is a claim, and the limit is
   * what holds when the claim was a lie.
   */
  maxBytes?: number;
  /**
   * How much of the body is buffered before each part goes to ESM. Defaults to
   * {@link DEFAULT_UPLOAD_PART_SIZE}, and has to be greater than zero.
   */
  partSize?: number;
  /**
   * The content types this route accepts - `["image/png", "application/pdf"]`. Empty, the default, accepts
   * any. Matched case-insensitively with parameters stripped, so `text/csv; charset=utf-8` matches
   * `"text/csv"`, and anything else is refused with 415 before the body is read.
   */
  contentTypes?: readonly string[];
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
  /** {@link ROUTE_PROXY} or {@link ROUTE_UPLOAD}. Turning a route into one clears what the other needed. */
  type?: string;
  /** The bucket an upload route writes into, by ERN. Only meaningful on an upload route. */
  bucket?: string;
  keyPrefix?: string;
  maxBytes?: number;
  partSize?: number;
  contentTypes?: readonly string[];
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
  "type",
  "bucket",
  "keyPrefix",
  "maxBytes",
  "partSize",
  "contentTypes",
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
   * Refused with HTTP 409 if this account and namespace already use the route ID, or if another route already
   * answers for this path and one of these methods. An application that does not exist is refused with 404 rather than becoming a
   * route that answers 503 for every request - which looks like an application that is down rather than one
   * that was never deployed.
   *
   * @param routeId the name to manage this route under, unique within this account and namespace.
   * @param path the path prefix to publish, which has to start with `/`.
   * @param options request options
   * @throws {Error} if neither an application nor a module was named, or both were. The server refuses that
   *   too; this just says so before the round trip.
   */
  async createRoute(routeId: string, path: string, options: CreateRouteOptions = {}): Promise<Route> {
    const applicationId = options.applicationId ?? "";
    const moduleTarget = options.moduleTarget ?? "";
    // The server's rule for a proxy route, checked here to save the round trip. An upload route names
    // neither of these - see createUploadRoute, which is why this is not simply always required.
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
   * Publishes a path that writes what it receives into a bucket, instead of forwarding it anywhere.
   *
   * The gateway is the endpoint here. A request's body is streamed into ESM in parts as it arrives and is
   * never held whole in memory, which is what makes an upload a route *type* rather than another field on
   * the proxy behaviour - the two cannot share a request path. So this names a bucket and no backend, and
   * the server refuses an upload route that names an application or a module: naming one says the author
   * expected the request to be forwarded, and it will not be.
   *
   * The key an upload lands under is the path below the route, with `keyPrefix` in front of it. Keys are
   * checked rather than trusted - an empty path segment, a `.` or `..` segment, or a null byte is refused -
   * so a caller cannot climb out of the prefix it was given.
   *
   * `maxBytes` and `contentTypes` are both answered *before* the body is read, which is the point of having
   * matched the route first: a caller sending something this route will not take is told so now rather than
   * after spending however long it takes to send it.
   *
   * @param routeId the route's own ID, unique within the account and namespace
   * @param path the path prefix it publishes; it has to start with `/`
   * @param bucketErn the bucket to write into, by ERN - it has to exist already, since a route to a bucket
   *   that is not there accepts a whole upload before discovering it has nowhere to put it
   * @param options the limits and the key prefix
   */
  async createUploadRoute(
    routeId: string,
    path: string,
    bucketErn: string,
    options: CreateUploadRouteOptions = {},
  ): Promise<Route> {
    const payload: Record<string, unknown> = {
      routeId,
      path,
      type: ROUTE_UPLOAD,
      bucket: bucketErn,
      methods: [...(options.methods ?? [])],
      authentication: options.authentication ?? ROUTE_AUTH_NONE,
      active: options.active ?? true,
      keyPrefix: options.keyPrefix ?? "",
      maxBytes: options.maxBytes ?? 0,
      partSize: options.partSize ?? DEFAULT_UPLOAD_PART_SIZE,
      contentTypes: [...(options.contentTypes ?? [])],
    };
    if (options.namespace) payload["namespace"] = options.namespace;
    if (options.region) payload["region"] = options.region;
    return toRoute(await this.call("create-route", payload));
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
   *
   * The session's own account and namespace, as {@link getRoute}, {@link updateRoute} and
   * {@link deleteRoute} are - so this lists what the session can then address rather than everything the
   * gateway serves. The proxy itself routes across every namespace; this is the management view of it.
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
