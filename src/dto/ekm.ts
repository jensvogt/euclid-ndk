/**
 * The shapes EKM sends back.
 *
 * Parsed the same defensive way as every other module's - see {@link import("./json.js")}. Field names
 * are the server's (`dto/include/euclid/dto/ekm`), converted to camelCase.
 *
 * Nothing here carries key material: a key's bytes never leave the server, which is the point of having
 * a key module rather than a table of keys. What a caller gets is a handle - the key's name to encrypt
 * with, its ERN to administer - and the description it was given, which is what answers, months later,
 * whether the key can be deleted.
 */

import { flag, number, stringMap, strings, text } from "./json.js";

// -- resources -----------------------------------------------------------------------------------

/**
 * An encryption key, described rather than disclosed.
 *
 * `name` is the ID the server minted, and what {@link import("../modules/ekm.js").EuclidEkm.encrypt}
 * takes; `ern` is what the administrative actions take. The two are not interchangeable, which is the
 * one thing about EKM worth remembering.
 */
export interface Key {
  name: string;
  ern: string;
  description: string;
  algorithm: string;
  length: number;
  /**
   * `AVAILABLE`, `REVOKED` or `PENDING_DELETION`. Only an available key encrypts; a revoked one and one
   * scheduled for deletion still decrypt what they wrote.
   */
  status: string;
  tags: Record<string, string>;
  /** When a key scheduled for deletion goes for good. Empty for a key that is not. */
  deletionDate: string;
  created: string;
  modified: string;
}

/**
 * A stored X.509 certificate.
 *
 * `certificate` is the PEM, which is public and comes back. The private key does not: it goes in once
 * and no action returns it, so there is no field for it here.
 */
export interface Certificate {
  name: string;
  ern: string;
  description: string;
  /** The PEM-encoded certificate. */
  certificate: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  fingerprint: string;
  subjectAltNames: string[];
  /**
   * Whether euclid generated and signed this itself, in which case nobody else has vouched for it and a
   * client still has to be told to trust it.
   */
  generated: boolean;
  notBefore: string;
  notAfter: string;
  tags: Record<string, string>;
  created: string;
  modified: string;
}

// -- what the actions answer with ------------------------------------------------------------------

/** A newly created key. `name` is the ID the server minted - the only handle to it. */
export interface CreateKeyResult {
  name: string;
  ern: string;
  description: string;
  algorithm: string;
  length: number;
  status: string;
}

/**
 * A key scheduled for deletion, and the date it goes for good.
 *
 * Scheduled rather than deleted: everything the key encrypted becomes unreadable when that date passes,
 * and the window is the only chance anybody gets to notice.
 */
export interface DeleteKeyResult {
  name: string;
  ern: string;
  deletionDate: string;
  status: string;
}

/** A revoked key: it encrypts nothing further, and still decrypts what it wrote. */
export interface RevokeKeyResult {
  name: string;
  ern: string;
  status: string;
}

/** A key as it now reads. Only the description changed - not the material, and not the life. */
export interface KeyDescriptionResult {
  name: string;
  ern: string;
  description: string;
}

/** The name and ERN of a deleted certificate. */
export interface DeleteCertificateResult {
  name: string;
  ern: string;
}

// -- parsers ---------------------------------------------------------------------------------------

export function toKey(document: unknown): Key {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    description: text(document, "description"),
    algorithm: text(document, "algorithm"),
    length: number(document, "length"),
    status: text(document, "status"),
    tags: stringMap(document, "tags"),
    deletionDate: text(document, "deletionDate"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toCertificate(document: unknown): Certificate {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    description: text(document, "description"),
    certificate: text(document, "certificate"),
    subject: text(document, "subject"),
    issuer: text(document, "issuer"),
    serialNumber: text(document, "serialNumber"),
    fingerprint: text(document, "fingerprint"),
    subjectAltNames: strings(document, "subjectAltNames"),
    generated: flag(document, "generated"),
    notBefore: text(document, "notBefore"),
    notAfter: text(document, "notAfter"),
    tags: stringMap(document, "tags"),
    created: text(document, "created"),
    modified: text(document, "modified"),
  };
}

export function toCreateKeyResult(document: unknown): CreateKeyResult {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    description: text(document, "description"),
    algorithm: text(document, "algorithm"),
    length: number(document, "length"),
    status: text(document, "status"),
  };
}

export function toDeleteKeyResult(document: unknown): DeleteKeyResult {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    deletionDate: text(document, "deletionDate"),
    status: text(document, "status"),
  };
}

export function toRevokeKeyResult(document: unknown): RevokeKeyResult {
  return { name: text(document, "name"), ern: text(document, "ern"), status: text(document, "status") };
}

export function toKeyDescriptionResult(document: unknown): KeyDescriptionResult {
  return {
    name: text(document, "name"),
    ern: text(document, "ern"),
    description: text(document, "description"),
  };
}

export function toDeleteCertificateResult(document: unknown): DeleteCertificateResult {
  return { name: text(document, "name"), ern: text(document, "ern") };
}
