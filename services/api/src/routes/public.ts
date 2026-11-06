import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Deps } from "../deps.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { getLegalDocuments } from "../repos/legalConfig.js";
import type {
  LegalDocumentSet,
  LegalDocumentVersion,
} from "../domain/legalDocuments.js";
import { errors, legalDocumentsResponseSchema } from "./apiDocs.js";
import { RateRules } from "../lib/rateLimit.js";
import { CONSENT_TYPE_SET } from "../domain/types.js";

/**
 * 版情報の公開キャッシュ TTL。起動時に全クライアントが呼ぶ最高トラフィック
 * 経路であり、同一ドキュメントを要求毎に読むと課金 read が利用者数に比例
 * するため短期キャッシュする（版ローテーションの伝播遅延は10秒以内）。
 * 同意提出・評価側は本キャッシュを使わず常に fresh read を維持する。
 */
const LEGAL_DOC_CACHE_MS = 10_000;

const UNAVAILABLE = () =>
  new ApiError(503, ErrorCodes.UPSTREAM_UNAVAILABLE, "公開文書が準備できていません。", {
    retryable: true,
    // 失敗もキャッシュTTL分保持されるため、TTLを超える再試行間隔を案内する
    retryAfterSeconds: 15,
  });

/**
 * 公開フィールドのみに絞って検証する。version/documentHash が非空文字列の
 * 文書のみ受理（publishedAt 欠落は致命的でないため空文字に正規化）。
 * Firestore 上に混入し得る運用メタ等の余計なキーは応答に流さない。
 */
function toPublicDocument(d: unknown): LegalDocumentVersion | undefined {
  if (d === null || typeof d !== "object") return undefined;
  const v = d as Record<string, unknown>;
  if (
    typeof v.version !== "string" ||
    v.version === "" ||
    typeof v.documentHash !== "string" ||
    v.documentHash === ""
  ) {
    return undefined;
  }
  return {
    version: v.version,
    documentHash: v.documentHash,
    publishedAt: toIso(v.publishedAt),
  };
}

function toIso(published: unknown): string {
  if (typeof published === "string") {
    // UTC ISO に正規化（"2026-11-01" 等の非Z形式を素通ししない）
    return Number.isNaN(Date.parse(published))
      ? ""
      : new Date(published).toISOString();
  }
  if (
    published !== null &&
    typeof published === "object" &&
    typeof (published as { toDate?: unknown }).toDate === "function"
  ) {
    try {
      const d = (published as { toDate(): unknown }).toDate();
      return d instanceof Date && !Number.isNaN(d.getTime())
        ? d.toISOString()
        : "";
    } catch {
      return "";
    }
  }
  return "";
}

/** API-039: 公開法務文書の現行版・ハッシュ。クライアントが同意画面の版照合に使う。 */
export function registerPublicRoutes(app: FastifyInstance, deps: Deps): void {
  let cached:
    | { docSet: LegalDocumentSet | undefined; expiresAtMs: number }
    | undefined;
  let inflight: Promise<LegalDocumentSet | undefined> | undefined;

  const loadDocSet = (log: FastifyBaseLogger) => {
    const nowMs = deps.clock.now().getTime();
    if (!cached || cached.expiresAtMs <= nowMs) {
      // 同時到着は進行中 read を共有（single-flight）
      inflight ??= getLegalDocuments(deps.db)
        .catch((err) => {
          log.warn(
            { err, route: "legal-documents" },
            "legal config read failed",
          );
          return undefined;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight.then((docSet) => {
        // 取得失敗（undefined）もキャッシュし、障害中の read 連打を防ぐ
        cached = {
          docSet,
          expiresAtMs: deps.clock.now().getTime() + LEGAL_DOC_CACHE_MS,
        };
        return docSet;
      });
    }
    return Promise.resolve(cached.docSet);
  };

  app.withTypeProvider<ZodTypeProvider>().get(
    "/v1/public/legal-documents",
    {
      // 起動時に全クライアントが呼ぶため、CGNAT配下でも動く読み取り系レートを適用
      config: { access: { tier: "public", rateRule: RateRules.publicRead } },
      schema: {
        response: {
          200: legalDocumentsResponseSchema,
          ...errors(401, 429, 500, 503),
        },
        tags: ["public"],
        summary: "公開法務文書（現行版・必須同意一覧）",
      },
    },
    async (req, reply) => {
      // 版ローテーションの伝播を経路キャッシュが遅らせないよう配信側でも抑止
      void reply.header("cache-control", "no-store");
      const docSet = await loadDocSet(req.log);
      if (!docSet) {
        // 未設定・読取失敗・requiredConsents 不備のいずれか（詳細は loadDocSet の warn 参照）
        req.log.warn(
          { route: "legal-documents" },
          "legal config missing or unreadable",
        );
        throw UNAVAILABLE();
      }
      // 公開フィールドへ正規化しつつ、既知種別外のキーと
      // 版/ハッシュ不備の文書を落とす。null-prototype でプロトタイプ名
      // （constructor 等）の誤判定を防ぐ
      const documents = Object.create(null) as LegalDocumentSet["documents"];
      for (const [type, raw] of Object.entries(docSet.documents)) {
        if (!CONSENT_TYPE_SET.has(type)) continue;
        const pub = toPublicDocument(raw);
        if (pub) documents[type as keyof typeof documents] = pub;
      }
      // 必須一覧の欠落・必須種別の文書欠落/メタ不備は設定不備として安全側に失敗させる
      const complete = docSet.requiredConsents.every(
        (t) => typeof t === "string" && Object.hasOwn(documents, t),
      );
      if (!complete) {
        req.log.warn(
          { route: "legal-documents" },
          "legal config incomplete (required consents or document metadata missing)",
        );
        throw UNAVAILABLE();
      }
      return {
        documents,
        requiredConsents: docSet.requiredConsents,
        updatedAt: docSet.updatedAt ?? null,
      };
    },
  );
}
