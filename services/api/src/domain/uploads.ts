import type { UploadSourcePurpose, UploadStatus } from "./types.js";

/** FR-M01 / 02 §7: JPEG/PNG/PDF、10MB まで。PDF のページ上限(暫定5)はOCR前処理で検査する。 */
export const UPLOAD_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
] as const;
export type UploadMimeType = (typeof UPLOAD_ALLOWED_MIME_TYPES)[number];

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export const UPLOAD_SOURCE_PURPOSES: readonly UploadSourcePurpose[] = [
  "prescription_photo",
  "medication_notebook",
];

export function isUploadMimeType(value: string): value is UploadMimeType {
  return (UPLOAD_ALLOWED_MIME_TYPES as readonly string[]).includes(value);
}

/** objectPath に PII を含めない（04 §5.7）。uid は不透明IDのため使用可。 */
export function uploadObjectPath(uid: string, uploadId: string): string {
  return `patient-uploads/${uid}/${uploadId}/original`;
}

const MAGIC_SIGNATURES: Record<UploadMimeType, number[]> = {
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
};

/**
 * 宣言 MIME とファイル先頭のマジックバイトを照合する（SEC-07: 拡張子偽装の拒否）。
 * prefix が署名より短い場合は判定不能として false を返す。
 */
export function matchesMagicBytes(
  prefix: Uint8Array,
  mimeType: UploadMimeType,
): boolean {
  const sig = MAGIC_SIGNATURES[mimeType];
  if (prefix.length < sig.length) return false;
  return sig.every((b, i) => prefix[i] === b);
}

/** 読み取り系で使う、クライアントに返してよい状態か。 */
export function isTerminalUploadStatus(status: UploadStatus): boolean {
  return status === "rejected" || status === "expired" || status === "deleted";
}
