import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

/**
 * スナップショットカーソル（Firestore docパス）の不透明化。
 * docパスは内部IDを含み、ocrJobsでは旧形式IDがuploadIdそのもののため
 * そのまま返すとFR-O04の識別子非公開に違反する。AES-256-GCMで暗号化し、
 * 改竄・他用途カーソルは復号失敗として空ページに倒す（fail-closed）。
 */
const AAD = Buffer.from("opaque-cursor-v1", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;

function cursorKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("cursor-key-v1").digest();
}

export function encodeOpaqueCursor(secret: string, docPath: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", cursorKey(secret), iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(docPath, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url");
}

/** 復号できるdocパスを返す。改竄・形式不正・異種用途は null（呼び出し側で空ページ）。 */
export function decodeOpaqueCursor(
  secret: string,
  token: string,
): string | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < IV_BYTES + TAG_BYTES + 1) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cursorKey(secret),
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
