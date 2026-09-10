/**
 * Reading fields out of a server response, defensively.
 *
 * Every response type in this package parses the same way: a field the server did not send reads as
 * an empty string, an empty array or a zero rather than throwing. A client that insisted on a field
 * being there would break on the release that adds one - the parse would reach a document shaped
 * slightly differently from the one it was written against - which is the failure mode these
 * helpers exist to avoid.
 */

/** The document as an object, or an empty one when it is anything else. */
export function object(document: unknown): Record<string, unknown> {
  return document !== null && typeof document === "object" && !Array.isArray(document)
    ? (document as Record<string, unknown>)
    : {};
}

/** A string field, empty when absent or null. */
export function text(document: unknown, name: string): string {
  const value = object(document)[name];
  return typeof value === "string" ? value : "";
}

/** A boolean field, `fallback` when absent or not a boolean. */
export function flag(document: unknown, name: string, fallback = false): boolean {
  const value = object(document)[name];
  return typeof value === "boolean" ? value : fallback;
}

/** A number field, zero when absent or not a number. */
export function number(document: unknown, name: string): number {
  const value = object(document)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** An array of strings, empty when absent, with anything that is not a string left out. */
export function strings(document: unknown, name: string): string[] {
  const value = object(document)[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** An array of sub-documents, empty when absent. The caller parses each one. */
export function documents(document: unknown, name: string): unknown[] {
  const value = object(document)[name];
  return Array.isArray(value) ? value : [];
}
