/**
 * The shapes ESS sends back.
 *
 * Parsed the same defensive way as every other module's. One thing is deliberately absent from
 * {@link Secret}: the value. Every action but `get-secret` answers with a secret's metadata only, so a
 * listing, a rotation and a tag change can be logged, printed and passed around without any of them being
 * the thing that leaks it.
 */

import { number, object, stringMap, text } from "./json.js";

/**
 * A secret's metadata: everything about it except what it is.
 *
 * `version` is how many times the value has been replaced, and `rotated` when that last happened - which
 * together are what an audit of "has this been rotated since the incident" actually reads.
 */
export interface Secret {
  name: string;
  ern: string;
  description: string;
  /**
   * The EKM key the value is encrypted under. Deleting that key there is what makes this secret's value
   * unrecoverable, whatever ESS still says about it.
   */
  encryptionKeyErn: string;
  version: number;
  rotated: string;
  tags: Record<string, string>;
  created: string;
  modified: string;
}

/**
 * A secret, decrypted: its value, and the metadata that goes with it.
 *
 * The only shape in this SDK that carries a secret's value, and the only action that produces one.
 * Whatever a caller does with `value`, this object is the point at which the value entered the process -
 * which is worth knowing when deciding what to log.
 */
export interface SecretValue {
  value: string;
  secret: Secret;
}

/** The name and ERN of a deleted secret. */
export interface DeleteSecretResult {
  name: string;
  ern: string;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toSecret(document: unknown): Secret {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    description: text(document, "description"),
    encryptionKeyErn: text(document, "encryptionKeyErn"),
    version: number(document, "version"),
    rotated: text(document, "rotated"),
    tags: stringMap(document, "tags"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toSecretValue(document: unknown): SecretValue {
  return { value: text(document, "value"), secret: toSecret(object(document)["secret"]) };
}

export function toDeleteSecretResult(document: unknown): DeleteSecretResult {
  return { name: text(document, "name"), ern: text(document, "ern") };
}
