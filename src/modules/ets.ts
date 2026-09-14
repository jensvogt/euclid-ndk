/**
 * ETS - euclid's transfer module: FTP and SFTP servers in front of a bucket.
 *
 * One object, {@link EuclidEts}, built from a session that has already logged in:
 *
 * ```ts
 * const ets = session.ets();
 *
 * await ets.createServer("drop-box", "incoming", 2222, { userIds: ["jens"], directories: ["inbox"] });
 * await ets.startServer("drop-box");
 * ```
 *
 * What a client uploads becomes an object in the bucket, and what is in the bucket is what a client lists - so
 * this is ESM reached over a protocol somebody's software already speaks. A partner who will only ever send
 * files by SFTP needs no euclid client, and what they send arrives where everything else in euclid can reach
 * it: a bucket subscription fires, an application consumes it, the usual machinery.
 *
 * A bucket has no directories - keys share a prefix, and that is all - so a client that expects to change into
 * one before uploading is told which exist by the server's `directories`.
 *
 * Every action here is administrator-only, server-side. {@link EuclidSession.isAdmin} says whether the
 * logged-in user is one, though the server enforces it regardless.
 */

import {
  toDeleteServerResult,
  toTransferServer,
  toTransferServers,
  type DeleteServerResult,
  type TransferServer,
} from "../dto/ets.js";
import { ModuleClient } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ets";

/** What a transfer server speaks. SFTP unless a deployment says otherwise. */
export const PROTOCOL_SFTP = "SFTP";
export const PROTOCOL_FTP = "FTP";

/** The address a server binds when the deployment does not narrow it: every interface on the host. */
export const DEFAULT_ADDRESS = "0.0.0.0";

/** The passive-mode port range an FTP server hands out unless it is given one. */
export const DEFAULT_PASV_MIN = 6000;
export const DEFAULT_PASV_MAX = 6100;

/** The highest port a server can be asked to bind. */
export const MAX_PORT = 65535;

/** Everything a transfer server is created with beyond its ID, its bucket and its port. */
export interface CreateServerOptions {
  /** {@link PROTOCOL_SFTP} or {@link PROTOCOL_FTP}; SFTP when left out. */
  protocol?: string;
  /** The address to bind, {@link DEFAULT_ADDRESS} when left out. */
  address?: string;
  /** The key prefix a session starts in. Empty is the root of the bucket. */
  homeDirectory?: string;
  /** The users who may log in, by user ID. */
  userIds?: readonly string[];
  /** The groups whose members may log in, by name. */
  userGroups?: readonly string[];
  /**
   * The directories a client sees whether or not anything is stored under them - a bucket has none of its own,
   * so a client that has to change into one before uploading needs them declared here.
   */
  directories?: readonly string[];
  /** The SFTP host key this server presents, by name: euclid keeps the material. */
  hostKey?: string;
  /** The passive-mode port range for FTP, which a firewall has to allow through. */
  pasvMin?: number;
  pasvMax?: number;
}

/**
 * What an update changes - and only what it names.
 *
 * The distinction the server draws is between a field being sent and not being sent, rather than between its
 * values: leaving `homeDirectory` out keeps the stored one, while passing `""` puts sessions back at the root
 * of the bucket. A list that is named replaces the stored one rather than adding to it.
 *
 * `serverId`, the namespace and the runtime name are not here: the first two identify the server and the third
 * is the host's, issued once and kept.
 */
export interface UpdateServerChanges {
  /** The bucket to serve instead, by name. Refused with HTTP 404 if there is no such bucket. */
  bucket?: string;
  address?: string;
  port?: number;
  homeDirectory?: string;
  userIds?: readonly string[];
  userGroups?: readonly string[];
  directories?: readonly string[];
  hostKey?: string;
  pasvMin?: number;
  pasvMax?: number;
}

/** The fields an update sends when - and only when - it was given them. */
const UPDATABLE = [
  "bucket",
  "address",
  "port",
  "homeDirectory",
  "userIds",
  "userGroups",
  "directories",
  "hostKey",
  "pasvMin",
  "pasvMax",
] as const satisfies readonly (keyof UpdateServerChanges)[];

/**
 * ETS's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.ets} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEts extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  // -- servers ---------------------------------------------------------------------------------

  /**
   * Defines a transfer server in front of a bucket, stopped.
   *
   * Nothing listens yet: a new server's desired state is `STOPPED`, so {@link startServer} is what puts it in
   * service - which is also when an SFTP host key is generated if none was named.
   *
   * Refused with HTTP 409 if the ID is taken or if another server on the host already holds the port - a TCP
   * port is not partitioned by account or namespace, so that check crosses both - and with 404 if the bucket
   * is not there. The bucket is resolved now rather than at start-up, so a typo is answered to whoever made it
   * rather than found later in a log.
   *
   * @param bucket the bucket to serve, by name: a client's files are its objects.
   * @throws {Error} if the port is outside 1..{@link MAX_PORT}, which the server refuses anyway - this just
   *   says so before the round trip.
   */
  async createServer(
    serverId: string,
    bucket: string,
    port: number,
    options: CreateServerOptions = {},
  ): Promise<TransferServer> {
    requirePort(port);
    return toTransferServer(
      await this.call("create-server", {
        serverId,
        bucket,
        port,
        protocol: options.protocol ?? PROTOCOL_SFTP,
        address: options.address ?? DEFAULT_ADDRESS,
        homeDirectory: options.homeDirectory ?? "",
        userIds: [...(options.userIds ?? [])],
        userGroups: [...(options.userGroups ?? [])],
        directories: [...(options.directories ?? [])],
        hostKey: options.hostKey ?? "",
        pasvMin: options.pasvMin ?? DEFAULT_PASV_MIN,
        pasvMax: options.pasvMax ?? DEFAULT_PASV_MAX,
      }),
    );
  }

  /**
   * Changes a transfer server. Only what `changes` names changes - see {@link UpdateServerChanges}.
   *
   * A running server picks the change up when it is next started: what is stored here is the definition, and
   * the manager acts on it. So changing the port of a server that is running does not move the listener out
   * from under a client mid-session.
   */
  async updateServer(serverId: string, changes: UpdateServerChanges = {}): Promise<TransferServer> {
    if (changes.port !== undefined) requirePort(changes.port);
    const payload: Record<string, unknown> = { serverId };
    for (const field of UPDATABLE) {
      const value = changes[field];
      if (value !== undefined) payload[field] = value;
    }
    return toTransferServer(await this.call("update-server", payload));
  }

  /** One transfer server, by its ID, with what it is doing next to what was asked of it. */
  async getServer(serverId: string): Promise<TransferServer> {
    return toTransferServer(await this.call("get-server", { serverId }));
  }

  /**
   * The transfer servers whose ID starts with a prefix; an empty prefix lists them all.
   *
   * The session's own account and namespace, as every other action here is - so this lists what the session
   * can then address rather than every server on the host.
   */
  async listServers(prefix = ""): Promise<TransferServer[]> {
    return toTransferServers(await this.call("list-servers", { prefix }));
  }

  /** Removes a transfer server. Stop it first - this does not. */
  async deleteServer(serverId: string): Promise<DeleteServerResult> {
    return toDeleteServerResult(await this.call("delete-server", { serverId }));
  }

  // -- running ---------------------------------------------------------------------------------

  /**
   * Asks for a transfer server to listen, and answers with it as it stands.
   *
   * Asking is all this does, as in EAP: the desired state changes here and the manager acts on it, so the
   * server in the answer may still read `STOPPED` - it says what was asked for, not what has happened yet.
   */
  async startServer(serverId: string): Promise<TransferServer> {
    return toTransferServer(await this.call("start-server", { serverId }));
  }

  /**
   * Asks for a transfer server to stop listening, and answers with it as it stands.
   *
   * What a client is in the middle of is the manager's business, not this call's: nothing here waits for a
   * session to finish.
   */
  async stopServer(serverId: string): Promise<TransferServer> {
    return toTransferServer(await this.call("stop-server", { serverId }));
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * ETS's own metrics, as the server collects them. Answered unparsed - the shape belongs to the monitoring
   * module rather than to ETS.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}

/**
 * Refused here rather than on arrival: a port is a number somebody types, and 0 or 70000 is a typo the server
 * would answer with a 400 that cost a round trip.
 */
function requirePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`port must be between 1 and ${MAX_PORT}`);
  }
}
