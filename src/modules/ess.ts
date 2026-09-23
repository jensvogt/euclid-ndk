/**
 * ESS - euclid's secret store: values kept encrypted under an EKM key, fetched one at a time.
 *
 * One object, {@link EuclidEss}, built from a session that has already logged in:
 *
 * ```ts
 * const ess = session.ess();
 * await ess.createSecret("db-password", "hunter2", { description: "the reporting database" });
 *
 * const password = (await ess.getSecret("db-password")).value;
 * ```
 *
 * The value is encrypted with EKM before it is stored, so a secret's life is tied to a key's: deleting that
 * key there is what makes the value unrecoverable, whatever ESS still says about it.
 *
 * Only {@link EuclidEss.getSecret} answers with a value. Everything else - listing, rotating, tagging -
 * answers with metadata alone, so those calls can be logged and printed without being the thing that leaks
 * it.
 */

import { toPage, type Page } from "../dto/eam.js";
import {
  toDeleteSecretResult,
  toSecret,
  toSecretValue,
  type DeleteSecretResult,
  type Secret,
  type SecretValue,
} from "../dto/ess.js";
import { listPayload, ModuleClient, type ListOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ess";

/** What a secret is stored with besides its value. */
export interface CreateSecretOptions {
  description?: string;
  /**
   * The EKM key to encrypt it under. Left empty, the server picks the account's own; naming one puts this
   * secret's life in the hands of that key, which is the point when a set of secrets should be revocable
   * together.
   */
  keyErn?: string;
}

/**
 * What an update changes - and only what it names.
 *
 * The distinction the server draws is between a field being sent and not being sent rather than between its
 * values, so leaving `description` out leaves the stored description alone while passing `""` clears it.
 * The same goes for `value`: leaving it out leaves it, and an empty string stores an empty one, because an
 * empty string is a value somebody may legitimately have.
 *
 * Naming a `keyErn` re-encrypts the value under that key, which is how a secret is moved off a key that is
 * being retired.
 */
export interface UpdateSecretChanges {
  value?: string;
  description?: string;
  keyErn?: string;
}

/**
 * ESS's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.ess} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEss extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET });
  }

  /** Stores a secret, and answers with its metadata - never the value it was just given. */
  async createSecret(name: string, value: string, options: CreateSecretOptions = {}): Promise<Secret> {
    return this.#secret("create-secret", {
      name,
      value,
      description: options.description ?? "",
      keyErn: options.keyErn ?? "",
    });
  }

  /**
   * One secret, decrypted: `value` is the value, `secret` the metadata around it.
   *
   * The only call in this SDK that answers with a secret's value, and so the point at which the value
   * enters the process.
   */
  async getSecret(name: string): Promise<SecretValue> {
    return toSecretValue(await this.call("get-secret", { name }));
  }

  /** One page of secrets, and how many exist in total. Metadata only. */
  async listSecrets(options: ListOptions = {}): Promise<Page<Secret>> {
    return toPage(await this.call("list-secrets", listPayload(options, "name")), "secrets", toSecret);
  }

  /**
   * Whether a secret exists.
   *
   * Three answers, not two. `true` and `false` are the ones a caller expects; the third is an
   * `EuclidServiceError`, and it is the one that matters. An expired session, an unreachable
   * gateway or a refused permission is not the same as "not there", and resolving to `false` for
   * them would have callers recreating secrets over an outage.
   *
   * Asks {@link listSecrets} rather than {@link getSecret}, deliberately. `get-secret` answers with
   * the decrypted value, so asking it whether a secret exists would mean holding `ess:get-secret` -
   * permission to read the password rather than to know the name is taken - decrypting it, carrying
   * the plaintext back across the wire, and leaving an audit entry indistinguishable from somebody
   * actually reading it. None of that is any part of the question. This needs `ess:list-secrets` and
   * never touches the value.
   *
   * The whole matching page is asked for rather than the default, because the prefix also matches
   * longer names - `"db-password"` matches `"db-password-old"` too - and a name could otherwise be
   * called absent because longer ones crowded it off page one.
   *
   * @param name name of the secret, matched exactly.
   */
  async existsSecret(name: string): Promise<boolean> {
    const matching = await this.listSecrets({ prefix: name, pageSize: 0 });
    return matching.items.some((secret) => secret.name === name);
  }

  /** Replaces a secret's value, which is what a rotation is and what bumps its version. */
  async rotateSecret(name: string, value: string): Promise<Secret> {
    return this.updateSecret(name, { value });
  }

  /**
   * Changes a secret that already exists: its value, its description, the key it is under, or any
   * combination. Only what `changes` names changes - see {@link UpdateSecretChanges}.
   *
   * @throws {Error} if none of the three was named, which the server refuses anyway - this just says so
   *   before the round trip.
   */
  async updateSecret(name: string, changes: UpdateSecretChanges): Promise<Secret> {
    if (changes.value === undefined && changes.description === undefined && !changes.keyErn) {
      throw new Error("updateSecret needs a value, a description or a keyErn to change");
    }

    const payload: Record<string, unknown> = { name };
    if (changes.value !== undefined) payload["value"] = changes.value;
    if (changes.description !== undefined) payload["description"] = changes.description;
    // Truthy rather than defined: there is no such thing as moving a secret onto the empty key, so an
    // empty string here means "leave it where it is" rather than a value to send.
    if (changes.keyErn) payload["keyErn"] = changes.keyErn;
    return this.#secret("update-secret", payload);
  }

  /** Deletes a secret, outright. The value is gone; the key it was under is left alone. */
  async deleteSecret(name: string): Promise<DeleteSecretResult> {
    return toDeleteSecretResult(await this.call("delete-secret", { name }));
  }

  /**
   * Tags a secret, and answers with it as it now reads. A tag already there has its value replaced - ESS
   * has no separate set-secret-tag action to distinguish the two.
   */
  async addSecretTag(name: string, key: string, value: string): Promise<Secret> {
    return this.#secret("add-secret-tag", { name, key, value });
  }

  /** Removes a tag from a secret, and answers with it as it now reads. */
  async deleteSecretTag(name: string, key: string): Promise<Secret> {
    return this.#secret("delete-secret-tag", { name, key });
  }

  /**
   * ESS's own metrics, as the server collects them. Answered unparsed - the shape belongs to the monitoring
   * module rather than to ESS.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }

  /** The actions that answer with one secret's metadata, wrapped in a `secret` field. */
  async #secret(action: string, payload: Record<string, unknown>): Promise<Secret> {
    const response = await this.call(action, payload);
    return toSecret(response["secret"]);
  }
}
