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
import { documents, flag, number, object, stringMap, text } from "./json.js";

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
  /**
   * Whether this bucket's events are being held rather than delivered - see
   * {@link import("../modules/esm.js").EuclidEsm.stopBucket}. The objects are untouched either way;
   * what is stopped is the notifications a subscription would have sent.
   */
  stopped: boolean;
  /**
   * Whether an upload over an existing key keeps the object it replaces - see
   * {@link import("../modules/esm.js").EuclidEsm.setBucketVersioning}.
   */
  versioning: boolean;
  /**
   * Priority the notifications this bucket sends are given, empty when it sets none. Nothing about the
   * bucket depends on it - see
   * {@link import("../modules/esm.js").EuclidEsm.setBucketPriority}.
   */
  priority: string;
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
  /**
   * `STANDARD` or `ARCHIVED` - whether the bytes are still on disk or in a month's archive. See
   * {@link import("../modules/esm.js").LIFECYCLE_ARCHIVED}.
   *
   * An archived object is still listed, still has its key and its size, and still answers every call
   * about it *except* a read of its bytes: `getObject` and `downloadFile` need it restored first.
   */
  lifecycleState: string;
  /** Until when a restored object stays online - its grace period - or empty. */
  restoredUntil: string;
  /**
   * Which version of the key this is, in a bucket with versioning on - and empty in one without.
   *
   * Given to each object stored while its bucket keeps versions, and to an object that had none when
   * it is superseded and kept. So every *non-current* version has one, while a current object written
   * before versioning was turned on may not.
   */
  versionId: string;
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
  /**
   * The object's own user-defined attributes, carried on the notification rather than left to be fetched.
   *
   * That is the whole point of them: whatever put the object in the bucket knows things the bucket cannot
   * express - which supplier it came from, how urgent it is - and a subscriber that has to read the object
   * to find out has been told the wrong thing. Binary values are left out by the server, since a
   * notification is metadata and nothing reading one wants a blob inlined into it.
   */
  attributes: Record<string, Variant>;
  /** euclid's own envelope as it travelled with the object - a correlation id and its siblings. */
  systemAttributes: Record<string, Variant>;
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

/** A bucket and the priority its notifications now carry. */
export interface SetBucketPriorityResult {
  ern: string;
  name: string;
  /** As stored - upper case, or empty when it was cleared. */
  priority: string;
}

/**
 * What a background bucket deletion took on.
 *
 * Only a deletion asked to run in the background answers with anything at all - a bucket deleted inline is
 * simply gone by the time the call returns. So `background` is true whenever this is worth reading, `count`
 * is how many objects the bucket held when the work was taken on, and `jobId` names the job doing it, which
 * outlives the instance that started it.
 *
 * The bucket itself goes when the emptying finishes, so it stays listed - and still deletable - until it is
 * genuinely gone.
 */
export interface DeleteBucketResult {
  ern: string;
  /** How many objects the bucket held when the deletion was taken on. */
  count: number;
  /** The background job doing the work. */
  jobId: string;
  /** Whether the server is still working through it. */
  background: boolean;
}

/**
 * A purged bucket, and how many objects went.
 *
 * `background` says the server answered before doing any of it, in which case `count` is how many
 * objects the bucket held when the purge was taken on rather than how many have gone, and `jobId`
 * names the job doing it. That job outlives the instance that started it - one stopped by the
 * autoscaler, or lost to a crash, leaves a job another instance picks up and carries on.
 */
/** What an abandoned upload was, and what became of the object it was writing. */
export interface AbortUploadResult {
  uploadId: string;
  bucketErn: string;
  key: string;
  /** How many staged parts were thrown away. */
  parts: number;
  /**
   * Whether the object row at that key went with the upload.
   *
   * True for a first upload, whose row described bytes that never arrived. False for a re-upload,
   * where the row is the previous version - still published, still readable, and not this upload's
   * to delete. Worth reading rather than assuming: "the upload is gone" and "the object is gone"
   * are different outcomes, and a caller cleaning up after a failure needs to know which one they
   * got.
   */
  objectRemoved: boolean;
}

export interface PurgeBucketResult {
  ern: string;
  count: number;
  /** The background job doing the work, empty unless `background`. */
  jobId: string;
  /** Whether the server is still working through the objects. */
  background: boolean;
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
  /** The version this upload became, in a bucket that keeps versions; empty in one that does not. */
  versionId: string;
  /**
   * Whether the bytes were already the ones this key held, in which case **nothing was written**: no
   * row, no file and no event.
   *
   * Only a versioning bucket answers this way, and it is not a failure - the object is there, with the
   * bytes that were sent, and `versionId` is the version that already held them. A caller re-uploading
   * what it uploaded before learns here that it changed nothing, which is the one thing a plain
   * "stored" answer could not tell it.
   */
  unchanged: boolean;
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

/**
 * Where one object stands between online and archived.
 *
 * `archivedAt`, `restoredAt`, `restoredUntil` and `archiveFile` are each empty until there is something
 * to say: an object that has never been archived has none of them, and a restored one keeps the archive
 * it came out of named, because the bytes are still in it until the grace period ends.
 */
export interface ObjectLifecycle {
  ern: string;
  bucketErn: string;
  key: string;
  /** `STANDARD` or `ARCHIVED`. */
  lifecycleState: string;
  archivedAt: string;
  restoredAt: string;
  /** When a restored object goes back to being archived, or empty for one that is not restored. */
  restoredUntil: string;
  /** The archive holding its bytes - one file per month - or empty for an object that is online. */
  archiveFile: string;
}

/**
 * One rule for what a bucket archives on its own, and for how long a restore keeps it back.
 *
 * `prefix` is what the rule covers, empty for the whole bucket. `archiveAfterDays` is measured from an
 * object's last access rather than its age, so a rule does not archive what is being read.
 */
export interface LifecycleRule {
  id: string;
  prefix: string;
  archiveAfterDays: number;
  restoreDays: number;
  enabled: boolean;
}

/** A bucket's lifecycle rules, as they now stand. An empty list is a bucket that archives nothing. */
export interface BucketLifecycle {
  ern: string;
  name: string;
  rules: LifecycleRule[];
}

/**
 * A bucket's event delivery after stopping or starting it.
 *
 * `held` is what is waiting after a stop, `released` what was let go by a start - each reported by the
 * call it belongs to and zero in the other.
 */
export interface BucketStateResult {
  ern: string;
  name: string;
  stopped: boolean;
  held: number;
  released: number;
}

/**
 * One object whose file on disk does not match what the database says about it.
 *
 * `problem` is the server's own word for what is wrong - a file that is missing, or one whose size does
 * not match. `recordedSize` is what the database holds, `fileSize` what is on disk, and
 * `expectedFileSize` what the file *should* measure, which for an encrypted object is not its plaintext
 * size.
 */
export interface ObjectProblem {
  key: string;
  ern: string;
  problem: string;
  recordedSize: number;
  fileSize: number;
  expectedFileSize: number;
  internalName: string;
  internalDir: string;
  created: string;
  /** Anything more the check had to say, or empty. */
  detail: string;
}

/**
 * What one page of a verification found.
 *
 * `scanned` is how many objects were looked at, `checked` how many were actually verified and `skipped`
 * the rest - an upload still in progress, an archived object (its bytes are in a zip, not a file) and a
 * directory marker are all skipped rather than reported as problems.
 *
 * `nextKey` is where to carry on from, and **empty when the bucket is exhausted**: a full page may have
 * more behind it, a short one was the end.
 */
export interface VerifyObjectsResult {
  bucketErn: string;
  afterKey: string;
  scanned: number;
  checked: number;
  skipped: number;
  problems: ObjectProblem[];
  nextKey: string;
}

/**
 * One version of a key: the object as it was when it was current.
 *
 * `latest` marks the one that is current now - the only one a read without a version returns, and the
 * only one that lives in the object collection rather than the version collection.
 */
export interface ObjectVersion {
  versionId: string;
  latest: boolean;
  size: number;
  md5Sum: string;
  contentType: string;
  status: string;
  /** `STANDARD` or `ARCHIVED`: a version can be archived like any other object. */
  lifecycleState: string;
  owner: string;
  created: string;
  modified: string;
}

/**
 * Every version of one key, with the current object among them.
 *
 * `versioning` is the bucket's setting as it stands *now*, which is not necessarily what every version
 * was written under: turning versioning off keeps the versions already made, so a listing can hold
 * several while the bucket no longer keeps new ones.
 */
export interface ObjectVersions {
  bucketErn: string;
  key: string;
  /** The key's own ERN, which every version of it shares. */
  ern: string;
  versioning: boolean;
  total: number;
  versions: ObjectVersion[];
}

/** A bucket and whether it now keeps the objects an upload replaces. */
export interface BucketVersioningResult {
  ern: string;
  name: string;
  versioning: boolean;
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
    stopped: flag(document, "stopped"),
    versioning: flag(document, "versioning"),
    priority: text(document, "priority"),
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
    // "STANDARD" when absent, which is what an object written before archiving existed is and what a
    // euclid too old to report it means: online.
    lifecycleState: text(document, "lifecycleState") || "STANDARD",
    restoredUntil: text(document, "restoredUntil"),
    versionId: text(document, "versionId"),
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
    attributes: toVariantMap(object(document)["attributes"]),
    systemAttributes: toVariantMap(object(document)["systemAttributes"]),
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

export function toObjectVersion(document: unknown): ObjectVersion {
  return {
    versionId: text(document, "versionId"),
    latest: flag(document, "latest"),
    size: number(document, "size"),
    md5Sum: text(document, "md5Sum"),
    contentType: text(document, "contentType"),
    status: text(document, "status"),
    lifecycleState: text(document, "lifecycleState") || "STANDARD",
    owner: text(document, "owner"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toObjectVersions(document: unknown): ObjectVersions {
  return {
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
    ern: text(document, "ern"),
    versioning: flag(document, "versioning"),
    total: number(document, "total"),
    versions: documents(document, "versions").map(toObjectVersion),
  };
}

export function toBucketVersioningResult(document: unknown): BucketVersioningResult {
  return {
    ern: text(document, "ern"),
    name: text(document, "name"),
    versioning: flag(document, "versioning"),
  };
}

export function toObjectLifecycle(document: unknown): ObjectLifecycle {
  return {
    ern: text(document, "ern"),
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
    lifecycleState: text(document, "lifecycleState") || "STANDARD",
    archivedAt: text(document, "archivedAt"),
    restoredAt: text(document, "restoredAt"),
    restoredUntil: text(document, "restoredUntil"),
    archiveFile: text(document, "archiveFile"),
  };
}

export function toLifecycleRule(document: unknown): LifecycleRule {
  return {
    id: text(document, "id"),
    prefix: text(document, "prefix"),
    archiveAfterDays: number(document, "archiveAfterDays"),
    restoreDays: number(document, "restoreDays"),
    // A rule is in force unless it says otherwise, which is the server's own reading of an absent flag.
    enabled: flag(document, "enabled", true),
  };
}

export function toBucketLifecycle(document: unknown): BucketLifecycle {
  return {
    ern: text(document, "ern"),
    name: text(document, "name"),
    rules: documents(document, "rules").map(toLifecycleRule),
  };
}

export function toBucketStateResult(document: unknown): BucketStateResult {
  return {
    ern: text(document, "ern"),
    name: text(document, "name"),
    stopped: flag(document, "stopped"),
    held: number(document, "held"),
    released: number(document, "released"),
  };
}

export function toObjectProblem(document: unknown): ObjectProblem {
  return {
    key: text(document, "key"),
    ern: text(document, "ern"),
    problem: text(document, "problem"),
    recordedSize: number(document, "recordedSize"),
    fileSize: number(document, "fileSize"),
    expectedFileSize: number(document, "expectedFileSize"),
    internalName: text(document, "internalName"),
    internalDir: text(document, "internalDir"),
    created: text(document, "created"),
    detail: text(document, "detail"),
  };
}

export function toVerifyObjectsResult(document: unknown): VerifyObjectsResult {
  return {
    bucketErn: text(document, "bucketErn"),
    afterKey: text(document, "afterKey"),
    scanned: number(document, "scanned"),
    checked: number(document, "checked"),
    skipped: number(document, "skipped"),
    problems: documents(document, "problems").map(toObjectProblem),
    nextKey: text(document, "nextKey"),
  };
}

export function toSetBucketPriorityResult(document: unknown): SetBucketPriorityResult {
  return { ern: text(document, "ern"), name: text(document, "name"), priority: text(document, "priority") };
}

export function toDeleteBucketResult(document: unknown): DeleteBucketResult {
  return {
    ern: text(document, "ern"),
    count: number(document, "objects"),
    jobId: text(document, "jobId"),
    background: flag(document, "async"),
  };
}

export function toAbortUploadResult(document: unknown): AbortUploadResult {
  return {
    uploadId: text(document, "uploadId"),
    bucketErn: text(document, "bucketErn"),
    key: text(document, "key"),
    parts: number(document, "parts"),
    objectRemoved: flag(document, "objectRemoved"),
  };
}

export function toPurgeBucketResult(document: unknown): PurgeBucketResult {
  // "count" when the purge ran inline, "objects" when it was taken on: the same figure at two
  // points in the same work, and count reads it either way rather than a zero that only means the
  // other field name was used.
  return {
    ern: text(document, "ern"),
    count: number(document, "count") || number(document, "objects"),
    jobId: text(document, "jobId"),
    background: flag(document, "async"),
  };
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
    versionId: text(document, "versionId"),
    unchanged: flag(document, "unchanged"),
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
