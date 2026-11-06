import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { errors } from "../core/errors.js";

/**
 * AES-256-GCM envelope encryption for stored credentials.
 *
 * The additional authenticated data binds each ciphertext to the organisation,
 * provider and owner it belongs to, so a row copied to another tenant, or moved
 * between providers, fails to decrypt instead of silently authorising the wrong
 * user. Keys are 32 bytes, base64 or hex encoded.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("Credential encryption key must decode to exactly 32 bytes");
    }
    this.key = key;
  }

  static decode(value: string): Buffer {
    const trimmed = value.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
    return Buffer.from(trimmed, "base64");
  }

  /** Returns null when no key is configured; callers must then fail closed. */
  static from(value: string | null | undefined): SecretBox | null {
    if (!value) return null;
    if (!/^(?:[0-9a-f]{64}|[A-Za-z0-9+/=_-]{40,})$/i.test(value.trim())) {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY is not valid base64 or hex");
    }
    return new SecretBox(SecretBox.decode(value));
  }

  private aad(context: string): Buffer {
    return Buffer.from(`talisman:${VERSION}:${context}`, "utf8");
  }

  seal(plaintext: string, context: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  open(sealed: SealedSecret, context: string): string {
    const iv = Buffer.from(sealed.iv, "base64");
    const tag = Buffer.from(sealed.tag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw errors.forbidden("Stored credential is malformed");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(this.aad(context));
    decipher.setAuthTag(tag);
    try {
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, "base64")),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    } catch {
      // Wrong key, tampered ciphertext, or a row moved to another tenant.
      throw errors.forbidden("Stored credential could not be decrypted");
    }
  }
}
