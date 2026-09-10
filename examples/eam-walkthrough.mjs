#!/usr/bin/env node
/**
 * Everything EAM does, in the order you would do it.
 *
 *   npm run build
 *   node examples/eam-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Read-only apart from the access key it creates and deletes again, so it is safe to point at a
 * running server. The administrator-only calls at the end are skipped when the login says the user
 * is not one - the server would refuse them anyway, but saying so here is more useful than a 403.
 */

import { Euclid, EuclidAuthenticationError, EuclidServiceError, SIGV4 } from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/eam-walkthrough.mjs <url> <username> <password>");
  process.exit(2);
}

let session;
try {
  // Reuses ~/.euclid/credentials when a valid session is already cached for this server, so running
  // this twice in a row costs one login rather than two.
  session = await Euclid.forServer(baseUrl)
    .access()
    .credentials(username, password)
    // A development server's certificate is usually its own; drop this line, or point caCertPath()
    // at the real CA, anywhere it matters.
    .verify(false)
    .signingScheme(SIGV4)
    .login();
} catch (error) {
  if (error instanceof EuclidAuthenticationError) {
    console.error(`login refused: ${error.reason || error.message}`);
    process.exit(1);
  }
  throw error;
}

try {
  console.log(`logged in as ${session.userId} in ${session.accountId}/${session.region}, admin=${session.isAdmin}`);
  console.log(
    `signing as ${session.accessKeyId || "(no access key - using the bearer token)"} over ${session.authority}`,
  );

  const users = await session.listUsers({ pageSize: 5 });
  console.log(`\n${users.total} user(s); first ${users.items.length}:`);
  for (const user of users.items) {
    const namespaces = user.accountGrants.flatMap((grant) => grant.namespaces);
    console.log(`  ${user.userId.padEnd(16)} ${user.email.padEnd(28)} namespaces=${JSON.stringify(namespaces)}`);
  }

  // The secret comes back here and nowhere else, so anything that needs it has to keep it.
  const created = await session.createAccessKey();
  console.log(`\ncreated access key ${created.accessKeyId}`);
  const keys = await session.listAccessKeys();
  console.log(`  this user now has: ${JSON.stringify(keys.map((key) => key.accessKeyId))}`);
  await session.deleteAccessKey(created.accessKeyId);
  console.log(`  deleted ${created.accessKeyId} again`);

  if (!session.isAdmin) {
    console.log("\nnot an administrator - skipping the account and namespace listings");
  } else {
    const accounts = await session.listAccounts({ pageSize: 5 });
    console.log(`\n${accounts.total} account(s):`);
    for (const account of accounts.items) {
      console.log(`  ${account.accountId.padEnd(16)} ${account.name}`);
      try {
        const namespaces = await session.listNamespaces(account.accountId, { pageSize: 5 });
        console.log(`      namespaces: ${JSON.stringify(namespaces.items.map((entry) => entry.name))}`);
      } catch (error) {
        if (!(error instanceof EuclidServiceError)) throw error;
        console.log(`      namespaces: unavailable (${error.reason || error.message})`);
      }
    }

    const groups = await session.listUserGroups({ pageSize: 5 });
    console.log(`\n${groups.total} user group(s): ${JSON.stringify(groups.items.map((group) => group.name))}`);
  }
} finally {
  session.close();
}
