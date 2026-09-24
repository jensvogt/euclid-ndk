/**
 * The `~/.euclid/credentials` file, shared with euclid-cli, euclid-jdk and euclid-pdk.
 *
 * All four clients read and write the same file, so a login from any of them is picked up by the
 * others. That makes the field names a wire format rather than an implementation detail: the
 * namespace key is `namespace` (not `nameSpace`), `isAdmin` travels alongside the token, and an
 * absent namespace is written as an empty string rather than null so the CLI's string reader can
 * take it. `baseUrl` is the one field the CLI has no equivalent for - it is what lets a cached
 * session be recognised as belonging to the server being talked to now.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One cached login. */
export interface CachedCredentials {
  token: string;
  userId: string;
  accountId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  isAdmin: boolean;
  baseUrl: string;
  namespace: string;
  /** The document as it was read, for fields a later euclid added that this one does not name. */
  raw: Record<string, unknown>;
}

/**
 * Where the credentials live.
 *
 * Resolved per call rather than captured at import, mirroring euclid-cli's
 * `Credentials::FilePath()`: the home directory is read when the file is actually touched, so a
 * process that changes it is not left talking to a stale path. `EUCLID_CREDENTIALS_FILE` overrides
 * it, which is also how a euclid-managed application is handed its own credentials.
 */
export function credentialsPath(): string {
  return process.env["EUCLID_CREDENTIALS_FILE"] || join(homedir(), ".euclid", "credentials");
}

/** The cached credentials, or null when there is no readable, well-formed file. */
export async function load(): Promise<CachedCredentials | null> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(credentialsPath(), "utf8"));
  } catch {
    // No file, no permission, or not JSON. All three mean the same thing to a caller: there is
    // nothing cached to reuse, so log in.
    return null;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
  return fromJson(document as Record<string, unknown>);
}

/** Writes the credentials, readable by their owner alone. */
export async function save(credentials: CachedCredentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(toJson(credentials)), "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // Not every filesystem has POSIX permissions, and a credentials file that exists is better
    // than a login that failed over its mode.
  }
}

/**
 * Patches the cached namespace in place, if what is cached belongs to `baseUrl`.
 *
 * Keeps the file in step when a session's namespace changes outside of a login. A no-op when
 * nothing is cached for that server, in keeping with the best-effort nature of the cache: failing
 * to record a namespace is not a reason to fail the call that changed it.
 */
export async function updateNamespace(baseUrl: string, namespace: string): Promise<void> {
  const cached = await load();
  if (cached === null || cached.baseUrl !== baseUrl) return;
  cached.namespace = namespace || "";
  await save(cached);
}

/**
 * Whether a JWT is well-formed and its `exp` is still in the future.
 *
 * Checked locally to avoid a round trip that would only tell us what the token already says. The
 * signature is not verified - the client does not hold the server's secret, and a token the client
 * forged for itself would be rejected on arrival anyway.
 */
export function isTokenValid(token: string): boolean {
  const parts = token.split(".");
  if (parts.length < 2) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== "object") return false;
  const expiry = (payload as { exp?: unknown }).exp;
  return typeof expiry === "number" && Date.now() / 1000 < expiry;
}

/** An empty set of credentials, which is what every field defaults from. */
export function emptyCredentials(): CachedCredentials {
  return {
    token: "",
    userId: "",
    accountId: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    isAdmin: false,
    baseUrl: "",
    namespace: "",
    raw: {},
  };
}

function fromJson(document: Record<string, unknown>): CachedCredentials {
  return {
    token: text(document["token"]),
    userId: text(document["userId"]),
    accountId: text(document["accountId"]),
    region: text(document["region"]),
    accessKeyId: text(document["accessKeyId"]),
    secretAccessKey: text(document["secretAccessKey"]),
    isAdmin: document["isAdmin"] === true,
    // "endpoint" is the same field under the name euclid's manager writes it as. A managed
    // application is handed its credentials through EUCLID_CREDENTIALS_FILE - see
    // {@link credentialsPath} - and the file the manager writes there calls the server "endpoint",
    // where a file this SDK wrote calls it "baseUrl". Reading only one of the two left an
    // application with a valid token and no idea where to send it.
    baseUrl: text(document["baseUrl"]) || text(document["endpoint"]),
    namespace: text(document["namespace"]),
    raw: document,
  };
}

function toJson(credentials: CachedCredentials): Record<string, unknown> {
  return {
    token: credentials.token,
    userId: credentials.userId,
    accountId: credentials.accountId,
    region: credentials.region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    isAdmin: credentials.isAdmin,
    baseUrl: credentials.baseUrl,
    namespace: credentials.namespace,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
