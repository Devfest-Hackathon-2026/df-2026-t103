import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type {
  AccountDoc,
  LegalConsentDoc,
} from "../domain/firestoreDocs.js";
import {
  onboardingConsentsBodySchema,
  type OnboardingConsentsBody,
} from "../domain/schemas.js";
import { validateConsentSubmission } from "../domain/consents.js";
import { ApiError, ErrorCodes, assertParsed } from "../lib/errors.js";
import { requestHash, runIdempotent } from "../lib/idempotency.js";
import { getLegalDocuments } from "../repos/legalConfig.js";
import {
  auditInTransaction,
  auditUidHash,
  logAuditEvent,
} from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import type { AuditEventDoc } from "../domain/firestoreDocs.js";
import type { RegistrationSource } from "../domain/types.js";

export interface OnboardingResult {
  onboardingState: "profile_pending" | "completed";
}

/**
 * API-004 POST /onboarding/consents。
 * Google/Passkey 初回利用・規約改定時の再同意をサーバ確定する。
 * 同意が確定するまでは PHI 系 API を利用できない（02 §5.1, SEC-16）。
 */
export async function recordOnboardingConsents(
  deps: Deps,
  params: {
    uid: string;
    providers: string[];
    emailVerified: boolean;
    body: unknown;
    idempotencyKey: string;
    requestId: string;
  },
): Promise<OnboardingResult> {
  const body: OnboardingConsentsBody = assertParsed(
    onboardingConsentsBodySchema.safeParse(params.body),
  );

  const legalDocs = await getLegalDocuments(deps.db);
  if (!legalDocs) {
    throw new ApiError(500, ErrorCodes.INTERNAL, "同意文書の設定が見つかりません。");
  }
  const grants = validateConsentSubmission(legalDocs, body.consents);

  const source = inferRegistrationSource(params.providers);

  const committedAudits: AuditEventDoc[] = [];
  const { result } = await runIdempotent<OnboardingResult>(deps, {
    namespace: "onboarding_consents",
    key: params.idempotencyKey,
    principal: params.uid,
    requestHash: requestHash(deps, body),
    execute: async (tx) => {
      // Firestore は競合時に execute を再試行する。再試行で push が
      // 重複しロールバック分まで sink へ流れないよう都度リセットする
      committedAudits.length = 0;
      const accountRef = deps.db.doc(`accounts/${params.uid}`);
      const snap = await tx.get(accountRef);
      const ts = FieldValue.serverTimestamp();
      let onboardingState: OnboardingResult["onboardingState"] =
        "profile_pending";

      if (!snap.exists) {
        const account: AccountDoc = {
          uid: params.uid,
          accountStatus: "onboarding_pending",
          onboardingState: "profile_pending",
          emailVerified: params.emailVerified,
          providers: params.providers.length ? params.providers : ["unknown"],
          schemaVersion: "1",
          createdAt: ts,
          updatedAt: ts,
        };
        tx.create(
          accountRef,
          account as unknown as DocumentData,
        );
      } else {
        const account = snap.data() as AccountDoc;
        if (
          account.accountStatus !== "onboarding_pending" &&
          account.accountStatus !== "active"
        ) {
          throw ApiError.forbidden("このアカウント状態では同意を記録できません。");
        }
        onboardingState =
          account.onboardingState === "completed" ? "completed" : "profile_pending";
        tx.update(accountRef, {
          onboardingState,
          emailVerified: params.emailVerified,
          updatedAt: ts,
        });
      }

      for (const grant of grants) {
        const ref = deps.db.collection("legalConsents").doc();
        const consent: LegalConsentDoc = {
          subjectUid: params.uid,
          consentType: grant.consentType,
          documentVersion: grant.documentVersion,
          documentHash: grant.documentHash,
          decision: grant.decision,
          method: "explicit_checkbox",
          registrationSource: source,
          occurredAt: ts,
          revokedAt: null,
          schemaVersion: "1",
        };
        tx.create(ref, consent as unknown as DocumentData);
      }

      committedAudits.push(
        auditInTransaction(tx, deps, {
          actorType: "patient",
          actorUidHash: auditUidHash(deps, params.uid),
          action: AUDIT_ACTIONS.CONSENT_ACCEPTED,
          resourceType: "legalConsents",
          requestId: params.requestId,
          outcome: "recorded",
          details: { source },
        }),
      );

      return { onboardingState };
    },
  });

  // コミット確定後にシンク転送用ログを出す（冪等リプレイでは execute が
  // 走らないため二重出力しない）
  for (const e of committedAudits) logAuditEvent(deps, e);

  return result;
}

function inferRegistrationSource(providers: string[]): RegistrationSource {
  if (providers.some((p) => p.includes("google"))) return "google_onboarding";
  if (providers.some((p) => p.includes("custom") || p.includes("passkey"))) {
    return "passkey_onboarding";
  }
  // 既存アカウント（メール等）の規約改定再同意
  return "reconsent";
}
