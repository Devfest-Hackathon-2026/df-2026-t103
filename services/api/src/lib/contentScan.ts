import type { ContentScanner } from "../deps.js";
import {
  isUploadMimeType,
  matchesMagicBytes,
} from "../domain/uploads.js";

const SIGNATURE_BYTES = 8;

/**
 * 内容チェックフックの既定実装。
 * 宣言MIMEと先頭マジックバイトの一致を検証し、拡張子偽装・異種ファイルを拒否する
 * （SEC-07）。ウイルススキャン・EXIF除去・ページ数検査は調達後に本IFの
 * 別実装または前処理ワーカーへ接続する（02 §7, FR-M01）。
 */
export class SignatureContentScanner implements ContentScanner {
  async scanUpload(params: {
    bucket: string;
    objectPath: string;
    declaredMimeType: string;
    readPrefix: (maxBytes: number) => Promise<Uint8Array>;
  }): Promise<{ verdict: "clean" | "rejected"; reason?: string }> {
    if (!isUploadMimeType(params.declaredMimeType)) {
      return { verdict: "rejected", reason: "unsupported_mime" };
    }
    // 読取失敗は再試行可能なエラーとして伝播させる（一時障害で
    // 有効な画像を終端rejected+削除しないため）。拒否は検査に
    // 成功した内容が不正な場合のみ。
    const prefix = await params.readPrefix(SIGNATURE_BYTES);
    if (!matchesMagicBytes(prefix, params.declaredMimeType)) {
      return { verdict: "rejected", reason: "content_mismatch" };
    }
    return { verdict: "clean" };
  }
}
