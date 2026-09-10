/**
 * Request signing and verification for euclid.
 *
 * Two schemes, one credential pair. {@link import("./sigv4.js")} is what euclid has always spoken;
 * {@link import("./rfc9421.js")} is the standard scheme replacing it. Both are keyed by the access
 * key ID and secret a login hands back, and {@link SigningScheme} is how a client picks between
 * them.
 *
 * Verification is here as well as signing, because it is the only way to demonstrate that the two
 * canonicalisations are the same one, and because a Node service fronting euclid needs to check the
 * signatures it receives with the same rules the server applies.
 */

export * as rfc9421 from "./rfc9421.js";
export { RFC9421, SIGV4, signingSchemeOf } from "./scheme.js";
export type { SigningScheme } from "./scheme.js";
export { SignableRequest } from "./signable.js";
export * as sigv4 from "./sigv4.js";
