/**
 * Small URL helpers, kept in one place because a signature depends on getting them right.
 *
 * `host` is a signed header under both schemes, and `@authority` is a signed component under
 * RFC 9421. If what a client signs is not byte-for-byte what it sends, the signature fails on
 * arrival and the failure says nothing about why - so the value that goes into the signature and
 * the value that goes on the wire are computed here, once, by the same function.
 *
 * Parsed by hand rather than with `new URL()`, which normalises a default port away: euclid's
 * server compares the Host header it received against the one the signature covers, so
 * `https://host:443` has to keep the port it was written with.
 */

/** `https://host/` and `https://host` name the same server; this picks the second spelling. */
export function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** The URL's scheme, lowercase, defaulting to https. */
export function schemeOf(url: string): string {
  const separator = url.indexOf("://");
  return separator < 0 ? "https" : url.slice(0, separator).toLowerCase();
}

/**
 * The `Host` header for this URL: the authority as written, minus any userinfo.
 *
 * Deliberately preserves a port that was written out even when it is the scheme's default, and
 * omits one that was not. The header is sent explicitly rather than left to node's http client,
 * because that omits a default port and a signature made over the other spelling would not verify.
 */
export function hostHeaderOf(url: string): string {
  const separator = url.indexOf("://");
  const rest = separator < 0 ? url : url.slice(separator + 3);
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  const at = authority.lastIndexOf("@");
  return (at < 0 ? authority : authority.slice(at + 1)).toLowerCase();
}

/**
 * The RFC 9421 `@authority`: the host header, minus the port when it is the scheme's default.
 *
 * §2.2.3 requires the default port to be dropped, which is why this is not simply the Host header.
 */
export function authorityOf(url: string): string {
  const host = hostHeaderOf(url);
  const scheme = schemeOf(url);
  const defaultPort = scheme === "https" ? ":443" : scheme === "http" ? ":80" : "";
  return defaultPort && host.endsWith(defaultPort) ? host.slice(0, -defaultPort.length) : host;
}
