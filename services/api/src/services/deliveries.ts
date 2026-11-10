import {
  FieldValue,
  Timestamp,
  type DocumentData,
} from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import {
  shareScopeSchema,
  type DeliveryCreateBody,
  type ShareScope,
} from "../domain/schemas.js";
import type {
  AuditEventDoc,
  DeliveryDoc,
  LegalConsentDoc,
  QuestionnaireRevisionDoc,
} from "../domain/firestoreDocs.js";
import type { LegalDocumentVersion } from "../domain/legalDocuments.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import {
  idempotencyKeyHash,
  requestHash,
  runIdempotent,
  type IdempotentOutcome,
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
import { isSyntheticRecipient } from "../repos/facilities.js";
import { facilityConsentRef } from "../repos/accounts.js";
import { LEGAL_DOCUMENTS_PATH } from "../repos/legalConfig.js";

const IDEMPOTENCY_NS = "deliver";

/** shareScope のフラグ一覧（スキーマ由来。新規フラグ追加時は自動で検証対象になる）。 */
const SHARE_SCOPE_KEYS = Object.keys(
  shareScopeSchema.shape,
) as (keyof ShareScope)[];

/** 配送作成時の同意検証の拒否分類（監査 details.reason、PHI なし）。 */
type ConsentRejectReason =
  | "consent_not_accepted"
  | "document_version_mismatch"
  | "document_hash_mismatch"
  | "share_scope_exceeds_consent"
  | "facility_consent_denied"
  | "facility_consent_revoked";

/**
 * 施設別同意の検証不備による配送拒否（412）。
 * 呼出側で DELIVERY_REJECTED 監査へ変換するため理由を保持する。
 */
class ConsentDeniedError extends ApiError {
  constructor(
    readonly consentReason: ConsentRejectReason,
    message: string,
  ) {
    super(412, ErrorCodes.PRECONDITION_FAILED, message);
  }
}

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
  consentId: string;
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
    emailVerified?: boolean;
    body: DeliveryCreateBody;
    idempotencyKey: string;
    requestId?: string;
  },
): Promise<DeliveryCreateResult> {
  const { senderUid, body, idempotencyKey } = params;
  const reqHash = requestHash(deps, body);
  // (uid, facilityId) 単位の同意 state doc（撤回検知点・拒否監査の関連リソース）。
  const facilityConsentDocRef = facilityConsentRef(
    deps.db,
    senderUid,
    body.facilityId,
  );

  const committedAudits: AuditEventDoc[] = [];
  let outcome: IdempotentOutcome<DeliveryCreateResult>;
  try {
    outcome = await runIdempotent<DeliveryCreateResult>(deps, {
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
          syntheticDemo?: boolean;
          syntheticSelfService?: boolean;
          syntheticPatientUid?: string;
        };
        // Read the server-owned patient binding inside the transaction so a
        // concurrent revocation is rechecked before committing the delivery.
        const syntheticPatient = facDoc.verificationStatus === "pending"
          ? await tx.get(deps.db.doc(`syntheticDemoPatients/${senderUid}`))
          : undefined;
        const syntheticDemoDelivery = isSyntheticRecipient(facDoc, senderUid, body.facilityId, syntheticPatient?.data());
        if ((facDoc.verificationStatus !== "verified" || facDoc.syntheticDemo === true || facDoc.syntheticSelfService === true) && !syntheticDemoDelivery) {
          throw ApiError.precondition("この施設は現在問診票の受付を行っていません。");
        }
        if (facDoc.syntheticSelfService === true && !deps.config.syntheticSelfServiceEnabled) {
          throw ApiError.precondition("合成デモはこの環境では利用できません。");
        }
        if (facDoc.syntheticSelfService === true && params.emailVerified !== true) {
          throw ApiError.forbidden("メールアドレスの確認が必要です。");
        }
        if (!facDoc.receivingEnabled) {
          throw ApiError.precondition("この施設は現在問診票の受付を停止しています。（E2E-006）");
        }
  
        // 4. アカウントの現状態を tx 内でも確認
        // （配送 tx in-flight 中の退会/停止・退会ジョブの consent 削除との競合を安全側へ）。
        const accountSnap = await tx.get(deps.db.doc(`accounts/${senderUid}`));
        if (
          !accountSnap.exists ||
          (accountSnap.data() as { accountStatus?: string }).accountStatus !==
            "active"
        ) {
          throw ApiError.forbidden("アカウントが利用できません。");
        }

        // 5. 施設別送信同意のサーバ検証（#219, FR-H05, 04 §5.3）
        // 第三者提供文書の現行版は tx 内で読み、版ローテーションとの競合で
        // 古い版への同意が書き込まれないようにする（read→write 競合で再評価）。
        const legalSnap = await tx.get(deps.db.doc(LEGAL_DOCUMENTS_PATH));
        const legalData = legalSnap.data() as
          | { documents?: Record<string, Partial<LegalDocumentVersion>> }
          | undefined;
        const disclosureDoc = legalData?.documents?.hospital_disclosure;
        if (!disclosureDoc?.version || !disclosureDoc?.documentHash) {
          throw new ApiError(
            500,
            ErrorCodes.INTERNAL,
            "同意文書の設定が不完全です。",
          );
        }
  
        if (body.consent.accepted !== true) {
          throw new ConsentDeniedError(
            "consent_not_accepted",
            "この送信への明示的な同意が必要です。",
          );
        }
        if (body.consent.documentVersion !== disclosureDoc.version) {
          throw new ConsentDeniedError(
            "document_version_mismatch",
            "同意文書の版が最新ではありません。最新の文書を確認してください。",
          );
        }
        if (body.consent.documentHash !== disclosureDoc.documentHash) {
          throw new ConsentDeniedError(
            "document_hash_mismatch",
            "同意文書の内容が最新版と一致しません。最新の文書を確認してください。",
          );
        }
        if (
          SHARE_SCOPE_KEYS.some(
            (k) => body.shareScope[k] && !body.consent.shareScope[k],
          )
        ) {
          throw new ConsentDeniedError(
            "share_scope_exceeds_consent",
            "送信範囲が同意された範囲を超えています。",
          );
        }
  
        // 施設別同意の撤回・拒否状態は tx 内 read で検知する。
        // 撤回操作がこの doc へ書き込むと read→write 競合で本 tx が
        // 再評価されるため、撤回と配送作成のレースでも安全側に倒れる。
        const facilityConsentSnap = await tx.get(facilityConsentDocRef);
        if (facilityConsentSnap.exists) {
          const fcDoc = facilityConsentSnap.data() as LegalConsentDoc;
          // ID衝突した他主体の doc を自前の同意と誤認しない（防御的照合）
          const fcScope = (fcDoc.scope ?? {}) as Record<string, unknown>;
          const mismatched =
            fcDoc.subjectUid !== senderUid ||
            fcScope["facilityId"] !== body.facilityId;
          if (mismatched) {
            throw new ConsentDeniedError(
              "facility_consent_denied",
              "この施設への送信同意がありません。",
            );
          }
          if (fcDoc.revokedAt) {
            throw new ConsentDeniedError(
              "facility_consent_revoked",
              "この施設への送信同意は撤回されています。",
            );
          }
          if (fcDoc.decision === "denied") {
            throw new ConsentDeniedError(
              "facility_consent_denied",
              "この施設への送信同意がありません。",
            );
          }
        }
  
        // 6. スナップショットの構築（PHIはFirestoreから再取得、リクエスト本文を信頼しない）
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
  
        // 7. 施設別同意記録（#219, 04 §5.3）
        // 2 doc: (a) (uid, facilityId) 単位の撤回検知用 state doc（merge upsert）、
        // (b) 本送信の証跡 doc（immutable、deliveryId/版/範囲に紐づく）。
        // deliveryId は doc 生成前に採番できるため円環参照は成立しない。
        const deliveryId = randomId("dlv");
        const sendConsentRef = deps.db.collection("legalConsents").doc();
        const now = Timestamp.fromDate(deps.clock.now());
  
        const facilityConsentDoc: LegalConsentDoc = {
          subjectUid: senderUid,
          consentType: "hospital_disclosure",
          documentVersion: disclosureDoc.version,
          documentHash: disclosureDoc.documentHash,
          decision: "granted",
          method: "explicit_checkbox",
          registrationSource: "facility_consent",
          scope: {
            facilityId: body.facilityId,
            purpose: "medical_intake_preparation",
            lastDeliveryId: deliveryId,
            lastConsentId: sendConsentRef.id,
          },
          occurredAt: FieldValue.serverTimestamp(),
          revokedAt: null,
          schemaVersion: "1",
        };
        // merge: 他フロー（撤回等）が同 doc に書いた項目を潰さない
        tx.set(
          facilityConsentDocRef,
          facilityConsentDoc as unknown as DocumentData,
          { merge: true },
        );
  
        const sendConsentDoc: LegalConsentDoc = {
          subjectUid: senderUid,
          consentType: "hospital_disclosure",
          documentVersion: disclosureDoc.version,
          documentHash: disclosureDoc.documentHash,
          decision: "granted",
          method: "explicit_checkbox",
          registrationSource: "delivery_send",
          scope: {
            facilityId: body.facilityId,
            questionnaireId: body.questionnaireId,
            questionnaireRevisionId: String(body.questionnaireRevision),
            // 同意した範囲と実際に送信した範囲を別々に証跡化する
            shareScope: body.consent.shareScope,
            sentShareScope: body.shareScope,
            deliveryId,
            facilityConsentId: facilityConsentDocRef.id,
            purpose: "medical_intake_preparation",
          },
          occurredAt: FieldValue.serverTimestamp(),
          revokedAt: null,
          schemaVersion: "1",
        };
        tx.create(
          sendConsentRef,
          sendConsentDoc as unknown as DocumentData,
        );
  
        // 8. Delivery ドキュメントの作成（consentId は本送信の同意証跡を指す）
        const keyHash = idempotencyKeyHash(
          deps,
          IDEMPOTENCY_NS,
          senderUid,
          idempotencyKey,
        );
        const deliveryDoc: DeliveryDoc = {
          senderUid,
          facilityId: body.facilityId,
          questionnaireId: body.questionnaireId,
          questionnaireRevisionId: String(body.questionnaireRevision),
          consentId: sendConsentRef.id,
          consentDocumentVersion: disclosureDoc.version,
          consentDocumentHash: disclosureDoc.documentHash,
          facilityConsentId: facilityConsentDocRef.id,
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
  
        // 9. 監査イベント（PHI・本文を含めない。同意証跡は hash/版/ハッシュのみ）
        committedAudits.push(
          auditInTransaction(tx, deps, {
            actorType: "patient",
            actorUidHash: auditUidHash(deps, senderUid),
            action: AUDIT_ACTIONS.DELIVERY_CREATED,
            resourceType: "delivery",
            resourceIdHash: auditResourceHash(deps, deliveryId),
            facilityId: body.facilityId,
            decision: "allow",
            details: {
              consentIdHash: auditResourceHash(deps, sendConsentRef.id),
              documentVersion: disclosureDoc.version,
              documentHash: disclosureDoc.documentHash,
            },
            ...(params.requestId ? { requestId: params.requestId } : {}),
          }),
        );
  
      return { deliveryId, status: "created" as const };
      },
    });
  } catch (err) {
    // 同意検証の拒否は証跡として監査化する（reason と申告した版/hash のみ、PHI なし）
    if (err instanceof ConsentDeniedError) {
      await audit(deps, {
        actorType: "patient",
        actorUidHash: auditUidHash(deps, senderUid),
        action: AUDIT_ACTIONS.DELIVERY_REJECTED,
        resourceType: "legalConsents",
        resourceIdHash: auditResourceHash(deps, facilityConsentDocRef.id),
        facilityId: body.facilityId,
        decision: "deny",
        details: {
          reason: err.consentReason,
          documentVersion: body.consent.documentVersion,
          documentHash: body.consent.documentHash,
        },
        ...(params.requestId ? { requestId: params.requestId } : {}),
      });
    }
    throw err;
  }
  const { result, replayed } = outcome;

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
    consentId: doc.consentId,
    createdAt: tsToIso(doc.createdAt),
    deliveredAt: tsToIso(doc.deliveredAt),
    acknowledgedAt: tsToIso(doc.acknowledgedAt),
  };
}
