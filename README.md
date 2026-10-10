# euclid-ndk

Node.js client library for the [euclid](https://github.com/jensvogt/euclid) server.

Twelve modules so far. EAM - euclid's access management module - is where a login comes from; ESM
(storage), EQS (queues), ENS (notifications), EKM (keys), EKV (tables), EAP (applications), ESS (secrets),
EAG (the API gateway), ETS (FTP and SFTP servers), EMO (monitoring) and EMM (the module manager itself) are
reached from the session it hands back. EES is the one module still to come, and speaks the same protocol
over the same client.

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
`session.ekm()`, `session.ekv()`, `session.eap()`, `session.ess()`, `session.eag()`, `session.ets()`, `session.emo()`,
`session.emm()` - and each answers
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
its own credentials. A file the manager wrote names the server `endpoint` where a file this SDK wrote
names it `baseUrl`; both are read, so a managed application does not end up with a valid token and no
idea where to send it.

Pass `useCache(false)` to force a fresh login and leave the file alone.

### Account and namespace scope

Everything euclid stores belongs to an account and a namespace. The account is the logged-in user's; the
namespace is the session's, and travels as `x-euclid-namespace` on every request - set it with `namespace()`
at login or `changeNamespace` later, and read it back from `session.namespace`. Empty means the account root,
which is a scope like any other rather than "all of them".

That pair is what a **name** is unique within, so a bare name always means "mine, here":

```ts
await session.changeNamespace("development");
const ern = await session.eqs().getQueueErn("orders");   // development's orders queue

await session.changeNamespace("production");
const other = await session.eqs().getQueueErn("orders"); // a different queue, same name
```

The same holds for a bucket name, a topic name, an EKV table name, an EAP application ID and an EAG route ID:
two namespaces can each have one of that name, and neither can reach the other's by naming it. An **ERN**
carries its scope, so anything that takes one is unambiguous whatever the session is scoped to - which is why
most calls here take ERNs and only the `get*Ern` lookups take names.

Listings are scoped the same way. `listTables`, `listApplications` and `listRoutes` show what this session
could then address rather than everything the installation holds; `changeNamespace` is how to look elsewhere.

Two places treat a namespace as a filter rather than as a scope, because the server does:

* `purgeAllQueues` and `purgeAllTopics` take a `namespace`, where **empty means every namespace of the
  account**. Their defaults differ - the queue one purges the account, the topic one the session's namespace -
  and each keeps what it shipped with; `EVERY_NAMESPACE` asks for all of them explicitly.
* `updateApplication({ namespace })` *moves* an application, since the namespace is part of what identifies
  it. See [What EAP covers](#what-eap-covers).

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
| `listUsers`, `getUser`, `register`, `deleteUser` | users |
| `changePassword`, `resetPassword` | your own password, given the current one; or somebody else's, as an administrator |
| `createAccessKey`, `listAccessKeys`, `deleteAccessKey` | the caller's own signing credentials |
| `createUserGroup`, `listUserGroups`, `getUserGroup`, `deleteUserGroup`, `addUserToUserGroup`, `removeUserFromUserGroup` | groups |
| `createAccount`, `listAccounts`, `getAccount`, `deleteAccount` | accounts |
| `createNamespace`, `listNamespaces`, `deleteNamespace` | namespaces |
| `createRole`, `updateRole`, `getRole`, `listRoles`, `deleteRole` | what a role of this account carries |
| `grantRole`, `revokeRole`, `listGrants` | who may do what, and where |
| `checkPermission`, `listPermissions` | why a call was allowed or refused, and what can be granted at all |
| `changeNamespace` | which namespace this session is scoped to |
| `metrics` | EAM's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

Several of these are administrator-only server-side; `session.isAdmin` says whether the logged-in
user is one, though the server enforces it regardless.

### Roles and grants

Access is a role granted to a principal, scoped. A **role** is a named set of permissions belonging to one
account; a **grant** gives that role to a user or a user group, in some namespaces and over some resources.
What a user may do is the union of the grants held by them and by every group they are in.

```ts
import { EVERY_PERMISSION, ROLE_OPERATOR } from "euclid-ndk";

await session.createRole("reporting", ["esm:list-objects", "esm:get-object"], "reads the reports bucket");
const grant = await session.grantRole("reporting", userErn, { namespaces: ["production"] });
// ... and to take it away again:
await session.revokeRole(grant.grantId);
```

A permission is `<module>:<action>` - `esm:put-object` - with `<module>:*` for one module's lot and
`EVERY_PERMISSION` (`*:*`) for everything a role can reach, which is still not installation administration.
`listPermissions` is the vocabulary the server actually answers, and a permission outside it is refused
naming the one it did not know. A role with no permissions is refused here before the round trip.

Seven roles are euclid's own - `ROLE_ACCOUNT_ADMINISTRATOR`, `ROLE_OPERATOR`, `ROLE_READER`,
`ROLE_PUBLISHER`, `ROLE_CONSUMER`, `ROLE_APPLICATION`, `ROLE_TRANSFER` - computed rather than stored, so they
can be granted in any account, stay current as modules gain actions, and cannot be changed or deleted.
`listRoles` leaves them out unless `includeBuiltin` asks, since they are the same everywhere; a role's
`builtin` flag says which kind it is. `updateRole` replaces the permission list rather than adding to it.

A grant is revoked by its own `grantId`, not by the (role, principal) pair: the same role can be granted to
the same principal twice with different scope, and revoking has to say which. Deleting a role while anybody
still holds it is refused - the grants go first.

**This replaced the old namespace grants.** `grantNamespaceAccess` and `revokeNamespaceAccess` are gone from
the server, and with them from this SDK: access to a namespace is now a role granted in it, so one call says
what a principal may do there as well as where. `session.isAdmin` is unchanged - installation administration
is membership of the `administrator` user group rather than a role, because roles are per account and an
installation administrator is by definition not.

## What ESM covers

`session.esm()` answers with the storage client, and with the same one every time - a connection per
module rather than per call. It follows the session it came from: a `changeNamespace` between two
calls scopes the second one.

| Method | Action |
| --- | --- |
| `createBucket`, `listBuckets`, `getBucketErn`, `existsBucket`, `getBucketSize`, `renameBucket`, `purgeBucket`, `deleteBucket` | buckets |
| `addBucketTag`, `setBucketTag`, `deleteBucketTag` | bucket tags |
| `enableEncryption`, `disableEncryption` | encryption at rest, under an EKM key |
| `setBucketInternal` | whether a bucket is euclid's own plumbing, and so left out of a listing |
| `setBucketPriority` | the priority the notifications this bucket sends are given |
| `listObjects`, `copyObject`, `moveObject`, `renameObject`, `deleteObject`, `deleteObjects` | objects |
| `countObjects`, `getObjectCount` | how many there are: counted exactly, or the bucket's stored running total |
| `touchObject` | re-announce objects already stored, for a listener that missed their events |
| `addObjectAttribute`, `setObjectAttribute`, `listObjectAttributes`, `deleteObjectAttribute` | user-defined attributes |
| `subscribe`, `listSubscriptions`, `unsubscribe`, `parseBucketEvent` | a bucket's events, into a queue or a topic |
| `putObject`, `getObject`, `uploadFile`, `downloadFile`, `abortUpload` | the object's bytes themselves |
| `metrics` | ESM's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

Buckets and objects are named by ERN, not by name - `createBucket` answers with the one everything
else takes, and `getBucketErn` is how an existing bucket's is looked up.

`deleteBucket` takes `{ ifEmpty: true }` for "remove it only if nothing is using it" - what an automated
caller means, as against an operator who has decided the contents go too. A bucket holding anything is then
refused with 409 naming the count, directory markers included, since a marker is an object somebody's
transfer client can see. `{ background: true }` is the other half, for a bucket large enough that emptying
it outlasts the request; the two are never combined, because `ifEmpty` has already established there is
nothing to empty. EQS's `deleteQueue({ ifEmpty: true })` is the same idea, and counts events still on their
way into the queue as well - one is about to become a message, and a delete discards it.

`existsBucket` is one of a family - ESM, EQS, ENS, EKM, EKV and ESS each have one, for buckets, queues,
topics, keys, tables and secrets. All six answer three ways rather than two. `true` and `false` are the
expected pair; the third is a thrown `EuclidServiceError`, and it is the one that matters. Only HTTP 404 -
the answer that actually says the thing is absent - becomes `false`. An expired session, an unreachable
gateway or a refused permission throws, because resolving `false` for those would have a caller recreating
something over an outage:

```ts
if (!(await session.esm().existsBucket("reports"))) await session.esm().createBucket("reports");
```

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

The event carries the object's own **attributes** as well as its key and size, which is the whole point of
having put them on the object: whatever uploaded it knows things the bucket cannot express - which supplier
it came from, how urgent it is - and a subscriber that has to read the object to find that out has been told
the wrong thing. `event.attributes` and `event.systemAttributes` are typed variant maps, empty when the
notification carried none. Binary values are left out by the server, since a notification is metadata and
nothing reading one wants a blob inlined into it.

`unsubscribe` takes the subscription's own ERN - not the bucket's, and not the target's. Subscribing
is not idempotent: a second call delivers every matching event twice, so a caller that may run twice
checks `listSubscriptions` first.

`setBucketPriority` is about those messages rather than about the bucket. A bucket is not consumed from
and has no queue of its own, so there is nothing there for a priority to mean - it is handed on to the
notifications a subscription turns an object event into. "Everything that lands here is urgent" is the
statement, and the queue on the far side of the subscription is where it takes effect:

```ts
import { PRIORITY_HIGH } from "euclid-ndk";

await esm.setBucketPriority(bucket.ern, PRIORITY_HIGH);
await esm.setBucketPriority(bucket.ern, "");  // back to letting the queue decide
```

Four statements can be in play about one message, least specific first: the target queue's own default,
the bucket's, the priority in the object's own system attributes, and one a message already carried when
a topic passed it on. The object's beats the bucket's because it is the narrower claim - which is what
lets a bucket set a floor without giving up the ability to say more about a particular object.

**Empty is not `MEDIUM`.** Clearing it is the only way back to letting the queue decide: a bucket that
says nothing leaves a queue created `LOW` delivering at `LOW`, where a bucket saying `MEDIUM` overrides
it. `createBucket` takes a priority too, and omits the field entirely when it is empty; `setBucketPriority`
sends it either way, because there an empty value is the instruction.

## What EQS covers

`session.eqs()` answers with the queue client.

| Method | Action |
| --- | --- |
| `createQueue`, `listQueues`, `getQueueErn`, `existsQueue`, `getQueueMetadata`, `purgeQueue`, `purgeAllQueues`, `deleteQueue` | queues |
| `deleteQueue({ ifEmpty })`, `purgeQueue({ background })` | removing one only if nothing is using it; emptying a backlog without waiting |
| `addQueueTag`, `setQueueTag`, `deleteQueueTag` | queue tags |
| `stopQueue`, `startQueue`, `setQueueVisibility` | what a queue hands out, and for how long |
| `setQueueDelay`, `setQueueMaxMessageLength` | how long a send is held back, and how large it may be |
| `sendMessage`, `sendMessageBatch`, `receiveMessages`, `receiveAllMessages`, `deleteMessage`, `deleteMessageById` | messages |
| `listMessages`, `getMessageCount`, `getMessageMetadata` | inspecting a queue without consuming it |
| `getMessageAttribute`, `setMessageAttribute`, `setMessageVisibility`, `updateMessageBody` | one message at a time |
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

### Delay and message size

Three things about a queue are changeable while it is in service, and all three apply to what happens next
rather than to what is already on it:

```ts
import { INSTALLATION_MAX_MESSAGE_LENGTH, MAX_QUEUE_DELAY } from "euclid-ndk";

await eqs.setQueueVisibility(queue.ern, 120);        // the lease new receives get
await eqs.setQueueDelay(queue.ern, 30);             // how long a send waits to become receivable
await eqs.setQueueMaxMessageLength(queue.ern, 262144);
```

A message already waiting had its delay turned into a timestamp when it arrived, so changing the delay neither
releases it early nor holds back one promised sooner; a message already on the queue was measured against the
limit in force when it arrived, so lowering the limit does not go back and reject it; and a lease already
handed out keeps the window it was given. The delay runs from none to `MAX_QUEUE_DELAY` (900 seconds, the bound
SQS holds `DelaySeconds` to) and a value outside that is refused here before the round trip.

`sendMessage` now refuses a body the queue will not take with HTTP 400 saying both figures. What is measured is
the **body alone** - the same number a message's `size` reports - so attributes travel alongside it rather than
against the limit.

`setQueueMaxMessageLength` answers with two numbers, because zero is a value: `maxMessageLength` is what the
queue now holds and `effectiveMaxMessageLength` is what a send is actually measured against.
`INSTALLATION_MAX_MESSAGE_LENGTH` (zero) means the queue carries no limit of its own - which is what a queue
created before the limit meant anything holds - and is measured against the installation's 1 MiB instead. It
does not mean "accept nothing".

`asInternal()` marks a client's requests as euclid's own traffic. The same `get-message-count` is a
user's question one moment and a metric collector's poll the next, and only the caller knows which, so
instrumentation says so rather than leaving the server to guess from a rate.

## What ENS covers

`session.ens()` answers with the notification client.

| Method | Action |
| --- | --- |
| `createTopic`, `listTopics`, `getTopicErn`, `existsTopic`, `getTopicMetadata`, `purgeTopic`, `purgeAllTopics`, `deleteTopic` | topics |
| `addTopicTag`, `setTopicTag`, `deleteTopicTag` | topic tags |
| `stopTopic`, `startTopic` | holding delivery, and handing over what was held |
| `resendMessages` | handing what the topic still holds to its subscribers again |
| `setTopicRetention`, `setTopicMaxMessageLength` | how long a published message is kept, and how large it may be |
| `publishMessage`, `listMessages`, `getMessageCount` | messages |
| `getMessageAttribute`, `setMessageAttribute`, `updateMessageBody` | one published message at a time |
| `subscribe`, `listSubscriptions`, `unsubscribe` | delivery onward to a queue |
| `metrics` | ENS's own metrics |

`updateMessageBody` replaces a stored body - the whole of it, since a body is opaque to euclid and
there is nothing that could merge two. Both modules answer with `previousSize` alongside the new one,
because the body it replaced is gone by the time the answer arrives. The queue's or topic's maximum
message length applies exactly as it does to a send or a publish, so sending something short and then
growing it is not a way around a limit.

On a topic it corrects **the record rather than the delivery**: a publish fans a message out to its
subscribers immediately, so the copies that already left are past changing. What this reaches is the
copy ENS still holds - what `listMessages` and `getMessage` answer with, and what `resendMessages`
would send.
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

### Holding delivery

`stopTopic` stops a topic delivering without stopping it accepting - what is published while it is stopped
is stored and fanned out when `startTopic` runs, oldest first:

```ts
await ens.stopTopic(topic.ern);                       // subscribers are being redeployed
// ... publishers carry on, and nothing is lost
const started = await ens.startTopic(topic.ern);
console.log(`${started.released} held message(s) delivered`);
```

So a subscriber being redeployed, or a downstream system taken down for the evening, is a reason to hold
delivery rather than to lose what arrives meanwhile. `released` is delivery rather than a promise of it: the
fan-out happens inside that call, so starting a topic that collected a fortnight of traffic is a fortnight of
fan-out here. The server works a page at a time and marks each message as it goes, so an interrupted start has
delivered a prefix rather than nothing and running it again picks up where it stopped. Starting a topic that
was never stopped is not an error - nothing is held, nothing is released.

`getTopicMetadata` is where to look before starting one: `held` says how much has piled up, and `status` reads
`TOPIC_RUNNING` or `TOPIC_STOPPED`. Both also appear on every topic a listing returns. Nothing already
delivered is affected by either call - a message on a subscriber's queue belongs to that queue.

### Retention

A topic is fanned out at publish time, so nothing ever consumes its messages and nothing else removes them:
without a retention period the collection only grows, and because every topic shares it, one busy topic is
paid for by every publish in the installation. `setTopicRetention` is what bounds that:

```ts
import { INSTALLATION_RETENTION, RETENTION_FOREVER } from "euclid-ndk";

await ens.setTopicRetention(topic.ern, 7 * 24 * 60 * 60);       // seconds: keep a week
await ens.setTopicRetention(topic.ern, INSTALLATION_RETENTION); // or follow the installation's own
await ens.setTopicRetention(topic.ern, RETENTION_FOREVER);      // or keep everything
```

`INSTALLATION_RETENTION` (zero) means this topic has never been told what it wants and follows
`euclid.modules.ens.retention-period` as that changes, rather than freezing a copy of what it says today.
`RETENTION_FOREVER` (-1) is not a very long period but the absence of one: the server stores such a message
with no expiry at all, which is exactly what its TTL index ignores, so nothing ever removes it — the topic
then grows without limit and only `purgeTopic` empties it. A period below -1 is refused here before the round
trip, as the server would refuse it anyway. The change applies to messages published afterwards: the expiry is
stamped on each message when it is stored and enforced by a TTL index, so the ones already there keep the
expiry they were given.

### Message size

`setTopicMaxMessageLength` changes the largest message a topic accepts, and `publishMessage` refuses a longer
body with HTTP 400 saying both figures. As in EQS it is the **body alone** that counts, so attributes travel
alongside it; unlike EQS the length has to be positive, since a topic has no "no limit of my own" to be set
back to and one accepting nothing would be `stopTopic` said irreversibly. A notification euclid publishes
itself - a bucket's object event - is not measured against it, because there is nobody to answer 400 to.

Like retention, it governs what is published from here on: a message already in the topic was accepted under
the rule in force when it arrived, and lowering the limit is not a reason to go back and lose it.

One wire asymmetry is reproduced rather than papered over: an attribute's name travels as `name` in
most of EQS and as `key` throughout ENS, so a request this SDK builds matches what euclid-cli and
euclid-jdk send.

## What EKM covers

`session.ekm()` answers with the key client.

| Method | Action |
| --- | --- |
| `createKey`, `listKeys`, `getKey`, `existsKey`, `setKeyDescription`, `addKeyTag`, `deleteKeyTag` | keys |
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
| `createTable`, `getTable`, `existsTable`, `listTables`, `deleteTable` | tables |
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
| `createApplication`, `updateApplication`, `copyApplication`, `redeployApplication`, `deleteApplication` | deploying |
| `startApplication`, `stopApplication`, `restartApplication`, `scaleApplication`, `listApplications`, `getApplication` | running |
| `applyInfrastructure` | making the installation match the application's own declaration |
| `setLogLevel`, `resetLogLevel` | what one application logs, without restarting it |
| `reportLoad` | an application telling euclid how busy it is, which is what the autoscaler acts on |
| `listNodes`, `getNode`, `drainNode`, `resumeNode`, `deleteNode` | the worker nodes applications are placed on |
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

A runtime is matched exactly and in upper case. `RUNTIME_JAVA` is whichever java the host calls java, which
is what every application deployed before the versioned runtimes existed says; `RUNTIME_JAVA21` and
`RUNTIME_JAVA25` name a version and start under the executable that host has configured for it. A jar built
for 25 does not start on 21, and leaving it to whichever java resolved first made the version an accident of
the manager's `PATH` - so a versioned runtime is the one to name when the artifact needs one.

The deployment says which buckets, queues, topics and secrets the application may reach, and euclid grants
those to the identity it runs as: a technical principal it creates unless one is named, with no password, no
login and one access key, so that nothing an application leaks is a person's credential. Those names are
resolved in the session's namespace, so a deployment cannot grant itself another namespace's bucket by
naming it.

A deployment naming none of the four says nothing about what it needs, and euclid reads that the only way it
safely can: the application role with `resources: ["*"]` - every resource in the namespace. Naming the lists
is how an application is held to what it actually uses.

**On an update, the four go together.** The server rebuilds the whole resource list from whatever the request
carries, so naming `buckets` and `queues` on an application that also holds topics or secrets **revokes those**.
Pass every list the application should end up with, or none of them:

```ts
await eap.updateApplication("order-service", {
  buckets: ["artifacts"],
  queues: ["orders"],
  topics: ["order-events"],   // leaving these two out would revoke them
  secrets: ["db-password"],
});
```

An application ID is unique within an account and namespace, not across the installation - so `namespace` is
the other half of what identifies one, and `runtimeName` is what everything on the host is actually called:
its directory, its socket, its log channel and the principal named after it (`app-<runtimeName>`). The server
issues that name at deployment and keeps it afterwards, including across a move. For an application deployed
before the field existed it is the bare application ID.

`updateApplication({ namespace })` is that move: the ERN is rebuilt, the row moves, and the technical
principal's grant follows - while the runtime name stays, so nothing shifts underneath a running instance on
the host. An empty string moves the application back to the account root, and a namespace that already has an
application of this ID refuses the move with HTTP 409.

Starting asks rather than waits. `desiredState` is what somebody asked for and `state` is what is
actually answering, so a freshly started application usually comes back `RUNNING`/`STOPPED` - the two
differing is an application starting up, and the two differing for long is one that cannot.

`updateApplication` sends only the fields it is given, because that is the distinction the server draws,
as in ESS and EAG below:
leaving `command` out keeps the stored command, while passing `""` clears it and hands the artifact back
to the runtime's own interpreter. `buckets`, `queues`, `topics` and `secrets` are re-resolved together
whenever any one of them is named - so pass all four or none, since naming one revokes what the others
granted. For a new build of the
same application, `redeployApplication` is the call; one that would change neither the version nor the
checksum is refused, which usually means the new artifact never reached the bucket.

### Jobs and schedules

An application is a `PROCESS` or a `JOB`, and the difference is what finishing means:

```ts
import { TYPE_JOB } from "euclid-ndk";

await eap.createApplication("nightly-import", RUNTIME_JAVA, "artifacts", "import-1.0.0.jar", {
  type: TYPE_JOB,
  schedule: "0 2 * * *",   // UTC; "@daily" works too
});
```

A `PROCESS` is started and kept up: an exit is a fault, the slot is filled again, and the pool is held at
its instance count. That is what everything euclid ran before this field existed is, and what an
application with no type stored still reads as - including against a euclid too old to report one.

A `JOB` runs to completion. Exit 0 is success rather than a crash to back off from, the slot is not
refilled, and the autoscaler leaves it alone, since a backlog says nothing about how many copies of a
one-shot task to run. A nightly import deployed as a `PROCESS` is restarted forever, every completed run
recorded as a crash - which is the mistake the type exists to make impossible to express.

A `schedule` is only valid on a `JOB`, and the server refuses one on a `PROCESS` rather than storing a cron
expression that will never fire. An expression that does not parse is refused at the moment it is set, not
hours later when it was due. `Application.nextRunAt` is when it fires next, computed server-side when the
schedule was set - and **empty when there is no schedule**, rather than the epoch, which would read as a job
fifty years overdue. An empty `schedule` unschedules, putting a job back to running on demand.

Changing a job back into a process has to clear the schedule in the same `updateApplication` call: the
server checks the pair once both have been applied, so this is refused rather than left as a schedule that
silently stopped firing.

```ts
await eap.updateApplication("nightly-import", { type: TYPE_PROCESS, schedule: "" });
```

### Worker nodes

An application runs on the manager's own host unless it asks for somewhere else. `nodeLabels` is that ask -
`{ os: "windows" }`, `{ gpu: "true" }` - matched against the labels a worker node registered with. An empty
set, which is the default, hands the application back to the manager.

Nodes register themselves and renew a lease; nothing here configures one. What an operator does is read the
fleet, empty a host, and forget it once it is gone:

```ts
const nodes = await eap.listNodes();          // live or not: a node that stopped renewing reads live: false
const node = await eap.getNode("worker-01");  // and what it is holding slots for
```

`getNode` is the only one that answers `applications`, each entry saying how many slots this node holds and
how many are actually serving out of them - a node holding four and running none is the state worth seeing.
Working that out means walking every pool, which is why a listing does not.

`drainNode` stops new instances being placed on a node and lets the ones it has leave as they are replaced.
It is **not** a stop: the node keeps running what it has and keeps renewing, because a node that downed
tools on being drained would make draining an outage. Taking a host out of service is `drainNode`, then
stopping the worker, then `deleteNode` - in that order. `deleteNode` alone does not stop anything; a worker
still running re-registers on its next renewal.

Every node action is open to any authenticated caller except `deleteNode`, which needs an administrator:
a node's name is bound to the principal that registered it, and freeing the name is what would let another
principal claim it along with its assignments and its applications' credentials.

### Reporting load

An application tells euclid how busy it is, and the autoscaler acts on that:

```ts
await eap.reportLoad(process.env.EUCLID_INSTANCE_ID, 72, { backlog: 120, active: 3 });
```

The instance id is the one euclid handed the process in `EUCLID_INSTANCE_ID`. A report that cannot say which
slot of which pool it came from is refused rather than attributed to the wrong one. An application running as
its own `app-<runtimeName>` principal already says which pool it is; one deployed with a *named* user passes
`applicationId` as well, and has to be the identity that application runs as.

`active` - work started and not finished - is not a load signal. It says "do not stop me", not "start
another one": scale-down passes over an instance reporting any, because work in flight is work a second
instance cannot take over. The call answers with what the server stored, so a client reporting 150 learns
that euclid recorded 100.

This is not a metric. Push the same numbers to `session.emo().pushMetrics` as well if you want the history -
that path aggregates into five-minute buckets, which is right for a graph and five minutes too slow for a
control loop.

### Infrastructure declarations

An application can carry its own infrastructure: a `<applicationId>.euclid.json` file stored beside its
artifact in the bucket it deploys from, naming under `creates` the queues, topics and buckets it owns, and
under `uses` the ones belonging to others that it reaches, with the `access` it needs and the `owner` that
has it. euclid applies it whenever the application is created, updated or redeployed; `applyInfrastructure`
is how to reconcile without a deploy:

```ts
const applied = await eap.applyInfrastructure("order-service");
if (!applied.declared) console.log("no declaration stored - nothing to reconcile");
for (const gone of applied.deleted) console.log(`removed ${gone}`);
```

Three things to know before trusting one:

* **The reconcile is full.** A resource this application created and the declaration no longer names is
  *deleted*, with the messages or objects in it. That is why the call answers instead of just succeeding -
  `deleted` names each one, so a removal nobody intended is visible rather than something to go looking for.
* **`declared: false` is not a failure.** It means no declaration is stored; the four lists are empty and
  nothing happened. An application that provisions by hand reads this way every time.
* **`granted` and `revoked` repeat themselves.** Access roles are replaced wholesale rather than diffed, so
  a re-apply that changes nothing still reports every `access-` role in both lists.

Applying changes nothing about the running instances - the modification date is deliberately not stamped, so
the manager does not read it as a new revision and cycle the pool. A declaration that cannot be applied
throws rather than being half applied: one naming a resource that belongs to another application, or claiming
one it does not own. During a *deploy* the same failure is only logged, because refusing there would stop a
release over a JSON typo; asked for directly, it is an error.

## What ESS covers

`session.ess()` answers with the secret store.

| Method | Action |
| --- | --- |
| `createSecret`, `getSecret`, `existsSecret`, `listSecrets`, `deleteSecret` | secrets |
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

`existsSecret` asks the listing rather than `getSecret`, deliberately: asking for the value to find out
whether a name is taken would need `ess:get-secret` rather than `ess:list-secrets`, decrypt the secret,
carry the plaintext back, and leave an audit entry indistinguishable from somebody actually reading it.

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
| `createRoute`, `createModuleRoute`, `createUploadRoute`, `updateRoute`, `getRoute`, `listRoutes`, `deleteRoute` | published paths |
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

### Upload routes

A route with no backend: the gateway is the endpoint, and what it does with the body is write it into a
bucket.

```ts
await eag.createUploadRoute("inbox", "/upload", bucketErn, {
  keyPrefix: "incoming/",             // prefixed to the key, which is otherwise the path below the route
  maxBytes: 100 * 1024 * 1024,        // 0, the default, accepts any size
  contentTypes: ["text/csv"],         // empty, the default, accepts any type
  authentication: ROUTE_AUTH_EUCLID,
});
```

The difference from a proxy route is not which backend but **who reads the body**: a proxied request is
buffered whole and handed on, while an upload is streamed into ESM in parts and never held in memory. That
is why it is a type on the route rather than another field on the one behaviour - the two cannot share a
request path - and why an upload route naming an application or a module is refused: naming one says the
author expected the request to be forwarded, and it will not be.

`maxBytes` and `contentTypes` are both answered *before* a byte of the body is read, which is the point of
matching the route first: a caller sending something this route will not take is told so now - 413 or 415 -
rather than after spending however long it takes to send it. A `Content-Length` over the limit is refused on
the header, and a body that turns out longer than it claimed is cut off at the same limit, because the
header is a claim and the limit is what holds when the claim was a lie.

Keys are checked rather than trusted: an empty path segment, a `.` or `..` segment, or a null byte is
refused, so a caller cannot climb out of the prefix it was given. A route stored before the type existed
reads as `ROUTE_PROXY`, which is what it is.

`listListeners` answers with a page of listeners plus `serving`, which says whether the gateway's ports are
bound at all. A listener whose port was taken, or whose certificate could not be loaded, is still listed -
it is the one somebody is looking for. An HTTPS listener's certificate arrives flat, as a dozen
`certificate*` fields, and is gathered back into one `certificate` object here; it is `null` for a plain
HTTP listener and for an HTTPS one the server found none for.

## What ETS covers

`session.ets()` answers with the transfer client. Every action is administrator-only server-side.

| Method | Action |
| --- | --- |
| `createServer`, `updateServer`, `getServer`, `listServers`, `deleteServer` | transfer servers |
| `startServer`, `stopServer` | putting one in service, and taking it out |
| `metrics` | ETS's own metrics |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

A transfer server is an FTP or SFTP listener in front of a bucket: what a client uploads becomes an object,
and what is in the bucket is what a client lists. A partner who will only ever send files by SFTP needs no
euclid client, and what they send arrives where the rest of euclid can reach it - a bucket subscription
fires, an application consumes it, the usual machinery.

```ts
import { PROTOCOL_SFTP } from "euclid-ndk";

const ets = session.ets();
await ets.createServer("drop-box", "incoming", 2222, {
  protocol: PROTOCOL_SFTP,          // or PROTOCOL_FTP
  userIds: ["jens"],                 // and/or userGroups, who may log in
  homeDirectory: "partners/acme",   // the key prefix a session starts in
  directories: ["inbox", "outbox"], // what a client sees whether or not anything is stored there
});
await ets.startServer("drop-box");
```

`directories` is the one thing that has no equivalent in the bucket: a bucket has no directories, keys merely
share a prefix, so a client that expects to change into one before uploading has to be told they exist.

Creating is refused with HTTP 409 if the ID is taken or if another server on the host already holds the port
- a TCP port is not partitioned by account or namespace, so that check crosses both - and with 404 if the
bucket is not there, since the bucket is resolved at creation rather than at start-up. A port outside
1…`MAX_PORT` is refused here before the round trip.

Starting asks rather than waits, as in EAP: `desiredState` is what was asked for and `state` what the host
reports, so a freshly started server often reads `RUNNING`/`STOPPED` for a moment. `updateServer` sends only
what it names, and a server picks a change up when it is next started rather than moving a listener out from
under a client mid-session.

## What EMO covers

`session.emo()` answers with the monitoring client.

| Method | Action |
| --- | --- |
| `pushMetrics` | adding an application's own measurements to the installation's |
| `registry` | meters that accumulate in the process and publish on a step |
| `listMetrics`, `average` | reading the rows back (administrator-only) |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

euclid's own modules push their samples here rather than being polled, because a module the autoscaler is
tearing down cannot answer a poll - it simply stops pushing. An application is in the same position, and what
it pushes lands in the same rows EMO's collectors write: the same rollups, the same retention, the same graphs
as CPU, memory and the module gauges.

### Meters, and what a step means

`pushMetrics` takes numbers that are already final. An application that wants to count and time things wants a
registry, which is what euclid-jdk does with Micrometer and euclid-pdk with its own:

```ts
const metrics = session.emo().registry("invoice-parser", { commonLabels: { host } });
const parsed = metrics.counter("invoices.parsed");
const failed = metrics.counter("invoices.parsed", { outcome: "failed" });
const duration = metrics.timer("invoice.parse");
metrics.gaugeFrom("queue.depth", () => queue.length);

try {
  for (const invoice of incoming) {
    await duration.time(async () => ((await parse(invoice)) ? parsed : failed).increment());
  }
} finally {
  await metrics.close();     // publishes the step in hand
}
```

A counter and a timer report what accumulated since the last publish and start again, which is what makes them
rates to EMO - the thing a rollup sums. A gauge reports what it reads at the moment of publishing and is not
reset. Every registered meter is published every step, including the ones that did not move: a zero is a fact,
and a gap in a graph is not. The step defaults to `DEFAULT_STEP_MS` (a minute, as in euclid-jdk); `stepMs: 0`
starts no timer at all and leaves publishing to `publish()`, which is what an application with a loop of its
own wants, and what a test wants.

A timer is given durations in **seconds** and publishes them in **milliseconds**, as `<name>.count` and
`<name>.total` (rates) and `<name>.max` (a gauge) - the names euclid-jdk's registry uses, so the same operation
graphs beside a Java one's. There are no percentiles: EMO stores one value per series per interval, so a p99
would have to be computed here and pushed as a series of its own.

Three things are worth knowing before this runs in anger:

* **Labels are series.** Every meter is one stored row per step, forever, so the number of label combinations
  is the number of series - a label carrying a request ID is how a monitoring database is filled up.
* **A failed push is counted, not retried.** `publishes` and `failedPublishes` say whether the monitoring is
  working, which nothing else can: a metric about pushing metrics cannot be pushed. A rate sent twice is
  counted twice, and a monitoring system that lies about throughput is worse than one with a gap.
* **The publish timer is unref'd**, so it never keeps a process alive. Call `close()` in a `finally`: the last
  step is usually the interesting one and the one a process that simply exits would drop.

`NaN` and infinities are skipped rather than pushed - they are what a gauge over an empty collection reads, and
they would poison every rollup that averaged them.

### Reading it back

`listMetrics` and `average` are administrator-only: publishing your own numbers needs no special rights,
reading everybody's is a different question. A query narrows by name, labels, a window and a resolution, and
anything it does not name is left out of the request entirely rather than sent empty.

```ts
import { RESOLUTION_HOUR } from "euclid-ndk";

const rows = await emo.listMetrics({ name: "invoices.parsed", since, resolution: RESOLUTION_HOUR });
const mean = await emo.average({ name: "invoice.parse.total" });
```

A row's `value` is the mean for a gauge and the sum for a rate - `type` says which, in upper case, where a push
spells it in lower - and `minValue`/`maxValue` survive a rollup, so an hourly row still knows the worst five
minutes inside it.

## What EMM covers

`session.emm()` answers with the module manager. Every action is administrator-only server-side, and more
plainly so than elsewhere: between them they expose every module's live process pool and every module's raw
collections.

| Method | Action |
| --- | --- |
| `listModules`, `findModule` | every module the manager runs, and the processes in each |
| `setInstances`, `setThreads` | how many instances a pool may run, and how many threads each runs |
| `setLogLevel`, `resetLogLevel` | what one module logs, without restarting it |
| `stopModule`, `startModule`, `restartModule` | taking a module out of service, and cycling one |
| `exportArchive`, `importArchive` | the module collections as documents, out of the database and back in |
| `call(action, payload)` | anything the server gained that this SDK has not wrapped yet |

Two unrelated jobs live here, together because both are about the installation rather than anything stored
in it: the module pools, and export/import.

### The pools

```ts
const emm = session.emm();

for (const module of await emm.listModules()) {
  const running = module.instances.filter((instance) => instance.state === MODULE_RUNNING).length;
  console.log(`${module.name}  ${running}/${module.instances.length} running`);
}
```

This is the only view in euclid that shows a process: pids, hosts, ports, restart counts, and what each
instance last reported about its own load. "Module" is wider here than the twelve this SDK has clients for -
an application pool and a transfer server are modules to the manager too - which is what `module.core` says,
and `listModules` is not scoped by namespace, since these are the installation's processes rather than
anybody's resources. `findModule` filters that listing client-side, because EMM has no per-module read.

**Nothing here acts immediately.** EMM runs in its own process while the pools live in the manager's, so
every control action records what was asked for and the manager picks it up on its next reconcile, within a
second or so. That is also why these survive a restart: they are written on the module document, and
start-up applies them over `euclid.json`. Every result's `runningInstances` is therefore the pool *before*
the manager has acted - a measure of what the change will cost rather than of what it has done.

**-1 means "nothing was said", and is not zero.** `desiredMinInstances`, `desiredMaxInstances` and
`desiredThreads` are the limits asked for and not yet reconciled, `-1` when nothing is pending - which is
why a caller adjusting a limit twice in quick succession can see the second change for what it is. On an
instance, `utilisation` and `backlog` are `-1` when it has never reported: a module that does not report, an
SDK too old to know how, or a call being refused. A pool whose floor reads `0` has been asked to scale away
when idle; one that reads `-1` has been asked nothing.

`stopModule` and `startModule` are for core modules only - an application's desired state belongs to EAP and
a transfer server's to ETS, and anything recorded here for them would be undone within seconds, so the
server refuses it and says which call to use. `emm` cannot stop itself either: every other module can be
brought back with the call this is, and that one could not. `restartModule` *is* allowed for applications and
transfer servers, because it changes no desired state - the same instances come straight back, one per
reconcile tick, so the module keeps serving out of the ones not yet reached. A module that is stopped is
refused: there is nothing to restart, and honouring it would start what somebody asked to have stopped.

`setThreads` is the one change that cannot be applied to a running process - a thread count is fixed when
one starts - so the manager cycles the instances for it. `setLogLevel` needs no restart at all.

### Export and import

The module collections as documents: a backup, a copy of one installation into another, and the one way to
look at what euclid stores without a database client. It is the same file `euclid-cli emm export` writes, and
either tool reads the other's.

```ts
const archive = await emm.exportArchive({ modules: ["esm", "eqs"], full: true, passphrase });
await writeFile("backup.json", JSON.stringify(archive));

const result = await emm.importArchive(JSON.parse(await readFile("backup.json", "utf8")), { passphrase });
for (const { collection, imported, failed } of result.imported) console.log(collection, imported, failed);
```

Exactly one of `all` and `modules` is required - "every module" and "these modules" are different enough
requests that the server will not guess between them. `full` adds the bulk child data (EQS and ENS messages,
ESM objects); without it an archive holds the resources and not their contents, which is usually what
somebody inspecting an installation wants and always much smaller.

**What an archive is worth.** It carries access-key secrets, and EKM's key material if `ekm` was asked for -
base64-encoded, not encrypted, because a key store restored without its keys restores nothing. So `ekm`
cannot be exported without a `passphrase`, and the server refuses it rather than writing one. A sealed
archive holds nothing worth anything without the passphrase; the envelope around it stays readable - which
modules, when, and how to derive the key - which is enough to tell what a file is and to ask for the right
passphrase. What that protects is the file and not the action: anybody who may call this may call it again
without a passphrase.

A sealed export of named modules is **one request per module**, every frame sealed under one key, which is
why the archive carries `frames` rather than a single payload - a file holding ten modules is then not also
one response holding them. `exportArchive` does that loop and the salt-sharing itself; `all` stays a single
request, since there is nothing to tie together.

An import upserts each document by its `_id`, replacing the whole document rather than merging fields, so
what lands matches the export exactly. A wrong passphrase and an altered file fail the same way and nothing
is written when they do - the archive is authenticated as it is opened, so a half-imported archive is not a
state this can leave behind. Read `result.skipped` rather than the absence of an error: a collection this
installation does not recognise is reported rather than refused, so an import that wrote nothing at all
still succeeds.

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

A release says its version in three places, and `.github/workflows/publish.yml` refuses to publish
unless all three agree: the tag, `version` in `package.json` (which names the tarball), and `VERSION`
in `src/index.ts` (which is what an application asking this SDK its own version is told - checked
against the built `dist`, since that is what ships). So bump the two files, then tag and push:

```bash
npm version 0.2.0 --no-git-tag-version     # package.json
$EDITOR src/index.ts                       # VERSION
git commit -am "chore: release 0.2.0"
git tag -a v0.2.0 -m "euclid-ndk 0.2.0"
git push origin main v0.2.0
```

The tag runs the tests again (the test workflow triggers on branches, so a tag push would otherwise
run nothing), checks the three versions, builds `dist`, packs the tarball and publishes it to npm with
a provenance attestation - a signed statement of which workflow, at which commit, built what was
published. `workflow_dispatch` does the same for whatever `main` says, which is what a version whose
tag predates this workflow needs; it checks the two files against each other but has no tag to
compare.

Publishing authenticates as this repository rather than as somebody: npm is configured with a trusted
publisher for `jensvogt/euclid-ndk` and `publish.yml`, and mints a short-lived token from the workflow's
own OIDC identity - the same identity that signs the provenance attestation. No token is configured in
the workflow, so that exchange is the only way in and a run that cannot make it fails instead of falling
back to a secret.

If a release ever has to go out on a token again, `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the
publish step is the whole change. Be ready for `E403 ... You may not perform that action with these
credentials`, which is the registry's one answer for a read-only token, a granular token not scoped to
this package, and a token npm no longer accepts for direct publishing - it does not say which.

## Licence

Apache License 2.0.
