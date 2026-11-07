import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { DeliveryCreateBody } from "../domain/schemas.js";
import type { AuditEventDoc, DeliveryDoc } from "../domain/firestoreDocs.js";
import { ApiError } from "../lib/errors.js";
import {
  idempotencyKeyHash,
  requestHash,
  runIdempotent,
} from "../lib/idempotency.js";
import { randomId, sha256Hex, canonicalJson } from "../lib/hash.js";
import {
  audit,
  auditUidHash,
  auditResourceHash,
  auditInTransaction,
  logAuditEvent,
} from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { deliveryRef, getDelivery } from "../repos/deliveries.js";
import type { QuestionnaireRevisionDoc } from "../domain/firestoreDocs.js";

const IDEMPOTENCY_NS = "deliver";

export interface DeliveryCreateResult {
  deliveryId: string;
  status: "created";
}

export interface DeliveryGetResult {
  deliveryId: string;
  status: string;
  facilityId: string;
  questionnaireId: string;
  questionnaireRevisionId: string;
  createdAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
}

function tsToIso(ts: unknown): string | null {
  if (!ts) return null;
  if (ts instanceof Timestamp) return ts.toDate().toISOString();
  return null;
}

export async function createDelivery(
  deps: Deps,
  params: {
    senderUid: string;
    body: DeliveryCreateBody;
    idempotencyKey: string;
    requestId?: string;
  },
): Promise<DeliveryCreateResult> {
  const { senderUid, body, idempotencyKey } = params;
  const reqHash = requestHash(deps, body);

  const committedAudits: AuditEventDoc[] = [];
  const { result, replayed } = await runIdempotent<DeliveryCreateResult>(deps, {
    namespace: IDEMPOTENCY_NS,
    key: idempotencyKey,
    principal: senderUid,
    requestHash: reqHash,
    execute: async (tx) => {
      // tx リトライ時にロールバック済みイベントが残らないよう各試行でリセット
      committedAudits.length = 0;
      // 1. 問診票の所有権と確定版の確認
      const qSnap = await tx.get(
        deps.db.doc(`questionnaires/${body.questionnaireId}`),
      );
      if (!qSnap.exists) {
        throw ApiError.notFound("問診票が見つかりません。");
      }
      const qDoc = qSnap.data() as { patientUid: string; status: string };
      if (qDoc.patientUid !== senderUid) {
        throw ApiError.forbidden("この問診票の送信権限がありません。");
      }
      if (qDoc.status !== "finalized") {
        throw ApiError.precondition("確定済みの問診票のみ送信できます。");
      }

      // 2. 指定された revision の存在確認
      const revRef = deps.db.doc(
        `questionnaires/${body.questionnaireId}/revisions/${body.questionnaireRevision}`,
      );
      const revSnap = await tx.get(revRef);
      if (!revSnap.exists) {
        throw ApiError.notFound("指定された問診票のバージョンが見つかりません。");
      }
      const revDoc = revSnap.data() as QuestionnaireRevisionDoc;

      // 3. 施設の検証（VAL-008）
      const facRef = deps.db.doc(`facilities/${body.facilityId}`);
      const facSnap = await tx.get(facRef);
      if (!facSnap.exists) {
        throw ApiError.precondition("施設が見つかりません。送信できません。");
      }
      const facDoc = facSnap.data() as {
        verificationStatus: string;
        receivingEnabled: boolean;
      };
      if (facDoc.verificationStatus !== "verified") {
        throw ApiError.precondition("この施設は現在問診票の受付を行っていません。");
      }
      if (!facDoc.receivingEnabled) {
        throw ApiError.precondition("この施設は現在問診票の受付を停止しています。（E2E-006）");
      }

      // 4. スナップショットの構築（PHIはFirestoreから再取得、リクエスト本文を信頼しない）
      const snapshot: Record<string, unknown> = {
        schemaVersion: revDoc.schemaVersion,
        chiefComplaint: revDoc.chiefComplaint,
        sections: revDoc.sections,
        bodyLocations: revDoc.bodyLocations,
        unansweredTopics: revDoc.unansweredTopics,
      };
      if (body.shareScope.includeConfirmedMedications) {
        snapshot["medicationSnapshots"] = revDoc.medicationSnapshots;
      }
      if (body.shareScope.includeProfile) {
        snapshot["medicalHistorySnapshot"] = revDoc.medicalHistorySnapshot;
      }
      const snapshotSha256 = sha256Hex(canonicalJson(snapshot));

      // 患者表示情報: 同意された範囲の identity のみ Firestore から取得してスナップショット化。
      // リクエスト本文の氏名は信頼しない（04 §5.10: 明示的に送信した氏名/連絡先等だけ）。
      let identity: Record<string, unknown> = {};
      let patientDisplayName: string | null = null;
      if (body.shareScope.includeProfile) {
        const profileSnap = await tx.get(deps.db.doc(`patientProfiles/${senderUid}`));
        const profile = profileSnap.data() as
          | {
              familyName?: string;
              givenName?: string;
              familyNameKana?: string;
              givenNameKana?: string;
              birthDate?: string;
              phoneNumber?: string;
            }
          | undefined;
        if (profile) {
          identity = {
            ...(profile.familyName ? { familyName: profile.familyName } : {}),
            ...(profile.givenName ? { givenName: profile.givenName } : {}),
            ...(profile.familyNameKana ? { familyNameKana: profile.familyNameKana } : {}),
            ...(profile.givenNameKana ? { givenNameKana: profile.givenNameKana } : {}),
            ...(profile.birthDate ? { birthDate: profile.birthDate } : {}),
            ...(profile.phoneNumber ? { phoneNumber: profile.phoneNumber } : {}),
          };
          patientDisplayName = [profile.familyName, profile.givenName]
            .filter((v): v is string => typeof v === "string" && v.length > 0)
            .join(" ") || null;
        }
      }

      // 5. Delivery ドキュメントの作成
      const deliveryId = randomId("dlv");
      const keyHash = idempotencyKeyHash(
        deps,
        IDEMPOTENCY_NS,
        senderUid,
        idempotencyKey,
      );
      const now = Timestamp.fromDate(deps.clock.now());
      const deliveryDoc: DeliveryDoc = {
        senderUid,
        facilityId: body.facilityId,
        questionnaireId: body.questionnaireId,
        questionnaireRevisionId: String(body.questionnaireRevision),
        consentId: body.consentDocumentVersion,
        shareScope: body.shareScope,
        patientIdentitySnapshot: identity,
        patientDisplayName,
        questionnaireSnapshot: snapshot,
        snapshotSha256,
        // 施設側コピーは同期的に作成されるため作成=配送済み（created→delivered はtx内で完結）
        status: "delivered",
        deliveredAt: now,
        idempotencyKeyHash: keyHash,
        facilityRetentionPolicyVersion: "v1",
        createdAt: now,
      };
      tx.create(deliveryRef(deps.db, deliveryId), deliveryDoc as unknown as DocumentData);

      // 6. 監査イベント（PHI・本文を含めない）
      committedAudits.push(
        auditInTransaction(tx, deps, {
          actorType: "patient",
          actorUidHash: auditUidHash(deps, senderUid),
          action: AUDIT_ACTIONS.DELIVERY_CREATED,
          resourceType: "delivery",
          resourceIdHash: auditResourceHash(deps, deliveryId),
          facilityId: body.facilityId,
          decision: "allow",
          ...(params.requestId ? { requestId: params.requestId } : {}),
        }),
      );

      return { deliveryId, status: "created" as const };
    },
  });

  // 冪等リプレイでは二重にシンクへ流さない
  if (!replayed) for (const e of committedAudits) logAuditEvent(deps, e);
  return result;
}

export async function getDeliveryForSender(
  deps: Deps,
  params: { senderUid: string; deliveryId: string; requestId?: string },
): Promise<DeliveryGetResult> {
  const { senderUid, deliveryId } = params;
  const doc = await getDelivery(deps.db, deliveryId);
  if (!doc || doc.senderUid !== senderUid) {
    // VAL-010: 存在・所有権を区別しない（情報露出を避ける）
    throw ApiError.notFound("配送記録が見つかりません。");
  }

  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, senderUid),
    action: AUDIT_ACTIONS.DELIVERY_VIEWED,
    resourceType: "delivery",
    resourceIdHash: auditResourceHash(deps, deliveryId),
    facilityId: doc.facilityId,
    decision: "allow",
    ...(params.requestId ? { requestId: params.requestId } : {}),
  });

  return {
    deliveryId,
    status: doc.status,
    facilityId: doc.facilityId,
    questionnaireId: doc.questionnaireId,
    questionnaireRevisionId: doc.questionnaireRevisionId,
    createdAt: tsToIso(doc.createdAt),
    deliveredAt: tsToIso(doc.deliveredAt),
    acknowledgedAt: tsToIso(doc.acknowledgedAt),
  };
}
