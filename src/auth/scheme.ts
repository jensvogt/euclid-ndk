/** Which request-signing scheme a client uses when it authenticates with an access key. */

import * as rfc9421 from "./rfc9421.js";
import type { SignableRequest } from "./signable.js";
import * as sigv4 from "./sigv4.js";

/**
 * SigV4 or RFC 9421.
 *
 * Two schemes exist because euclid is moving from one to the other, not because both are wanted in
 * the end. {@link SIGV4} is what euclid has always spoken and stays the default, so no existing
 * caller changes behaviour; {@link RFC9421} is the standard scheme meant to replace it. Choosing
 * one is a per-client decision, so a deployment can move one service at a time and roll back by
 * changing a line rather than a release.
 *
 * Neither is consulted when a client authenticates with a bearer token: with no access key there is
 * nothing to sign with, and the token goes in Authorization as before.
 *
 * The two do not collide on the wire - SigV4 puts its signature in Authorization, RFC 9421 in
 * Signature/Signature-Input - so a server can accept both at once and tell which a request used.
 * {@link signingSchemeOf} is that test.
 */
export interface SigningScheme {
  readonly name: "sigv4" | "rfc9421";

  /**
   * Signs a request in place.
   *
   * `region` and `service` are ignored by {@link RFC9421}: SigV4 needs them to derive its signing
   * key, whereas RFC 9421 signs the `x-euclid-region` and `x-euclid-target` headers that carry the
   * same facts, and binding them twice would add a way for the two copies to disagree.
   */
  sign(req: SignableRequest, accessKeyId: string, secretAccessKey: string, region: string, service: string): void;

  /** Verifies a request signed with this scheme, answering the access key ID or null. */
  verify(req: SignableRequest, lookupSecret: (keyId: string) => string | null | undefined): string | null;

  /** The headers {@link SigningScheme.sign} writes, for callers that copy them onto another request. */
  signatureHeaderNames(): readonly string[];
}

/** What euclid has always spoken, and the default. */
export const SIGV4: SigningScheme = Object.freeze<SigningScheme>({
  name: "sigv4",
  sign(req, accessKeyId, secretAccessKey, region, service) {
    sigv4.sign(req, accessKeyId, secretAccessKey, region, service);
  },
  verify(req, lookupSecret) {
    return sigv4.verify(req, lookupSecret);
  },
  signatureHeaderNames() {
    return sigv4.SIGNATURE_HEADER_NAMES;
  },
});

/** The standard scheme meant to replace SigV4. */
export const RFC9421: SigningScheme = Object.freeze<SigningScheme>({
  name: "rfc9421",
  sign(req, accessKeyId, secretAccessKey) {
    rfc9421.sign(req, accessKeyId, secretAccessKey);
  },
  verify(req, lookupSecret) {
    return rfc9421.verify(req, lookupSecret);
  },
  signatureHeaderNames() {
    return rfc9421.SIGNATURE_HEADER_NAMES;
  },
});

/**
 * Which scheme, if either, a received request presents a signature for.
 *
 * A routing decision, not a verification: it says which {@link SigningScheme.verify} to call and
 * nothing about whether that call will succeed. Null means the request presents no signature at
 * all - a bearer-token request, or an unsigned one.
 */
export function signingSchemeOf(req: SignableRequest): SigningScheme | null {
  if (req.get("signature-input")) return RFC9421;
  if (req.get("authorization").startsWith(sigv4.ALGORITHM)) return SIGV4;
  return null;
}
