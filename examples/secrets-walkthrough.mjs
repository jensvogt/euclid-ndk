#!/usr/bin/env node
/**
 * ESS and EKM together: a secret, the key it is encrypted under, and what rotating it changes.
 *
 *   npm run build
 *   node examples/secrets-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Creates one key and one secret of its own, named after the moment it started, and removes both again at the
 * end - so it is safe to point at a running server, and a run that dies halfway leaves two obviously
 * disposable resources behind rather than touching anything of yours.
 */

import { Euclid, EuclidAuthenticationError, EuclidServiceError } from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/secrets-walkthrough.mjs <url> <username> <password>");
  process.exit(2);
}

let session;
try {
  session = await Euclid.forServer(baseUrl)
    .access()
    .credentials(username, password)
    // A development server's certificate is usually its own; drop this line, or point caCertPath() at the
    // real CA, anywhere it matters.
    .verify(false)
    .login();
} catch (error) {
  if (error instanceof EuclidAuthenticationError) {
    console.error(`login refused: ${error.reason || error.message}`);
    process.exit(1);
  }
  throw error;
}

const ekm = session.ekm();
const ess = session.ess();
const name = `ndk-walkthrough-${Math.floor(Date.now() / 1000)}`;

try {
  const key = await ekm.createKey({ description: `created by ${name}` });
  console.log(`created key ${key.name}  (${key.algorithm}-${key.length}, ${key.status})`);
  console.log("  a secret's value is encrypted under a key like this one before it is stored");

  try {
    await walk(ess, key, name);
  } finally {
    try {
      await ess.deleteSecret(name);
      console.log(`\ndeleted secret ${name}`);
    } catch (error) {
      if (!(error instanceof EuclidServiceError)) throw error;
      console.log(`\ncould not delete the secret: ${error.reason || error.message}`);
    }
    const scheduled = await ekm.deleteKey(key.name);
    console.log(`scheduled key ${key.name} for deletion on ${scheduled.deletionDate}`);
    console.log("  anything still encrypted under it becomes unreadable then");
  }
} finally {
  session.close();
}

/** Everything between creating the secret and removing it. */
async function walk(ess, key, name) {
  // Answers with metadata: the value it was just given does not come back, which is what lets this be logged.
  const stored = await ess.createSecret(name, "hunter2", {
    description: "the reporting database",
    keyErn: key.ern,
  });
  console.log(`\nstored secret ${stored.name}  version ${stored.version}`);
  console.log(`  ern: ${stored.ern}`);
  console.log(`  under key ${stored.encryptionKeyErn}`);

  // The one call that answers with a value, and so the point at which it enters this process.
  const fetched = await ess.getSecret(name);
  console.log(`\nread it back: ${fetched.value.length} character(s), version ${fetched.secret.version}`);

  const rotated = await ess.rotateSecret(name, "hunter3");
  console.log(`\nrotated to version ${rotated.version} at ${rotated.rotated}`);
  console.log(`  the value is now ${(await ess.getSecret(name)).value === "hunter3" ? "the new one" : "unchanged"}`);

  // Only what is named changes - the value and the key it is under stay exactly as they were.
  const described = await ess.updateSecret(name, { description: "the analytics database" });
  console.log(`described as "${described.description}", still version ${described.version}`);

  const tagged = await ess.addSecretTag(name, "purpose", "sdk-walkthrough");
  console.log(`tagged: ${JSON.stringify(tagged.tags)}`);

  const secrets = await ess.listSecrets({ pageSize: 5 });
  console.log(`\n${secrets.total} secret(s); first ${secrets.items.length} - metadata only, never values:`);
  for (const secret of secrets.items) {
    const rotatedAt = secret.rotated ? `rotated ${secret.rotated}` : "never rotated";
    console.log(`  ${secret.name.padEnd(34)} v${String(secret.version).padEnd(3)} ${rotatedAt}`);
    if (secret.description) console.log(`      ${secret.description}`);
  }
}
