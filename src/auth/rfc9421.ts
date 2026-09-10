/**
 * RFC 9421 HTTP Message Signatures, the scheme meant to take over from SigV4.
 *
 * Same credentials, same threat model, standard wire format: the caller still presents an access
 * key ID and its secret, and the signature is still an HMAC-SHA256 over a canonical rendering of
 * the request, but what gets rendered and how it travels is the IETF's rather than AWS's. The
 * signature goes in `Signature` and `Signature-Input` instead of `Authorization`, which is what
 * lets the two schemes coexist during a migration - SigV4 owns `Authorization`, this owns its own
 * headers, and a server can accept either without guessing which one a request meant.
 *
 * **Algorithm.** Only `hmac-sha256`, because that is the algorithm that takes euclid's existing
 * access-key/secret pairs unchanged: the HMAC key is the secret's UTF-8 bytes directly (RFC 9421
 * §3.3.3), with none of SigV4's key-derivation chain to reproduce.
 *
 * **Covered components.** RFC 9421 lets a signer choose what its signature covers and declare it
 * in `Signature-Input`. Taken literally that would let a request decide how little of itself to
 * authenticate, so it is not taken literally here: the set is fixed, {@link verify} rejects a
 * signature covering anything else in any other order, and {@link sign} refuses to sign a request
 * that cannot supply all of it. The list is a wire format shared with euclid's
 * `Core::HttpSignature::CoveredComponents()` and the two only ever change together.
 *
 * See RFC 9421 and RFC 9530 (Content-Digest).
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SignableRequest } from "./signable.js";

export const ALGORITHM = "hmac-sha256";
export const TAG = "euclid";
const LABEL = "sig1";
const DEFAULT_MAX_SKEW_SECONDS = 15 * 60;

/**
 * The derived components pin the request line and host, content-digest pins the body, and the
 * x-euclid-* headers pin what the request asks for and on whose behalf - which for euclid lives in
 * headers rather than in the URI.
 *
 * Two absences are deliberate. "@query" is not covered because euclid POSTs everything to "/" and
 * carries its arguments in the body, so there is no query string to protect. "x-euclid-namespace"
 * is not covered either, and that one is a real gap rather than a simplification: the namespace
 * scopes what a request may touch and it currently travels unsigned. Closing it means adding the
 * component to euclid's server and to this list in the same release.
 */
const REQUIRED_COMPONENTS = [
  "@method",
  "@path",
  "@authority",
  "content-digest",
  "x-euclid-account-id",
  "x-euclid-action",
  "x-euclid-region",
  "x-euclid-target",
  "x-euclid-user-id",
] as const;

export const SIGNATURE_HEADER_NAMES = ["Content-Digest", "Signature-Input", "Signature"] as const;

/**
 * The parameters of one signature, as carried in `Signature-Input`.
 *
 * `raw` is the parameter string exactly as received. It is kept because that is what the signature
 * was computed over: re-serialising the parsed fields would not reliably reproduce another
 * implementation's byte-for-byte choices, and a base rebuilt from a re-serialisation would fail to
 * verify a perfectly good signature.
 */
export interface SignatureParams {
  components: string[];
  created: number | null;
  expires: number | null;
  keyId: string;
  algorithm: string | null;
  nonce: string | null;
  tag: string | null;
  raw: string;
}

/** A signature and its parameters, paired by the dictionary label they share. */
export interface ParsedSignature {
  label: string;
  params: SignatureParams;
  signature: Buffer;
}

/** The components every euclid signature covers, in signing order. */
export function requiredComponents(): readonly string[] {
  return REQUIRED_COMPONENTS;
}

/**
 * The components a signature over this request must cover.
 *
 * Takes the request because RFC 9421 allows a signer to cover a field only when the message carries
 * one, and a future version of euclid may want that back. It does not vary today.
 */
export function coveredComponents(_req: SignableRequest): readonly string[] {
  return REQUIRED_COMPONENTS;
}

/** The headers {@link sign} writes, in the case they should be sent in. */
export function signatureHeaderNames(): readonly string[] {
  return SIGNATURE_HEADER_NAMES;
}

/** The RFC 9530 `Content-Digest` value binding a body to its signature. */
export function contentDigest(body: Buffer | string): string {
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return `sha-256=:${createHash("sha256").update(raw).digest("base64")}:`;
}

/** Serialises the `Signature-Input` value for a set of covered components, without a label. */
export function serializeSignatureParams(
  components: readonly string[],
  created: number,
  keyId: string,
  nonce: string,
): string {
  const inner = components.map(quote).join(" ");
  return `(${inner});created=${created};keyid=${quote(keyId)};alg=${quote(ALGORITHM)};nonce=${quote(nonce)};tag=${quote(TAG)}`;
}

/**
 * Builds the §2.5 signature base: one line per component, then `@signature-params`.
 *
 * The last line carries no trailing newline. Answers null if any covered component is absent from
 * the request - §2.1 forbids signing over a field that is not there, and producing a base with a
 * blank in its place would sign something the verifier will never reconstruct.
 */
export function signatureBase(req: SignableRequest, components: readonly string[], params: string): string | null {
  const lines: string[] = [];
  for (const component of components) {
    const value = componentValue(req, component);
    if (value === null) return null;
    lines.push(`"${component}": ${value}`);
  }
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

/**
 * Signs a request in place: sets Content-Digest, Signature-Input and Signature.
 *
 * Call it once every header the signature covers and the body are already set. Unlike SigV4 this
 * leaves Authorization alone, so a request can carry a bearer token and a signature at once if a
 * deployment wants both during a migration.
 *
 * Throws when a component that must be covered is missing, which for a client means it was
 * configured without a region, an account id or a user id and so has nothing to sign with.
 */
export function sign(req: SignableRequest, accessKeyId: string, secretAccessKey: string): void {
  req.header("Content-Digest", contentDigest(req.body));

  const components = coveredComponents(req);
  const params = serializeSignatureParams(components, Math.floor(Date.now() / 1000), accessKeyId, newNonce());
  const base = signatureBase(req, components, params);
  if (base === null) {
    const missing = components.filter((component) => componentValue(req, component) === null);
    throw new Error(
      `request cannot be signed, it is missing ${JSON.stringify(missing)} - euclid signs a fixed set of ` +
        "components, so a client configured without a region, account id or user id has nothing to sign with",
    );
  }

  const signature = createHmac("sha256", Buffer.from(secretAccessKey, "utf8")).update(base, "utf8").digest();
  req.header("Signature-Input", `${LABEL}=${params}`);
  req.header("Signature", `${LABEL}=:${signature.toString("base64")}:`);
}

/**
 * Verifies an RFC 9421-signed request, answering the key ID it was signed with.
 *
 * Rebuilds the base from the request exactly as received - including the parameters verbatim - and
 * compares the HMAC in constant time. Answers null on every failure without saying which, as
 * {@link import("./sigv4.js").verify} does.
 *
 * The checks mirror euclid's `Core::HttpSignature::Verify`: the covered set must be exactly
 * {@link requiredComponents}, in that order; `alg` must be `hmac-sha256`; `created` must be within
 * the skew window; and `Content-Digest` must match the body actually received, since that header is
 * the only thing the signature covers the body through.
 *
 * `tag` is checked only when present, and euclid's own signer emits none. Requiring it would reject
 * signatures made by the server itself.
 */
export function verify(
  req: SignableRequest,
  lookupSecret: (keyId: string) => string | null | undefined,
  maxSkewSeconds: number = DEFAULT_MAX_SKEW_SECONDS,
): string | null {
  const parsed = parseSignature(req.get("signature-input"), req.get("signature"));
  if (parsed === null) return null;
  const params = parsed.params;

  // Only one algorithm exists here, so an unexpected alg is a rejection rather than a branch -
  // which is also what stops a signature being reinterpreted under a weaker one.
  if (params.algorithm !== ALGORITHM) return null;
  if (params.tag !== null && params.tag !== TAG) return null;

  // Fixed policy, not client-negotiated, and order-sensitive because the server is.
  const required = coveredComponents(req);
  if (params.components.length !== required.length) return null;
  if (params.components.some((component, index) => component !== required[index])) return null;

  const now = Math.floor(Date.now() / 1000);
  if (params.created === null || Math.abs(now - params.created) > maxSkewSeconds) return null;
  if (params.expires !== null && params.expires < now) return null;

  if (!req.has("content-digest") || !equal(req.get("content-digest"), contentDigest(req.body))) return null;

  const secret = lookupSecret(params.keyId);
  if (secret == null) return null;

  const base = signatureBase(req, params.components, params.raw);
  if (base === null) return null;

  const expected = createHmac("sha256", Buffer.from(secret, "utf8")).update(base, "utf8").digest();
  if (expected.length !== parsed.signature.length || !timingSafeEqual(expected, parsed.signature)) return null;

  return params.keyId;
}

/**
 * Parses a matching pair of `Signature-Input` and `Signature` values.
 *
 * Both must hold exactly one signature under the same label. RFC 9421 allows several - a proxy
 * adding its own alongside the client's - but euclid has no use for more than one, and refusing to
 * choose among them means never verifying the wrong one.
 */
export function parseSignature(signatureInputHeader: string, signatureHeader: string): ParsedSignature | null {
  const inputMember = singleDictionaryMember(signatureInputHeader);
  const signatureMember = singleDictionaryMember(signatureHeader);
  if (inputMember === null || signatureMember === null || inputMember[0] !== signatureMember[0]) return null;

  const params = parseSignatureParams(inputMember[1]);
  const signature = parseByteSequence(signatureMember[1]);
  if (params === null || signature === null) return null;
  return { label: inputMember[0], params, signature };
}

/** Parses a `Signature-Input` value: an inner list of components, then the parameters. */
export function parseSignatureParams(value: string): SignatureParams | null {
  if (!value || value[0] !== "(") return null;

  const components: string[] = [];
  let pos = 1;
  for (;;) {
    if (pos >= value.length) return null;
    const char = value[pos];
    if (char === ")") {
      pos += 1;
      break;
    }
    if (char === " ") {
      pos += 1;
      continue;
    }
    if (char !== '"') return null;
    const end = endOfQuotedString(value, pos);
    if (end < 0) return null;
    // A component carrying parameters of its own ("x";req and friends) means something this module
    // does not implement, so it is rejected rather than quietly read as plain.
    if (end + 1 < value.length && value[end + 1] !== " " && value[end + 1] !== ")") return null;
    components.push(unquote(value.slice(pos, end + 1)));
    pos = end + 1;
  }
  if (components.length === 0) return null;

  const parameters = parseParameters(value.slice(pos));
  if (parameters === null) return null;

  const keyId = parameters["keyid"];
  if (typeof keyId !== "string") return null;

  const created = timestampOf(parameters, "created");
  const expires = timestampOf(parameters, "expires");
  if (created === INVALID || expires === INVALID) return null;

  return {
    components,
    created,
    expires,
    keyId,
    algorithm: stringOrNull(parameters["alg"]),
    nonce: stringOrNull(parameters["nonce"]),
    tag: stringOrNull(parameters["tag"]),
    raw: value,
  };
}

// -- internals -------------------------------------------------------------------------------

/** One covered component's value for the base: §2.2's derived values, or the header. */
function componentValue(req: SignableRequest, component: string): string | null {
  if (!component.startsWith("@")) return req.has(component) ? req.get(component) : null;

  const question = req.target.indexOf("?");
  const path = question < 0 ? req.target : req.target.slice(0, question);
  const query = question < 0 ? null : req.target.slice(question + 1);

  switch (component) {
    case "@method":
      return req.method.toUpperCase();
    case "@authority":
      return authorityOf(req);
    case "@scheme":
      return req.scheme;
    case "@path":
      // §2.2.6: the path is "/" when empty.
      return path === "" ? "/" : path;
    case "@query":
      // §2.2.7: the query keeps its leading "?", and is that character alone when there is none.
      return query === null ? "?" : `?${query}`;
    case "@request-target":
      return req.target;
    case "@target-uri": {
      const authority = authorityOf(req);
      return authority === null ? null : `${req.scheme}://${authority}${req.target}`;
    }
    default:
      return null;
  }
}

/** §2.2.3: the host header lowercased, minus the port when it is the scheme's default. */
function authorityOf(req: SignableRequest): string | null {
  const host = req.get("host").toLowerCase();
  if (!host) return null;
  const defaultPort = req.scheme === "https" ? ":443" : req.scheme === "http" ? ":80" : "";
  return defaultPort && host.endsWith(defaultPort) ? host.slice(0, -defaultPort.length) : host;
}

/**
 * Splits a structured-field dictionary that must hold exactly one member into label and value.
 *
 * Respects quoting and nesting, so a comma inside a component name or a base64 signature cannot be
 * mistaken for a member separator.
 */
function singleDictionaryMember(value: string): [string, string] | null {
  if (!value) return null;

  const members = splitTopLevel(value, ",");
  if (members.length !== 1) return null;

  const member = members[0]!.trim();
  const equals = indexOfTopLevel(member, "=");
  if (equals <= 0 || equals === member.length - 1) return null;
  return [member.slice(0, equals).trim(), member.slice(equals + 1).trim()];
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let start = 0;
  let i = 0;
  while (i < value.length) {
    const char = value[i];
    if (inQuotes) {
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === '"') inQuotes = false;
    } else if (char === '"') inQuotes = true;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(value.slice(start));
  return parts;
}

function indexOfTopLevel(value: string, charToFind: string): number {
  let inQuotes = false;
  let i = 0;
  while (i < value.length) {
    const char = value[i];
    if (inQuotes) {
      if (char === "\\") {
        i += 2;
        continue;
      }
      if (char === '"') inQuotes = false;
    } else if (char === '"') inQuotes = true;
    else if (char === charToFind) return i;
    i += 1;
  }
  return -1;
}

/** The index of the closing quote of the string opening at `start`, or -1 if unterminated. */
function endOfQuotedString(value: string, start: number): number {
  let i = start + 1;
  while (i < value.length) {
    if (value[i] === "\\") {
      i += 2;
      continue;
    }
    if (value[i] === '"') return i;
    i += 1;
  }
  return -1;
}

/** Parses `;name=value;name2=value2` into a mapping, or null if it is not well-formed. */
function parseParameters(rest: string): Record<string, unknown> | null {
  const parameters: Record<string, unknown> = {};
  let pos = 0;
  while (pos < rest.length) {
    if (rest[pos] !== ";") return null;
    pos += 1;
    while (pos < rest.length && rest[pos] === " ") pos += 1;

    const nameStart = pos;
    while (pos < rest.length && rest[pos] !== "=" && rest[pos] !== ";") pos += 1;
    const name = rest.slice(nameStart, pos).trim();
    if (!name) return null;

    if (pos >= rest.length || rest[pos] === ";") {
      // A bare parameter is a boolean true in structured fields.
      parameters[name] = true;
      continue;
    }

    pos += 1; // the '='
    if (pos < rest.length && rest[pos] === '"') {
      const end = endOfQuotedString(rest, pos);
      if (end < 0) return null;
      parameters[name] = unquote(rest.slice(pos, end + 1));
      pos = end + 1;
    } else if (pos < rest.length && rest[pos] === ":") {
      const end = rest.indexOf(":", pos + 1);
      if (end < 0) return null;
      parameters[name] = decodeBase64(rest.slice(pos + 1, end));
      pos = end + 1;
    } else {
      const valueStart = pos;
      while (pos < rest.length && rest[pos] !== ";") pos += 1;
      parameters[name] = asIntegerOrToken(rest.slice(valueStart, pos).trim());
    }
  }
  return parameters;
}

/** Parses a structured-field byte sequence, `:<base64>:`. */
function parseByteSequence(value: string): Buffer | null {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== ":" || trimmed[trimmed.length - 1] !== ":") return null;
  return decodeBase64(trimmed.slice(1, -1));
}

function decodeBase64(value: string): Buffer | null {
  // Node's base64 decoder ignores what it cannot read rather than refusing it, so a round trip is
  // what says the input really was base64 - the strictness the verifier depends on.
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "") ? decoded : null;
}

function asIntegerOrToken(raw: string): string | number {
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

const INVALID = Symbol("invalid");

/** The parameter as a Unix timestamp; null when absent, INVALID when present but not an integer. */
function timestampOf(parameters: Record<string, unknown>, name: string): number | null | typeof INVALID {
  if (!(name in parameters)) return null;
  const value = parameters[name];
  return typeof value === "number" && Number.isInteger(value) ? value : INVALID;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(quoted: string): string {
  return quoted.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** Constant-time string comparison, which is what a digest check has to be. */
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
