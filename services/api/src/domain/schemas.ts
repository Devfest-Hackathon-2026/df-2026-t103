import { z } from "zod";
import { UPLOAD_ALLOWED_MIME_TYPES } from "./uploads.js";
import { BODY_LOCATIONS, INTAKE_SYMPTOM_MAX_CHARS } from "./intake.js";

const KANA_PATTERN = /^[ァ-ヶー・\s]+$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PREFECTURES = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県",
  "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
] as const;

const consentEntrySchema = z.object({
  accepted: z.boolean(),
  documentVersion: z.string().min(1).max(100),
});

/** 同意マップ: 既知の consentType のみ受理する。省略可能（partial）。 */
export const consentMapSchema = z
  .partialRecord(
    z.enum([
      "terms_of_service",
      "privacy_policy_ack",
      "health_data_collection",
      "hospital_disclosure",
      "optional_analytics",
    ]),
    consentEntrySchema,
  )
  .refine((m) => Object.keys(m).length > 0, {
    message: "consents が空です。",
  });
export type ConsentMap = z.infer<typeof consentMapSchema>;

export const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[a-zA-Z-]+$/, "locale の形式が不正です。")
  .default("ja-JP");

export const registerBodySchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("メールアドレスの形式が不正です。")
      .max(254),
    password: z
      .string()
      .min(8, "パスワードは8文字以上にしてください。")
      .max(128)
      .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), {
        message: "パスワードは英字と数字を含めてください。",
      }),
    consents: consentMapSchema,
    locale: localeSchema,
  })
  .strict();
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const onboardingConsentsBodySchema = z
  .object({
    consents: consentMapSchema,
    locale: localeSchema,
  })
  .strict();
export type OnboardingConsentsBody = z.infer<typeof onboardingConsentsBodySchema>;

function isValidPastDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parts = value.split("-").map((v) => Number(v));
  const y = parts[0]!;
  const m = parts[1]!;
  const d = parts[2]!;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return false;
  }
  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return date.getTime() < todayUtc;
}

const optionalTrimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max).optional();

export const profilePatchSchema = z
  .object({
    familyName: optionalTrimmed(1, 50, "姓を入力してください。"),
    givenName: optionalTrimmed(1, 50, "名を入力してください。"),
    familyNameKana: optionalTrimmed(1, 50, "姓カナを入力してください。").refine(
      (v) => v === undefined || KANA_PATTERN.test(v),
      { message: "カタカナで入力してください。" },
    ),
    givenNameKana: optionalTrimmed(1, 50, "名カナを入力してください。").refine(
      (v) => v === undefined || KANA_PATTERN.test(v),
      { message: "カタカナで入力してください。" },
    ),
    birthDate: z
      .string()
      .trim()
      .refine(isValidPastDate, { message: "正しい日付を選んでください。" })
      .optional(),
    phoneNumber: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s\-()（）ー－―]/g, ""))
      .refine((v) => /^0\d{9,10}$/.test(v), {
        message: "電話番号をご確認ください。",
      })
      .optional(),
    postalCode: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s\-ー－―]/g, ""))
      .refine((v) => /^\d{7}$/.test(v), {
        message: "7桁の郵便番号を入力してください。",
      })
      .optional(),
    address: z
      .object({
        prefecture: z.enum(PREFECTURES),
        city: z.string().trim().min(1).max(100),
        line1: z.string().trim().min(1).max(200),
        line2: z.string().trim().max(200).optional(),
      })
      .strict()
      .optional(),
    medicalHistory: z
      .array(z.string().trim().min(1).max(100))
      .max(20)
      .optional(),
    allergyStatus: z.enum(["unknown", "no_known", "reported"]).optional(),
    locale: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[a-zA-Z-]+$/, "locale の形式が不正です。")
      .optional(),
  })
  .strict();
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

// 03_機能仕様書 §3.2: 氏名・カナ・生年月日・電話番号・郵便番号・住所(都道府県/市区町村/番地) が完了必須
export const REQUIRED_PROFILE_FIELDS = [
  "familyName",
  "givenName",
  "familyNameKana",
  "givenNameKana",
  "birthDate",
  "phoneNumber",
  "postalCode",
  "address",
] as const;

export const emptyBodySchema = z.object({}).strict();

/**
 * API-019 POST /uploads/init。拡張子ではなく MIME・容量・SHA-256 を申告させる。
 * 実ファイルとの一致は complete 時にサーバが検証する（クライアント申告を信用しない）。
 */
export const uploadInitBodySchema = z
  .object({
    fileName: z.string().trim().min(1).max(200).optional(),
    mimeType: z.enum(UPLOAD_ALLOWED_MIME_TYPES),
    // 上限超過はサービス層で 413 FILE_TOO_LARGE を返す（03 §4.2）
    bytes: z.number().int().min(1, "ファイルが空です。"),
    sha256: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[0-9a-f]{64}$/, "SHA-256 の形式が不正です。"),
    sourcePurpose: z.enum(["prescription_photo", "medication_notebook"]),
  })
  .strict();
export type UploadInitBody = z.infer<typeof uploadInitBodySchema>;

/**
 * API-023 POST /medications（本人確認済み薬剤登録）。
 * OCR由来は ocrJobId(+candidateId) を付すと出所・証跡が保存される。
 * currentStatus は利用者の明示が必須（FR-M05）。未確認のまま登録する場合は
 * confirmationStatus="unconfirmed" を指定する（E2E-003）。
 */
export const medicationCreateSchema = z
  .object({
    displayName: z.string().trim().min(1, "薬剤名を入力してください。").max(200),
    genericName: z.string().trim().max(200).optional(),
    // OCR候補の誤値を利用者が明示的に消せるよう null 許容（FR-M04）。
    // undefined は候補値の引継ぎ、null はクリア、文字列は上書き。
    strength: z.string().trim().max(100).nullable().optional(),
    instructionsText: z.string().trim().max(500).nullable().optional(),
    quantity: z.string().trim().max(100).nullable().optional(),
    prescribedAt: z
      .string()
      .trim()
      .regex(DATE_PATTERN, "処方日は YYYY-MM-DD 形式で入力してください。")
      .nullable()
      .optional(),
    currentStatus: z.enum(["taking", "past", "not_sure"]),
    confirmationStatus: z.enum(["confirmed", "unconfirmed"]).optional(),
    ocrJobId: z.string().min(1).max(200).optional(),
    candidateId: z.string().min(1).max(200).optional(),
    attachToQuestionnaire: z.boolean().optional(),
  })
  .strict();
export type MedicationCreateBody = z.infer<typeof medicationCreateSchema>;

/** API-025 PATCH /medications/{id}。出所フィールドは変更不可。 */
export const medicationPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    genericName: z.string().trim().max(200).nullable().optional(),
    strength: z.string().trim().max(100).nullable().optional(),
    instructionsText: z.string().trim().max(500).nullable().optional(),
    quantity: z.string().trim().max(100).nullable().optional(),
    prescribedAt: z
      .string()
      .trim()
      .regex(DATE_PATTERN)
      .nullable()
      .optional(),
    currentStatus: z.enum(["taking", "past", "not_sure"]).optional(),
    confirmationStatus: z
      .enum(["unconfirmed", "confirmed", "rejected"])
      .optional(),
    attachToQuestionnaire: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "更新する項目を指定してください。",
  });
export type MedicationPatchBody = z.infer<typeof medicationPatchSchema>;

/** API-009 POST /intakes。 */
export const intakeCreateSchema = z
  .object({
    questionnaireTemplateVersion: z.string().trim().max(50).optional(),
    locale: z.string().trim().max(10).optional(),
  })
  .strict();
export type IntakeCreateBody = z.infer<typeof intakeCreateSchema>;

/** API-011 POST /intakes/{id}/symptoms（FR-I01/I02）。 */
export const intakeSymptomsSchema = z
  .object({
    initialSymptomText: z
      .string()
      .max(
        INTAKE_SYMPTOM_MAX_CHARS,
        `症状は${INTAKE_SYMPTOM_MAX_CHARS}文字以内で入力してください。`,
      ),
    bodyLocations: z
      .array(z.enum(BODY_LOCATIONS))
      .max(BODY_LOCATIONS.length)
      .default([]),
    expectedIntakeRevision: z.number().int().min(1),
  })
  .strict();
export type IntakeSymptomsBody = z.infer<typeof intakeSymptomsSchema>;

/**
 * API-013 POST /intakes/{id}/answers。
 * 表示時の questionRevision と intake revision を必須化（stale検出, 04 §9.1）。
 */
export const intakeAnswerSchema = z
  .object({
    questionId: z.string().min(1).max(200),
    questionRevision: z.number().int().min(1),
    selectedCodes: z.array(z.string().min(1).max(50)).max(10).default([]),
    freeText: z.string().max(2000).nullish(),
    answerState: z.enum(["answered", "unknown", "skipped"]),
    expectedIntakeRevision: z.number().int().min(1),
  })
  .strict();
export type IntakeAnswerBody = z.infer<typeof intakeAnswerSchema>;

/** API-014 PATCH /answers/{answerId} — answers の docId は questionId。 */
export const intakeAnswerPatchSchema = z
  .object({
    questionRevision: z.number().int().min(1),
    selectedCodes: z.array(z.string().min(1).max(50)).max(10).optional(),
    freeText: z.string().max(2000).nullable().optional(),
    answerState: z.enum(["answered", "unknown", "skipped"]).optional(),
    expectedIntakeRevision: z.number().int().min(1),
  })
  .strict()
  .refine((v) => v.selectedCodes !== undefined || v.freeText !== undefined || v.answerState !== undefined, {
    message: "更新する項目を指定してください。",
  });
export type IntakeAnswerPatchBody = z.infer<typeof intakeAnswerPatchSchema>;
