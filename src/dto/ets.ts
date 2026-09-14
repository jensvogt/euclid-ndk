/**
 * The shapes ETS sends back.
 *
 * Parsed the same defensive way as every other module's. A transfer server is described the way an EAP
 * application is, and for the same reason: both are things euclid runs on a host, so both carry a
 * `runtimeName` of their own alongside the ID an operator named them by, and both report what was asked for
 * next to what is actually happening.
 */

import { documents, flag, number, strings, text } from "./json.js";

/**
 * One FTP or SFTP server euclid runs in front of a bucket.
 *
 * What a client uploads lands in the bucket as an object, and what is in the bucket is what a client sees -
 * so this is ESM reached over a protocol somebody's software already speaks, rather than a filesystem of its
 * own.
 */
export interface TransferServer {
  serverId: string;
  /**
   * What everything belonging to this server on the host is called - its directory, its process, its log
   * channel. Issued at creation and kept afterwards, because a server ID is only unique within an account and
   * namespace while these names are installation-wide.
   */
  runtimeName: string;
  ern: string;
  accountId: string;
  namespace: string;
  region: string;
  /** `FTP` or `SFTP` - see {@link import("../modules/ets.js").PROTOCOL_SFTP}. */
  protocol: string;
  /** The address it binds, `0.0.0.0` unless the deployment narrowed it. */
  address: string;
  port: number;
  /** The bucket it serves, by name and by ERN: a client's files are that bucket's objects. */
  bucketName: string;
  bucketErn: string;
  /** The key prefix a session starts in, empty for the root of the bucket. */
  homeDirectory: string;
  /** The users who may log in, by ID, and the groups whose members may. */
  userIds: string[];
  userGroups: string[];
  /**
   * The directories a client sees whether or not anything is stored under them.
   *
   * A bucket has no directories - keys share a prefix, and that is all - so a client that expects to `cd` into
   * one before uploading anything needs to be told they exist. These are those.
   */
  directories: string[];
  /** `RUNNING` or `STOPPED`, as asked for - the same words EAP uses. */
  desiredState: string;
  /** `RUNNING` or `STOPPED`, as observed on the host. */
  state: string;
  /** The SFTP host key this server presents, named rather than carried: the material stays with euclid. */
  hostKey: string;
  /** The passive-mode port range an FTP server hands out, which a firewall has to allow through. */
  pasvMin: number;
  pasvMax: number;
  created: string;
  modified: string;
}

/** The ID of a deleted transfer server, and that it went. */
export interface DeleteServerResult {
  serverId: string;
  deleted: boolean;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toTransferServer(document: unknown): TransferServer {
  return {
    serverId: text(document, "serverId"),
    runtimeName: text(document, "runtimeName"),
    ern: text(document, "ern"),
    accountId: text(document, "accountId"),
    namespace: text(document, "namespace"),
    region: text(document, "region"),
    protocol: text(document, "protocol"),
    address: text(document, "address"),
    port: number(document, "port"),
    bucketName: text(document, "bucketName"),
    bucketErn: text(document, "bucketErn"),
    homeDirectory: text(document, "homeDirectory"),
    userIds: strings(document, "userIds"),
    userGroups: strings(document, "userGroups"),
    directories: strings(document, "directories"),
    desiredState: text(document, "desiredState"),
    state: text(document, "state"),
    hostKey: text(document, "hostKey"),
    pasvMin: number(document, "pasvMin"),
    pasvMax: number(document, "pasvMax"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toTransferServers(document: unknown): TransferServer[] {
  return documents(document, "servers").map(toTransferServer);
}

export function toDeleteServerResult(document: unknown): DeleteServerResult {
  return { serverId: text(document, "serverId"), deleted: flag(document, "deleted") };
}
