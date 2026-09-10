/**
 * The shapes ESM sends back.
 *
 * Interfaces and the functions that parse them, exactly as {@link import("./eam.js")} does and for
 * the same reasons: a typo in a field name is a compile error here rather than an `undefined` that
 * travels, and every parse is defensive - see {@link import("./json.js")}.
 *
 * Field names are the server's (`dto/include/euclid/dto/esm`), converted to camelCase where they
 * differ; where they do not, the JSON name is the one on the wire. One rename is deliberate: the
 * server's `async` flag - "the server answered before it had finished" - is `background` here,
 * because `async` is a reserved word in the contexts that matter and a field nobody can write is
 * worse than a field spelled differently from the wire.
 */

import { toVariant, toVariantMap, type Variant } from "./com.js";
import { flag, number, object, stringMap, text } from "./json.js";

// -- resources -----------------------------------------------------------------------------------

/** A bucket: a named container of objects, scoped to an account and a namespace. */
export interface Bucket {
  name: string;
  ern: string;
  owner: string;
  size: number;
  objects: number;
  tags: Record<string, string>;
  /**
   * Whether objects written from now on are encrypted at rest. Says nothing about the ones already
   * stored - see {@link import("../modules/esm.js").EuclidEsm.enableEncryption}.
   */
  encrypted: boolean;
  encryptionKeyErn: string;
  /** One of euclid's own buckets rather than somebody's. Left out of a listing unless asked for. */
  internal: boolean;
  created: string;
  modified: string;
}

/**
 * One stored object, as a listing describes it.
 *
 * `key` is opaque: a bucket has directories only in the sense that keys share a prefix, which is why
 * listing them is something a caller asks for rather than something that happens.
 */
export interface EsmObject {
  ern: string;
  bucketErn: string;
  key: string;
  size: number;
  status: string;
  contentType: string;
  md5Sum: string;
  encrypted: boolean;
  attributes: Record<string, Variant>;
  created: string;
  modified: string;
}

/** What a subscription delivers: one object event, as the body of an ordinary message. */
export interface BucketEvent {
  eventType: string;
  bucketErn: string;
  key: string;
  ern: string;
  size: number;
  contentType: string;
  md5Sum: string;
}

/** One user-defined attribute of an object, as the server stored it. */
export interface ObjectAttribute {
  ern: string;
  name: string;
  value: Variant;
}

// -- what the actions answer with ------------------------------------------------------------------

/** A newly created bucket: its name, and the ERN everything else names it by. */
export interface CreateBucketResult {
  name: string;
  ern: string;
}

/**
 * A renamed bucket, and how much was repointed at it.
 *
 * The ERN is new as well as the name, so this is the one later calls have to use - nothing answers to
 * the old one afterwards.
 */
export interface RenameBucketResult {
  name: string;
  ern: string;
  objects: number;
  subscriptions: number;
}

/** A bucket and the flag it now carries. */
export interface SetBucketInternalResult {
  ern: string;
  name: string;
  internal: boolean;
}

/** A purged bucket, and how many objects went. */
export interface PurgeBucketResult {
  ern: string;
  count: number;
}

/**
 * How many keys were asked for and how many objects went.
 *
 * The two differ when a key named nothing, which is not an error - it simply was not there to delete
 * - so a caller that cares compares them. `background` says the server answered before it had
 * finished, in which case `objects` is what it took on rather than what it removed.
 */
export interface DeleteObjectsResult {
  ern: string;
  asked: number;
  objects: number;
  background: boolean;
}

/** The bucket whose objects were re-announced, and how many of them there were. */
export interface TouchObjectResult {
  ern: string;
  bucketName: string;
  prefix: string;
  objects: number;
  background: boolean;
}

/**
 * The key a bucket now encrypts under, and how many objects predate the change.
 *
 * Those objects are not re-encrypted and not touched: each one records the key it was written under
 * and is read back through it. `keyCreated` says the key is new and belongs to EKM from that moment
 * on - deleting it there is what makes this bucket's objects unrecoverable.
 */
export interface EnableEncryptionResult {
  ern: string;
  name: string;
  keyErn: string;
  keyId: string;
  algorithm: string;
  keyCreated: boolean;
  existingObjects: number;
}

/** The key a bucket was encrypting under, and how many objects are still under it. */
export interface DisableEncryptionResult {
  ern: string;
  name: string;
  previousKeyErn: string;
  previousKeyId: string;
  encryptedObjects: number;
}

/**
 * An object as it was stored, which is what both ways of writing one answer with.
 *
 * `put-object` and `complete-upload` return the same payload, so a caller that needs the object's ERN
 * does not have to take the multipart path to get one.
 */
export interface StoredObject {
  ern: string;
  bucketErn: string;
  key: string;
  size: number;
  status: string;
  contentType: string;
  md5Sum: string;
}

/** An opened multipart upload: the ID every part of it carries. */
export interface CreateUploadResult {
  uploadId: string;
  bucketErn: string;
  key: string;
}

/**
 * An opened multipart download, and how large the object turned out to be.
 *
 * The size is what says how many parts there are to ask for: unlike an upload, whose source the
 * caller has already stat'ed, a download's size is not known until the server is asked.
 */
export interface CreateDownloadResult {
  downloadId: string;
  bucketErn: string;
  key: string;
  ern: string;
  size: number;
  contentType: string;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toBucket(document: unknown): Bucket {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    owner: text(document, "owner"),
    size: number(document, "size"),
    objects: number(document, "objects"),
    tags: stringMap(document, "tags"),
    encrypted: flag(document, "encrypted"),
    encryptionKeyErn: text(document, "encryptionKeyErn"),
    internal: flag(document, "internal"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toEsmObject(document: unknown): EsmObject {
  return {
    ern: text(document, "ern"),
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
    size: number(document, "size"),
    status: text(document, "status"),
    contentType: text(document, "contentType"),
    md5Sum: text(document, "md5Sum"),
    encrypted: flag(document, "encrypted"),
    attributes: toVariantMap(object(document)["attributes"]),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toBucketEvent(document: unknown): BucketEvent {
  return {
    eventType: text(document, "eventType"),
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
    ern: text(document, "ern"),
    size: number(document, "size"),
    contentType: text(document, "contentType"),
    md5Sum: text(document, "md5Sum"),
  };
}

export function toObjectAttribute(document: unknown): ObjectAttribute {
  return {
    ern: text(document, "ern"),
    name: text(document, "name"),
    value: toVariant(object(document)["value"]),
  };
}

export function toCreateBucketResult(document: unknown): CreateBucketResult {
  return { name: text(document, "name"), ern: text(document, "ern") };
}

export function toRenameBucketResult(document: unknown): RenameBucketResult {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    objects: number(document, "objects"),
    subscriptions: number(document, "subscriptions"),
  };
}

export function toSetBucketInternalResult(document: unknown): SetBucketInternalResult {
  return { ern: text(document, "ern"), name: text(document, "name"), internal: flag(document, "internal") };
}

export function toPurgeBucketResult(document: unknown): PurgeBucketResult {
  return { ern: text(document, "ern"), count: number(document, "count") };
}

export function toDeleteObjectsResult(document: unknown): DeleteObjectsResult {
  return {
    ern: text(document, "ern"),
    asked: number(document, "asked"),
    objects: number(document, "objects"),
    background: flag(document, "async"),
  };
}

export function toTouchObjectResult(document: unknown): TouchObjectResult {
  return {
    ern: text(document, "ern"),
    bucketName: text(document, "bucketName"),
    prefix: text(document, "prefix"),
    objects: number(document, "objects"),
    background: flag(document, "async"),
  };
}

export function toEnableEncryptionResult(document: unknown): EnableEncryptionResult {
  return {
    ern: text(document, "ern"),
    name: text(document, "name"),
    keyErn: text(document, "keyErn"),
    keyId: text(document, "keyId"),
    algorithm: text(document, "algorithm"),
    keyCreated: flag(document, "keyCreated"),
    existingObjects: number(document, "existingObjects"),
  };
}

export function toDisableEncryptionResult(document: unknown): DisableEncryptionResult {
  return {
    ern: text(document, "ern"),
    name: text(document, "name"),
    previousKeyErn: text(document, "previousKeyErn"),
    previousKeyId: text(document, "previousKeyId"),
    encryptedObjects: number(document, "encryptedObjects"),
  };
}

export function toStoredObject(document: unknown): StoredObject {
  return {
    ern: text(document, "ern"),
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
    size: number(document, "size"),
    status: text(document, "status"),
    contentType: text(document, "contentType"),
    md5Sum: text(document, "md5Sum"),
  };
}

export function toCreateUploadResult(document: unknown): CreateUploadResult {
  return {
    uploadId: text(document, "uploadId"),
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
  };
}

export function toCreateDownloadResult(document: unknown): CreateDownloadResult {
  return {
    downloadId: text(document, "downloadId"),
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
    ern: text(document, "ern"),
    size: number(document, "size"),
    contentType: text(document, "contentType"),
  };
}
