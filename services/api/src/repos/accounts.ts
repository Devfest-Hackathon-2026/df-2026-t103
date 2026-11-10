import type {
  AccountDoc,
  LegalConsentDoc,
  PatientProfileDoc,
} from "../domain/firestoreDocs.js";
import type { ConsentType, RegistrationSource } from "../domain/types.js";
import { getDoc, queryDocs } from "./helpers.js";
import type { FirestoreLike, QueryCondition } from "./helpers.js";

export function accountRef(db: FirestoreLike, uid: string) {
  return db.doc(`accounts/${uid}`);
}

export async function getAccount(
  db: FirestoreLike,
  uid: string,
): Promise<AccountDoc | undefined> {
  const r = await getDoc<AccountDoc>(db, `accounts/${uid}`);
  return r.data;
}

export async function getProfile(
  db: FirestoreLike,
  uid: string,
): Promise<PatientProfileDoc | undefined> {
  const r = await getDoc<PatientProfileDoc>(db, `patientProfiles/${uid}`);
  return r.data;
}

export function profileRef(db: FirestoreLike, uid: string) {
  return db.doc(`patientProfiles/${uid}`);
}

export function consentsCollection(db: FirestoreLike) {
  return db.collection("legalConsents");
}

/**
 * 施設別送信同意の状態ドキュメント（(subjectUid, facilityId) で一意）。
 * 配送 tx が読み取る撤回検知ポイント。撤回操作がこの doc へ
 * revokedAt を書き込むと、in-flight の配送 tx が競合で再評価される。
 */
export function facilityConsentRef(
  db: FirestoreLike,
  subjectUid: string,
  facilityId: string,
) {
  return db.doc(`legalConsents/fc_${subjectUid}_${facilityId}`);
}

/**
 * 同意履歴の一覧（occurredAt 降順、上限 100）。
 * `sources` 指定時はその registrationSource のみ返す。
 * 送信証跡（delivery_send）は1送信1 doc の高頻度書き込みのため、
 * 履歴取得側で除外しないと登録系同意が押し出される（#219）。
 */
export async function listConsents(
  db: FirestoreLike,
  uid: string,
  opts?: { sources?: readonly RegistrationSource[] },
): Promise<Array<{ id: string; data: LegalConsentDoc }>> {
  const filters: Array<{ field: string; op: "==" | "in"; value: unknown }> = [
    { field: "subjectUid", op: "==", value: uid },
  ];
  // 空配列の in クエリは INVALID_ARGUMENT になるため早期に空結果を返す
  if (opts?.sources && opts.sources.length === 0) return [];
  if (opts?.sources) {
    filters.push({ field: "registrationSource", op: "in", value: [...opts.sources] });
  }
  const rows = await queryDocs<LegalConsentDoc>(
    db,
    "legalConsents",
    filters,
    { orderBy: [{ field: "occurredAt", direction: "desc" }], limit: 100 },
  );
  return rows.map((r) => ({ id: r.id, data: r.data }));
}

/**
 * 必須同意種別ごとの最新の有効（granted・未撤回）同意を解決する。
 * 履歴全体を一括 limit すると hospital_disclosure 等の多量レコードで
 * 登録時同意が押し出され得るため、種別ごとにクエリする（04_DB設計書 §5.3）。
 * `sources` 指定時はその registrationSource のみ対象とする。
 * 送信証跡（delivery_send）は撤回されない恒久的証跡であり「現在の同意」
 * ではないため、現状態の解決では facility_consent 等に絞ること（#219）。
 */
export async function latestConsentsByType(
  db: FirestoreLike,
  uid: string,
  types: ConsentType[],
  opts?: { sources?: readonly RegistrationSource[] },
): Promise<Map<ConsentType, LegalConsentDoc>> {
  const result = new Map<ConsentType, LegalConsentDoc>();
  await Promise.all(
    types.map(async (type) => {
      // 空配列の in クエリは INVALID_ARGUMENT になるため絞り込みを適用しない
      const filters: QueryCondition[] = [
        { field: "subjectUid", op: "==", value: uid },
        { field: "consentType", op: "==", value: type },
      ];
      if (opts?.sources && opts.sources.length === 0) return;
      if (opts?.sources) {
        filters.push({
          field: "registrationSource",
          op: "in",
          value: [...opts.sources],
        });
      }
      const rows = await queryDocs<LegalConsentDoc>(
        db,
        "legalConsents",
        filters,
        { orderBy: [{ field: "occurredAt", direction: "desc" }], limit: 200 },
      );
      const granted = rows.find(
        (r) => r.data.decision === "granted" && !r.data.revokedAt,
      );
      if (granted) result.set(type, granted.data);
    }),
  );
  return result;
}
