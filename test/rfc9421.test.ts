/**
 * RFC 9421 signing, verification and structured-field parsing.
 *
 * The round trips here are self-referential in the way the SigV4 vectors are not, so what they are
 * really for is the policy: the covered set is fixed, its order matters, the digest binds the body,
 * and a stale or altered signature is refused without saying which of those it was. Those are the
 * rules euclid's `Core::HttpSignature::Verify` applies, and a client that disagreed with any of
 * them would produce signatures the server rejects.
 */

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import * as rfc9421 from "../src/auth/rfc9421.js";
import { SignableRequest } from "../src/auth/signable.js";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

/** A request carrying everything euclid's covered component set needs. */
function euclidRequest(body = '{"prefix":""}'): SignableRequest {
  return new SignableRequest("POST", "/")
    .header("host", "euclid.example.com")
    .header("x-euclid-account-id", "000000000000")
    .header("x-euclid-action", "list-users")
    .header("x-euclid-region", "eu-central-1")
    .header("x-euclid-target", "eam")
    .header("x-euclid-user-id", "jens")
    .setBody(body)
    .setScheme("https");
}

describe("content digest", () => {
  it("is RFC 9530's sha-256 byte sequence", () => {
    const expected = createHash("sha256").update("hello", "utf8").digest("base64");
    assert.equal(rfc9421.contentDigest("hello"), `sha-256=:${expected}:`);
  });

  it("reads a string and its bytes the same way", () => {
    assert.equal(rfc9421.contentDigest("hello"), rfc9421.contentDigest(Buffer.from("hello", "utf8")));
  });
});

describe("signing and verifying", () => {
  it("round-trips a request it signed", () => {
    const request = euclidRequest();
    rfc9421.sign(request, ACCESS_KEY_ID, SECRET);

    assert.ok(request.get("signature-input").startsWith("sig1=("));
    assert.ok(request.get("signature").startsWith("sig1=:"));
    // The scheme leaves Authorization alone, which is what lets a token and a signature coexist.
    assert.equal(request.get("authorization"), "");
    assert.equal(rfc9421.verify(request, () => SECRET), ACCESS_KEY_ID);
  });

  it("covers the components euclid's server covers, in that order", () => {
    const request = euclidRequest();
    rfc9421.sign(request, ACCESS_KEY_ID, SECRET);

    const params = rfc9421.parseSignatureParams(request.get("signature-input").slice("sig1=".length));
    assert.ok(params !== null);
    assert.deepEqual(params.components, [...rfc9421.requiredComponents()]);
    assert.equal(params.algorithm, rfc9421.ALGORITHM);
    assert.equal(params.keyId, ACCESS_KEY_ID);
    assert.equal(params.tag, rfc9421.TAG);
  });

  it("refuses a request whose body changed after it was signed", () => {
    const request = euclidRequest();
    rfc9421.sign(request, ACCESS_KEY_ID, SECRET);

    // Both halves, because the digest is the only thing the signature covers the body through.
    request.setBody('{"prefix":"pwned"}');
    request.header("Content-Digest", rfc9421.contentDigest(request.body));

    assert.equal(rfc9421.verify(request, () => SECRET), null);
  });

  it("refuses a request whose covered header changed after it was signed", () => {
    const request = euclidRequest();
    rfc9421.sign(request, ACCESS_KEY_ID, SECRET);

    request.header("x-euclid-action", "delete-user");

    assert.equal(rfc9421.verify(request, () => SECRET), null);
  });

  it("refuses a signature covering a narrower set than the required one", () => {
    const request = euclidRequest();
    rfc9421.sign(request, ACCESS_KEY_ID, SECRET);

    const narrowed = rfc9421.serializeSignatureParams(
      ["@method", "@path"],
      Math.floor(Date.now() / 1000),
      ACCESS_KEY_ID,
      "nonce",
    );
    const base = rfc9421.signatureBase(request, ["@method", "@path"], narrowed);
    assert.ok(base !== null);
    request.header("Signature-Input", `sig1=${narrowed}`);
    request.header("Signature", `sig1=:${hmacBase64(base)}:`);

    assert.equal(rfc9421.verify(request, () => SECRET), null);
  });

  it("refuses a created timestamp outside the skew window", () => {
    const request = euclidRequest();
    rfc9421.sign(request, ACCESS_KEY_ID, SECRET);

    assert.equal(rfc9421.verify(request, () => SECRET, -1), null);
  });

  it("refuses an unknown key without saying that is what was wrong", () => {
    const request = euclidRequest();
    rfc9421.sign(request, ACCESS_KEY_ID, SECRET);

    assert.equal(
      rfc9421.verify(request, () => null),
      null,
    );
  });

  it("refuses to sign a request that cannot supply every covered component", () => {
    const incomplete = new SignableRequest("POST", "/").header("host", "euclid.example.com").setBody("{}");

    assert.throws(() => rfc9421.sign(incomplete, ACCESS_KEY_ID, SECRET), /missing/);
  });

  it("signs a fresh nonce each time, so two identical requests do not share a signature", () => {
    const first = euclidRequest();
    const second = euclidRequest();
    rfc9421.sign(first, ACCESS_KEY_ID, SECRET);
    rfc9421.sign(second, ACCESS_KEY_ID, SECRET);

    assert.notEqual(first.get("signature"), second.get("signature"));
  });
});

describe("the signature base", () => {
  it("renders the derived components §2.2 defines", () => {
    const request = euclidRequest();
    const base = rfc9421.signatureBase(request, ["@method", "@path", "@authority"], "()");
    assert.equal(base, '"@method": POST\n"@path": /\n"@authority": euclid.example.com\n"@signature-params": ()');
  });

  it("drops the default port from @authority but keeps a written-out one", () => {
    const standard = euclidRequest().header("host", "euclid.example.com:443");
    assert.equal(rfc9421.signatureBase(standard, ["@authority"], "()"), '"@authority": euclid.example.com\n"@signature-params": ()');

    const other = euclidRequest().header("host", "euclid.example.com:8443");
    assert.equal(
      rfc9421.signatureBase(other, ["@authority"], "()"),
      '"@authority": euclid.example.com:8443\n"@signature-params": ()',
    );
  });

  it("answers null when a covered component is absent rather than signing a blank", () => {
    const request = new SignableRequest("POST", "/").setBody("{}");
    assert.equal(rfc9421.signatureBase(request, ["x-euclid-action"], "()"), null);
  });
});

describe("structured fields", () => {
  it("parses a dictionary member whose value contains a comma", () => {
    const parsed = rfc9421.parseSignature('sig1=("@method" "@path");created=1;keyid="k";alg="hmac-sha256"', "sig1=:AAEC:");
    assert.ok(parsed !== null);
    assert.equal(parsed.label, "sig1");
    assert.deepEqual(parsed.params.components, ["@method", "@path"]);
    assert.deepEqual([...parsed.signature], [0, 1, 2]);
  });

  it("refuses two signatures rather than choosing between them", () => {
    const two = 'sig1=("@method");created=1;keyid="k", sig2=("@path");created=1;keyid="k"';
    assert.equal(rfc9421.parseSignature(two, "sig1=:AAEC:, sig2=:AAEC:"), null);
  });

  it("refuses a component carrying parameters of its own", () => {
    assert.equal(rfc9421.parseSignatureParams('("@method";req);created=1;keyid="k"'), null);
  });

  it("refuses a params value that is not an inner list", () => {
    assert.equal(rfc9421.parseSignatureParams('"@method";created=1'), null);
    assert.equal(rfc9421.parseSignatureParams(""), null);
  });

  it("refuses a created that is not an integer", () => {
    assert.equal(rfc9421.parseSignatureParams('("@method");created="soon";keyid="k"'), null);
  });

  it("requires a keyid", () => {
    assert.equal(rfc9421.parseSignatureParams('("@method");created=1'), null);
  });
});

/** The base64 HMAC of a base under the test secret, for the hand-built signature above. */
function hmacBase64(base: string): string {
  return createHmac("sha256", Buffer.from(SECRET, "utf8")).update(base, "utf8").digest("base64");
}
