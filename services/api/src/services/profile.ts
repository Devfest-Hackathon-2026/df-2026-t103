import {
  FieldValue,
  Timestamp,
  type DocumentData,
} from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type {
  AccountDoc,
  PatientProfileDoc,
} from "../domain/firestoreDocs.js";
import {
  profilePatchSchema,
  REQUIRED_PROFILE_FIELDS,
  type ProfilePatch,
} from "../domain/schemas.js";
import { ApiError, assertParsed } from "../lib/errors.js";
import { getProfile, profileRef } from "../repos/accounts.js";

export interface ProfileResponse {
  profile: Record<string, unknown>;
  profileComplete: boolean;
}

function toIso(value: unknown): string | undefined {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  if (typeof value === "string") return value;
  return undefined;
}

/**
 * Firestore ドキュメントを API 応答形式へ変換する。
 * Timestamp 系フィールドは 03 §4 の UTC ISO8601 契約どおり文字列化する。
 */
function serializeProfile(doc: PatientProfileDoc): Record<string, unknown> {
  const { patientUid: _ignored, ...rest } = doc;
  const out: Record<string, unknown> = { ...rest };
  const updatedAt = toIso(rest.updatedAt);
  if (updatedAt !== undefined) out.updatedAt = updatedAt;
  if (Array.isArray(rest.medicalHistory)) {
    out.medicalHistory = rest.medicalHistory.map((e) => ({
      ...e,
      updatedAt: toIso(e.updatedAt) ?? e.updatedAt,
    }));
  }
  return out;
}

/** API-003 GET /me/profile。 */
export async function getMyProfile(
  deps: Deps,
  uid: string,
): Promise<ProfileResponse> {
  const profile = await getProfile(deps.db, uid);
  if (!profile) {
    throw ApiError.notFound("プロフィールが登録されていません。");
  }
  return {
    profile: serializeProfile(profile),
    profileComplete: profile.profileComplete,
  };
}

/**
 * API-002 PATCH /me/profile。
 * 部分更新を許し、必須項目が揃った時点で onboarding を完了に進める（BR-02）。
 */
export async function patchMyProfile(
  deps: Deps,
  uid: string,
  body: unknown,
): Promise<ProfileResponse> {
  const patch: ProfilePatch = assertParsed(
    profilePatchSchema.safeParse(body),
  );
  if (Object.keys(patch).length === 0) {
    throw ApiError.validation([
      { field: "(body)", message: "更新項目がありません。" },
    ]);
  }

  await deps.db.runTransaction(async (tx) => {
    const accountRef = deps.db.doc(`accounts/${uid}`);
    const accountSnap = await tx.get(accountRef);
    if (!accountSnap.exists) {
      throw ApiError.forbidden("アカウントが初期化されていません。");
    }
    const account = accountSnap.data() as AccountDoc;
    if (
      account.accountStatus !== "onboarding_pending" &&
      account.accountStatus !== "active"
    ) {
      throw ApiError.forbidden("このアカウント状態ではプロフィールを更新できません。");
    }

    const ref = profileRef(deps.db, uid);
    const existingSnap = await tx.get(ref);
    const ts = FieldValue.serverTimestamp();

    const updates: Record<string, unknown> = { updatedAt: ts };
    if (patch.familyName !== undefined) updates.familyName = patch.familyName;
    if (patch.givenName !== undefined) updates.givenName = patch.givenName;
    if (patch.familyNameKana !== undefined) {
      updates.familyNameKana = patch.familyNameKana;
    }
    if (patch.givenNameKana !== undefined) {
      updates.givenNameKana = patch.givenNameKana;
    }
    if (patch.birthDate !== undefined) updates.birthDate = patch.birthDate;
    if (patch.phoneNumber !== undefined) updates.phoneNumber = patch.phoneNumber;
    if (patch.postalCode !== undefined) updates.postalCode = patch.postalCode;
    if (patch.address !== undefined) updates.address = patch.address;
    if (patch.allergyStatus !== undefined) {
      updates.allergyStatus = patch.allergyStatus;
    }
    if (patch.locale !== undefined) updates.locale = patch.locale;
    if (patch.medicalHistory !== undefined) {
      // 配列内要素には FieldValue.serverTimestamp() を入れられない
      // （Firestore SDK が transform-in-array を拒否する）ため具体値を使う
      const entryTs = Timestamp.now();
      updates.medicalHistory = patch.medicalHistory.map((text) => ({
        conditionText: text,
        selfReported: true,
        updatedAt: entryTs,
      }));
    }

    const merged: PatientProfileDoc = {
      ...(existingSnap.exists
        ? (existingSnap.data() as PatientProfileDoc)
        : ({ patientUid: uid, locale: "ja-JP" } as PatientProfileDoc)),
      ...(updates as Partial<PatientProfileDoc>),
    };
    merged.profileComplete = REQUIRED_PROFILE_FIELDS.every(
      (f) => merged[f] !== undefined && merged[f] !== null && merged[f] !== "",
    );

    if (!existingSnap.exists) {
      tx.set(ref, merged as unknown as DocumentData);
    } else {
      tx.update(ref, { ...updates, profileComplete: merged.profileComplete });
    }

    // プロフィール完了でアカウントを active へ進める（同意はゲートで現行確認済み）
    if (merged.profileComplete && account.onboardingState !== "completed") {
      tx.update(accountRef, {
        accountStatus: "active",
        onboardingState: "completed",
        updatedAt: ts,
      });
    }
  });

  // tx コミット後の確定値を読み直して返す（serverTimestamp の解決済み値）
  const committed = await getProfile(deps.db, uid);
  if (!committed) {
    throw new ApiError(500, "INTERNAL", "プロフィールの保存に失敗しました。");
  }
  return {
    profile: serializeProfile(committed),
    profileComplete: committed.profileComplete,
  };
}
