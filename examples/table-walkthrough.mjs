#!/usr/bin/env node
/**
 * EKV: a table, the items in it, and the difference between a query and a scan.
 *
 *   npm run build
 *   node examples/table-walkthrough.mjs https://euclid.example.com:5566 admin admin
 *
 * Works in a table of its own, named after the moment it started, and deletes it again at the end - so it is
 * safe to point at a running server, and a run that dies halfway leaves one obviously disposable table behind
 * rather than touching anything of yours.
 */

import {
  Euclid,
  EuclidAuthenticationError,
  EuclidServiceError,
  KEY_NUMBER,
  SORT_BEGINS_WITH,
  SORT_BETWEEN,
  SORT_GE,
} from "../dist/index.js";

const [, , baseUrl, username, password] = process.argv;
if (!baseUrl || !username || !password) {
  console.log("usage: node examples/table-walkthrough.mjs <url> <username> <password>");
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

const ekv = session.ekv();
const name = `ndk-walkthrough-${Math.floor(Date.now() / 1000)}`;

try {
  // Two keys: the partition key identifies a session's owner, the sort key orders that owner's sessions in
  // time - which is what makes the partition readable as a range.
  const table = await ekv.createTable(name, "userId", { sortKey: "startedAt", sortKeyType: KEY_NUMBER });
  console.log(`created table ${table.name}`);
  console.log(`  ern: ${table.ern}`);
  console.log(
    `  keyed on ${table.partitionKey} (${table.partitionKeyType}) + ${table.sortKey} (${table.sortKeyType})`,
  );

  try {
    await walk(ekv, name);
  } finally {
    console.log(`\ndeleted table ${name} and the ${await ekv.deleteTable(name)} item(s) in it`);
  }
} finally {
  session.close();
}

/** Everything between creating the table and deleting it. */
async function walk(ekv, table) {
  const started = Math.floor(Date.now() / 1000);
  for (const [offset, host] of ["laptop", "desktop", "phone", "tablet"].entries()) {
    await ekv.putItem(table, {
      userId: "jens",
      startedAt: started + offset,
      host,
      tags: ["walkthrough"],
      meta: { agent: "euclid-ndk" },
    });
  }
  await ekv.putItem(table, { userId: "alice", startedAt: started, host: "workstation" });
  console.log(`\nwrote 5 items into ${table}`);

  // Scalars, arrays and nested objects, stored as themselves - EKV holds documents rather than the typed
  // attribute maps a queue message carries.
  const item = await ekv.getItem(table, { userId: "jens", startedAt: started });
  console.log(`\nread one item by key: ${JSON.stringify(item.attributes)}`);
  console.log(
    `  written ${item.created}, last changed ${item.modified} - kept out of the attributes, so writing ` +
      "this item back does not add them to it",
  );

  // The ordinary way to change one field: read, change, write the whole thing back. putItem replaces rather
  // than merges, so anything left out here would be gone.
  await ekv.putItem(table, { ...item.attributes, host: "laptop-2" });
  const changed = await ekv.getItem(table, { userId: "jens", startedAt: started });
  console.log(`  changed one field: ${changed.attributes.host}`);

  const missing = await ekv.findItem(table, { userId: "nobody", startedAt: 0 });
  console.log(`\nfindItem on a key that names nothing: ${missing}  (getItem would throw - a miss and an empty item are different)`);

  const hosts = (result) => JSON.stringify(result.items.map((entry) => entry.attributes.host));

  console.log(`\nquery, whole partition: ${hosts(await ekv.query(table, "jens"))}`);
  console.log(
    `query, sort key >= ${started + 2}: ` +
      hosts(await ekv.query(table, "jens", { sortOperator: SORT_GE, sortValue: started + 2 })),
  );
  console.log(
    `query, between ${started} and ${started + 1}: ` +
      hosts(
        await ekv.query(table, "jens", { sortOperator: SORT_BETWEEN, sortValue: started, sortUpper: started + 1 }),
      ),
  );
  console.log(`query, newest first, one item: ${hosts(await ekv.query(table, "jens", { forward: false, pageSize: 1 }))}`);

  // begins-with is the one operator that is not a comparison, so it needs a string sort key - this table's is
  // a number, and the server says so rather than answering with nonsense.
  try {
    await ekv.query(table, "jens", { sortOperator: SORT_BEGINS_WITH, sortValue: "2026-" });
  } catch (error) {
    if (!(error instanceof EuclidServiceError)) throw error;
    console.log(`query, begins-with on a number sort key: refused - ${error.reason || error.message}`);
  }

  const scanned = await ekv.scan(table, { pageSize: 3 });
  const pairs = scanned.items.map((entry) => [entry.attributes.userId, entry.attributes.host]);
  console.log(`\nscan, first ${scanned.items.length} of ${scanned.total}: ${JSON.stringify(pairs)}`);
  console.log("  a scan reads the table rather than a partition: fine for an export, wrong for a lookup");

  const described = await ekv.getTable(table);
  console.log(`\n${described.name} holds ${described.itemCount} item(s)`);

  const tables = await ekv.listTables({ pageSize: 5 });
  console.log(`${tables.total} table(s) in this namespace; first ${tables.items.length}:`);
  for (const listed of tables.items) {
    const sortKey = listed.sortKey ? ` + ${listed.sortKey}` : "";
    console.log(`  ${listed.name.padEnd(32)} ${(listed.partitionKey + sortKey).padEnd(24)} ${String(listed.itemCount).padStart(6)} item(s)`);
  }
}
