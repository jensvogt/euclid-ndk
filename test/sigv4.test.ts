/**
 * SigV4 canonicalisation and signing.
 *
 * The first three tests are AWS's own published test-suite cases (get-vanilla,
 * get-vanilla-query-order-key-case, post-x-www-form-urlencoded) with their published signatures.
 * They are here because they are the only checks in this file that are not self-referential: a
 * round trip of our own sign() against our own verify() would pass just as happily if both had the
 * same bug, whereas these fix the canonical form against an implementation nobody involved here
 * wrote. euclid's C++, Java and Python implementations are pinned by the same vectors, which is
 * what makes the four interoperate.
 */

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { SignableRequest } from "../src/auth/signable.js";
import * as sigv4 from "../src/auth/sigv4.js";

const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const ACCESS_KEY_ID = "AKIDEXAMPLE";
const DATE_STAMP = "20150830";
const AMZ_DATE = "20150830T123600Z";
const REGION = "us-east-1";
const SERVICE = "service";
const CREDENTIAL_SCOPE = "20150830/us-east-1/service/aws4_request";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function signatureFor(canonicalRequest: string): string {
  const stringToSign = sigv4.buildStringToSign(AMZ_DATE, CREDENTIAL_SCOPE, sha256Hex(canonicalRequest));
  const key = sigv4.deriveSigningKey(SECRET, DATE_STAMP, REGION, SERVICE);
  return createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
}

describe("AWS published vectors", () => {
  it("get-vanilla: GET /, no query, host and x-amz-date signed, empty body", () => {
    const headers = { host: "example.amazonaws.com", "x-amz-date": AMZ_DATE };
    const signed = ["host", "x-amz-date"];

    const canonical = sigv4.buildCanonicalRequest("GET", "/", "", headers, signed, EMPTY_SHA256);

    assert.equal(
      canonical,
      "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\n" +
        `host;x-amz-date\n${EMPTY_SHA256}`,
    );
    assert.equal(
      sigv4.buildStringToSign(AMZ_DATE, CREDENTIAL_SCOPE, sha256Hex(canonical)),
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n" +
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
    assert.equal(signatureFor(canonical), "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("get-vanilla-query-order-key-case: query parameters sort by key", () => {
    const headers = { host: "example.amazonaws.com", "x-amz-date": AMZ_DATE };
    const signed = ["host", "x-amz-date"];

    const canonicalQuery = sigv4.canonicalizeQueryString("Param2=value2&Param1=value1");
    assert.equal(canonicalQuery, "Param1=value1&Param2=value2");

    const canonical = sigv4.buildCanonicalRequest("GET", "/", canonicalQuery, headers, signed, EMPTY_SHA256);

    assert.equal(
      canonical,
      "GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\n" +
        `x-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    );
    assert.equal(signatureFor(canonical), "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("post-x-www-form-urlencoded: the body is hashed, not the form", () => {
    const body = "Param1=value1";
    const headers = {
      "content-type": "application/x-www-form-urlencoded",
      host: "example.amazonaws.com",
      "x-amz-date": AMZ_DATE,
    };
    const signed = ["content-type", "host", "x-amz-date"];

    const canonical = sigv4.buildCanonicalRequest("POST", "/", "", headers, signed, sha256Hex(body));

    assert.equal(signatureFor(canonical), "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a");
  });
});

describe("canonicalisation", () => {
  it("percent-encodes everything outside the unreserved set, uppercase", () => {
    assert.equal(sigv4.canonicalizeQueryString("a=b c"), "a=b%20c");
    assert.equal(sigv4.canonicalizeQueryString("a=b/c"), "a=b%2Fc");
    assert.equal(sigv4.canonicalizeQueryString("a=~-._"), "a=~-._");
  });

  it("re-encodes what arrived percent-encoded, so two spellings of one value agree", () => {
    assert.equal(sigv4.canonicalizeQueryString("a=b%20c"), sigv4.canonicalizeQueryString("a=b c"));
  });

  it("gives a parameter with no value an empty one", () => {
    assert.equal(sigv4.canonicalizeQueryString("a"), "a=");
  });

  it("canonicalises the empty query, which is what euclid always has", () => {
    assert.equal(sigv4.canonicalizeQueryString(""), "");
  });
});

/** A request carrying everything euclid's signed header set needs. */
function euclidRequest(body = '{"prefix":""}'): SignableRequest {
  return new SignableRequest("POST", "/")
    .header("host", "euclid.example.com")
    .header("x-euclid-account-id", "000000000000")
    .header("x-euclid-action", "list-users")
    .header("x-euclid-region", "eu-central-1")
    .header("x-euclid-target", "eam")
    .header("x-euclid-user-id", "jens")
    .setBody(body);
}

describe("signing and verifying", () => {
  it("round-trips a request it signed", () => {
    const request = euclidRequest();
    sigv4.sign(request, ACCESS_KEY_ID, SECRET, "eu-central-1", "eam");

    assert.ok(request.get("authorization").startsWith("AWS4-HMAC-SHA256 "));
    assert.equal(request.get("x-amz-content-sha256"), sha256Hex('{"prefix":""}'));
    assert.equal(sigv4.verify(request, () => SECRET), ACCESS_KEY_ID);
  });

  it("refuses a request whose body changed after it was signed", () => {
    const request = euclidRequest();
    sigv4.sign(request, ACCESS_KEY_ID, SECRET, "eu-central-1", "eam");

    request.setBody('{"prefix":"pwned"}');

    assert.equal(sigv4.verify(request, () => SECRET), null);
  });

  it("refuses a request whose signed header changed after it was signed", () => {
    const request = euclidRequest();
    sigv4.sign(request, ACCESS_KEY_ID, SECRET, "eu-central-1", "eam");

    request.header("x-euclid-action", "delete-user");

    assert.equal(sigv4.verify(request, () => SECRET), null);
  });

  it("refuses an unknown access key without saying that is what was wrong", () => {
    const request = euclidRequest();
    sigv4.sign(request, ACCESS_KEY_ID, SECRET, "eu-central-1", "eam");

    assert.equal(
      sigv4.verify(request, () => null),
      null,
    );
  });

  it("refuses a signature that covers fewer headers than euclid's fixed set", () => {
    const request = euclidRequest();
    sigv4.sign(request, ACCESS_KEY_ID, SECRET, "eu-central-1", "eam");

    // A request does not get to choose how little of itself it authenticates.
    const narrowed = request.get("authorization").replace(/SignedHeaders=[^,]+/, "SignedHeaders=host");
    request.header("Authorization", narrowed);

    assert.equal(sigv4.verify(request, () => SECRET), null);
  });

  it("refuses a stale timestamp", () => {
    const request = euclidRequest();
    sigv4.sign(request, ACCESS_KEY_ID, SECRET, "eu-central-1", "eam");

    assert.equal(sigv4.verify(request, () => SECRET, -1), null);
  });

  it("refuses a malformed or absent Authorization header", () => {
    assert.equal(sigv4.parseAuthorizationHeader(undefined), null);
    assert.equal(sigv4.parseAuthorizationHeader("Bearer something"), null);
    assert.equal(sigv4.parseAuthorizationHeader("AWS4-HMAC-SHA256 Credential=a/b/c/d/e"), null);
    assert.equal(sigv4.verify(euclidRequest(), () => SECRET), null);
  });

  it("parses the credential scope it wrote", () => {
    const request = euclidRequest();
    sigv4.sign(request, ACCESS_KEY_ID, SECRET, "eu-central-1", "eam");

    const parsed = sigv4.parseAuthorizationHeader(request.get("authorization"));
    assert.ok(parsed !== null);
    assert.equal(parsed.scope.accessKeyId, ACCESS_KEY_ID);
    assert.equal(parsed.scope.region, "eu-central-1");
    assert.equal(parsed.scope.service, "eam");
    assert.equal(parsed.signedHeaders, sigv4.signedHeaderNames().join(";"));
  });
});
