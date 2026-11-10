import type { OcrFailureCode } from "./types.js";

/** PDF の暫定ページ上限（02 §7）。 */
export const OCR_PDF_MAX_PAGES = 5;

/** OCR原文の永続化上限（証跡保存。超過分は切り詰めてフラグを立てる）。 */
export const OCR_TEXT_MAX_CHARS = 20_000;

/**
 * 薬剤候補（FR-O03）。全フィールド nullable — OCR/AI は欠損を推測せず
 * 未回答として表す（VAL-011）。利用者確認まで status=unconfirmed。
 */
export interface OcrCandidate {
  candidateId: string;
  /** 薬剤名 */
  name: string | null;
  /** 規格（例: 5mg） */
  strength: string | null;
  /** 用法・用量（例: 1日3回毎食後） */
  dosage: string | null;
  /** 用量・日数 */
  quantity: string | null;
  /** 処方日 YYYY-MM-DD */
  prescribedAt: string | null;
  /** 0-1 の信頼度 */
  confidence: number;
  /** extractedText 内の根拠位置（証跡） */
  evidenceSpan?: { start: number; end: number };
}

/** OCRエンジンアダプタの結果。失敗は分類コードで返す（例外にしない）。 */
export type OcrEngineResult =
  | {
      ok: true;
      candidates: OcrCandidate[];
      /** OCR生テキスト。根拠・証跡保存用（FR-O07 拡張）。 */
      extractedText?: string;
    }
  | {
      ok: false;
      code: OcrFailureCode;
      /** true なら再キューで再試行（engine_unavailable 等）。 */
      retryable?: boolean;
    };
