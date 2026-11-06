import type { LegalDocumentSet } from "./legalDocuments.js";
import type { ConsentMap } from "./schemas.js";
import type { ConsentType } from "./types.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";

export interface ValidatedGrant {
  consentType: ConsentType;
  documentVersion: string;
  documentHash: string;
  decision: "granted" | "denied";
}

/**
 * 送信された同意を現行法務文書と照合する（02 §5.1.1, BR-13）。
 * - 必須同意の欠落・accepted=false → 400
 * - documentVersion が現行版と不一致 → 412
 * - 任意同意（optional_analytics 等）は拒否を証跡として記録できる
 */
export function validateConsentSubmission(
  legalDocs: LegalDocumentSet,
  consents: ConsentMap,
): ValidatedGrant[] {
  const grants: ValidatedGrant[] = [];

  for (const required of legalDocs.requiredConsents) {
    const requiredDoc = legalDocs.documents[required];
    // 必須種別の文書/メタ欠落は設定不備。クライアント起因の 400/412 ではなく
    // サーバ障害として 500 にする（再同意を試みても自己解決不能なため）
    if (!requiredDoc?.version || !requiredDoc?.documentHash) {
      throw new ApiError(
        500,
        ErrorCodes.INTERNAL,
        "同意文書の設定が不完全です。",
      );
    }
    const submitted = consents[required];
    if (!submitted) {
      throw ApiError.validation([
        { field: `consents.${required}`, message: "必須の同意項目が未回答です。" },
      ]);
    }
    if (submitted.accepted !== true) {
      throw ApiError.validation([
        { field: `consents.${required}.accepted`, message: "必須項目への同意が必要です。" },
      ]);
    }
  }

  for (const [type, submitted] of Object.entries(consents)) {
    if (!submitted) continue;
    const consentType = type as ConsentType;
    const current = legalDocs.documents[consentType];
    if (!current) {
      throw ApiError.validation([
        { field: `consents.${consentType}`, message: "不明な同意種別です。" },
      ]);
    }
    if (!current.version || !current.documentHash) {
      throw new ApiError(
        500,
        ErrorCodes.INTERNAL,
        "同意文書の設定が不完全です。",
      );
    }
    if (submitted.documentVersion !== current.version) {
      throw ApiError.precondition(
        "同意文書の版が最新ではありません。最新の文書を確認してください。",
      );
    }
    grants.push({
      consentType,
      documentVersion: current.version,
      documentHash: current.documentHash,
      decision: submitted.accepted ? "granted" : "denied",
    });
  }
  return grants;
}
