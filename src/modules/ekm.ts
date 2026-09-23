/**
 * EKM - euclid's key management module: encryption keys, and the certificates a deployment serves.
 *
 * One object, {@link EuclidEkm}, built from a session that has already logged in:
 *
 * ```ts
 * const ekm = session.ekm();
 * const key = await ekm.createKey({ description: "customer exports" });
 *
 * const sealed = await ekm.encrypt(key.name, "account 4711");
 * const plain = await ekm.decrypt(key.name, sealed);
 * ```
 *
 * Key material never leaves the server: {@link EuclidEkm.encrypt} and {@link EuclidEkm.decrypt} send the
 * bytes to the key rather than fetching the key to the bytes. That is what makes a key deletable as a
 * unit - and what makes deleting one final, since nothing anywhere else has a copy.
 *
 * A key is named two ways, and they are not interchangeable. `name` is the ID the server minted and is
 * what encrypts, decrypts and is deleted; the ERN is what revokes, describes and tags. Both are on every
 * {@link import("../dto/ekm.js").Key} a listing returns.
 *
 * `encrypt` and `decrypt` carry raw bytes rather than JSON, and present the session's bearer token for
 * the same reason ESM's transfer actions do - see {@link ModuleClient}.
 */

import { toPage, type Page } from "../dto/eam.js";
import {
  toCertificate,
  toCreateKeyResult,
  toDeleteCertificateResult,
  toDeleteKeyResult,
  toKey,
  toKeyDescriptionResult,
  toRevokeKeyResult,
  type Certificate,
  type CreateKeyResult,
  type DeleteCertificateResult,
  type DeleteKeyResult,
  type Key,
  type KeyDescriptionResult,
  type RevokeKeyResult,
} from "../dto/ekm.js";
import { EuclidServiceError } from "../errors.js";
import { listPayload, ModuleClient, type Bytes, type ListOptions } from "./base.js";
import type { EuclidSession } from "./eam.js";

export const TARGET = "ekm";

/** The only algorithm the server generates so far; anything else is refused with HTTP 400. */
export const AES = "AES";

/**
 * The key length this SDK asks for when the caller does not say. 128 is the other one the server
 * accepts, and what euclid-jdk's no-argument `createKey()` mints; 256 is what euclid itself creates when
 * a bucket asks to be encrypted, which is the better default to inherit.
 */
export const DEFAULT_KEY_LENGTH = 256;

/**
 * How long a key scheduled for deletion stays alive by default, in days. The server's own default when
 * the field is left out, restated here because it is the one number in this module that decides whether
 * a mistake can be caught.
 */
export const DEFAULT_PENDING_WINDOW_DAYS = 7;

/** The actions that carry raw bytes rather than JSON. */
export const BYTE_ACTIONS = ["encrypt", "decrypt"];

/** What a key is created as, and what it says it is for. */
export interface CreateKeyOptions {
  /** {@link AES}; the server generates nothing else so far. */
  algorithm?: string;
  /** 128 or 256 bits. */
  length?: number;
  /** What the key is for. Free text, never interpreted - and worth supplying; see {@link EuclidEkm.createKey}. */
  description?: string;
}

/** What a generated certificate is valid for, and for how long. */
export interface CreateCertificateOptions {
  /**
   * The certificate's common name. Defaults to the name it is stored under: for a listener certificate
   * those are usually the same word, and a certificate with an empty subject is refused by everything
   * that reads it.
   */
  commonName?: string;
  /** The other names it should be valid for. */
  subjectAltNames?: Iterable<string>;
  /** How long it is valid, in days, or left out for the server's default of 825. */
  validDays?: number;
  /** The RSA key length, or left out for the server's default of 2048. */
  keyBits?: number;
  description?: string;
}

/**
 * EKM's operations, on the credentials of the session that created it.
 *
 * Built by {@link EuclidSession.ekm} rather than directly, so that it shares that session's identity,
 * namespace and connection settings - and follows them as they change.
 */
export class EuclidEkm extends ModuleClient {
  constructor(session: EuclidSession) {
    super(session, { target: TARGET, byteActions: BYTE_ACTIONS });
  }

  // -- keys ------------------------------------------------------------------------------------

  /**
   * Creates a key, and answers with the ID the server minted for it.
   *
   * The description is worth supplying. A key is identified by that generated ID, which says nothing
   * about what the key protects, and a key outlives the reason it was made - so months later this is the
   * only thing that answers whether it can be deleted, and deleting one is not a mistake that can be
   * undone.
   */
  async createKey(options: CreateKeyOptions = {}): Promise<CreateKeyResult> {
    return toCreateKeyResult(
      await this.call("create-key", {
        algorithm: options.algorithm ?? AES,
        length: options.length ?? DEFAULT_KEY_LENGTH,
        description: options.description ?? "",
      }),
    );
  }

  /** One page of keys, and how many exist in total. Never their material. */
  async listKeys(options: ListOptions = {}): Promise<Page<Key>> {
    return toPage(await this.call("list-keys", listPayload(options, "name")), "keys", toKey);
  }

  /**
   * One key, by name or by ERN. Its description, never its material.
   *
   * What comes back is exactly what {@link listKeys} describes each of its own with - name, ERN,
   * description, algorithm, length, status, tags and timestamps - so this is the single-key form of
   * a listing rather than another view of one.
   *
   * A value starting with `ern:` is taken as an ERN and names one key in the installation; anything
   * else is a name and is resolved in the session's own account and namespace, the pair
   * {@link createKey} built the ERN from. A key that exists only in another namespace is a 404 when
   * asked for by name.
   */
  async getKey(nameOrErn: string): Promise<Key> {
    const payload = nameOrErn.startsWith("ern:") ? { ern: nameOrErn } : { name: nameOrErn };
    return toKey(((await this.call("get-key", payload)) as { key?: unknown }).key);
  }

  /**
   * Whether a key exists.
   *
   * Three answers, not two. `true` and `false` are the ones a caller expects; the third is a
   * {@link EuclidServiceError}, and it is the one that matters. An expired session, an unreachable
   * gateway or a refused permission is not the same as "not there", and resolving to `false` for
   * them would have callers deleting and recreating things over an outage. Only HTTP 404 - the
   * answer that actually says it is absent - becomes `false`; everything else rejects.
   *
   * Reads the key's description, never its material. A revoked or pending-deletion key still
   * exists and this resolves `true` for it; {@link getKey} carries the status that tells those
   * apart.
   *
   * @param nameOrErn name of the key in the session's account and namespace, or a full ERN.
   */
  async existsKey(nameOrErn: string): Promise<boolean> {
    try {
      await this.getKey(nameOrErn);
    } catch (error) {
      if (error instanceof EuclidServiceError && error.status === 404) {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Schedules a key for deletion, and answers with the date it goes for good.
   *
   * Scheduled rather than immediate, because this is the one action here that cannot be undone by any
   * other: everything the key encrypted - a bucket's objects, a secret's value - becomes unreadable when
   * the date passes, and the window is the only chance anybody gets to notice. A key inside its window
   * still decrypts.
   *
   * Takes the key's ID rather than its ERN, as {@link encrypt} does.
   */
  async deleteKey(keyId: string, pendingWindowInDays = DEFAULT_PENDING_WINDOW_DAYS): Promise<DeleteKeyResult> {
    return toDeleteKeyResult(await this.call("delete-key", { keyId, pendingWindowInDays }));
  }

  /**
   * Stops a key encrypting anything further, without touching what it already wrote.
   *
   * The difference from {@link deleteKey} is that nothing becomes unreadable: a revoked key still
   * decrypts, so this is what to reach for when a key should no longer be used but the data under it is
   * still wanted.
   *
   * Takes the key's ERN rather than its ID.
   */
  async revokeKey(ern: string): Promise<RevokeKeyResult> {
    return toRevokeKeyResult(await this.call("revoke-key", { ern }));
  }

  /**
   * Changes what a key says it is for.
   *
   * Only the description changes: the material, algorithm, length, status and any scheduled deletion are
   * untouched, so describing a key neither prolongs nor shortens its life. An empty string clears the
   * description rather than leaving it alone - otherwise there would be no way to remove one.
   *
   * Takes the key's ERN rather than its ID.
   */
  async setKeyDescription(ern: string, description: string): Promise<KeyDescriptionResult> {
    return toKeyDescriptionResult(await this.call("set-key-description", { ern, description }));
  }

  /**
   * Tags a key. The tag is upserted, so one already there has its value replaced - EKM has no separate
   * set-key-tag action to distinguish the two.
   */
  async addKeyTag(ern: string, key: string, value: string): Promise<void> {
    await this.call("add-key-tag", { ern, key, value });
  }

  /** Removes a tag from a key. */
  async deleteKeyTag(ern: string, key: string): Promise<void> {
    await this.call("delete-key-tag", { ern, key });
  }

  // -- using a key -----------------------------------------------------------------------------

  /**
   * Encrypts bytes with a key the server holds, and answers with `IV || ciphertext || tag`.
   *
   * Those are the exact bytes {@link decrypt} takes back; nothing here needs to be unpacked or
   * re-assembled. Only a key whose status is `AVAILABLE` encrypts - a revoked one, or one scheduled for
   * deletion, is refused with HTTP 403.
   *
   * Takes the key's ID - the `name` {@link createKey} answered with - rather than its ERN.
   */
  async encrypt(keyId: string, plaintext: Bytes): Promise<Buffer> {
    return this.#transform("encrypt", keyId, plaintext);
  }

  /**
   * Decrypts what {@link encrypt} produced.
   *
   * Works for a revoked key and for one scheduled for deletion, right up until its deletion date passes -
   * which is the whole difference between revoking a key and deleting it.
   */
  async decrypt(keyId: string, ciphertext: Buffer | Uint8Array): Promise<Buffer> {
    return this.#transform("decrypt", keyId, ciphertext);
  }

  /**
   * encrypt and decrypt differ only in direction: both send opaque bytes, name their key in a header, and
   * answer with opaque bytes.
   */
  async #transform(action: string, keyId: string, data: Bytes): Promise<Buffer> {
    const response = await this.postBytes(action, data, { "x-euclid-key-id": keyId });
    if (!response.ok) throw new EuclidServiceError(TARGET, action, response.status, response.text);
    return response.content;
  }

  // -- certificates ----------------------------------------------------------------------------

  /**
   * Stores a certificate somebody else issued, together with the private key that proves it.
   *
   * Both halves are required and the server checks them against each other: a certificate stored with a
   * key that is not its own is accepted silently by every step after this one and only shows itself as a
   * handshake that fails for every caller. A mismatch is HTTP 400 here instead.
   *
   * The private key stays with EKM. It goes in and is never handed back - no action returns one.
   */
  async importCertificate(
    name: string,
    certificatePem: string,
    privateKeyPem: string,
    description = "",
  ): Promise<Certificate> {
    return this.#certificate("import-certificate", {
      name,
      description,
      certificate: certificatePem,
      privateKey: privateKeyPem,
    });
  }

  /**
   * Generates a self-signed certificate, for an installation that has to serve HTTPS before anybody has
   * bought it a real one.
   *
   * Nobody has vouched for the result - {@link import("../dto/ekm.js").Certificate.generated} says so,
   * and a client still has to be told to trust it.
   */
  async createCertificate(name: string, options: CreateCertificateOptions = {}): Promise<Certificate> {
    const payload: Record<string, unknown> = {
      name,
      description: options.description ?? "",
      commonName: options.commonName ?? "",
      subjectAltNames: [...(options.subjectAltNames ?? [])],
    };
    // Left out rather than sent as zero, so the server's own defaults - 825 days, 2048 bits - apply.
    if (options.validDays) payload["validDays"] = options.validDays;
    if (options.keyBits) payload["keyBits"] = options.keyBits;
    return this.#certificate("create-certificate", payload);
  }

  /** One stored certificate, by name. The PEM comes back; the private key does not. */
  async getCertificate(name: string): Promise<Certificate> {
    return this.#certificate("get-certificate", { name });
  }

  /** One page of certificates, and how many exist in total. */
  async listCertificates(options: ListOptions = {}): Promise<Page<Certificate>> {
    const response = await this.call("list-certificates", listPayload(options, "name"));
    return toPage(response, "certificates", toCertificate);
  }

  /**
   * Deletes a certificate, outright and with no grace period.
   *
   * Unlike {@link deleteKey} this needs none: nothing becomes unreadable, because a certificate is
   * public. A listener already serving it keeps the copy it loaded until it is restarted, which is what
   * makes this recoverable - import a replacement under the same name.
   */
  async deleteCertificate(name: string): Promise<DeleteCertificateResult> {
    return toDeleteCertificateResult(await this.call("delete-certificate", { name }));
  }

  /** The three actions that answer with one certificate, wrapped in a `certificate` field. */
  async #certificate(action: string, payload: Record<string, unknown>): Promise<Certificate> {
    const response = await this.call(action, payload);
    return toCertificate(response["certificate"]);
  }

  // -- monitoring ------------------------------------------------------------------------------

  /**
   * EKM's own metrics, as the server collects them. Answered unparsed - the shape belongs to the
   * monitoring module rather than to EKM.
   */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call("get-metrics");
  }
}
