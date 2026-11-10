import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Deps } from "../deps.js";
import type { ConsentState } from "./context.js";
import { ApiError, ErrorCodes } from "../lib/errors.js";
import { RateRules, type RateLimitRule } from "../lib/rateLimit.js";
import { getAccount, latestConsentsByType } from "../repos/accounts.js";
import { CONSENT_HISTORY_SOURCES } from "../domain/types.js";
import { audit } from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { getLegalDocuments } from "../repos/legalConfig.js";
import { getActiveMemberships } from "../repos/facilities.js";
import type { ConsentType, MembershipRole } from "../domain/types.js";
import type { LegalDocumentSet } from "../domain/legalDocuments.js";

export type AccessTier =
  | "none"
  | "public"
  | "internal"
  | "authenticated"
  | "consented"
  | "active";

export interface RouteAccess {
  tier: AccessTier;
  /** pending_deletion でも到達を許す（退会取消・状況参照用）。 */
  allowPendingDeletion?: boolean;
  /** suspended でも到達を許す（/me の状態参照用）。 */
  allowSuspended?: boolean;
  rateRule?: RateLimitRule;
}

const APP_CHECK_HEADER = "x-firebase-appcheck";
const INTERNAL_TOKEN_HEADER = "x-internal-job-token";

function clientIp(req: FastifyRequest): string {
  return req.ip || "unknown";
}

function safeTokenEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * ルート共通の検証パイプライン（02 §11.1 の検証順に従う）。
 * 認証→App Check→状態・同意→認可→レート制御。public は App Check+レートのみ。
 */
export async function enforceAccess(
  deps: Deps,
  req: FastifyRequest,
): Promise<void> {
  // 未登録パスは 404 ハンドラへ。not-found コンテキストでは
  // routeOptions.url/config が undefined になり得るため先に判定する
  if (req.is404) return;
  const access = req.routeOptions.config?.access;
  if (!access) {
    // 実際にマッチした業務ルート（/v1, /v1/*）でアクセス階層の宣言漏れが
    // あれば fail-closed。swagger UI 等プラグイン提供ルート（/docs 等）
    // の到達は許す。
    const url = req.routeOptions.url;
    if (url === "/v1" || url?.startsWith("/v1/")) {
      throw new ApiError(
        500,
        ErrorCodes.INTERNAL,
        "ルートのアクセス設定がありません。",
      );
    }
    return;
  }

  // none: LB/監視 scope（認証・App Check・レートなし）を明示宣言した経路。
  if (access.tier === "none") return;

  if (access.tier === "public") {
    await checkAppCheck(deps, req);
    consumeRate(deps, req, access.rateRule ?? RateRules.register, clientIp(req));
    return;
  }

  if (access.tier === "internal") {
    await checkInternalToken(deps, req);
    consumeRate(deps, req, access.rateRule ?? RateRules.internalJob, clientIp(req));
    return;
  }

  // ---- 認証（ID token） ----
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw ApiError.unauthenticated("認証が必要です。");
  }
  const token = await deps.auth.verifyIdToken(header.slice(7).trim(), true);
  if (!token) {
    // 提示されたトークンの検証失敗は認証イベントとして監査に残す
    // （Bearer 未提示は雑音として記録しない）。UIDは検証不能なため省略。
    // 未認証段階のためレート制御前に書き込まれる点を踏まえ、監査書込自体を
    // IP単位で制限し、トークンSpamによる書込コスト増幅を抑止する
    // （制限超過時は401応答のみで監査は落とす）。
    // req.ip は trustProxy 設定次第ではプロキシ共有IPとなるため、
    // その場合は全体バケットとして上限のみ機能する
    let throttled = false;
    try {
      deps.rateLimiter.consume(
        `auth_fail:${clientIp(req)}`,
        RateRules.authFailAudit,
      );
    } catch {
      throttled = true;
    }
    if (!throttled) {
      await audit(deps, {
        actorType: "patient",
        action: AUDIT_ACTIONS.AUTH_FAIL,
        decision: "deny",
        requestId: req.requestContext.requestId,
        details: { clientClass: "bearer", resultCode: "token_invalid" },
      });
    }
    throw ApiError.unauthenticated("認証情報が無効または期限切れです。");
  }
  req.requestContext.auth = token;

  // ---- App Check ----
  await checkAppCheck(deps, req);

  // ---- アカウント状態 ----
  const account = await getAccount(deps.db, token.uid);
  req.requestContext.account = account ?? null;
  if (account) {
    if (account.accountStatus === "pending_deletion" && !access.allowPendingDeletion) {
      throw ApiError.forbidden("退会手続き中のため利用できません。");
    }
    if (account.accountStatus === "suspended" && !access.allowSuspended) {
      throw ApiError.forbidden("アカウントが停止されています。");
    }
    if (account.accountStatus === "deleted") {
      throw ApiError.forbidden("このアカウントは削除済みです。");
    }
  }

  // ---- 同意・onboarding の評価 ----
  if (access.tier === "consented" || access.tier === "active") {
    const consentState = await evaluateConsents(deps, req);
    req.requestContext.consentState = consentState;
    if (!account) {
      throw ApiError.forbidden("アカウントが初期化されていません。");
    }
    if (!consentState.current) {
      throw ApiError.precondition(
        "必要な同意が完了していません。同意手続きを行ってください。",
      );
    }
    if (
      access.tier === "active" &&
      (account.accountStatus !== "active" || account.onboardingState !== "completed")
    ) {
      throw ApiError.forbidden("プロフィール登録が完了していません。");
    }
  }

  consumeRate(
    deps,
    req,
    access.rateRule ?? RateRules.authenticatedDefault,
    token.uid,
  );
}

async function checkAppCheck(deps: Deps, req: FastifyRequest): Promise<void> {
  if (deps.config.appCheckMode !== "enforce") return;
  const token = req.headers[APP_CHECK_HEADER];
  const value = Array.isArray(token) ? token[0] : token;
  if (!value || !(await deps.appCheck.verify(value))) {
    throw new ApiError(
      401,
      ErrorCodes.APP_CHECK_FAILED,
      "クライアントの検証に失敗しました。",
    );
  }
}

async function checkInternalToken(deps: Deps, req: FastifyRequest): Promise<void> {
  const expected = deps.config.internalJobToken;
  if (!expected) {
    if (deps.config.emulator || deps.config.nodeEnv === "test") {
      req.log.warn("INTERNAL_JOB_TOKEN unset; allowing internal job call (emulator)");
      return;
    }
    throw ApiError.forbidden("内部ジョブが設定されていません。");
  }
  const header = req.headers[INTERNAL_TOKEN_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !safeTokenEqual(value, expected)) {
    throw ApiError.forbidden("内部ジョブの呼び出しが拒否されました。");
  }
}

function consumeRate(
  deps: Deps,
  req: FastifyRequest,
  rule: RateLimitRule,
  key: string,
): void {
  deps.rateLimiter.consume(`${req.routeOptions.url ?? req.url}:${key}`, rule);
}

/**
 * 必須同意の現行版判定。
 * 同意レコードの documentVersion が現行版と一致し granted のものだけ有効。
 */
export async function evaluateConsents(
  deps: Deps,
  req: FastifyRequest,
): Promise<ConsentState> {
  const uid = req.requestContext.auth?.uid;
  if (!uid) return { current: false, missing: [] };

  let legalDocs: LegalDocumentSet | null | undefined;
  try {
    legalDocs =
      req.requestContext.legalDocs !== undefined
        ? req.requestContext.legalDocs
        : await getLegalDocuments(deps.db);
  } catch (err) {
    throw new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "同意文書の取得に失敗しました。",
      { retryable: true, cause: err },
    );
  }
  req.requestContext.legalDocs = legalDocs;
  if (!legalDocs) {
    throw new ApiError(500, ErrorCodes.INTERNAL, "同意文書の設定が見つかりません。");
  }

  // 必須種別の文書/メタ欠落は設定不備。ユーザーの未同意（412）ではなく
  // サーバ障害として検知できるよう 500 とする（公開経路の 503 と同義）。
  // 同意クエリ発行前に検証し、設定不備時の無駄な read を省く
  const requiredVersions = new Map<ConsentType, string>();
  for (const type of legalDocs.requiredConsents) {
    const required = legalDocs.documents[type];
    if (!required?.version || !required?.documentHash) {
      throw new ApiError(
        500,
        ErrorCodes.INTERNAL,
        "同意文書の設定が不完全です。",
      );
    }
    requiredVersions.set(type, required.version);
  }

  // 同意履歴の読取も Firestore 一時障害として 503 retryable に分類する
  let granted: Awaited<ReturnType<typeof latestConsentsByType>>;
  try {
    granted = await latestConsentsByType(
      deps.db,
      uid,
      legalDocs.requiredConsents,
      // 送信証跡（delivery_send）は「現在の同意」ではなく不可侵の過去証跡。
      // requiredConsents に hospital_disclosure が加わった将来変更でも
      // 証跡が standing consent を偽装しないよう絞り込む。
      { sources: CONSENT_HISTORY_SOURCES },
    );
  } catch (err) {
    throw new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "同意履歴の取得に失敗しました。",
      { retryable: true, cause: err },
    );
  }
  const missing: ConsentType[] = [];
  for (const type of legalDocs.requiredConsents) {
    const consent = granted.get(type);
    if (!consent || consent.documentVersion !== requiredVersions.get(type)) {
      missing.push(type);
    }
  }
  return { current: missing.length === 0, missing };
}

/** 高リスク操作の再認証要件（auth_time が直近 windowSeconds 以内）。 */
export function requireFreshAuth(deps: Deps, req: FastifyRequest): void {
  const auth = req.requestContext.auth;
  if (!auth) throw ApiError.unauthenticated();
  const ageSec = deps.clock.now().getTime() / 1000 - auth.authTimeSeconds;
  if (ageSec > deps.config.reauthWindowSeconds) {
    throw new ApiError(
      403,
      ErrorCodes.REAUTH_REQUIRED,
      "この操作には再認証が必要です。",
    );
  }
}

/** 施設テナント境界: URLの facilityId を権限証明にせず membership 正本で照合（02 §5.3）。 */
export async function requireFacilityRole(
  deps: Deps,
  req: FastifyRequest,
  facilityId: string,
  roles: MembershipRole[],
): Promise<void> {
  const uid = req.requestContext.auth?.uid;
  if (!uid) throw ApiError.unauthenticated();
  const memberships = await getActiveMemberships(deps.db, uid);
  const hit = memberships.find(
    (m) => m.facilityId === facilityId && roles.includes(m.role),
  );
  if (!hit) {
    throw ApiError.forbidden("この施設に対する権限がありません。");
  }
}

export async function requirePlatformSecurityAdmin(
  deps: Deps,
  req: FastifyRequest,
): Promise<void> {
  const uid = req.requestContext.auth?.uid;
  if (!uid) throw ApiError.unauthenticated();
  const memberships = await getActiveMemberships(deps.db, uid);
  if (!memberships.some((m) => m.role === "platform_security_admin")) {
    throw ApiError.forbidden("運営管理者の権限がありません。");
  }
}
