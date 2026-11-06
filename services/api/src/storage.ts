import type { Storage } from "firebase-admin/storage";
import type { AppConfig } from "./config.js";
import type { StorageGateway, UploadUrlInstruction } from "./deps.js";

/**
 * Firebase Cloud Storage(admin SDK) 実装。
 * - 本番: V4 署名URL（Cloud Run の SA に iam.serviceAccounts.signBlob が必要）
 * - エミュレータ: 署名不能のため Storage Emulator のメディアアップロードURLを返す
 *   （開発専用。クライアントは同じ PUT/Content-Type で送ればよい）
 */
export function createStorageGateway(
  storage: Storage,
  config: AppConfig,
): StorageGateway {
  const emulatorHost =
    process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? "localhost:9199";
  // クライアントが解決できる公開側ホスト。Compose では emulatorHost は
  // 内部DNS名(firebase:9199)のためブラウザから到達不能。公開側を分離する。
  const publicEmulatorHost = config.storageEmulatorPublicHost ?? emulatorHost;

  return {
    async deleteObject(bucket, objectPath, generation) {
      const file = storage.bucket(bucket).file(objectPath);
      await file.delete({ ignoreNotFound: true });
      void generation; // generation一致確認はエミュレータ非対応のため省略（本運用で再検討）
    },

    async inspectObject(bucket, objectPath) {
      const file = storage.bucket(bucket).file(objectPath);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [meta] = await file.getMetadata();
      return {
        generation: String(meta.generation ?? ""),
        sizeBytes: Number(meta.size ?? 0),
        contentType: meta.contentType,
        md5HashBase64: meta.md5Hash ?? null,
      };
    },

    async createUploadUrl(params): Promise<UploadUrlInstruction> {
      const expiresAtIso = params.expiresAt.toISOString();
      if (config.emulator) {
        // Storage Emulator の GCS JSON API 互換アップロードエンドポイント。
        // メディアアップロードはPOST（PUTは継続用のresumableでupload_id必須）。
        const url =
          `http://${publicEmulatorHost}/upload/storage/v1/b/` +
          `${encodeURIComponent(params.bucket)}/o` +
          `?uploadType=media&name=${encodeURIComponent(params.objectPath)}` +
          // 本番と同じく新規作成のみ許可（既存オブジェクトの上書きを拒否）
          `&ifGenerationMatch=0`;
        return {
          method: "POST",
          url,
          headers: { "content-type": params.mimeType },
          expiresAt: expiresAtIso,
        };
      }
      const file = storage.bucket(params.bucket).file(params.objectPath);
      // create-only: generation=0 前提条件で既存オブジェクトの上書きを禁止する。
      // 署名対象ヘッダなのでクライアントも同じ値を送る必要がある（改ざん不可）。
      const [url] = await file.getSignedUrl({
        version: "v4",
        action: "write",
        expires: params.expiresAt,
        contentType: params.mimeType,
        extensionHeaders: { "x-goog-if-generation-match": "0" },
      });
      return {
        method: "PUT",
        url,
        headers: {
          "content-type": params.mimeType,
          "x-goog-if-generation-match": "0",
        },
        expiresAt: expiresAtIso,
      };
    },

    async readObjectPrefix(bucket, objectPath, maxBytes) {
      const file = storage.bucket(bucket).file(objectPath);
      const [buf] = await file.download({ start: 0, end: maxBytes - 1 });
      return new Uint8Array(buf);
    },
  };
}
