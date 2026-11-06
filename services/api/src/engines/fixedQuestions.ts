import type { LlmQuestion } from "../ai/questionSchema.js";

/**
 * FR-I10 / BR-03 の固定質問セット（医療専門家検証済みの決定的質問）。
 * FR-I07 の要約に必要なトピックを網羅する（主訴/発症時期/頻度/部位/
 * 生活影響/服薬・持病/アレルギー）。順序は情報価値の高い順。
 */
export const FIXED_TOPICS = [
  "onset_timing",
  "severity",
  "frequency",
  "life_impact",
  "associated_symptoms",
  "current_medication",
  "medical_history",
  "allergy",
] as const;

export const UNKNOWN_OPTION = { code: "UNKNOWN", label: "分からない" } as const;

export const FIXED_QUESTIONS: ReadonlyArray<LlmQuestion> = [
  {
    questionText: "その症状は、いつ頃からありますか？",
    topic: "onset_timing",
    options: [
      { code: "TODAY", label: "今日から" },
      { code: "LT_WEEK", label: "1週間以内" },
      { code: "GT_WEEK", label: "1週間より前" },
      UNKNOWN_OPTION,
    ],
  },
  {
    questionText: "症状の強さは、どのくらいですか？",
    topic: "severity",
    options: [
      { code: "MILD", label: "軽い（気になる程度）" },
      { code: "MODERATE", label: "つらい（生活に少し支障）" },
      { code: "SEVERE", label: "非常につらい" },
      UNKNOWN_OPTION,
    ],
  },
  {
    questionText: "症状は、どのくらいの頻度で起きますか？",
    topic: "frequency",
    options: [
      { code: "CONSTANT", label: "ずっと続いている" },
      { code: "DAILY", label: "ほぼ毎日" },
      { code: "OCCASIONAL", label: "ときどき" },
      UNKNOWN_OPTION,
    ],
  },
  {
    questionText: "日常生活への影響はありますか？",
    topic: "life_impact",
    options: [
      { code: "NONE", label: "ほとんど影響なし" },
      { code: "SOME", label: "一部の動作がつらい" },
      { code: "CANNOT_DAILY", label: "日常生活が難しい" },
      UNKNOWN_OPTION,
    ],
  },
  {
    questionText: "他にも気になる症状はありますか？",
    topic: "associated_symptoms",
    options: [
      { code: "FEVER", label: "発熱がある" },
      { code: "PAIN", label: "痛みがある" },
      { code: "NONE", label: "特にない" },
      UNKNOWN_OPTION,
    ],
  },
  {
    questionText: "現在、服用している薬はありますか？",
    topic: "current_medication",
    options: [
      { code: "YES", label: "ある" },
      { code: "NONE", label: "ない" },
      UNKNOWN_OPTION,
    ],
  },
  {
    questionText: "持病や既往歴はありますか？",
    topic: "medical_history",
    options: [
      { code: "YES", label: "ある" },
      { code: "NONE", label: "ない" },
      UNKNOWN_OPTION,
    ],
  },
  {
    questionText: "薬や食べ物でアレルギーはありますか？",
    topic: "allergy",
    options: [
      { code: "YES", label: "ある" },
      { code: "NONE", label: "ない" },
      UNKNOWN_OPTION,
    ],
  },
];

/** 未出題の固定質問を順に返す。全て出題済みなら null。 */
export function nextFixedQuestion(askedTopics: Set<string>): LlmQuestion | null {
  for (const q of FIXED_QUESTIONS) {
    if (!askedTopics.has(q.topic)) return q;
  }
  return null;
}
