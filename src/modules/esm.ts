/**
 * ESM - euclid's storage module: buckets, objects, attributes, subscriptions and transfers.
 *
 * One object, {@link EuclidEsm}, built from a session that has already logged in:
 *
 * ```ts
 * const esm = (await Euclid.forServer(url).login("jens", "secret")).esm();
 * const bucket = await esm.createBucket("reports");
 * await esm.uploadFile(bucket.ern, "2026/q3.pdf", "q3.pdf");
 * ```
 *
 * Most of what it does is the same JSON action every other module speaks. Four actions are not:
 * `put-object`, `get-object`, `upload-part` and `download-part` carry the object's bytes themselves,
 * with the bucket, the key and the part number riding as headers instead of in a body - which is what
 * keeps a 5 MiB part 5 MiB on the wire rather than a third larger as base64 inside JSON.
 *
 * Those four also authenticate differently: they present the session's bearer token rather than a
 * signature, which is what euclid-cli, euclid-jdk and euclid-pdk do for the same four actions, so
 * every client writes objects the same way. A session that asked for `AUTH_SIGNATURE` signs
 * them anyway - it asked not to be handed a token silently, and a signature over raw bytes is exact
 * here in a way it is not in every language.
 */

import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import {
  QUEUE,
  TOPIC,
  toSubscribeResult,
  toSubscription,
  toVariantMap,
  variantMapToJson,
  variantOf,
  variantToJson,
  type SubscribeResult,
  type Subscription,
  type Variant,
  type VariantInput,
} from "../dto/com.js";
import {
  type BucketEvent,
  type CreateBucketResult,
  type CreateDownloadResult,
  type CreateUploadResult,
  type DeleteObjectsResult,
  type DisableEncryptionResult,
  type EnableEncryptionResult,
  type EsmObject,
  type ObjectAttribute,
  type PurgeBucketResult,
  type RenameBucketResult,
  type SetBucketInternalResult,
  type StoredObject,
  type TouchObjectResult,
  type Bucket,
  toBucket,
  toBucketEvent,
  toCreateBucketResult,
  toCreateDownloadResult,
  toCreateUploadResult,
  toDeleteObjectsResult,
  toDisableEncryptionResult,
  toEnableEncryptionResult,
  toEsmObject,
  toObjectAttribute,
  toPurgeBucketResult,
  toRenameBucketResult,
  toSetBucketInternalResult,
  toStoredObject,
  toTouchObjectResult,
} from "../dto/esm.js";
import { toPage, type Page } from "../dto/eam.js";
import { EuclidServiceError } from "../errors.js";
import type { Response } from "../http/client.js";
import { listPayload, ModuleClient, type Bytes, type ListOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "esm";

/** The object events a subscription can ask for. Asking for none asks for all of them. */
export const OBJECT_CREATED = "esm.object.created";
export const OBJECT_UPDATED = "esm.object.updated";
export const OBJECT_DELETED = "esm.object.deleted";

/**
 * How much of a file goes into one part. Larger parts mean fewer round trips and more memory in
 * flight; 5 MiB is what euclid-cli, euclid-jdk and euclid-pdk use, which is what makes a file
 * uploaded by one of them arrive in the same pieces as one uploaded by another.
 */
export const DEFAULT_PART_SIZE = 5 * 1024 * 1024;

/** How many parts travel at once. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * How many attempts one step of a transfer gets. Transfers are long and made of many steps, so a
 * transient failure in any of them would otherwise throw away everything already transferred.
 */
export const MAX_PART_ATTEMPTS = 4;

/** The delay before retrying, in milliseconds, multiplied by the attempt number. */
export const PART_RETRY_BASE_DELAY_MS = 500;

/**
 * What `get-object` answers when the object is at or above the size the caller said it would accept.
 * Not an error in {@link EuclidEsm.downloadFile}: it is the server saying the object needs the
 * multipart path.
 */
export const PAYLOAD_TOO_LARGE = 413;

/** The actions that carry raw bytes rather than JSON - see this module's documentation. */
export const BYTE_ACTIONS = ["put-object", "get-object", "upload-part", "download-part"];

/** How a bucket listing is paged, and whether euclid's own buckets are in it. */
export interface ListBucketsOptions extends ListOptions {
  includeInternal?: boolean;
}

/** How an object listing is paged, and whether the directory markers are in it. */
export interface ListObjectsOptions extends ListOptions {
  includeDirectories?: boolean;
}

/**
 * The two attribute maps a write carries, and they are not the same one.
 *
 * `attributes` are the caller's own, listed back by {@link EuclidEsm.listObjectAttributes} and
 * meaningless to euclid. `systemAttributes` are euclid's envelope: they travel with the object across
 * every hop and are never mixed into the caller's. The one euclid acts on is `priority` - an object
 * written with `systemAttributes: { priority: PRIORITY_LOW }` produces a notification carrying it,
 * which is how a producer's decision survives a hop through a bucket.
 */
export interface AttributeOptions {
  attributes?: Record<string, VariantInput>;
  systemAttributes?: Record<string, VariantInput>;
}

/** How a file is cut up on the way out, and what the object it becomes carries. */
export interface UploadOptions extends AttributeOptions {
  partSize?: number;
  concurrency?: number;
}

/** How an object is fetched: in what parts, and how many at a time. */
export interface DownloadOptions {
  partSize?: number;
  concurrency?: number;
}

/** Which of a bucket's events a subscription asks for, and which keys they have to match. */
export interface SubscribeOptions {
  /** {@link OBJECT_CREATED}, {@link OBJECT_UPDATED}, {@link OBJECT_DELETED}, or none for all. */
  eventTypes?: Iterable<string>;
  prefix?: string;
  /** Whether the zero-byte directory markers are delivered too. */
  directories?: boolean;
}

/** Which of a bucket's objects are re-announced, and whether the caller waits for it. */
export interface TouchObjectOptions {
  prefix?: string;
  background?: boolean;
}

/**
 * The notification a bucket subscription delivered, out of the message that carried it.
 *
 * A subscription puts its notification into a queue or a topic as an ordinary message, so nothing
 * about receiving it is special - whatever reads that queue hands the message body to this.
 *
 * @throws {SyntaxError} if the body is not JSON at all.
 */
export function parseBucketEvent(messageBody: string | Buffer): BucketEvent {
  return toBucketEvent(JSON.parse(typeof messageBody === "string" ? messageBody : messageBody.toString("utf8")));
}

/**
 * ESM's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.esm} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEsm extends ModuleClient {
  /**
   * How long the byte-carrying actions may take, in milliseconds, or null for the session's own
   * timeout. Worth raising: the session's default is sized for an action that answers from a
   * database, and a 5 MiB part on a slow link is not that.
   */
  transferTimeoutMs: number | null = null;

  /**
   * The delay before one step of a transfer is tried again, multiplied by the attempt number.
   *
   * A field rather than a constant because it is the one thing about a retry a caller may reasonably
   * want to change: nothing in a test suite wants to wait out a backoff that exists to be kind to a
   * struggling server.
   */
  retryBaseDelayMs = PART_RETRY_BASE_DELAY_MS;

  constructor(session: EuclidSession) {
    super(session, { target: TARGET, byteActions: BYTE_ACTIONS });
  }

  /**
   * {@link parseBucketEvent}, reachable from the client so that the call that reads a subscription's
   * messages is found next to the call that created the subscription.
   */
  static readonly parseBucketEvent = parseBucketEvent;

  // -- buckets ---------------------------------------------------------------------------------

  /**
   * Creates a bucket, and answers with the ERN everything else names it by.
   *
   * `internal` marks it as euclid's own plumbing rather than somebody's bucket, which leaves it out of
   * an ordinary listing - see {@link setBucketInternal}, which is how a bucket that already exists
   * changes its mind about that.
   */
  async createBucket(name: string, internal = false): Promise<CreateBucketResult> {
    return toCreateBucketResult(await this.call("create-bucket", { name, internal }));
  }

  /** Deletes a bucket. It has to be empty; {@link purgeBucket} is what makes it so. */
  async deleteBucket(ern: string): Promise<void> {
    await this.call("delete-bucket", { ern });
  }

  /**
   * One page of buckets, and how many exist in total.
   *
   * euclid's own buckets are left out unless `includeInternal` asks for them, so a listing shows what
   * a person would recognise rather than the artifact bucket applications are deployed from.
   */
  async listBuckets(options: ListBucketsOptions = {}): Promise<Page<Bucket>> {
    const payload = { ...listPayload(options, "name"), includeInternal: options.includeInternal ?? false };
    return toPage(await this.call("list-buckets", payload), "buckets", toBucket);
  }

  /** The ERN of the bucket of this name, in the session's account and namespace. */
  async getBucketErn(name: string): Promise<string> {
    return this.textOf("get-bucket-ern", { name }, "ern");
  }

  /** How many bytes a bucket holds. */
  async getBucketSize(ern: string): Promise<number> {
    return this.numberOf("get-bucket-size", { ern }, "size");
  }

  /**
   * Renames a bucket, and with it every object and subscription that named the old one.
   *
   * The ERN changes too, and nothing answers to the old one afterwards, so the one in the result is
   * what later calls have to use. Refused rather than merged when a bucket of the new name exists.
   */
  async renameBucket(ern: string, newName: string): Promise<RenameBucketResult> {
    return toRenameBucketResult(await this.call("rename-bucket", { ern, newName }));
  }

  /**
   * Marks a bucket as euclid's own plumbing, or stops doing so.
   *
   * Separate from creating one because the bucket this exists for usually predates anybody thinking
   * about it, and reversible for the same reason: a flag that can only be set is one nobody dares set.
   */
  async setBucketInternal(ern: string, internal = true): Promise<SetBucketInternalResult> {
    return toSetBucketInternalResult(await this.call("set-bucket-internal", { ern, internal }));
  }

  /**
   * Deletes a bucket's objects, leaving the bucket itself in place.
   *
   * A prefix narrows it to the keys that start with that; an empty one purges everything.
   */
  async purgeBucket(ern: string, prefix = ""): Promise<PurgeBucketResult> {
    return toPurgeBucketResult(await this.call("purge-bucket", { ern, prefix }));
  }

  /**
   * Encrypts every object written to this bucket from now on, under an EKM key.
   *
   * What it does not do is touch the objects already there: their bytes stay as they were stored, each
   * one records the key it is under, and the result says how many such objects there are.
   * Re-encrypting them is a decision for whoever owns the data.
   *
   * A named key has to exist and be usable for encryption. An unnamed one is created here as AES-256
   * and belongs to EKM from that moment on - which means deleting it there is what makes this
   * bucket's objects unrecoverable.
   */
  async enableEncryption(bucketErn: string, keyId = ""): Promise<EnableEncryptionResult> {
    return toEnableEncryptionResult(await this.call("enable-encryption", { bucketErn, keyId }));
  }

  /**
   * Stops encrypting new objects written to a bucket.
   *
   * The mirror image of {@link enableEncryption} in one respect and no other: it says what happens to
   * the next upload, and it is not an undo. Nothing already stored is decrypted or rewritten, and the
   * key is left alone rather than revoked - those objects are still under it.
   */
  async disableEncryption(bucketErn: string): Promise<DisableEncryptionResult> {
    return toDisableEncryptionResult(await this.call("disable-encryption", { bucketErn }));
  }

  /** Tags a bucket. A key that is already tagged keeps its value - {@link setBucketTag} overwrites. */
  async addBucketTag(bucketErn: string, key: string, value: string): Promise<void> {
    await this.call("add-bucket-tag", { ern: bucketErn, key, value });
  }

  /** Tags a bucket, overwriting any value the key already had. */
  async setBucketTag(bucketErn: string, key: string, value: string): Promise<void> {
    await this.call("set-bucket-tag", { ern: bucketErn, key, value });
  }

  /** Removes a tag from a bucket. */
  async deleteBucketTag(bucketErn: string, key: string): Promise<void> {
    await this.call("delete-bucket-tag", { ern: bucketErn, key });
  }

  // -- objects ---------------------------------------------------------------------------------

  /**
   * One page of a bucket's objects, and how many it holds in total.
   *
   * Keys are opaque strings, so a bucket only has "directories" in the sense that keys share a prefix;
   * the markers for them are left out unless `includeDirectories` asks for them.
   */
  async listObjects(bucketErn: string, options: ListObjectsOptions = {}): Promise<Page<EsmObject>> {
    const payload = {
      bucketErn,
      ...listPayload(options, "name"),
      includeDirectories: options.includeDirectories ?? false,
    };
    return toPage(await this.call("list-objects", payload), "objects", toEsmObject);
  }

  /**
   * How many objects a bucket holds. Cheaper than listing them when only the number matters - the
   * server counts rather than paging every object back to the caller.
   */
  async getObjectCount(bucketErn: string, prefix = ""): Promise<number> {
    return this.numberOf("get-object-count", { ern: bucketErn, prefix }, "count");
  }

  /** Deletes one object, by its own ERN. */
  async deleteObject(ern: string): Promise<void> {
    await this.call("delete-object", { ern });
  }

  /**
   * Deletes several named objects from a bucket in one call.
   *
   * A key that names no object is not an error, so the result reports both how many keys were asked
   * for and how many objects went. Deleting everything under a prefix is {@link purgeBucket} rather
   * than a variant of this - the server refuses keys and a prefix in the same request, since answering
   * both would delete more than either.
   *
   * `background` has the server answer as soon as it has taken the work on rather than when it has
   * finished, in which case the count is what it took on.
   */
  async deleteObjects(bucketErn: string, keys: readonly string[], background = false): Promise<DeleteObjectsResult> {
    const payload = { ern: bucketErn, keys: [...keys], async: background };
    return toDeleteObjectsResult(await this.call("delete-objects", payload));
  }

  /**
   * Copies an object, leaving the source in place.
   *
   * The copy gets its own bytes on disk and its own ERN, so the two are independent from here on. Both
   * ends are permission-checked, and an existing object at the target is refused with HTTP 409 rather
   * than silently replaced.
   */
  async copyObject(
    sourceBucketErn: string,
    sourceKey: string,
    targetBucketErn: string,
    targetKey: string,
  ): Promise<EsmObject> {
    return this.#transferObject("copy-object", sourceBucketErn, sourceKey, targetBucketErn, targetKey);
  }

  /**
   * Moves an object to another bucket or key, removing the source.
   *
   * The bytes are not copied - the same file answers to a different key from now on - so this costs
   * the same whatever the object's size. Refuses an existing target exactly as {@link copyObject} does.
   */
  async moveObject(
    sourceBucketErn: string,
    sourceKey: string,
    targetBucketErn: string,
    targetKey: string,
  ): Promise<EsmObject> {
    return this.#transferObject("move-object", sourceBucketErn, sourceKey, targetBucketErn, targetKey);
  }

  /**
   * Renames an object within its bucket - a {@link moveObject} that cannot leave it, which is the
   * whole difference between the two.
   */
  async renameObject(bucketErn: string, key: string, newKey: string): Promise<EsmObject> {
    return toEsmObject(await this.call("rename-object", { bucketErn, key, newKey }));
  }

  /**
   * Re-announces objects already in a bucket, so a listener that missed their creation events hears
   * about them now.
   *
   * Nothing about the objects changes - not a byte, not their modified time. "Touch" here means what
   * it does to listeners, not what it does to storage: a timestamp is something consumers compare
   * against, and moving it would make this destructive in exactly the way it is trying not to be.
   *
   * `background` is what a bucket of any size wants: the announcement is per object, and holding a
   * request open for all of them is a request that times out.
   */
  async touchObject(bucketErn: string, options: TouchObjectOptions = {}): Promise<TouchObjectResult> {
    const payload = { ern: bucketErn, prefix: options.prefix ?? "", async: options.background ?? false };
    return toTouchObjectResult(await this.call("touch-object", payload));
  }

  /** copy-object and move-object take the same request and differ only in whether the source survives. */
  async #transferObject(
    action: string,
    sourceBucketErn: string,
    sourceKey: string,
    targetBucketErn: string,
    targetKey: string,
  ): Promise<EsmObject> {
    return toEsmObject(await this.call(action, { sourceBucketErn, sourceKey, targetBucketErn, targetKey }));
  }

  // -- object attributes -----------------------------------------------------------------------

  /**
   * Adds a user-defined attribute to an object. One of that name already there keeps its value -
   * {@link setObjectAttribute} overwrites.
   *
   * The value is a {@link Variant}, or a plain value to be tagged as one - see
   * {@link import("../dto/com.js").variantOf}.
   */
  async addObjectAttribute(ern: string, name: string, value: VariantInput): Promise<ObjectAttribute> {
    return this.#objectAttribute("add-object-attribute", ern, name, value);
  }

  /** Sets a user-defined attribute on an object, overwriting any value it already had. */
  async setObjectAttribute(ern: string, name: string, value: VariantInput): Promise<ObjectAttribute> {
    return this.#objectAttribute("set-object-attribute", ern, name, value);
  }

  /** Every user-defined attribute of an object, keyed by name. */
  async listObjectAttributes(ern: string): Promise<Record<string, Variant>> {
    const response = await this.call("list-object-attributes", { ern });
    return toVariantMap(response["attributes"]);
  }

  /** Deletes one user-defined attribute from an object. */
  async deleteObjectAttribute(ern: string, name: string): Promise<void> {
    await this.call("delete-object-attribute", { ern, name });
  }

  async #objectAttribute(
    action: string,
    ern: string,
    name: string,
    value: VariantInput,
  ): Promise<ObjectAttribute> {
    return toObjectAttribute(
      await this.call(action, { ern, name, value: variantToJson(variantOf(value)) }),
    );
  }

  // -- subscriptions ---------------------------------------------------------------------------

  /**
   * Announces a bucket's object events to a queue or a topic from now on.
   *
   * What lands there is a {@link BucketEvent}, carried as the body of an ordinary message - see
   * {@link parseBucketEvent}. The filters are applied by the server as it publishes, so a subscription
   * only ever delivers what it asked for rather than the target receiving everything and discarding
   * most of it.
   *
   * Not idempotent: a second call registers a second subscription and the target then receives every
   * matching event twice, so a caller that may run twice checks {@link listSubscriptions} first.
   *
   * @param bucketErn bucket resource name
   * @param targetType {@link QUEUE} or {@link TOPIC}, which is also what decides how a bare target
   *   name is resolved.
   * @param targetErn target resource name
   * @param options call options
   */
  async subscribe(
    bucketErn: string,
    targetType: string,
    targetErn: string,
    options: SubscribeOptions = {},
  ): Promise<SubscribeResult> {
    return toSubscribeResult(
      await this.call("subscribe", {
        sourceErn: bucketErn,
        type: targetType,
        targetErn,
        eventTypes: [...(options.eventTypes ?? [])],
        prefix: options.prefix ?? "",
        directories: options.directories ?? false,
      }),
    );
  }

  /**
   * Removes a subscription, by the ERN {@link subscribe} answered with - not the bucket's, and not the
   * target's.
   */
  async unsubscribe(ern: string): Promise<void> {
    await this.call("unsubscribe", { ern });
  }

  /** Every subscription currently registered on a bucket. */
  async listSubscriptions(bucketErn: string): Promise<Subscription[]> {
    const response = await this.call("list-subscriptions", { bucketErn });
    const subscriptions = response["subscriptions"];
    return Array.isArray(subscriptions) ? subscriptions.map(toSubscription) : [];
  }

  // -- objects, in bytes -----------------------------------------------------------------------

  /**
   * Uploads an object in a single request, skipping the multipart sequence entirely.
   *
   * A string is stored as its UTF-8 bytes, which is what the object then is; anything that matters
   * about the encoding is the caller's to decide before calling this.
   *
   * Takes two attribute maps, which are not the same one - see {@link AttributeOptions}.
   */
  async putObject(
    bucketErn: string,
    key: string,
    data: Bytes,
    options: AttributeOptions = {},
  ): Promise<StoredObject> {
    const headers = {
      "x-euclid-bucket-ern": bucketErn,
      "x-euclid-key": key,
      ...attributeHeaders(options),
    };
    // Answers with JSON even though the request carried bytes: the same payload complete-upload
    // answers with, so a caller that needs the ERN does not have to take the multipart path.
    const response = await this.postBytes("put-object", data, headers);
    return toStoredObject(this.result("put-object", response));
  }

  /**
   * Downloads an object's bytes in a single request.
   *
   * The size limit is the server's to enforce rather than this client's: a download's size is not
   * known until the server is asked, unlike an upload's, so the caller declares how large a response
   * it is willing to take and an object at or above that comes back as HTTP 413.
   * {@link downloadFile} uses exactly that to decide whether an object needs the multipart path.
   */
  async getObject(bucketErn: string, key: string, maxInlineSize = DEFAULT_PART_SIZE): Promise<Buffer> {
    const response = await this.#getObject(bucketErn, key, maxInlineSize);
    if (!response.ok) throw new EuclidServiceError(TARGET, "get-object", response.status, response.text);
    return response.content;
  }

  /**
   * Uploads a local file in parts, several at a time.
   *
   * The file is read a part at a time rather than into memory, and no more than `concurrency` parts
   * are ever in flight, so the memory this costs is bounded by the two together whatever the file's
   * size. An empty file is one empty part, so that the object exists.
   *
   * Attributes belong on the upload rather than added afterwards: completing an upload is finished off
   * in the background, and the object row written at the end carries what this call supplied - an
   * attribute added between here and there is overwritten and silently lost.
   *
   * @throws {EuclidServiceError} if a part or one of the calls bracketing them failed for good.
   * @throws {Error} if `partSize` is less than a byte, which the server rejects too.
   */
  async uploadFile(
    bucketErn: string,
    key: string,
    file: string,
    options: UploadOptions = {},
  ): Promise<StoredObject> {
    const partSize = options.partSize ?? DEFAULT_PART_SIZE;
    checkPartSize(partSize);
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

    // Opened before anything is sent, so a path that is not there costs no round trip at all.
    const source = await open(file, "r");
    try {
      const { size } = await source.stat();
      const upload = await this.#createUpload(bucketErn, key, concurrency);
      // An empty file is one empty part rather than none, so that the object exists afterwards.
      const parts = Math.max(1, Math.ceil(size / partSize));
      await runBounded(parts, concurrency, async (index) => {
        const offset = index * partSize;
        const data = await readPart(source, offset, Math.min(partSize, Math.max(0, size - offset)));
        await this.#uploadPart(upload.uploadId, index + 1, data);
      });
      return this.#completeUpload(upload.uploadId, options);
    } finally {
      await source.close();
    }
  }

  /**
   * Downloads an object to a local file, fetching its parts several at a time.
   *
   * An object that fits in one part skips multipart entirely. Unlike an upload - whose source this
   * client has already stat'ed - a download's size is not known before asking, so the single-request
   * path is tried first and HTTP 413 is what says the object was too large for it.
   *
   * Missing parent directories are created. Answers with the number of bytes written.
   *
   * @throws {Error} if `partSize` is less than a byte, which the server rejects too.
   */
  async downloadFile(
    bucketErn: string,
    key: string,
    file: string,
    options: DownloadOptions = {},
  ): Promise<number> {
    const partSize = options.partSize ?? DEFAULT_PART_SIZE;
    checkPartSize(partSize);
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

    const inline = await this.#getObject(bucketErn, key, partSize);
    if (inline.status !== PAYLOAD_TOO_LARGE) {
      if (!inline.ok) throw new EuclidServiceError(TARGET, "get-object", inline.status, inline.text);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, inline.content);
      return inline.content.length;
    }

    const download = await this.#createDownload(bucketErn, key, concurrency);
    await mkdir(dirname(file), { recursive: true });
    const sink = await open(file, "w");
    try {
      // Sized up front so that each part can be written at its own offset whatever order the parts
      // arrive in - the download's answer to uploadFile() reading its source in order while letting
      // the parts themselves complete out of order.
      await sink.truncate(download.size);
      const parts = Math.ceil(download.size / partSize);
      await runBounded(parts, concurrency, async (index) => {
        const part = await this.#downloadPart(download.downloadId, index + 1, partSize);
        if (part.length > 0) await sink.write(part, 0, part.length, index * partSize);
      });
    } finally {
      await sink.close();
    }
    await this.#completeDownload(download.downloadId);
    return download.size;
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * ESM's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to ESM.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }

  // -- the multipart sequence ------------------------------------------------------------------

  /**
   * Opens a multipart upload, declaring the concurrency it is about to use so that the gateway's
   * autoscaler can ramp storage instances toward it rather than discover the load.
   *
   * Retried on 5xx: the object row the server seeds is keyed on the bucket and key, so a second
   * attempt updates the same row, and the only cost of a repeat is the scratch directory the abandoned
   * upload ID left behind.
   */
  async #createUpload(bucketErn: string, key: string, concurrency: number): Promise<CreateUploadResult> {
    return toCreateUploadResult(
      await this.#callWithRetry("create-upload", { bucketErn, key }, concurrencyHeader(concurrency)),
    );
  }

  async #uploadPart(uploadId: string, number: number, data: Buffer): Promise<void> {
    await this.#withRetry("upload-part", () =>
      this.postBytes("upload-part", data, {
        "x-euclid-upload-id": uploadId,
        "x-euclid-part-number": String(number),
      }),
    );
  }

  /**
   * Assembles the parts into the object.
   *
   * The attributes ride on this request because the background pass that finishes the upload builds
   * the object row from what this call was given. Retried on 5xx like the create: failing here
   * discards every part already uploaded, and an upload the server did accept fails a retry with 404
   * rather than being assembled twice.
   */
  async #completeUpload(uploadId: string, options: AttributeOptions): Promise<StoredObject> {
    return toStoredObject(
      await this.#callWithRetry("complete-upload", { uploadId }, attributeHeaders(options)),
    );
  }

  /**
   * Opens a multipart download, which stages the object and says how large it is.
   *
   * Retried on 5xx: the session it opens is scratch state keyed by a fresh download ID, so a retried
   * attempt starts a new one and the abandoned session is simply never used.
   */
  async #createDownload(bucketErn: string, key: string, concurrency: number): Promise<CreateDownloadResult> {
    return toCreateDownloadResult(
      await this.#callWithRetry("create-download", { bucketErn, key }, concurrencyHeader(concurrency)),
    );
  }

  async #downloadPart(downloadId: string, number: number, partSize: number): Promise<Buffer> {
    const response = await this.#withRetry("download-part", () =>
      this.postBytes("download-part", Buffer.alloc(0), {
        "x-euclid-download-id": downloadId,
        "x-euclid-part-number": String(number),
        "x-euclid-part-size": String(partSize),
      }),
    );
    return response.content;
  }

  /**
   * Releases the download's server-side scratch state. Retried on 5xx for the same reason completing
   * an upload is: failing here throws away every part already fetched.
   */
  async #completeDownload(downloadId: string): Promise<void> {
    await this.#callWithRetry("complete-download", { downloadId }, {});
  }

  /** The raw response, so a caller can tell an object that was too large from one that failed. */
  async #getObject(bucketErn: string, key: string, maxInlineSize: number): Promise<Response> {
    return this.postBytes("get-object", Buffer.alloc(0), {
      "x-euclid-bucket-ern": bucketErn,
      "x-euclid-key": key,
      "x-euclid-part-size": String(maxInlineSize),
    });
  }

  // -- transport -------------------------------------------------------------------------------

  /**
   * One of the JSON actions bracketing a transfer, retried the way the parts between them are.
   *
   * They run once per transfer rather than once per part, but giving up on a transient failure in one
   * of them discards the whole file, which is what makes them worth the same treatment.
   */
  async #callWithRetry(
    action: string,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.#withRetry(action, () => this.post(action, payload, headers));
    return this.result(action, response);
  }

  /**
   * Sends one step of a transfer, retrying while it looks transient.
   *
   * A 4xx means the request itself is wrong and a repeat would be answered identically, so only a 5xx
   * and a request that never got an answer are tried again. An error thrown here is the transport
   * failing rather than the server refusing - a refusal arrives as a status.
   */
  async #withRetry(action: string, send: () => Promise<Response>): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt === MAX_PART_ATTEMPTS;
      let response: Response | null = null;
      try {
        response = await send();
      } catch (error) {
        if (last) throw error;
      }
      if (response !== null && (response.status < 500 || last)) {
        if (!response.ok) throw new EuclidServiceError(TARGET, action, response.status, response.text);
        return response;
      }
      await delay(this.retryBaseDelayMs * attempt);
    }
  }

  /**
   * The byte-carrying actions, on this client's transfer timeout rather than the session's - a 5 MiB
   * part on a slow link is not an action that answers from a database.
   */
  protected override async postBytes(
    action: string,
    data: Bytes,
    headers: Record<string, string> = {},
    timeoutMs?: number,
  ): Promise<Response> {
    return super.postBytes(action, data, headers, timeoutMs ?? this.transferTimeoutMs ?? undefined);
  }
}

/**
 * The two attribute maps, as the headers that carry them.
 *
 * Headers rather than body fields because the actions that take them are the ones whose body is either
 * the object's bytes or nothing at all. An empty map is left out entirely, so a request that has
 * nothing to say about attributes says nothing.
 */
function attributeHeaders(options: AttributeOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.attributes !== undefined && Object.keys(options.attributes).length > 0) {
    headers["x-euclid-attributes"] = JSON.stringify(variantMapToJson(options.attributes));
  }
  if (options.systemAttributes !== undefined && Object.keys(options.systemAttributes).length > 0) {
    headers["x-euclid-system-attributes"] = JSON.stringify(variantMapToJson(options.systemAttributes));
  }
  return headers;
}

/** What a transfer declares up front, so the gateway can ramp toward it rather than discover it. */
function concurrencyHeader(concurrency: number): Record<string, string> {
  return { "x-euclid-expected-concurrency": String(concurrency) };
}

/**
 * Refused here rather than on arrival: a part size of zero would otherwise upload a file as one empty
 * part and call it stored, which is a corrupt object rather than an error.
 */
function checkPartSize(partSize: number): void {
  if (!Number.isInteger(partSize) || partSize < 1) throw new Error("partSize must be at least 1 byte");
}

/**
 * One part of a file, read at its own offset.
 *
 * Positioned reads rather than a shared file position, so the parts can be read in whatever order the
 * pool gets to them. A short read is read again rather than treated as the end of the file: a read may
 * answer with fewer bytes than it was asked for, and a part shorter than it should be is a corrupt
 * object at the other end.
 */
async function readPart(source: FileHandle, offset: number, length: number): Promise<Buffer> {
  const part = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await source.read(part, filled, length - filled, offset + filled);
    if (bytesRead === 0) return part.subarray(0, filled);
    filled += bytesRead;
  }
  return part;
}

/**
 * Runs `task` for every index below `count`, no more than `concurrency` of them outstanding.
 *
 * Workers pull the next index as they finish one rather than the work being handed out in advance, so
 * a part that takes longer than the rest does not leave a worker idle - and the memory in flight is
 * bounded by the concurrency rather than by the number of parts.
 *
 * The first failure is what the caller sees, thrown after the pool has drained: a part still in flight
 * when another one failed is one the server is already writing, and abandoning it would not stop that.
 */
async function runBounded(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  // An array rather than one slot, so that "has anything failed yet" stays readable from inside the
  // workers; only the first one is ever thrown.
  const failures: unknown[] = [];

  const worker = async (): Promise<void> => {
    while (failures.length === 0) {
      const index = next;
      next += 1;
      if (index >= count) return;
      try {
        await task(index);
      } catch (error) {
        failures.push(error);
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  if (failures.length > 0) throw failures[0];
}

function delay(milliseconds: number): Promise<void> {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}
