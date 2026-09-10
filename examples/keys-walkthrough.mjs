#!/usr/bin/env node
/**
 * EKM: a key, the bytes it seals, and the certificates a deployment serves.
 *
 *   npm run build
 *   node examples/keys-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Creates one key of its own, round-trips some bytes through it, and schedules it for deletion again at
 * the end - so it is safe to point at a running server, and a run that dies halfway leaves one obviously
 * disposable key behind rather than touching anything of yours. The certificates are only read.
 */

import { Euclid, EuclidAuthenticationError, EuclidServiceError } from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/keys-walkthrough.mjs <url> <username> <password>");
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
const name = `ndk-walkthrough-${Math.floor(Date.now() / 1000)}`;

try {
  const key = await ekm.createKey({ description: `created by ${name}` });
  console.log(`created key ${key.name}  (${key.algorithm}-${key.length}, ${key.status})`);
  console.log(`  ern: ${key.ern}`);
  console.log("  the name is what encrypts and decrypts; the ERN is what revokes, describes and tags");

  try {
    await walk(ekm, key);
  } finally {
    const scheduled = await ekm.deleteKey(key.name);
    console.log(`\nscheduled key ${key.name} for deletion on ${scheduled.deletionDate}`);
    console.log("  everything it encrypted becomes unreadable then - which is why it is a date rather than an act");
  }
} finally {
  session.close();
}

/** Everything between creating the key and scheduling its deletion. */
async function walk(ekm, key) {
  const plaintext = "account 4711";

  // The bytes go to the key rather than the key coming to the bytes: material never leaves the server.
  const sealed = await ekm.encrypt(key.name, plaintext);
  console.log(`\nencrypted ${plaintext.length} byte(s) into ${sealed.length}  (IV || ciphertext || tag)`);
  console.log(`  ${sealed.subarray(0, 16).toString("hex")}...`);

  const recovered = await ekm.decrypt(key.name, sealed);
  console.log(`decrypted back to "${recovered.toString("utf8")}"  identical=${recovered.toString("utf8") === plaintext}`);

  await ekm.addKeyTag(key.ern, "purpose", "sdk-walkthrough");
  const described = await ekm.setKeyDescription(key.ern, `${key.description} (described afterwards)`);
  console.log(`\ndescribed as "${described.description}" - only the description changed, not the key's life`);

  const keys = await ekm.listKeys({ pageSize: 5 });
  console.log(`\n${keys.total} key(s); first ${keys.items.length}:`);
  for (const entry of keys.items) {
    const deletion = entry.deletionDate ? `, goes ${entry.deletionDate}` : "";
    console.log(`  ${entry.name.padEnd(40)} ${entry.algorithm}-${entry.length} ${entry.status}${deletion}`);
    if (entry.description) console.log(`      ${entry.description}`);
  }

  try {
    const certificates = await ekm.listCertificates({ pageSize: 5 });
    console.log(`\n${certificates.total} certificate(s):`);
    for (const certificate of certificates.items) {
      const vouched = certificate.generated ? "self-signed by euclid" : "issued elsewhere";
      console.log(`  ${certificate.name.padEnd(20)} ${certificate.subject}  (${vouched})`);
      console.log(`      valid ${certificate.notBefore} to ${certificate.notAfter}, fingerprint ${certificate.fingerprint}`);
      // The PEM comes back; the private key never does.
      console.log(`      also valid for ${JSON.stringify(certificate.subjectAltNames)}`);
    }
  } catch (error) {
    if (!(error instanceof EuclidServiceError)) throw error;
    console.log(`\ncertificates: unavailable (${error.reason || error.message})`);
  }
}
