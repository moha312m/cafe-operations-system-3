import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { resolveAuthSecret } from "@/lib/auth";

// Symmetric encryption for third-party credentials stored in the database
// (today: the WhatsApp Business access token). AES-256-GCM, so a tampered
// ciphertext fails to open instead of decrypting to garbage.
//
// The key comes from INTEGRATIONS_ENCRYPTION_KEY, or — when that is unset —
// from AUTH_SECRET, which production already refuses to run without. Changing
// whichever one is in use makes stored credentials unreadable; they then have
// to be entered again, which is the safe failure.

const VERSION = "v1";

function key(): Buffer {
  const dedicated = process.env.INTEGRATIONS_ENCRYPTION_KEY ?? "";
  if (process.env.NODE_ENV === "production" && dedicated && dedicated.length < 32) {
    throw new Error("INTEGRATIONS_ENCRYPTION_KEY_TOO_WEAK");
  }
  const material = dedicated || resolveAuthSecret();
  return createHash("sha256").update(`cafeops-integrations:${material}`).digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

/** Throws `SECRET_UNREADABLE` — never the value — when the box will not open. */
export function openSecret(sealed: string): string {
  try {
    const [version, iv, tag, body] = sealed.split(":");
    if (version !== VERSION || !iv || !tag || !body) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("SECRET_UNREADABLE");
  }
}
