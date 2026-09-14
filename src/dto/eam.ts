/**
 * The shapes EAM sends back.
 *
 * Interfaces and the functions that parse them, rather than untyped objects, so a typo in a field
 * name is a compile error here instead of an `undefined` that travels. Each parse is defensive -
 * see {@link import("./json.js")}.
 *
 * Field names are the server's (`dto/include/euclid/dto/eam`), converted to camelCase where they
 * differ; where they do not, the JSON name is the one on the wire.
 */

import { documents, flag, number, object, strings, text } from "./json.js";

/** The caller identity a response echoes back, from the server's `BaseDto`. */
export interface Metadata {
  region: string;
  accountId: string;
  user: string;
}

/** A signing credential. The secret is returned once, at creation, and never again. */
export interface AccessKey {
  accessKeyId: string;
  active: boolean;
  createdAt: string;
}

/**
 * One role, given to one principal, somewhere.
 *
 * The only thing that grants anything, and the only thing that carries scope. Replaced the per-user
 * `accountGrants`/`resourceGrants` lists: what a user may do is the union of the grants held by
 * them and by every group they belong to.
 *
 * `grantId` is what {@link import("../modules/eam.js").EuclidSession.revokeRole} takes - not the
 * (role, principal) pair, since the same role may be granted to the same principal twice with
 * different scope and revoking has to say which.
 */
export interface Grant {
  grantId: string;
  role: string;
  principal: string;
  accountId: string;
  namespaces: string[];
  resources: string[];
  granted: string;
  grantedBy: string;
}

/**
 * A named set of permissions, belonging to one account.
 *
 * A permission is `<module>:<action>` - `esm:put-object` - with `<module>:*` for every action of one module
 * and {@link import("../modules/eam.js").EVERY_PERMISSION} for the lot;
 * {@link import("../modules/eam.js").EuclidSession.listPermissions} is the vocabulary a server answers.
 *
 * `builtin` says which roles can be changed at all: euclid's own are computed rather than stored, so they are
 * referenceable from every account, current with whatever actions the installation has, and writable nowhere.
 */
export interface Role {
  name: string;
  ern: string;
  accountId: string;
  region: string;
  description: string;
  permissions: string[];
  builtin: boolean;
  created: string;
  modified: string;
}

/** A user. `password` is a hash when the server sends one at all - never the plaintext. */
export interface User {
  userId: string;
  ern: string;
  password: string;
  email: string;
  accountId: string;
  region: string;
  created: string;
  modified: string;
}

/** A named set of users. Membership in the `administrator` group is what makes an admin. */
export interface UserGroup {
  name: string;
  ern: string;
  accountId: string;
  region: string;
  description: string;
  userIds: string[];
  created: string;
  modified: string;
}

/** A tenant. Namespaces live under it, and everything else is scoped by the pair. */
export interface Account {
  accountId: string;
  name: string;
  ern: string;
  description: string;
  created: string;
  modified: string;
}

/** A namespace within an account, unique by name within it. */
export interface Namespace {
  accountId: string;
  name: string;
  ern: string;
  description: string;
  created: string;
  modified: string;
}

/** What `login` answers with: a bearer token and, usually, an access key to sign with. */
export interface LoginResult {
  token: string;
  accessKeyId: string;
  secretAccessKey: string;
  createdAt: string;
  isAdmin: boolean;
  metadata: Metadata;
  /** The response as it arrived, for anything a later euclid added that this does not name. */
  raw: Record<string, unknown>;
}

/** One page of something, and how many exist in total. */
export interface Page<T> {
  total: number;
  items: T[];
}

/** A newly created access key. This is the only time the secret is ever returned. */
export interface CreateAccessKeyResult {
  accessKeyId: string;
  secretAccessKey: string;
  createdAt: string;
  metadata: Metadata;
}

export function toMetadata(document: unknown): Metadata {
  return { region: text(document, "region"), accountId: text(document, "accountId"), user: text(document, "user") };
}

export function toAccessKey(document: unknown): AccessKey {
  return {
    accessKeyId: text(document, "accessKeyId"),
    active: flag(document, "active", true),
    createdAt: text(document, "createdAt"),
  };
}

export function toGrant(document: unknown): Grant {
  return {
    grantId: text(document, "grantId"),
    role: text(document, "role"),
    principal: text(document, "principal"),
    accountId: text(document, "accountId"),
    namespaces: strings(document, "namespaces"),
    resources: strings(document, "resources"),
    granted: text(document, "granted"),
    grantedBy: text(document, "grantedBy"),
  };
}

export function toRole(document: unknown): Role {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    accountId: text(document, "accountId"),
    region: text(document, "region"),
    description: text(document, "description"),
    permissions: strings(document, "permissions"),
    builtin: flag(document, "builtin"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toUser(document: unknown): User {
  return {
    userId: text(document, "userId"),
    ern: text(document, "ern"),
    password: text(document, "password"),
    email: text(document, "email"),
    accountId: text(document, "accountId"),
    region: text(document, "region"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toUserGroup(document: unknown): UserGroup {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    accountId: text(document, "accountId"),
    region: text(document, "region"),
    description: text(document, "description"),
    userIds: strings(document, "userIds"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toAccount(document: unknown): Account {
  return {
    accountId: text(document, "accountId"),
    name: text(document, "name"),
    ern: text(document, "ern"),
    description: text(document, "description"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toNamespace(document: unknown): Namespace {
  return {
    accountId: text(document, "accountId"),
    name: text(document, "name"),
    ern: text(document, "ern"),
    description: text(document, "description"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toLoginResult(document: unknown): LoginResult {
  return {
    token: text(document, "token"),
    accessKeyId: text(document, "accessKeyId"),
    secretAccessKey: text(document, "secretAccessKey"),
    createdAt: text(document, "createdAt"),
    isAdmin: flag(document, "isAdmin"),
    metadata: toMetadata(object(document)["metadata"]),
    raw: object(document),
  };
}

export function toCreateAccessKeyResult(document: unknown): CreateAccessKeyResult {
  return {
    accessKeyId: text(document, "accessKeyId"),
    secretAccessKey: text(document, "secretAccessKey"),
    createdAt: text(document, "createdAt"),
    metadata: toMetadata(object(document)["metadata"]),
  };
}

/** One page of whatever a listing returns, under the field the server puts it in. */
export function toPage<T>(document: unknown, field: string, parse: (entry: unknown) => T): Page<T> {
  return { total: number(document, "total"), items: documents(document, field).map(parse) };
}
