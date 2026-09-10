# euclid-ndk

Node.js client library for the [euclid](https://github.com/jensvogt/euclid) server.

This first release covers the three things everything else needs: the connection, request signing,
and EAM - euclid's access management module. The remaining modules (ESM, EQS, ENS, EES, EKM, ESS,
EKV, EAG, EAP, ETS) speak the same protocol over the same client and will follow.

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
