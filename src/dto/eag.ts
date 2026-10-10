/**
 * The shapes EAG sends back.
 *
 * Parsed the same defensive way as every other module's. One thing is not just parsed but gathered: a
 * listener's certificate arrives flat, as a dozen `certificate*` fields alongside the listener's own, and
 * {@link toListener} collects them into a {@link ListenerCertificate} - or into null, when the server said
 * it found none.
 */

import { type Page } from "./eam.js";
import { documents, flag, number, object, strings, text } from "./json.js";

/**
 * One published path: what the gateway answers for, and where it sends it.
 *
 * A route goes to an application euclid runs or to a euclid module, never to both and never to neither, so
 * a non-empty `moduleTarget` is exactly what says this is a module route. An empty `methods` means every
 * method.
 */
/**
 * What an upload route does with a body, as the server stored it.
 *
 * Present on every route and empty on a proxy one, since the server reports the block either way.
 */
export interface RouteUpload {
  /** The bucket uploads are written into, by ERN. */
  bucket: string;
  /** Prefixed to the key each upload lands under; empty writes at the root of the bucket. */
  keyPrefix: string;
  /** The largest body accepted, in bytes. Zero accepts any size. */
  maxBytes: number;
  /** How much of a body is buffered before each part goes to ESM. */
  partSize: number;
  /** The content types accepted; empty accepts any. */
  contentTypes: string[];
}

export interface Route {
  routeId: string;
  ern: string;
  accountId: string;
  region: string;
  namespace: string;
  path: string;
  applicationId: string;
  moduleTarget: string;
  moduleAction: string;
  methods: string[];
  /**
   * `NONE`, `EUCLID` or `BASIC` - what a caller has to present before anything is forwarded. See
   * {@link import("../modules/eag.js")}.
   */
  authentication: string;
  /**
   * `PROXY` or `UPLOAD` - whether the gateway forwards what this route carries or writes it into a bucket.
   * A route stored before the type existed reads as `PROXY`, which is what it is. See
   * {@link import("../modules/eag.js").ROUTE_UPLOAD}.
   */
  type: string;
  /** Where an upload route puts what it receives. Empty on a proxy route. */
  upload: RouteUpload;
  /**
   * Whether the gateway is serving this path at all - see
   * {@link import("../modules/eag.js").EuclidEag.setRouteActive}.
   */
  active: boolean;
  created: string;
  modified: string;
}

/**
 * The certificate an HTTPS listener is actually serving.
 *
 * `generated` is whether euclid minted it itself because the listener needed something to start with.
 * Callers reject a self-signed certificate until they are given it, so which of the two this is decides
 * whether the port works for anybody who has not been told about it.
 */
export interface ListenerCertificate {
  ern: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprint: string;
  subjectAltNames: string[];
  generated: boolean;
  notBefore: string;
  notAfter: string;
  /** Whether `notAfter` is already in the past, as the server judged it against its own clock. */
  expired: boolean;
}

/**
 * One port the gateway was configured to answer on, and what it speaks.
 *
 * `certificateName` is the certificate this listener serves, which is the conventional one for its
 * namespace when the configuration named none; `certificateConfigured` is what the configuration actually
 * wrote, so "this listener names its certificate" and "this listener takes the conventional one" can be
 * told apart - the second is a non-empty `certificateConfigured`.
 */
export interface Listener {
  namespace: string;
  port: number;
  /** `http` or `https`. */
  protocol: string;
  /**
   * Whether the gateway's ports are bound at all - the same answer for every listener, since it is a
   * property of the proxy rather than of one port.
   */
  serving: boolean;
  certificateName: string;
  certificateConfigured: string;
  /** Null for a plain HTTP listener, and for an HTTPS one whose certificate the server did not find. */
  certificate: ListenerCertificate | null;
}

/**
 * What the gateway was configured to serve, and whether it is serving it.
 *
 * A listener whose port was taken, or whose certificate could not be loaded, is still in `items` - it is
 * the one somebody is looking for - and `serving` is what says whether anything is actually bound.
 */
export interface ListListenersResult extends Page<Listener> {
  serving: boolean;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toRouteUpload(document: unknown): RouteUpload {
  return {
    bucket: text(document, "bucket"),
    keyPrefix: text(document, "keyPrefix"),
    maxBytes: number(document, "maxBytes"),
    partSize: number(document, "partSize"),
    contentTypes: strings(document, "contentTypes"),
  };
}

export function toRoute(document: unknown): Route {
  return {
    routeId: text(document, "routeId"),
    ern: text(document, "ern"),
    accountId: text(document, "accountId"),
    region: text(document, "region"),
    namespace: text(document, "namespace"),
    path: text(document, "path"),
    applicationId: text(document, "applicationId"),
    moduleTarget: text(document, "moduleTarget"),
    moduleAction: text(document, "moduleAction"),
    methods: strings(document, "methods"),
    authentication: text(document, "authentication"),
    // "PROXY" when absent, the server's own rule for a route stored before the type existed: it forwards,
    // and reading it as anything else would describe a behaviour the gateway never had.
    type: text(document, "type") || "PROXY",
    upload: toRouteUpload(object(document)["upload"]),
    // Absent means serving, which is the server's default for a stored route.
    active: flag(document, "active", true),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

/**
 * The certificate a listener entry describes, or null when it describes none.
 *
 * A plain HTTP listener has no certificate to be missing, and an HTTPS one whose certificate is absent is
 * what a port that never came up looks like - neither is a certificate this can describe, and the server
 * says which by `certificateFound`.
 */
export function toListenerCertificate(document: unknown): ListenerCertificate | null {
  if (!flag(document, "certificateFound")) return null;
  return {
    ern: text(document, "certificateErn"),
    subject: text(document, "certificateSubject"),
    issuer: text(document, "certificateIssuer"),
    serialNumber: text(document, "certificateSerialNumber"),
    fingerprint: text(document, "certificateFingerprint"),
    subjectAltNames: strings(document, "certificateSubjectAltNames"),
    generated: flag(document, "certificateGenerated"),
    notBefore: text(document, "certificateNotBefore"),
    notAfter: text(document, "certificateNotAfter"),
    expired: flag(document, "certificateExpired"),
  };
}

export function toListener(document: unknown): Listener {
  return {
    namespace: text(document, "namespace"),
    port: number(document, "port"),
    protocol: text(document, "protocol"),
    serving: flag(document, "serving"),
    certificateName: text(document, "certificate"),
    certificateConfigured: text(document, "certificateConfigured"),
    certificate: toListenerCertificate(document),
  };
}

export function toListListenersResult(document: unknown): ListListenersResult {
  const items = documents(document, "listeners").map(toListener);
  // The server sends a total; falling back to what arrived keeps a sparse answer self-consistent.
  return { total: number(document, "total") || items.length, items, serving: flag(document, "serving") };
}
