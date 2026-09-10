#!/usr/bin/env node
/**
 * Everything ESM does, in the order you would do it.
 *
 *   npm run build
 *   node examples/esm-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Works in a bucket of its own, named after the moment it started, and deletes it again at the end -
 * so it is safe to point at a running server, and a run that dies halfway leaves one obviously
 * disposable bucket behind rather than touching anything of yours.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Euclid, EuclidAuthenticationError, EuclidServiceError } from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/esm-walkthrough.mjs <url> <username> <password>");
  process.exit(2);
}

let session;
try {
  session = await Euclid.forServer(baseUrl)
    .access()
    .credentials(username, password)
    // A development server's certificate is usually its own; drop this line, or point caCertPath() at
    // the real CA, anywhere it matters.
    .verify(false)
    .login();
} catch (error) {
  if (error instanceof EuclidAuthenticationError) {
    console.error(`login refused: ${error.reason || error.message}`);
    process.exit(1);
  }
  throw error;
}

const esm = session.esm();
const name = `ndk-walkthrough-${Math.floor(Date.now() / 1000)}`;

try {
  const bucket = await esm.createBucket(name);
  console.log(`created bucket ${bucket.name}`);
  console.log(`  ern: ${bucket.ern}   (this, not the name, is what every other call takes)`);

  try {
    await walk(esm, bucket.ern);
  } finally {
    // Emptied first: a bucket with objects in it cannot be deleted, which is the server refusing to
    // lose track of data rather than an inconvenience.
    await esm.purgeBucket(bucket.ern);
    await esm.deleteBucket(bucket.ern);
    console.log(`\ndeleted bucket ${name} again`);
  }
} finally {
  session.close();
}

/** Everything between creating the bucket and deleting it. */
async function walk(esm, bucketErn) {
  await esm.setBucketTag(bucketErn, "purpose", "sdk-walkthrough");

  // Small enough for one request. The bytes go over the wire as bytes, not as base64 in a JSON field,
  // which is what keeps a large object the size it is.
  const stored = await esm.putObject(bucketErn, "notes/hello.txt", Buffer.from("written in one request\n"), {
    attributes: { author: "euclid-ndk", revision: 1 },
  });
  console.log(`\nput   ${stored.key.padEnd(24)} ${String(stored.size).padStart(8)} bytes  md5=${stored.md5Sum}`);
  const attributes = await esm.listObjectAttributes(stored.ern);
  console.log(`      attributes: ${JSON.stringify(attributes)}`);

  const scratch = await mkdtemp(join(tmpdir(), "euclid-ndk-"));
  try {
    const source = join(scratch, "large.bin");
    // ~10 MiB: three parts at the default part size.
    await writeFile(source, Buffer.alloc(10 * 1024 * 1024 + 1, "e"));

    const uploaded = await esm.uploadFile(bucketErn, "data/large.bin", source, {
      attributes: { origin: "esm-walkthrough.mjs" },
    });
    console.log(`put   ${uploaded.key.padEnd(24)} ${String(uploaded.size).padStart(8)} bytes  (in parts, several at a time)`);

    // Tried in one request first and fetched in parts when that comes back "too large", so the caller
    // does not have to know which of the two an object needs.
    const target = join(scratch, "downloaded.bin");
    const written = await esm.downloadFile(bucketErn, "data/large.bin", target);
    const identical = (await readFile(target)).equals(await readFile(source));
    console.log(`got   ${"downloaded.bin".padEnd(24)} ${String(written).padStart(8)} bytes  identical=${identical}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const objects = await esm.listObjects(bucketErn, { pageSize: 10 });
  console.log(`\n${objects.total} object(s) in the bucket:`);
  for (const object of objects.items) {
    console.log(`  ${object.key.padEnd(24)} ${String(object.size).padStart(9)} ${object.contentType}`);
  }

  const copied = await esm.copyObject(bucketErn, "notes/hello.txt", bucketErn, "notes/hello.copy.txt");
  console.log(`\ncopied to ${copied.key}, which is its own object with its own ERN`);
  const deleted = await esm.deleteObjects(bucketErn, ["notes/hello.copy.txt", "never-existed.txt"]);
  console.log(
    `deleted ${deleted.objects} of the ${deleted.asked} key(s) asked for - one named nothing, which is not an error`,
  );

  console.log(
    `\nbucket holds ${await esm.getObjectCount(bucketErn)} object(s), ${await esm.getBucketSize(bucketErn)} byte(s)`,
  );

  try {
    console.log(`subscriptions: ${JSON.stringify(await esm.listSubscriptions(bucketErn))}`);
  } catch (error) {
    if (!(error instanceof EuclidServiceError)) throw error;
    console.log(`subscriptions: unavailable (${error.reason || error.message})`);
  }
}
