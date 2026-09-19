/**
 * ESM, end to end against a fake euclid server.
 *
 * The JSON actions are checked the way EAM's are - what went on the wire, and what came back off it.
 * The transfers are checked against a storage stand-in that actually assembles what it is sent
 * (`fake-storage.ts`), because the part of a multipart upload a unit test cannot see is exactly the
 * part that corrupts an object: a part number off by one, a part size the two ends disagree about, or
 * a reassembly that depends on the order the parts happened to arrive in.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Euclid, parseBucketEvent, QUEUE, type EuclidEsm, type EuclidSession } from "../src/index.js";
import { EuclidServiceError } from "../src/errors.js";
import { AUTH_SIGNATURE } from "../src/index.js";
import { MAX_PART_ATTEMPTS, OBJECT_CREATED } from "../src/modules/esm.js";
import { FakeGateway, prepareLogin } from "./fake-gateway.js";
import { bucketErn, FakeStorage } from "./fake-storage.js";

const BUCKET = bucketErn("reports");

let gateway: FakeGateway;
let storage: FakeStorage;
let session: EuclidSession;
let esm: EuclidEsm;
let scratch = "";
let previous: string | undefined;

beforeEach(async () => {
  gateway = await new FakeGateway().start();
  storage = new FakeStorage().install(gateway);
  // Its own credentials file, as in the EAM suite: logging in writes the cache, and a test that forgot
  // this would overwrite the credentials of whoever ran the suite.
  previous = process.env["EUCLID_CREDENTIALS_FILE"];
  scratch = await mkdtemp(join(tmpdir(), "euclid-ndk-esm-"));
  process.env["EUCLID_CREDENTIALS_FILE"] = join(scratch, "credentials");

  prepareLogin(gateway);
  session = await Euclid.forServer(gateway.baseUrl).login("jens", "secret");
  esm = session.esm();
  // Retries without the waiting. The delays are what make a retry kind to a struggling server, and
  // what would make this suite take a minute to tell us the same thing.
  esm.retryBaseDelayMs = 0;
});

afterEach(async () => {
  session.close();
  await gateway.stop();
  if (previous === undefined) delete process.env["EUCLID_CREDENTIALS_FILE"];
  else process.env["EUCLID_CREDENTIALS_FILE"] = previous;
});

/** A path under this test's scratch directory. */
function path(...parts: string[]): string {
  return join(scratch, ...parts);
}

/** Every request of one action, in the order they were sent. */
function requestsFor(action: string) {
  return gateway.requests.filter((request) => request.action === action);
}

// -- buckets -----------------------------------------------------------------------------------

describe("buckets", () => {
  it("creates and lists them", async () => {
    gateway.answer("esm", "create-bucket", { name: "reports", ern: BUCKET });
    gateway.answer("esm", "list-buckets", {
      total: 2,
      buckets: [
        {
          name: "reports",
          ern: BUCKET,
          owner: "jens",
          size: 2048,
          objects: 3,
          tags: { team: "finance" },
          encrypted: true,
          encryptionKeyErn: "ern:ekm:key/1",
          created: "2026-01-01",
        },
        { name: "euclid-artifacts", internal: true },
      ],
    });

    const created = await esm.createBucket("reports");
    assert.deepEqual([created.name, created.ern], ["reports", BUCKET]);
    assert.deepEqual(gateway.last().json(), { name: "reports", internal: false });

    const listed = await esm.listBuckets({ prefix: "rep", pageSize: 25, includeInternal: true });
    assert.deepEqual(gateway.last().json(), {
      prefix: "rep",
      pageSize: 25,
      pageIndex: 0,
      sortColumn: "name",
      sortDirection: "asc",
      includeInternal: true,
    });
    assert.equal(listed.total, 2);
    assert.deepEqual(listed.items.map((bucket) => bucket.name), ["reports", "euclid-artifacts"]);
    assert.deepEqual(listed.items[0]?.tags, { team: "finance" });
    assert.equal(listed.items[0]?.encryptionKeyErn, "ern:ekm:key/1");
    assert.equal(listed.items[1]?.internal, true);
    // A field the server did not send reads as empty rather than throwing.
    assert.equal(listed.items[1]?.owner, "");
    assert.deepEqual(listed.items[1]?.tags, {});
  });

  it("describes one bucket the way a listing describes each", async () => {
    gateway.answer("esm", "get-bucket", {
      bucket: {
        name: "reports",
        ern: BUCKET,
        owner: "jens",
        size: 2048,
        objects: 7,
        tags: { team: "media" },
        encrypted: true,
        encryptionKeyErn: "ern:ekm:key/1",
      },
    });

    const bucket = await esm.getBucket("reports");

    assert.deepEqual(gateway.last().json(), { name: "reports" });
    assert.equal(bucket.ern, BUCKET);
    assert.equal(bucket.size, 2048);
    assert.equal(bucket.objects, 7);
    assert.deepEqual(bucket.tags, { team: "media" });
    assert.equal(bucket.encrypted, true);
  });

  it("asks for a bucket by ERN as well as by name", async () => {
    // A name is resolved in the session's own namespace and an ERN is not, so which of the two was
    // given has to reach the server as the field it is - the caller should not have to say.
    gateway.answer("esm", "get-bucket", { bucket: { name: "reports", ern: BUCKET } });

    await esm.getBucket(BUCKET);

    assert.deepEqual(gateway.last().json(), { ern: BUCKET });
  });

  it("answers the single-value actions as values", async () => {
    // An ERN, a size and a count are one string or one number; wrapping them would only mean the
    // caller unwrapping them again.
    gateway.answer("esm", "get-bucket-ern", { ern: BUCKET });
    gateway.answer("esm", "get-bucket-size", { ern: BUCKET, size: 4096 });
    gateway.answer("esm", "get-object-count", { ern: BUCKET, count: 12 });

    assert.equal(await esm.getBucketErn("reports"), BUCKET);
    assert.deepEqual(gateway.last().json(), { name: "reports" });
    assert.equal(await esm.getBucketSize(BUCKET), 4096);
    assert.equal(await esm.getObjectCount(BUCKET), 12);
    assert.deepEqual(gateway.last().json(), { ern: BUCKET });
  });

  it("counts for real, which is a different question from the stored total", async () => {
    // The two were one call until euclid 1.0.73, which took a prefix and ignored it - so a caller
    // asking about part of a bucket was quietly given the whole bucket's figure.
    gateway.answer("esm", "count-objects", {
      ern: BUCKET,
      prefix: "2026/",
      includeDirectories: false,
      count: 12,
    });

    assert.equal(await esm.countObjects(BUCKET, { prefix: "2026/" }), 12);
    assert.deepEqual(gateway.last().json(), {
      ern: BUCKET,
      prefix: "2026/",
      includeDirectories: false,
    });

    gateway.answer("esm", "count-objects", {
      ern: BUCKET,
      prefix: "",
      includeDirectories: true,
      count: 15,
    });

    assert.equal(await esm.countObjects(BUCKET, { includeDirectories: true }), 15);
    assert.deepEqual(gateway.last().json(), {
      ern: BUCKET,
      prefix: "",
      includeDirectories: true,
    });
  });

  it("tags, renames, purges and flags them", async () => {
    gateway.answer("esm", "add-bucket-tag", {});
    gateway.answer("esm", "set-bucket-tag", {});
    gateway.answer("esm", "delete-bucket-tag", {});
    gateway.answer("esm", "rename-bucket", {
      name: "archive",
      ern: bucketErn("archive"),
      objects: 7,
      subscriptions: 1,
    });
    gateway.answer("esm", "set-bucket-internal", { ern: BUCKET, name: "reports", internal: true });
    gateway.answer("esm", "purge-bucket", { ern: BUCKET, count: 7 });
    gateway.answer("esm", "delete-bucket", {});

    await esm.addBucketTag(BUCKET, "team", "finance");
    assert.deepEqual(gateway.last().json(), { ern: BUCKET, key: "team", value: "finance" });
    await esm.setBucketTag(BUCKET, "team", "ops");
    await esm.deleteBucketTag(BUCKET, "team");
    assert.deepEqual(gateway.last().json(), { ern: BUCKET, key: "team" });

    const renamed = await esm.renameBucket(BUCKET, "archive");
    assert.deepEqual([renamed.ern, renamed.objects, renamed.subscriptions], [bucketErn("archive"), 7, 1]);

    assert.equal((await esm.setBucketInternal(BUCKET)).internal, true);
    assert.deepEqual(gateway.last().json(), { ern: BUCKET, internal: true });

    assert.equal((await esm.purgeBucket(BUCKET, "2025/")).count, 7);
    assert.deepEqual(gateway.last().json(), { ern: BUCKET, prefix: "2025/", async: false });
    await esm.deleteBucket(BUCKET);
  });

  it("deletes a bucket in the background", async () => {
    // A bucket goes with its objects, and a large one is emptied in the background first.
    gateway.answer("esm", "delete-bucket", { ern: BUCKET, async: true, jobId: "job-7", objects: 40000 }, 202);

    const result = await esm.deleteBucket(BUCKET, true);

    assert.deepEqual(gateway.last().json(), { ern: BUCKET, async: true });
    assert.deepEqual([result.count, result.background, result.jobId], [40000, true, "job-7"]);
  });

  it("purges a bucket in the background", async () => {
    // Emptying a bucket can take minutes, so the server writes the work down and answers at once.
    gateway.answer("esm", "purge-bucket", { ern: BUCKET, async: true, jobId: "job-42", objects: 120000 }, 202);

    const result = await esm.purgeBucket(BUCKET, "", true);

    assert.deepEqual(gateway.last().json(), { ern: BUCKET, prefix: "", async: true });
    // "objects" here, "count" when it runs inline: the same figure at two points in the same work.
    assert.deepEqual([result.count, result.background, result.jobId], [120000, true, "job-42"]);
  });

  it("reports what encryption did not touch", async () => {
    // Both calls say what happens to the next upload; neither rewrites what is already stored, and the
    // counts are how a caller finds out.
    gateway.answer("esm", "enable-encryption", {
      ern: BUCKET,
      name: "reports",
      keyErn: "ern:ekm:key/7",
      keyId: "reports-key",
      algorithm: "AES-256",
      keyCreated: true,
      existingObjects: 42,
    });
    gateway.answer("esm", "disable-encryption", {
      ern: BUCKET,
      name: "reports",
      previousKeyErn: "ern:ekm:key/7",
      previousKeyId: "reports-key",
      encryptedObjects: 43,
    });

    const enabled = await esm.enableEncryption(BUCKET);
    assert.deepEqual(gateway.last().json(), { bucketErn: BUCKET, keyId: "" });
    assert.deepEqual([enabled.keyId, enabled.algorithm, enabled.keyCreated], ["reports-key", "AES-256", true]);
    assert.equal(enabled.existingObjects, 42);

    const disabled = await esm.disableEncryption(BUCKET);
    assert.equal(disabled.previousKeyId, "reports-key");
    assert.equal(disabled.encryptedObjects, 43);
  });
});

// -- objects -----------------------------------------------------------------------------------

describe("objects", () => {
  it("names both ends when copying, moving and renaming", async () => {
    const stored = {
      ern: `${BUCKET}/2026/q3.pdf`,
      bucketErn: BUCKET,
      key: "2026/q3.pdf",
      size: 12,
      status: "STORED",
      contentType: "application/pdf",
    };
    gateway.answer("esm", "copy-object", stored);
    gateway.answer("esm", "move-object", stored);
    gateway.answer("esm", "rename-object", stored);

    assert.equal((await esm.copyObject(BUCKET, "q3.pdf", BUCKET, "2026/q3.pdf")).key, "2026/q3.pdf");
    assert.deepEqual(gateway.last().json(), {
      sourceBucketErn: BUCKET,
      sourceKey: "q3.pdf",
      targetBucketErn: BUCKET,
      targetKey: "2026/q3.pdf",
    });
    assert.equal((await esm.moveObject(BUCKET, "q3.pdf", BUCKET, "2026/q3.pdf")).size, 12);
    assert.equal(gateway.last().action, "move-object");
    assert.equal((await esm.renameObject(BUCKET, "q3.pdf", "2026/q3.pdf")).contentType, "application/pdf");
    assert.deepEqual(gateway.last().json(), { bucketErn: BUCKET, key: "q3.pdf", newKey: "2026/q3.pdf" });
  });

  it("reports how many of the keys asked for named an object", async () => {
    // They differ when a key named nothing, which is not an error - so a caller that cares compares
    // the two.
    gateway.answer("esm", "delete-objects", { ern: BUCKET, asked: 3, objects: 2 });

    const result = await esm.deleteObjects(BUCKET, ["a", "b", "gone"]);

    assert.deepEqual(gateway.last().json(), { ern: BUCKET, keys: ["a", "b", "gone"], async: false });
    assert.deepEqual([result.asked, result.objects, result.background], [3, 2, false]);
  });

  it("touches a bucket in the background", async () => {
    gateway.answer(
      "esm",
      "touch-object",
      { ern: BUCKET, bucketName: "reports", prefix: "2026/", objects: 900, async: true },
      202,
    );

    const result = await esm.touchObject(BUCKET, { prefix: "2026/", background: true });

    assert.deepEqual(gateway.last().json(), { ern: BUCKET, prefix: "2026/", async: true });
    assert.deepEqual([result.objects, result.background, result.bucketName], [900, true, "reports"]);
  });

  it("lists them as a page", async () => {
    await esm.putObject(BUCKET, "2026/q3.pdf", Buffer.from("a report"));

    const listed = await esm.listObjects(BUCKET, { prefix: "2026/" });

    assert.deepEqual(gateway.last().json(), {
      bucketErn: BUCKET,
      prefix: "2026/",
      pageSize: 10,
      pageIndex: 0,
      sortColumn: "name",
      sortDirection: "asc",
      includeDirectories: false,
    });
    assert.deepEqual(listed.items.map((object) => object.key), ["2026/q3.pdf"]);
    assert.equal(listed.items[0]?.size, "a report".length);
    assert.equal(listed.items[0]?.status, "STORED");
  });
});

// -- object attributes -------------------------------------------------------------------------

describe("object attributes", () => {
  it("types them on the way out and back", async () => {
    // A plain value is tagged with the type euclid stores it under, so a caller only reaches for a
    // variant when it wants a tag other than the obvious one.
    gateway.answer("esm", "set-object-attribute", {
      ern: "ern:esm:object/1",
      name: "retries",
      value: { type: "long", value: 3 },
    });
    gateway.answer("esm", "list-object-attributes", {
      ern: "ern:esm:object/1",
      total: 3,
      attributes: {
        tenant: { type: "string", value: "acme" },
        retries: { type: "long", value: 3 },
        thumbnail: { type: "binary", value: "YWJj" },
      },
    });
    gateway.answer("esm", "delete-object-attribute", {});

    const attribute = await esm.setObjectAttribute("ern:esm:object/1", "retries", 3);
    assert.deepEqual(gateway.last().json(), {
      ern: "ern:esm:object/1",
      name: "retries",
      value: { type: "long", value: 3 },
    });
    assert.deepEqual(attribute.value, { type: "long", value: 3 });

    const attributes = await esm.listObjectAttributes("ern:esm:object/1");
    assert.equal(attributes["tenant"]?.value, "acme");
    assert.deepEqual(attributes["retries"], { type: "long", value: 3 });
    // binary is base64 on the wire and bytes here, so a caller never sees the encoding.
    assert.deepEqual(attributes["thumbnail"]?.value, Buffer.from("abc"));

    await esm.deleteObjectAttribute("ern:esm:object/1", "retries");
    assert.deepEqual(gateway.last().json(), { ern: "ern:esm:object/1", name: "retries" });
  });

  it("keeps the tag an explicit variant was given", async () => {
    gateway.answer("esm", "add-object-attribute", {
      ern: "ern:esm:object/1",
      name: "count",
      value: { type: "int", value: 3 },
    });

    await esm.addObjectAttribute("ern:esm:object/1", "count", { type: "int", value: 3 });

    assert.deepEqual(gateway.last().json()["value"], { type: "int", value: 3 });
  });
});

// -- subscriptions -----------------------------------------------------------------------------

describe("subscriptions", () => {
  it("subscribes a queue to a bucket's events", async () => {
    gateway.answer("esm", "subscribe", {
      ern: "ern:esm:subscription/1",
      sourceErn: BUCKET,
      type: "SQS",
      targetErn: "ern:eqs:queue/reports",
    });
    gateway.answer("esm", "list-subscriptions", {
      total: 1,
      subscriptions: [
        {
          ern: "ern:esm:subscription/1",
          sourceErn: BUCKET,
          type: "SQS",
          targetErn: "ern:eqs:queue/reports",
          created: "2026-01-01",
        },
      ],
    });
    gateway.answer("esm", "unsubscribe", {});

    const created = await esm.subscribe(BUCKET, QUEUE, "ern:eqs:queue/reports", {
      eventTypes: [OBJECT_CREATED],
      prefix: "2026/",
    });

    assert.deepEqual(gateway.last().json(), {
      sourceErn: BUCKET,
      type: "SQS",
      targetErn: "ern:eqs:queue/reports",
      eventTypes: ["esm.object.created"],
      prefix: "2026/",
      directories: false,
    });
    assert.equal(created.ern, "ern:esm:subscription/1");

    const subscriptions = await esm.listSubscriptions(BUCKET);
    assert.deepEqual(subscriptions.map((subscription) => subscription.targetErn), ["ern:eqs:queue/reports"]);

    // The subscription's own ERN, not the bucket's and not the target's.
    await esm.unsubscribe(created.ern);
    assert.deepEqual(gateway.last().json(), { ern: "ern:esm:subscription/1" });
  });

  it("reads a delivered notification as a bucket event", () => {
    const body = JSON.stringify({
      eventType: "esm.object.created",
      bucketErn: BUCKET,
      key: "q3.pdf",
      ern: `${BUCKET}/q3.pdf`,
      size: 8,
      contentType: "application/pdf",
      md5Sum: "d41d8",
    });

    const event = parseBucketEvent(body);

    assert.deepEqual([event.eventType, event.key, event.size], ["esm.object.created", "q3.pdf", 8]);
    assert.deepEqual(parseBucketEvent(Buffer.from(body, "utf8")), event);
  });
});

// -- objects, in bytes ---------------------------------------------------------------------------

describe("objects in bytes", () => {
  it("puts and gets one in a single request", async () => {
    const stored = await esm.putObject(BUCKET, "q3.pdf", Buffer.from("a report"));

    assert.deepEqual(storage.object(BUCKET, "q3.pdf"), Buffer.from("a report"));
    assert.deepEqual([stored.key, stored.size, stored.status], ["q3.pdf", 8, "STORED"]);
    // The bytes go over the wire as bytes, not as base64 inside a JSON field.
    assert.deepEqual(gateway.last().body, Buffer.from("a report"));
    assert.equal(gateway.last().headers["x-euclid-bucket-ern"], BUCKET);
    assert.equal(gateway.last().headers["content-type"], "application/octet-stream");

    assert.deepEqual(await esm.getObject(BUCKET, "q3.pdf"), Buffer.from("a report"));
  });

  it("stores a string as its UTF-8 bytes", async () => {
    await esm.putObject(BUCKET, "notes.txt", "grüße\n");

    assert.deepEqual(storage.object(BUCKET, "notes.txt"), Buffer.from("grüße\n", "utf8"));
  });

  it("carries both attribute maps", async () => {
    await esm.putObject(BUCKET, "q3.pdf", Buffer.from("a report"), {
      attributes: { tenant: "acme", retries: 3 },
      systemAttributes: { priority: "LOW" },
    });

    assert.deepEqual(storage.attributes(BUCKET, "q3.pdf"), {
      tenant: { type: "string", value: "acme" },
      retries: { type: "long", value: 3 },
    });
    // euclid's own envelope, never mixed into the caller's: this is what carries a producer's priority
    // across a hop through a bucket.
    assert.deepEqual(storage.systemAttributes(BUCKET, "q3.pdf"), {
      priority: { type: "string", value: "LOW" },
    });
  });

  it("says nothing about attributes when there are none", async () => {
    await esm.putObject(BUCKET, "q3.pdf", Buffer.from("a report"));

    assert.equal(storage.attributes(BUCKET, "q3.pdf"), undefined);
    assert.equal(gateway.last().headers["x-euclid-attributes"], undefined);
  });

  it("says so when an object is too large for one response", async () => {
    await esm.putObject(BUCKET, "big", Buffer.alloc(100, "x"));

    await assert.rejects(
      () => esm.getObject(BUCKET, "big", 50),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 413);
        assert.equal(error.reason, "Object too large for a single response");
        return true;
      },
    );
  });

  it("uploads and downloads a file in parts", async () => {
    const source = path("q3.pdf");
    // 12032 bytes: three parts at this part size, the last one short.
    const content = Buffer.concat(Array.from({ length: 47 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
    await writeFile(source, content);

    const stored = await esm.uploadFile(BUCKET, "2026/q3.pdf", source, { partSize: 5000, concurrency: 3 });

    assert.deepEqual(storage.object(BUCKET, "2026/q3.pdf"), content);
    assert.equal(stored.size, content.length);
    const parts = requestsFor("upload-part");
    const numbers = parts.map((request) => Number(request.headers["x-euclid-part-number"]));
    assert.deepEqual([...numbers].sort((left, right) => left - right), [1, 2, 3]);
    assert.deepEqual(
      parts
        .slice()
        .sort((left, right) => Number(left.headers["x-euclid-part-number"]) - Number(right.headers["x-euclid-part-number"]))
        .map((request) => request.body.length),
      [5000, 5000, 2032],
    );
    // The concurrency is declared up front so the gateway's autoscaler can ramp toward it.
    assert.equal(storage.declaredConcurrency.at(-1), "3");

    const target = path("downloaded", "q3.pdf");
    const written = await esm.downloadFile(BUCKET, "2026/q3.pdf", target, { partSize: 5000, concurrency: 3 });

    assert.equal(written, content.length);
    assert.deepEqual(await readFile(target), content);
    assert.equal(requestsFor("download-part").length, 3);
    assert.equal(gateway.last().action, "complete-download");
  });

  it("downloads a small object in one request", async () => {
    // A download's size is not known before asking, so the single-request path is tried first and 413
    // is what says it was not enough.
    await esm.putObject(BUCKET, "small", Buffer.from("a report"));

    const written = await esm.downloadFile(BUCKET, "small", path("small"), { partSize: 5000 });

    assert.equal(written, 8);
    assert.deepEqual(await readFile(path("small"), "utf8"), "a report");
    assert.deepEqual(
      gateway.requests.filter((request) => request.target === "esm").map((request) => request.action),
      ["put-object", "get-object"],
    );
  });

  it("sends one put-object for a file below the part size", async () => {
    // One part is not a multipart upload. create-upload, upload-part and complete-upload are three
    // round trips, and on the server an upload directory, a part file, an assembly pass and a
    // separate MD5 - none of which buys anything when there is only ever going to be one part.
    // Measured before this existed: 0.94 parts per upload, and 793,614 objects written in an hour
    // with every one of them under a kilobyte.
    await writeFile(path("q3.pdf"), "a report");

    await esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), { partSize: 5000 });

    assert.deepEqual(storage.object(BUCKET, "q3.pdf"), Buffer.from("a report"));
    assert.equal(requestsFor("put-object").length, 1);
    assert.equal(requestsFor("create-upload").length, 0);
    assert.equal(requestsFor("upload-part").length, 0);
  });

  it("still uses multipart for a file exactly one part long", async () => {
    // The boundary, stated rather than left to the reader: strictly below goes whole, equal does not.
    await writeFile(path("q3.pdf"), "a report");

    await esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), { partSize: 8 });

    assert.equal(requestsFor("create-upload").length, 1);
    assert.equal(requestsFor("put-object").length, 0);
  });

  it("carries the attributes of a small upload too", async () => {
    // put-object takes them on its own headers, so a file that changed route could lose the
    // metadata whatever put it there knows about it.
    await writeFile(path("q3.pdf"), "a report");

    await esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), {
      partSize: 5000,
      attributes: { tenant: "acme" },
      systemAttributes: { priority: "HIGH" },
    });

    const put = requestsFor("put-object")[0];
    assert.deepEqual(JSON.parse(put.headers["x-euclid-attributes"] as string), {
      tenant: { type: "string", value: "acme" },
    });
    assert.deepEqual(JSON.parse(put.headers["x-euclid-system-attributes"] as string), {
      priority: { type: "string", value: "HIGH" },
    });
  });

  it("still makes an object out of an empty file", async () => {
    await writeFile(path("empty"), Buffer.alloc(0));

    await esm.uploadFile(BUCKET, "empty", path("empty"));

    // It used to create an upload, send one empty part and complete it - three calls to store
    // nothing, with the part manufactured because an empty file yields none. The object is the
    // same either way.
    assert.deepEqual(storage.object(BUCKET, "empty"), Buffer.alloc(0));
    assert.equal(requestsFor("put-object").length, 1);
    assert.equal(requestsFor("create-upload").length, 0);
  });

  it("rides the upload's attributes on the call that completes it", async () => {
    // Rather than adding them afterwards: the row the server writes when it finishes assembling is
    // built from what completing the upload was given, so an attribute added later is overwritten.
    await writeFile(path("q3.pdf"), "a report");

    // partSize 2 against 8 bytes: four parts, so this stays a multipart upload. Left at the
    // default the file goes up whole and there is no complete-upload to assert on.
    await esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), {
      partSize: 2,
      attributes: { tenant: "acme" },
      systemAttributes: { priority: "HIGH" },
    });

    const complete = requestsFor("complete-upload").at(-1)!;
    assert.deepEqual(JSON.parse(complete.headers["x-euclid-attributes"]!), {
      tenant: { type: "string", value: "acme" },
    });
    assert.deepEqual(JSON.parse(complete.headers["x-euclid-system-attributes"]!), {
      priority: { type: "string", value: "HIGH" },
    });
  });
});

// -- retries -------------------------------------------------------------------------------------

describe("retries", () => {
  it("sends a part that failed transiently again", async () => {
    await writeFile(path("q3.pdf"), "a report");
    storage.failNext("upload-part", 2);

    // partSize 8 is exactly the file: one part, still multipart, so the count is about the
    // retry rather than about how many pieces the file was cut into.
    await esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), { partSize: 8, concurrency: 1 });

    assert.deepEqual(storage.object(BUCKET, "q3.pdf"), Buffer.from("a report"));
    assert.equal(requestsFor("upload-part").length, 3);
  });

  it("retries the calls bracketing a transfer too", async () => {
    // They run once per transfer rather than once per part, but giving up on a transient failure there
    // discards the whole file.
    await writeFile(path("q3.pdf"), "a report");
    storage.failNext("create-upload", 1);
    storage.failNext("complete-upload", 1);

    await esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), { partSize: 8 });

    assert.deepEqual(storage.object(BUCKET, "q3.pdf"), Buffer.from("a report"));
    assert.equal(requestsFor("create-upload").length, 2);
  });

  it("gives up with the server's reason when a part keeps failing", async () => {
    await writeFile(path("q3.pdf"), "a report");
    storage.failNext("upload-part", 99);

    await assert.rejects(
      () => esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), { partSize: 8 }),
      (error: EuclidServiceError) => {
        assert.deepEqual([error.target, error.action, error.status], ["esm", "upload-part", 500]);
        assert.equal(error.reason, "Storage temporarily unavailable");
        return true;
      },
    );
    assert.equal(requestsFor("upload-part").length, MAX_PART_ATTEMPTS);
  });

  it("does not retry a rejected part", async () => {
    // A 4xx means the request itself is wrong, and a repeat would be answered identically.
    await writeFile(path("q3.pdf"), "a report");
    storage.failNext("upload-part", 99, 400);

    await assert.rejects(
      () => esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), { partSize: 8 }),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.equal(requestsFor("upload-part").length, 1);
  });

  it("refuses a part size of nothing before anything is sent", async () => {
    // It would otherwise upload the file as one empty part and call it stored, which is a corrupt
    // object rather than an error.
    await writeFile(path("q3.pdf"), "a report");

    await assert.rejects(() => esm.uploadFile(BUCKET, "q3.pdf", path("q3.pdf"), { partSize: 0 }), /partSize/);
    await assert.rejects(() => esm.downloadFile(BUCKET, "q3.pdf", path("out"), { partSize: 0 }), /partSize/);

    assert.deepEqual(gateway.requests.filter((request) => request.target === "esm"), []);
  });

  it("opens no session when downloading an object that is not there", async () => {
    // The single-request attempt is also what finds out the object does not exist, and a 404 is not the
    // 413 that means "too large for this path".
    await assert.rejects(
      () => esm.downloadFile(BUCKET, "missing", path("missing")),
      (error: EuclidServiceError) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
    assert.deepEqual(
      gateway.requests.filter((request) => request.target === "esm").map((request) => request.action),
      ["get-object"],
    );
  });
});

// -- authentication ------------------------------------------------------------------------------

describe("how ESM authenticates", () => {
  it("signs the JSON actions and presents the token for the byte actions", async () => {
    // The one place the SDKs deliberately agree to use the token: an object's bytes are written the
    // same way by euclid-cli, euclid-jdk, euclid-pdk and this client.
    await esm.listObjects(BUCKET);
    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().headers["x-euclid-target"], "esm");

    await esm.putObject(BUCKET, "q3.pdf", Buffer.from("a report"));
    assert.equal(gateway.last().auth, "bearer");
  });

  it("signs the bytes too when the session asked for signatures", async () => {
    // It asked not to be handed a token quietly, and hashing raw bytes here is exact - so the signature
    // covers the object as it went over the wire, which the gateway verifies.
    const signing = await Euclid.forServer(gateway.baseUrl).login("jens", "secret", { auth: AUTH_SIGNATURE });
    try {
      await signing.esm().putObject(BUCKET, "q3.pdf", Buffer.from("a report"));
    } finally {
      signing.close();
    }

    assert.equal(gateway.last().auth, "sigv4");
    assert.equal(gateway.last().subject, "jens");
  });

  it("follows the session it came from", async () => {
    // A namespace changed between two calls scopes the second one: the client reads the session rather
    // than a copy of it taken when it was created.
    gateway.answer("eam", "change-namespace", {});

    await esm.listObjects(BUCKET);
    assert.equal(gateway.last().headers["x-euclid-namespace"], undefined);

    await session.changeNamespace("development");
    await esm.listObjects(BUCKET);
    assert.equal(gateway.last().headers["x-euclid-namespace"], "development");

    // The same client each time, so an application that calls esm() per operation pays for one
    // connection rather than one per call.
    assert.equal(session.esm(), esm);
  });
});

// -- escape hatch ---------------------------------------------------------------------------------

describe("call", () => {
  it("reaches an ESM action this SDK does not wrap", async () => {
    gateway.answer("esm", "some-future-action", { ok: true });

    assert.deepEqual(await esm.call("some-future-action", { x: 1 }), { ok: true });
    assert.deepEqual(gateway.last().json(), { x: 1 });
    assert.equal(gateway.last().auth, "sigv4");
  });

  it("answers metrics unparsed", async () => {
    gateway.answer("esm", "get-metrics", { items: [{ name: "esm-objects", value: 3 }] });

    assert.deepEqual(await esm.metrics(), { items: [{ name: "esm-objects", value: 3 }] });
  });
});
