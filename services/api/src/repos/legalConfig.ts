import type { LegalDocumentSet } from "../domain/legalDocuments.js";
import type { ConsentType } from "../domain/types.js";
import { CONSENT_TYPE_SET } from "../domain/types.js";
import { getDoc } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

const PATH = "appConfigs/publicLegalVersion";

/** appConfigs/publicLegalVersion の現行文書セットを読む。 */
export async function getLegalDocuments(
  db: FirestoreLike,
): Promise<LegalDocumentSet | undefined> {
  const r = await getDoc<{
    documents: LegalDocumentSet["documents"];
    requiredConsents: ConsentType[];
    updatedAt?: { toDate(): Date } | string;
  }>(db, PATH);
  if (!r.exists || !r.data) return undefined;
  const updated = r.data.updatedAt;
  // requiredConsents の非配列・空・未知種別は設定不備。空に正規化すると
  // 同意評価が空ループで vacuous pass（fail-open）するため、文書未設定と
  // 同じく undefined を返し各呼出側の fail-closed 経路に流す。
  const requiredConsents = r.data.requiredConsents;
  if (
    !Array.isArray(requiredConsents) ||
    requiredConsents.length === 0 ||
    !requiredConsents.every(
      (t): t is ConsentType =>
        typeof t === "string" && CONSENT_TYPE_SET.has(t),
    )
  ) {
    return undefined;
  }
  const documents = r.data.documents;
  let updatedAt: string | undefined;
  if (typeof updated === "string") {
    // 応答形式を UTC ISO に正規化（"2026-11-01" 等の非Z形式を素通ししない）
    updatedAt = Number.isNaN(Date.parse(updated))
      ? undefined
      : new Date(updated).toISOString();
  } else if (typeof updated?.toDate === "function") {
    try {
      updatedAt = updated.toDate().toISOString();
    } catch {
      updatedAt = undefined;
    }
  }
  return {
    documents:
      documents !== null &&
      typeof documents === "object" &&
      !Array.isArray(documents)
        ? documents
        : {},
    // 重複種別は読み取り側で無駄な並列クエリになるため一意化する
    requiredConsents: [...new Set(requiredConsents)],
    updatedAt,
  };
}
