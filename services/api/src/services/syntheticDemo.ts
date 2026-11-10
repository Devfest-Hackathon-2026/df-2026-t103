import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { LegalDocumentSet } from "../domain/legalDocuments.js";
import { CONSENT_HISTORY_SOURCES, CONSENT_TYPE_SET } from "../domain/types.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { isSyntheticRecipient } from "../repos/facilities.js";
import { LEGAL_DOCUMENTS_PATH } from "../repos/legalConfig.js";

export function selfServiceFacilityId(uid: string): string {
  // Not dependent on a rotating secret; retries must never allocate another facility.
  return `synthetic-self-${createHash("sha256").update(uid).digest("hex")}`;
}

/** Account-deletion worker only: remove this feature's owned pair, not legacy fixtures. */
export async function deleteSelfServiceDemo(deps: Deps, uid: string): Promise<number> {
  return deps.db.runTransaction(async (tx) => {
    const facilityId = selfServiceFacilityId(uid);
    const facilityRef = deps.db.doc(`facilities/${facilityId}`);
    const bindingRef = deps.db.doc(`syntheticDemoPatients/${uid}`);
    const facility = await tx.get(facilityRef);
    const binding = await tx.get(bindingRef);
    let count = 0;
    const data = facility.data();
    const bindingData = binding.data();
    const ownBinding = bindingData?.facilityId === facilityId && bindingData?.selfServiceVersion === 1;
    const selfServiceBinding = bindingData !== undefined && (
      "selfServiceVersion" in bindingData ||
      (typeof bindingData.facilityId === "string" && bindingData.facilityId.startsWith("synthetic-self-"))
    );
    // Validate before staging either delete, including when a prior attempt
    // already removed the facility. Legacy fixture bindings remain untouched.
    if (selfServiceBinding && !ownBinding) {
      throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "合成デモbindingの削除には運営の確認が必要です。");
    }
    const ownFacility = data?.facilityId === facilityId && data.syntheticSelfService === true && data.syntheticDemo === true &&
      data.syntheticPatientUid === uid && data.verificationStatus === "pending";
    if (facility.exists && !ownFacility && (ownBinding || (data?.syntheticSelfService === true && data.syntheticPatientUid === uid))) {
      // Do not silently declare account deletion complete while retaining a
      // corrupted owned facility, or delete a now-verified/foreign resource.
      throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "合成デモ施設の削除には運営の確認が必要です。");
    }
    if (ownFacility) {
      tx.delete(facilityRef);
      count++;
    }
    if (ownBinding) {
      tx.delete(bindingRef);
      count++;
    }
    return count;
  });
}

/** Storage-only sandbox. Never grants staff membership or real facility verification. */
export async function startSyntheticDemo(deps: Deps, uid: string, emailVerified: boolean) {
  if (!deps.config.syntheticSelfServiceEnabled) throw ApiError.notFound("合成デモはこの環境では利用できません。");
  if (!emailVerified) throw ApiError.forbidden("メールアドレスの確認が必要です。");
  return deps.db.runTransaction(async (tx) => {
    const account = (await tx.get(deps.db.doc(`accounts/${uid}`))).data();
    if (account?.uid !== uid || account.accountStatus !== "active" || account.onboardingState !== "completed") {
      throw ApiError.forbidden("プロフィール登録が完了していません。");
    }
    // Recheck standing consents and document rotation in the committing transaction.
    const legal = (await tx.get(deps.db.doc(LEGAL_DOCUMENTS_PATH))).data() as LegalDocumentSet | undefined;
    if (!legal || !Array.isArray(legal.requiredConsents) || !legal.requiredConsents.length ||
        !legal.requiredConsents.every((type) => CONSENT_TYPE_SET.has(type))) {
      throw ApiError.precondition("必要な同意文書を確認できません。");
    }
    for (const type of new Set(legal.requiredConsents)) {
      const doc = legal.documents?.[type];
      const consents = await tx.get(deps.db.collection("legalConsents")
        .where("subjectUid", "==", uid).where("consentType", "==", type)
        .where("registrationSource", "in", [...CONSENT_HISTORY_SOURCES])
        .orderBy("occurredAt", "desc").limit(200));
      const consent = consents.docs.map((s) => s.data()).find((c) => c.decision === "granted" && !c.revokedAt);
      if (!doc?.version || !doc.documentHash || consent?.documentVersion !== doc.version) {
        throw ApiError.precondition("必要な同意が完了していません。");
      }
    }
    const bindingRef = deps.db.doc(`syntheticDemoPatients/${uid}`);
    const binding = await tx.get(bindingRef);
    const facilityId = selfServiceFacilityId(uid);
    // Existing fixtures (including another owned demo) are never adopted or overwritten.
    if (binding.exists && (binding.data()?.facilityId !== facilityId || binding.data()?.selfServiceVersion !== 1)) {
      throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "既存の合成デモ設定があります。運営にお問い合わせください。");
    }
    const facilityRef = deps.db.doc(`facilities/${facilityId}`);
    const facility = await tx.get(facilityRef);
    if (binding.exists || facility.exists) {
      const data = facility.data();
      if (!binding.exists || !facility.exists || data?.facilityId !== facilityId || data.syntheticSelfService !== true ||
          data.receivingEnabled !== true || !isSyntheticRecipient(data as { verificationStatus: string }, uid, facilityId, binding.data())) {
        throw ApiError.conflict(ErrorCodes.REVISION_CONFLICT, "合成デモ設定が変更されています。運営にお問い合わせください。");
      }
    } else {
      // Lifetime quota is conservative: deletion does not replenish it automatically.
      const counterRef = deps.db.doc("syntheticDemoProvisioning/selfService");
      const counter = await tx.get(counterRef);
      const count = counter.exists ? counter.data()?.createdCount : 0;
      if (!Number.isSafeInteger(count) || count < 0 || count >= deps.config.syntheticSelfServiceMaxFacilities) {
        throw ApiError.precondition("合成デモの作成上限に達しています。");
      }
      const ts = FieldValue.serverTimestamp();
      tx.create(facilityRef, {
        facilityId, legalName: "架空・自己専用合成デモ施設（実在しません）",
        displayName: "架空・自己専用合成デモ施設（送信保存のみ）",
        address: { formatted: "架空の住所（実在しません）" },
        verificationStatus: "pending", receivingEnabled: true,
        syntheticDemo: true, syntheticSelfService: true, syntheticPatientUid: uid,
        serviceAgreementVersion: "synthetic-storage-only-v1", createdAt: ts, updatedAt: ts,
      });
      tx.create(bindingRef, { facilityId, selfServiceVersion: 1, syntheticDataOnly: true, optedInAt: ts });
      tx.set(counterRef, { createdCount: count + 1, updatedAt: ts });
    }
    return { facilityId, syntheticRecipient: true as const, verificationStatus: "pending" as const,
      mode: "storage_only" as const, hospitalViewing: "unconfirmed" as const };
  });
}
