/**
 * AWS Signature Version 4 request signing and verification.
 *
 * Ported from euclid's `Core::SigV4` (C++, `core/src/SigV4.cpp`), by way of euclid-pdk. Unlike real
 * AWS, the target service and the action live in `x-euclid-*` headers rather than in the URI, so
 * those headers are always part of the signed set: a fixed list rather than the client-chosen
 * `SignedHeaders` that AWS allows, so that nothing in transit can narrow what a signature actually
 * covers and still have it verify.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { SignableRequest } from "./signable.js";

export const ALGORITHM = "AWS4-HMAC-SHA256";
const SCOPE_TERMINATOR = "aws4_request";
const DEFAULT_MAX_SKEW_MS = 15 * 60 * 1000;

/**
 * Always part of the signature, in the (already alphabetical) order the canonical request needs.
 * host and the two x-amz-* headers give the usual SigV4 transport and payload integrity; the
 * x-euclid-* headers are in there because that is where euclid carries the routing information AWS
 * would put in the URI, and a signature that left them out would authenticate a request without
 * authenticating what it asks for.
 */
const SIGNED_HEADER_NAMES = [
  "host",
  "x-amz-content-sha256",
  "x-amz-date",
  "x-euclid-account-id",
  "x-euclid-action",
  "x-euclid-region",
  "x-euclid-target",
  "x-euclid-user-id",
] as const;

/**
 * Signature headers, in the case they are sent in, for callers that copy them onto some other
 * request object afterwards.
 */
export const SIGNATURE_HEADER_NAMES = ["x-amz-date", "x-amz-content-sha256", "Authorization"] as const;

/** The `<key>/<date>/<region>/<service>/aws4_request` scope out of an Authorization header. */
export interface CredentialScope {
  accessKeyId: string;
  dateStamp: string;
  region: string;
  service: string;
}

/** An Authorization header split into its parts. */
export interface ParsedAuthorization {
  scope: CredentialScope;
  signedHeaders: string;
  signature: string;
}

/** The headers a SigV4 signature always covers, lowercase, in signing order. */
export function signedHeaderNames(): readonly string[] {
  return SIGNED_HEADER_NAMES;
}

/**
 * Parses `AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...`.
 *
 * Answers null when the header is absent or not well-formed, which the caller treats exactly as it
 * treats a signature that does not match - see {@link verify}.
 */
export function parseAuthorizationHeader(headerValue: string | undefined): ParsedAuthorization | null {
  if (!headerValue || !headerValue.startsWith(ALGORITHM)) return null;

  let credential = "";
  let signedHeaders = "";
  let signature = "";
  for (const part of headerValue.slice(ALGORITHM.length).trim().split(",")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("Credential=")) credential = trimmed.slice("Credential=".length);
    else if (trimmed.startsWith("SignedHeaders=")) signedHeaders = trimmed.slice("SignedHeaders=".length);
    else if (trimmed.startsWith("Signature=")) signature = trimmed.slice("Signature=".length);
  }
  if (!credential || !signedHeaders || !signature) return null;

  const parts = credential.split("/");
  if (parts.length !== 5 || parts[4] !== SCOPE_TERMINATOR) return null;

  return {
    scope: { accessKeyId: parts[0]!, dateStamp: parts[1]!, region: parts[2]!, service: parts[3]! },
    signedHeaders,
    signature,
  };
}

/**
 * Percent-decodes each name and value, re-encodes them per SigV4's rules, and sorts by name.
 *
 * euclid POSTs everything to `/` and carries its arguments in the body, so in practice this
 * canonicalises the empty string. It is here because the canonical request has a slot for it and a
 * signature computed with a different filling for that slot does not verify.
 */
export function canonicalizeQueryString(rawQuery: string): string {
  if (!rawQuery) return "";

  const params: Array<[string, string]> = [];
  for (const pair of rawQuery.split("&")) {
    if (!pair) continue;
    const equals = pair.indexOf("=");
    const name = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? "" : pair.slice(equals + 1);
    params.push([uriEncode(percentDecode(name)), uriEncode(percentDecode(value))]);
  }

  params.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  return params.map(([name, value]) => `${name}=${value}`).join("&");
}

/** Builds the SigV4 canonical request string. */
export function buildCanonicalRequest(
  method: string,
  canonicalUri: string,
  canonicalQuery: string,
  headers: Record<string, string>,
  headerNames: readonly string[],
  payloadHashHex: string,
): string {
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name] ?? ""}\n`).join("");
  return [method, canonicalUri, canonicalQuery, canonicalHeaders, headerNames.join(";"), payloadHashHex].join("\n");
}

/** Builds the SigV4 string-to-sign. */
export function buildStringToSign(amzDate: string, credentialScope: string, canonicalRequestHashHex: string): string {
  return [ALGORITHM, amzDate, credentialScope, canonicalRequestHashHex].join("\n");
}

/** Derives the signing key via the kDate -> kRegion -> kService -> kSigning HMAC chain. */
export function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, SCOPE_TERMINATOR);
}

/**
 * Signs a request in place: sets x-amz-date, x-amz-content-sha256 and Authorization.
 *
 * Call it once every other header the signature covers - the `x-euclid-*` ones and host - and the
 * body are already set on `req`. Anything set afterwards is not covered, and on the server that is
 * indistinguishable from an attacker having added it.
 */
export function sign(
  req: SignableRequest,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  service: string,
): void {
  const amzDate = formatAmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);

  req.header("x-amz-date", amzDate);
  req.header("x-amz-content-sha256", sha256Hex(req.body));

  const [canonicalUri, canonicalQuery] = splitTarget(req.target);
  const canonicalRequest = buildCanonicalRequest(
    req.method,
    canonicalUri,
    canonicalQuery,
    req.headers,
    SIGNED_HEADER_NAMES,
    req.get("x-amz-content-sha256"),
  );

  const credentialScope = `${dateStamp}/${region}/${service}/${SCOPE_TERMINATOR}`;
  const stringToSign = buildStringToSign(amzDate, credentialScope, sha256Hex(Buffer.from(canonicalRequest, "utf8")));
  const signature = hmac(deriveSigningKey(secretAccessKey, dateStamp, region, service), stringToSign).toString("hex");

  req.header(
    "Authorization",
    `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${SIGNED_HEADER_NAMES.join(";")}, Signature=${signature}`,
  );
}

/**
 * Verifies a SigV4-signed request, answering the access key ID it was signed with.
 *
 * Recomputes the signature from the request exactly as received and compares it in constant time,
 * so any change to a signed header or to the body between signing and here makes this fail.
 *
 * Answers null on every failure - missing or malformed header, unknown key, stale timestamp,
 * mismatched signature - without saying which, the way token verification collapses its failure
 * modes into one rejection. A caller that could tell them apart would be an oracle.
 */
export function verify(
  req: SignableRequest,
  lookupSecret: (accessKeyId: string) => string | null | undefined,
  maxSkewMs: number = DEFAULT_MAX_SKEW_MS,
): string | null {
  const parsed = parseAuthorizationHeader(req.get("authorization"));
  if (parsed === null) return null;

  // Fixed policy rather than client-negotiated: a request does not get to choose how little of
  // itself it authenticates.
  if (parsed.signedHeaders !== SIGNED_HEADER_NAMES.join(";")) return null;

  const secret = lookupSecret(parsed.scope.accessKeyId);
  if (secret == null) return null;

  const headers = req.headers;
  const amzDate = headers["x-amz-date"] ?? "";
  if (amzDate.length < 8 || amzDate.slice(0, 8) !== parsed.scope.dateStamp) return null;

  const requestTime = parseAmzDate(amzDate);
  if (requestTime === null || Math.abs(Date.now() - requestTime) > maxSkewMs) return null;

  const payloadHash = headers["x-amz-content-sha256"];
  if (payloadHash === undefined || payloadHash !== sha256Hex(req.body)) return null;

  const [canonicalUri, canonicalQuery] = splitTarget(req.target);
  const canonicalRequest = buildCanonicalRequest(
    req.method,
    canonicalUri,
    canonicalQuery,
    headers,
    SIGNED_HEADER_NAMES,
    payloadHash,
  );

  const credentialScope = `${parsed.scope.dateStamp}/${parsed.scope.region}/${parsed.scope.service}/${SCOPE_TERMINATOR}`;
  const stringToSign = buildStringToSign(amzDate, credentialScope, sha256Hex(Buffer.from(canonicalRequest, "utf8")));
  const expected = hmac(
    deriveSigningKey(secret, parsed.scope.dateStamp, parsed.scope.region, parsed.scope.service),
    stringToSign,
  ).toString("hex");

  return equal(expected, parsed.signature) ? parsed.scope.accessKeyId : null;
}

// -- internals -------------------------------------------------------------------------------

/** `20150830T123600Z`, which is what SigV4 dates look like. */
function formatAmzDate(when: Date): string {
  return when.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function parseAmzDate(amzDate: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number) as [number, number, number, number, number, number, number];
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

function splitTarget(target: string): [string, string] {
  const question = target.indexOf("?");
  if (question < 0) return [target, ""];
  return [target.slice(0, question), canonicalizeQueryString(target.slice(question + 1))];
}

/** SigV4's URI-encoding: everything but the unreserved set, uppercase hex, byte by byte. */
function uriEncode(value: Buffer): string {
  let out = "";
  for (const byte of value) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char)) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function percentDecode(value: string): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < value.length) {
    if (value[i] === "%" && i + 2 < value.length) {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    out.push(...Buffer.from(value[i]!, "utf8"));
    i += 1;
  }
  return Buffer.from(out);
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Constant-time string comparison, which is what a signature check has to be. */
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
