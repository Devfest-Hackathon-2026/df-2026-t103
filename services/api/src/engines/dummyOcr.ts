import type { OcrEngine } from "../deps.js";
import type { OcrEngineResult } from "../domain/ocr.js";

/**
 * ダミーOCRエンジン（02 §8: 実エンジン未調達時の既定実装）。
 * 画像を読まず、候補0件の成功を返す。利用者が手入力で登録する導線は
 * 候補なしでも成立するため、抽出なしを正常終了として扱う。
 * 実エンジン確定後は OcrEngine の別実装（Vision/外部API等）に差し替える。
 */
export class DummyOcrEngine implements OcrEngine {
  readonly name = "dummy";

  async extract(): Promise<OcrEngineResult> {
    return { ok: true, candidates: [] };
  }
}
