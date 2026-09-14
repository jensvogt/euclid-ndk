/**
 * The shapes more than one euclid module speaks.
 *
 * {@link Variant} is here rather than in the module that needed it first for the same reason the
 * server keeps it in `Euclid::Dto::COM`: a queue message attribute, a topic message attribute and a
 * storage object attribute are the same typed value on the wire.
 *
 * {@link Subscription} is here for a plainer reason - ESM and ENS answer with the same four fields,
 * because both are saying the same thing: messages from this source go to that target from now on.
 */

import { object, text } from "./json.js";

/**
 * What a message is delivered at, and the only three values euclid accepts.
 *
 * Shared for the same reason {@link Variant} is: a queue message, a topic message and the `priority`
 * system attribute of a stored object all mean the same thing by it.
 */
export const PRIORITY_LOW = "LOW";
export const PRIORITY_MEDIUM = "MEDIUM";
export const PRIORITY_HIGH = "HIGH";

/**
 * What a subscription delivers to: a queue...
 *
 * Shared by ESM and ENS because the server's subscription is: both name a source, a target and which
 * of these two the target is.
 */
export const QUEUE = "SQS";
/** ...or a topic. The two name different modules, and this is what says which. */
export const TOPIC = "SNS";

/**
 * The namespace that means "every namespace of the account" on the actions that take one as a filter.
 *
 * Empty rather than absent, because the server reads the two the same way: a blanket purge is scoped by the
 * account and region it was given, and narrowed by a namespace only when one is named. Spelled out because
 * "" is the one value whose meaning here is the opposite of narrow.
 */
export const EVERY_NAMESPACE = "";

/** The type tags `Euclid::Dto::COM::Variant` round-trips a value through. */
export const VARIANT_INT = "int";
export const VARIANT_LONG = "long";
export const VARIANT_DOUBLE = "double";
export const VARIANT_FLOAT = "float";
export const VARIANT_BOOL = "bool";
export const VARIANT_STRING = "string";
export const VARIANT_BINARY = "binary";

/**
 * A typed value: what it is, and what it holds.
 *
 * The tag is what makes the round trip lossless. JSON has one number type and euclid's server has
 * several, so an attribute stored as a `long` would come back as a `double` - or an `int`, depending
 * on the reader - if the type travelled only in the shape of the value.
 *
 * `binary` is base64 on the wire and a {@link Buffer} here; {@link toVariant} decodes it and
 * {@link variantToJson} encodes it again, so a caller never sees the encoding.
 */
export interface Variant {
  type: string;
  value: unknown;
}

/** What {@link variantOf} takes: a plain value to be tagged, or a variant that already is. */
export type VariantInput = Variant | string | number | boolean | Uint8Array;

/**
 * A variant from a plain JavaScript value, tagged with the type euclid stores it under.
 *
 * A whole number becomes a `long` rather than an `int` because JavaScript has one number type and
 * the 64-bit tag is the one that holds all of the integers it can represent exactly; anything else
 * numeric becomes a `double` for the same reason.
 *
 * A {@link Variant} is returned as it is, so a caller may mix the two spellings in the same
 * attribute map - and reach for the explicit one exactly when it wants a tag other than the obvious
 * one.
 *
 * @throws {TypeError} for a value with no euclid variant type, which a variant spelled out by hand
 *   is the way past.
 */
export function variantOf(value: VariantInput): Variant {
  if (isVariant(value)) return value;
  if (typeof value === "boolean") return { type: VARIANT_BOOL, value };
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? VARIANT_LONG : VARIANT_DOUBLE, value };
  }
  if (typeof value === "string") return { type: VARIANT_STRING, value };
  if (value instanceof Uint8Array) return { type: VARIANT_BINARY, value: Buffer.from(value) };
  throw new TypeError(
    `a ${typeof value} has no euclid variant type - pass a Variant with the tag it should carry`,
  );
}

/** This variant as the server reads it, with a `binary` value encoded as base64. */
export function variantToJson(variant: Variant): Record<string, unknown> {
  if (variant.type === VARIANT_BINARY && variant.value instanceof Uint8Array) {
    return { type: variant.type, value: Buffer.from(variant.value).toString("base64") };
  }
  return { type: variant.type, value: variant.value };
}

/** One variant as the server sent it. An unreadable one reads as an empty string value. */
export function toVariant(document: unknown): Variant {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    return { type: VARIANT_STRING, value: "" };
  }
  const type = text(document, "type");
  const value = (document as Record<string, unknown>)["value"];
  if (type === VARIANT_BINARY && typeof value === "string") {
    // Handed back as the text it arrived as rather than throwing: a caller that can make sense of it
    // is better served than one that gets an exception instead of the object the attribute hung off.
    return { type, value: isBase64(value) ? Buffer.from(value, "base64") : value };
  }
  return { type, value };
}

/** An object of variants keyed by name, empty when absent. */
export function toVariantMap(document: unknown): Record<string, Variant> {
  return Object.fromEntries(Object.entries(object(document)).map(([name, value]) => [name, toVariant(value)]));
}

/** An attribute map as the server reads it, taking plain values or variants. */
export function variantMapToJson(
  attributes: Record<string, VariantInput> | undefined,
): Record<string, Record<string, unknown>> {
  if (attributes === undefined) return {};
  return Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [name, variantToJson(variantOf(value))]),
  );
}

/**
 * A standing instruction to deliver what arrives at a source onward to a target.
 *
 * One shape for both modules that have them: a bucket's events going to a queue (ESM) and a topic's
 * messages going to a queue (ENS) differ in what is delivered, not in how the instruction is
 * described. `type` is {@link QUEUE} or {@link TOPIC}, and `ern` is the subscription's own - which is
 * what removing it takes.
 */
export interface Subscription {
  ern: string;
  sourceErn: string;
  type: string;
  targetErn: string;
  created: string;
  modified: string;
}

/** A new subscription, as the `subscribe` actions answer with it: the same, minus the timestamps. */
export interface SubscribeResult {
  ern: string;
  sourceErn: string;
  type: string;
  targetErn: string;
}

export function toSubscription(document: unknown): Subscription {
  return {
    ern: text(document, "ern"),
    sourceErn: text(document, "sourceErn"),
    type: text(document, "type"),
    targetErn: text(document, "targetErn"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toSubscribeResult(document: unknown): SubscribeResult {
  return {
    ern: text(document, "ern"),
    sourceErn: text(document, "sourceErn"),
    type: text(document, "type"),
    targetErn: text(document, "targetErn"),
  };
}

/** Whether this is already a variant rather than a value to be tagged as one. */
function isVariant(value: unknown): value is Variant {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    typeof (value as { type?: unknown }).type === "string" &&
    "value" in value
  );
}

/**
 * Whether a string is base64 at all.
 *
 * Checked rather than trusted because node's decoder silently drops what it cannot read, which would
 * turn a `binary` attribute that arrived mangled into a shorter buffer that looks fine.
 */
function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
