# euclid-ndk

Node.js client library for the [euclid](https://github.com/jensvogt/euclid) server.

Nine modules so far. EAM - euclid's access management module - is where a login comes from; ESM
(storage), EQS (queues), ENS (notifications), EKM (keys), EKV (tables), EAP (applications), ESS
(secrets) and EAG (the API gateway) are reached from the session it hands back. The remaining modules
(EES, ETS) speak the same protocol over the same client and will follow.

Requires Node 20 or newer, and **has no dependencies**. Installing this SDK does not bring a TLS
stack, an HTTP client and a JSON parser along with it: the wire protocol is JSON over HTTP and the
signatures are HMAC-SHA256, all of which node's standard library already covers. TypeScript is a
development dependency, not a runtime one - what npm ships is JavaScript with its declarations
beside it.

## Installation

```bash
npm install euclid-ndk
```

ESM only, with types: `import { Euclid } from "euclid-ndk"`. A CommonJS application can reach it
with `await import("euclid-ndk")`.

## Usage

Log in once and reuse the session:

```ts
import { Euclid } from "euclid-ndk";

const session = await Euclid.forServer("https://euclid.example.com").login("jens", "secret");

const users = await session.listUsers({ prefix: "j", pageSize: 25 });
for (const user of users.items) console.log(user.userId, user.email);

session.close();
```

The builder form takes the same options one at a time, which reads better when there are several:

```ts
import { Euclid, RFC9421 } from "euclid-ndk";

const session = await Euclid.forServer("https://euclid.example.com")
  .access()
  .credentials("jens", "secret")
  .namespace("development")
  .signingScheme(RFC9421)
  .caCertPath("/etc/euclid/euclid_cert.crt")
  .login();
```

A session holds a connection, so close it when you are done:

```ts
try {
  await session.createAccount("111", "acme", "an account");
} finally {
  session.close();
}
```

Every listing answers with a page - `total` is how many exist, `items` is the page:

```ts
const { total, items } = await session.listAccounts({ pageSize: 5 });
```

The other modules hang off that session - `session.esm()`, `session.eqs()`, `session.ens()`,
`session.ekm()`, `session.ekv()`, `session.eap()`, `session.ess()`, `session.eag()` - and each answers
with the same client every time, so asking for one inside a loop costs one connection rather than one
per iteration:

```ts
const esm = session.esm();
const bucket = await esm.createBucket("reports");
await esm.uploadFile(bucket.ern, "2026/q3.pdf", "q3.pdf");
```

### The credentials cache

`login()` writes `~/.euclid/credentials` and reads it back on the next call, so logging in twice
costs one round trip. It is the same file `euclid-cli`, `euclid-jdk` and `euclid-pdk` use, with the
same field names, so a login from any of the four is picked up by the others.
`EUCLID_CREDENTIALS_FILE` overrides the path, which is also how euclid hands a managed application
its own credentials.

Pass `useCache(false)` to force a fresh login and leave the file alone.

### Signing

A login returns two credentials: a bearer token, and - when the user has one - an access key and
secret. By default a session signs with the access key when it has one and presents the token
otherwise, which is what `AUTH_AUTO` means. euclid accepts either for every action.

```ts
import { AUTH_BEARER } from "euclid-ndk";

const session = await Euclid.forServer(url).login("jens", "secret", { auth: AUTH_BEARER });
```

Two signing schemes are implemented, both keyed by the same access key and secret:

| Scheme | Where the signature travels | Notes |
| --- | --- | --- |
| `SIGV4` | `Authorization`, plus `x-amz-date` and `x-amz-content-sha256` | The default, and what euclid has understood from the start |
| `RFC9421` | `Signature` and `Signature-Input`, plus `Content-Digest` | [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) HTTP Message Signatures, the standard scheme meant to replace it |

Both cover a **fixed** set of headers rather than a set the request declares: the method, path and
authority, the body digest, and the `x-euclid-account-id`, `x-euclid-action`, `x-euclid-region`,
`x-euclid-target` and `x-euclid-user-id` headers that carry what the request is asking for and on
whose behalf. euclid's server compares that list against its own for exact equality, so a signature
covering more, fewer, or the same components in another order is rejected. `x-euclid-namespace` is
*not* covered - a real gap rather than a simplification, and one that has to be closed on both sides
at once.

Verification is implemented too, not just signing, and is what the test suite's fake gateway uses:

```ts
import { SignableRequest, signingSchemeOf } from "euclid-ndk";

const request = new SignableRequest("POST", "/")
  .headersFrom(incomingHeaders)
  .setBody(incomingBody)
  .setScheme("https");

const scheme = signingSchemeOf(request);
const keyId = scheme?.verify(request, lookupSecret) ?? null;
```

### TLS

`https://` URLs are verified against the system trust store. A euclid deployment usually presents
its own certificate, so `/etc/euclid/euclid_cert.crt` is trusted *alongside* the system store when
that file exists - the same default `euclid-cli --ca-cert` uses. Node replaces the trust store when
it is given a CA, so the union is spelled out here rather than assumed. Point `caCertPath` elsewhere,
or pass `verify(false)` for a development server whose certificate nothing vouches for.

### Errors

| Error | Thrown when |
| --- | --- |
| `EuclidAuthenticationError` | a login was refused |
| `EuclidServiceError` | a module refused or failed an action; carries `target`, `action`, `status` and `reason` |
| `EuclidError` | base class for both |

`reason` is the server's own message, pulled out of the `{"error": "..."}` body every euclid module
answers failures with.

### Retries

Two, both narrow on purpose:

* A request that failed because the connection was closed while it sat idle is sent again once, on a
  fresh connection. Only failures that produced no response at all qualify.
* A 401 whose body says the credentials had expired is sent again once with rebuilt headers, if
  rebuilding them produces something different. A wrong password or a missing permission is answered
  once, as before.

For a process that outlives its token, set `session.tokenProvider` to something that re-reads the
credentials file; the retry then has a fresh token to use.

## What EAM covers

| Method | Action |
| --- | --- |
| `listUsers`, `register`, `deleteUser` | users |
| `createAccessKey`, `listAccessKeys`, `deleteAccessKey` | the caller's own signing credentials |
| `createUserGroup`, `listUserGroups`, `deleteUserGroup`, `addUserToUserGroup`, `removeUserFromUserGroup` | groups |
| `createAccount`, `listAccounts`, `deleteAccount` | accounts |
| `createNamespace`, `listNamespaces`, `deleteNamespace`, `grantNamespaceAccess`, `revokeNamespaceAccess` | namespaces |
| `changeNamespace` | which namespace this session is scoped to |
| `metrics` | EAM's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

Several of these are administrator-only server-side; `session.isAdmin` says whether the logged-in
user is one, though the server enforces it regardless.

## What ESM covers

`session.esm()` answers with the storage client, and with the same one every time - a connection per
module rather than per call. It follows the session it came from: a `changeNamespace` between two
calls scopes the second one.

| Method | Action |
| --- | --- |
| `createBucket`, `listBuckets`, `getBucketErn`, `getBucketSize`, `renameBucket`, `purgeBucket`, `deleteBucket` | buckets |
| `addBucketTag`, `setBucketTag`, `deleteBucketTag` | bucket tags |
| `enableEncryption`, `disableEncryption` | encryption at rest, under an EKM key |
| `setBucketInternal` | whether a bucket is euclid's own plumbing, and so left out of a listing |
| `listObjects`, `getObjectCount`, `copyObject`, `moveObject`, `renameObject`, `deleteObject`, `deleteObjects` | objects |
| `touchObject` | re-announce objects already stored, for a listener that missed their events |
| `addObjectAttribute`, `setObjectAttribute`, `listObjectAttributes`, `deleteObjectAttribute` | user-defined attributes |
| `subscribe`, `listSubscriptions`, `unsubscribe`, `parseBucketEvent` | a bucket's events, into a queue or a topic |
| `putObject`, `getObject`, `uploadFile`, `downloadFile` | the object's bytes themselves |
| `metrics` | ESM's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

Buckets and objects are named by ERN, not by name - `createBucket` answers with the one everything
else takes, and `getBucketErn` is how an existing bucket's is looked up.

### Writing and reading bytes

`putObject` and `getObject` are one request each; `uploadFile` and `downloadFile` are the multipart
path, and are what a file of any size wants:

```ts
await esm.uploadFile(bucket.ern, "data/large.bin", "large.bin", { partSize: 5 * 1024 * 1024, concurrency: 4 });
const written = await esm.downloadFile(bucket.ern, "data/large.bin", "copy.bin");
```

The file is read a part at a time and no more than `concurrency` parts are ever in flight, so what an
upload costs in memory is bounded by the two together whatever the file's size. A download does not
know its size before asking, so one request is tried first and the server answering HTTP 413 is what
says the object needs the parts - a caller does not have to know which of the two an object needs.

Each step of a transfer is retried up to four times on a 5xx or a request that got no answer at all,
including the `create-upload` and `complete-upload` bracketing the parts: those run once per transfer
rather than once per part, but giving up on a transient failure in one of them discards the whole
file. A 4xx is answered once, since a repeat would be answered identically.

These four actions - `put-object`, `get-object`, `upload-part`, `download-part` - carry the object's
bytes as the request body, with the bucket, key and part number riding as headers, which is what
keeps a 5 MiB part 5 MiB on the wire rather than a third larger as base64 inside JSON. They also
present the session's bearer token rather than a signature, which is what euclid-cli, euclid-jdk and
euclid-pdk do for the same four, so every client writes objects the same way. A session that asked
for `AUTH_SIGNATURE` signs them anyway: it asked not to be handed a token silently.

### Attributes

An object carries two attribute maps, and they are not the same one. `attributes` are the caller's
own, listed back by `listObjectAttributes` and meaningless to euclid; `systemAttributes` are euclid's
envelope, which travels with the object across every hop. The one euclid acts on is `priority`.

```ts
import { PRIORITY_LOW } from "euclid-ndk";

await esm.putObject(bucket.ern, "notes/hello.txt", Buffer.from("hello\n"), {
  attributes: { author: "euclid-ndk", revision: 1 },
  systemAttributes: { priority: PRIORITY_LOW },
});
```

Values are typed on the wire: a plain value is tagged with the type euclid stores it under - a whole
number as `long`, anything else numeric as `double`, a `Uint8Array` as `binary` and base64 encoded -
and `{ type: "int", value: 3 }` is how a caller asks for a tag other than the obvious one. `binary`
comes back as a `Buffer`, so the encoding never reaches the caller.

Attributes belong on the write rather than added afterwards: completing an upload is finished off in
the background from what that call carried, so an attribute added between the two is overwritten.

### Subscriptions

A subscription announces a bucket's object events to a queue or a topic, filtered by the server as it
publishes. What lands there is an ordinary message whose body is the event:

```ts
import { OBJECT_CREATED, QUEUE, parseBucketEvent } from "euclid-ndk";

await esm.subscribe(bucket.ern, QUEUE, queueErn, { eventTypes: [OBJECT_CREATED], prefix: "2026/" });
const event = parseBucketEvent(message.body);
```

`unsubscribe` takes the subscription's own ERN - not the bucket's, and not the target's. Subscribing
is not idempotent: a second call delivers every matching event twice, so a caller that may run twice
checks `listSubscriptions` first.

## What EQS covers

`session.eqs()` answers with the queue client.

| Method | Action |
| --- | --- |
| `createQueue`, `listQueues`, `getQueueErn`, `getQueueMetadata`, `purgeQueue`, `purgeAllQueues`, `deleteQueue` | queues |
| `addQueueTag`, `setQueueTag`, `deleteQueueTag` | queue tags |
| `stopQueue`, `startQueue`, `setQueueVisibility` | what a queue hands out, and for how long |
| `sendMessage`, `receiveMessages`, `receiveAllMessages`, `deleteMessage`, `deleteMessageById` | messages |
| `listMessages`, `getMessageCount`, `getMessageMetadata` | inspecting a queue without consuming it |
| `getMessageAttribute`, `setMessageAttribute`, `setMessageVisibility` | one message at a time |
| `redriveDlq` | moving a dead letter queue's messages back where they came from |
| `asInternal`, `metrics` | euclid's own traffic, and EQS's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

Receiving is a lease rather than a read. A message a consumer takes is invisible to every other
consumer until its visibility timeout expires, and deleting it with the receipt handle is what says the
work was done - so the delete belongs after the work, not before it:

```ts
const eqs = session.eqs();
const queue = await eqs.createQueue("orders", { visibility: 30, maxRetries: 5, dlqName: "orders-dlq" });

await eqs.sendMessage(queue.ern, JSON.stringify({ order: 17 }), { attributes: { tenant: "acme" } });

for (const message of (await eqs.receiveMessages(queue.ern, { waitTimeSeconds: 20 })).items) {
  await handle(message.body);
  await eqs.deleteMessage(message.receiptHandle);
}
```

A consumer that dies instead simply stops holding the lease and the message comes back; after
`maxRetries` deliveries it goes to the dead letter queue, where `getMessageMetadata` explains why.

`waitTimeSeconds` is a long poll, and the waiting is the server's: it holds the request open until a
message lands or the window runs out, so an idle queue costs one request for the whole window rather
than one per tick, and the request gets a timeout of its own rather than the session's. Two details are
the client's:

* With no wait asked for, the queue's depth is checked first - a receive is a write, and one that takes
  nothing is work the server did for nothing.
* The server keeps a bounded number of long-poll slots so that waiting consumers cannot starve the
  producers sending to them. With none free it answers at once, which comes back empty with time still
  on the clock; the client then pauses briefly and asks again for what is left of the window, rather
  than hammering a server that is already short of threads.

`asInternal()` marks a client's requests as euclid's own traffic. The same `get-message-count` is a
user's question one moment and a metric collector's poll the next, and only the caller knows which, so
instrumentation says so rather than leaving the server to guess from a rate.

## What ENS covers

`session.ens()` answers with the notification client.

| Method | Action |
| --- | --- |
| `createTopic`, `listTopics`, `getTopicErn`, `getTopicMetadata`, `purgeTopic`, `purgeAllTopics`, `deleteTopic` | topics |
| `addTopicTag`, `setTopicTag`, `deleteTopicTag` | topic tags |
| `publishMessage`, `listMessages`, `getMessageCount` | messages |
| `getMessageAttribute`, `setMessageAttribute` | one published message at a time |
| `subscribe`, `listSubscriptions`, `unsubscribe` | delivery onward to a queue |
| `metrics` | ENS's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

What a topic does with a message is the whole difference from a queue: a queue holds one until a
consumer takes it, a topic hands each one to every subscriber and keeps it as a record of having done
so. There is no receive here and no receipt handle - a subscriber consumes from its own queue:

```ts
await ens.subscribe(topic.ern, await eqs.getQueueErn("orders"));
await ens.publishMessage(topic.ern, JSON.stringify({ order: 17 }), { priority: PRIORITY_HIGH });
```

Each subscriber consumes independently, so one that is slow or stopped delays nobody else. A message
published before a subscription existed is not delivered retrospectively, and one already delivered is
not withdrawn when the subscription goes. Subscribing is not idempotent, as in ESM.

A topic's counters are not a queue's: `available`, `send` and `resend` count delivery rather than a
backlog, since a topic does not hold one.

One wire asymmetry is reproduced rather than papered over: an attribute's name travels as `name` in
most of EQS and as `key` throughout ENS, so a request this SDK builds matches what euclid-cli and
euclid-jdk send.

## What EKM covers

`session.ekm()` answers with the key client.

| Method | Action |
| --- | --- |
| `createKey`, `listKeys`, `setKeyDescription`, `addKeyTag`, `deleteKeyTag` | keys |
| `revokeKey`, `deleteKey` | taking a key out of use, and out of existence |
| `encrypt`, `decrypt` | using one |
| `importCertificate`, `createCertificate`, `getCertificate`, `listCertificates`, `deleteCertificate` | the certificates a deployment serves |
| `metrics` | EKM's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

Key material never leaves the server: the bytes go to the key rather than the key coming to the bytes.

```ts
const ekm = session.ekm();
const key = await ekm.createKey({ description: "customer exports" });

const sealed = await ekm.encrypt(key.name, "account 4711");     // IV || ciphertext || tag
const plain = await ekm.decrypt(key.name, sealed);
```

A key is named two ways and they are not interchangeable: `name` is the ID the server minted, and is what
encrypts, decrypts and is deleted; the ERN is what revokes, describes and tags. Both are on every key a
listing returns, and nothing a listing returns is material.

Revoking and deleting are different in the way that matters. A revoked key encrypts nothing further and
still decrypts what it wrote; `deleteKey` schedules a date - seven days out by default - after which
everything it encrypted is unreadable. That window is the only chance anybody gets to notice, which is
why it is a date rather than an act, and a key inside it still decrypts.

`encrypt` and `decrypt` carry raw bytes and present the session's bearer token, exactly as ESM's transfer
actions do, and for the same reasons - including that a session which asked for `AUTH_SIGNATURE` signs
them anyway. A `description` is worth supplying at creation: a key outlives the reason it was made, and
months later it is the only thing that answers whether the key can be deleted.

## What EKV covers

`session.ekv()` answers with the key-value store.

| Method | Action |
| --- | --- |
| `createTable`, `describeTable`, `listTables`, `deleteTable` | tables |
| `putItem`, `getItem`, `findItem`, `deleteItem` | one item at a time |
| `query` | the items of one partition, in sort-key order |
| `scan` | a table's items without regard to their key |
| `metrics` | EKV's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

A table is keyed on one attribute or on two: a partition key that identifies an item, and optionally a sort
key that orders the items sharing a partition key - which is what makes a partition readable as a range.

```ts
import { KEY_NUMBER, SORT_GE } from "euclid-ndk";

const ekv = session.ekv();
await ekv.createTable("sessions", "userId", { sortKey: "startedAt", sortKeyType: KEY_NUMBER });

await ekv.putItem("sessions", { userId: "jens", startedAt: 1757462400, host: "laptop" });
const recent = await ekv.query("sessions", "jens", { sortOperator: SORT_GE, sortValue: 1757462400 });
for (const item of recent.items) console.log(item.attributes.host);
```

The key types are what make a range mean what it should: a `KEY_NUMBER` sort key orders 2, 9, 10, 100 rather
than putting "10" before "9". They cannot be changed after the table is created. Everything else about an
item is a free-form document - scalars, arrays, nested objects - and is *not* the typed `Variant` that EQS,
ENS and ESM attributes use: EKV stores what JSON can express.

`putItem` replaces rather than merges, so changing one field means reading the item, changing it and writing
the whole thing back. That is why `Item` keeps the server's `_created` and `_modified` out of `attributes`:
left in, they would be written back as two attributes of the caller's own, and they would stick.

`getItem` throws on a miss, because "there is no such item" and "here is an item with nothing in it" are
different answers and a caller should not have to tell them apart; `findItem` is the same read answering
`null` instead, and only for a 404. `query` is the lookup EKV is for - it addresses a partition by key -
while `scan` reads the table, which is right for an export and wrong for a lookup.

## What EAP covers

`session.eap()` answers with the application client. Every action is administrator-only server-side;
`session.isAdmin` says whether the logged-in user is one.

| Method | Action |
| --- | --- |
| `createApplication`, `updateApplication`, `redeployApplication`, `deleteApplication` | deploying |
| `startApplication`, `stopApplication`, `listApplications`, `getApplication` | running |
| `setLogLevel`, `resetLogLevel` | what one application logs, without restarting it |
| `metrics` | EAP's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

An application is deployed from an artifact already in a bucket - ESM puts it there, EAP names it:

```ts
import { RUNTIME_JAVA } from "euclid-ndk";

await esm.uploadFile(bucketErn, "order-service-1.4.0.jar", "target/order-service.jar");
await eap.createApplication("order-service", RUNTIME_JAVA, "artifacts", "order-service-1.4.0.jar", {
  queues: ["orders"],
  minInstances: 2,
  maxInstances: 5,
});
await eap.startApplication("order-service");
```

The deployment says which buckets and queues the application may reach, and euclid grants those to the
identity it runs as: a technical principal it creates unless one is named, with no password, no login and
one access key, so that nothing an application leaks is a person's credential.

Starting asks rather than waits. `desiredState` is what somebody asked for and `state` is what is
actually answering, so a freshly started application usually comes back `RUNNING`/`STOPPED` - the two
differing is an application starting up, and the two differing for long is one that cannot.

`updateApplication` sends only the fields it is given, because that is the distinction the server draws,
as in ESS and EAG below:
leaving `command` out keeps the stored command, while passing `""` clears it and hands the artifact back
to the runtime's own interpreter. `buckets` and `queues` are re-resolved together whenever either is
named - so pass both or neither, since naming one revokes what the other granted. For a new build of the
same application, `redeployApplication` is the call; one that would change neither the version nor the
checksum is refused, which usually means the new artifact never reached the bucket.

## What ESS covers

`session.ess()` answers with the secret store.

| Method | Action |
| --- | --- |
| `createSecret`, `getSecret`, `listSecrets`, `deleteSecret` | secrets |
| `rotateSecret`, `updateSecret` | replacing a value, a description, or the key it is under |
| `addSecretTag`, `deleteSecretTag` | tags |
| `metrics` | ESS's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

A value is encrypted with EKM before it is stored, so a secret's life is tied to a key's: deleting that key
there is what makes the value unrecoverable, whatever ESS still says about it.

```ts
const ess = session.ess();
await ess.createSecret("db-password", "hunter2", { description: "the reporting database" });

const password = (await ess.getSecret("db-password")).value;
```

`getSecret` is the only call that answers with a value, and so the only point at which one enters the
process - everything else answers with metadata alone, so a listing, a rotation and a tag change can be
logged and printed without being the thing that leaks it. `rotateSecret` is `updateSecret` with a value:
what bumps `version` and sets `rotated`, which together are what an audit of "has this been rotated since
the incident" actually reads.

`updateSecret` sends only what it names, with the same empty-string rule as EAP: leaving `description` out
keeps the stored one, `""` clears it, and an empty `value` stores an empty value because that is a value
somebody may legitimately have. Naming a `keyErn` re-encrypts the value under that key, which is how a
secret is moved off a key that is being retired.

## What EAG covers

`session.eag()` answers with the API gateway client. Every action is administrator-only server-side.

| Method | Action |
| --- | --- |
| `createRoute`, `createModuleRoute`, `updateRoute`, `getRoute`, `listRoutes`, `deleteRoute` | published paths |
| `setRouteActive` | taking one out of service, and putting it back |
| `listListeners` | the ports the gateway answers on, and whether it is answering |
| `metrics` | EAG's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

A route publishes a path prefix and says where everything beneath it goes: to an application euclid runs,
or to one action of a euclid module. It is one or the other - never both, never neither - and this client
refuses the other two before the round trip:

```ts
import { ROUTE_AUTH_EUCLID } from "euclid-ndk";

await eag.createRoute("orders", "/api/orders", {
  applicationId: "order-service",
  methods: ["GET", "POST"],          // none means every method
  authentication: ROUTE_AUTH_EUCLID, // or ROUTE_AUTH_NONE, or ROUTE_AUTH_BASIC
});
await eag.createModuleRoute("login", "/euclid/login", "eam", "login");
```

Module routes are the way in for something outside euclid that needs euclid itself - a browser that has to
log in before it can call anything. Without one, a front end would talk to the API gateway for the
application and to euclid's own gateway for its credentials: two ports, two origins, and CORS between them.

`namespace` and `region` are left out of the request entirely unless named, because this server reads an
empty namespace as *the empty namespace* rather than as "unspecified" - sending one would scope the route
to nothing. `setRouteActive` is how something stops being exposed in a hurry: the route stays exactly as it
was and comes back the same, which deleting and recreating it would not guarantee.

`listListeners` answers with a page of listeners plus `serving`, which says whether the gateway's ports are
bound at all. A listener whose port was taken, or whose certificate could not be loaded, is still listed -
it is the one somebody is looking for. An HTTPS listener's certificate arrives flat, as a dozen
`certificate*` fields, and is gathered back into one `certificate` object here; it is `null` for a plain
HTTP listener and for an HTTPS one the server found none for.

## Development

```bash
npm install
npm test          # compiles src and test into build/, then runs node --test
npm run build     # compiles src into dist/ with its .d.ts, which is what npm publishes
```

The suite runs against a fake euclid gateway (`test/fake-gateway.ts`) that authenticates requests
with the same rules `Core::HttpActionServer::Authenticate` applies, so a client that signs one thing
and sends another fails there rather than in production. The SigV4 canonicalisation is additionally
pinned by AWS's own published test vectors, which is what makes this SDK, euclid's C++, euclid-jdk
and euclid-pdk agree rather than merely each agree with itself.

Behind that gateway sit two stand-ins that implement rather than stub the parts a client can get
wrong. `test/fake-storage.ts` assembles what it is sent: an upload's parts are joined in part order and
a download hands back the byte range asked for, so a client that numbers its parts wrongly, sizes them
inconsistently or reassembles them out of order fails there rather than by writing a corrupt object to
a real server. `test/fake-queues.ts` really leases messages out and either honours a long poll or
declines it, which is what makes "took a message twice" and "abandoned a poll the server was still
serving" visible to a test at all.

Tests are compiled rather than run through a loader or node's type stripping, so `npm test` behaves
the same on every supported node.

### Releasing

Bump `version` in `package.json` and `VERSION` in `src/index.ts` - they have to agree, and
`.github/workflows/publish.yml` refuses to publish if they and the tag do not - then tag and push:

```bash
git tag -a v0.2.0 -m "euclid-ndk 0.2.0"
git push origin main v0.2.0
```

The tag runs the tests again (the test workflow triggers on branches, so a tag push would otherwise
run nothing), builds `dist`, packs the tarball and publishes it to npm with a provenance
attestation - a signed statement of which workflow, at which commit, built what was published.
`workflow_dispatch` does the same for whatever `main` says, which is what a version whose tag
predates this workflow needs.

Publishing authenticates with an `NPM_TOKEN` secret. Once the package exists on npm, configuring a
trusted publisher for this repository and `publish.yml` replaces it: npm then mints a short-lived
token from the workflow's own OIDC identity, and the secret can be deleted.

## Licence

Apache License 2.0.
