/**
 * The URL helpers.
 *
 * Small, and worth their own tests because a signature depends on them: what a client signs has to
 * be byte-for-byte what it sends, and node's own URL parser normalises a default port away - which
 * is exactly the difference that would make a signature fail on arrival with nothing to say why.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorityOf, hostHeaderOf, schemeOf, stripTrailingSlash } from "../src/url.js";

describe("stripTrailingSlash", () => {
  it("picks one spelling of the same server", () => {
    assert.equal(stripTrailingSlash("https://euclid.example.com/"), "https://euclid.example.com");
    assert.equal(stripTrailingSlash("https://euclid.example.com"), "https://euclid.example.com");
  });
});

describe("schemeOf", () => {
  it("reads the scheme, lowercased", () => {
    assert.equal(schemeOf("HTTPS://euclid.example.com"), "https");
    assert.equal(schemeOf("http://127.0.0.1:8080"), "http");
  });

  it("assumes https when a URL names no scheme", () => {
    assert.equal(schemeOf("euclid.example.com"), "https");
  });
});

describe("hostHeaderOf", () => {
  it("keeps a port that was written out, even the scheme's default", () => {
    assert.equal(hostHeaderOf("https://euclid.example.com:443"), "euclid.example.com:443");
    assert.equal(hostHeaderOf("http://127.0.0.1:8080/"), "127.0.0.1:8080");
  });

  it("omits a port that was not written out", () => {
    assert.equal(hostHeaderOf("https://euclid.example.com"), "euclid.example.com");
  });

  it("drops userinfo and lowercases the host", () => {
    assert.equal(hostHeaderOf("https://jens:secret@EUCLID.example.com/x"), "euclid.example.com");
  });

  it("stops at the path, the query and the fragment", () => {
    assert.equal(hostHeaderOf("https://euclid.example.com/path?q=1#f"), "euclid.example.com");
  });
});

describe("authorityOf", () => {
  it("drops the default port, which RFC 9421 §2.2.3 requires", () => {
    assert.equal(authorityOf("https://euclid.example.com:443"), "euclid.example.com");
    assert.equal(authorityOf("http://euclid.example.com:80"), "euclid.example.com");
  });

  it("keeps a port that is not the default", () => {
    assert.equal(authorityOf("https://euclid.example.com:8443"), "euclid.example.com:8443");
    assert.equal(authorityOf("http://127.0.0.1:8080"), "127.0.0.1:8080");
  });

  it("differs from the Host header exactly where the port is the scheme's own", () => {
    const url = "https://euclid.example.com:443";
    assert.notEqual(authorityOf(url), hostHeaderOf(url));
    assert.equal(authorityOf("https://euclid.example.com"), hostHeaderOf("https://euclid.example.com"));
  });
});
