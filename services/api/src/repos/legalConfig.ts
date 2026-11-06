import type { LegalDocumentSet } from "../domain/legalDocuments.js";
import type { ConsentType } from "../domain/types.js";
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
  return {
    documents: r.data.documents ?? {},
    requiredConsents: r.data.requiredConsents ?? [],
    updatedAt:
      typeof updated === "string"
        ? updated
        : updated && typeof updated.toDate === "function"
          ? updated.toDate().toISOString()
          : undefined,
  };
}
