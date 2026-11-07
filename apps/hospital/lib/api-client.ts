import { parseReviewFacilities, parseVerificationSummaries, type ReviewChecks } from "./facility-review";
export type JobType = "ocr" | "deletion";
export type JobFailure = { type: JobType; jobId: string; failureCode: string | null; attempts: number; failedAt: string | null };
export type JobFailurePage = { items: JobFailure[]; nextCursor: string | null };

const errorMessages: Record<number, string> = {
  400: "入力内容を確認してください。",
  401: "認証またはクライアントの検証に失敗しました。再ログインしてください。",
  403: "運営管理者の権限がありません。",
  404: "対象が見つかりません。施設IDを確認してください。",
  409: "審査状態が変わっている可能性があります。一覧を再取得して確認してください。",
  429: "操作が多すぎます。時間をおいて再試行してください。",
};

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly reauthRequired = false) {
    super(reauthRequired
      ? "再認証が必要です。ログアウトして再ログイン後、対象施設を確認して操作してください。"
      : errorMessages[status] ?? "APIへの接続に失敗しました。時間をおいて再試行してください。");
  }
}

// Whitelist the API-038 response. Do not carry unknown fields (including PHI)
// into component state or expose backend error bodies to the screen/logs.
export function parseJobFailurePage(value: unknown): JobFailurePage {
  if (!value || typeof value !== "object") throw new Error("API応答の形式が不正です。");
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || page.items.length > 100 || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new Error("API応答の形式が不正です。");
  const items = page.items.map((raw): JobFailure => {
    if (!raw || typeof raw !== "object") throw new Error("API応答の形式が不正です。");
    const item = raw as Record<string, unknown>;
    if ((item.type !== "ocr" && item.type !== "deletion") || typeof item.jobId !== "string" || !(item.failureCode === null || typeof item.failureCode === "string") || typeof item.attempts !== "number" || !Number.isInteger(item.attempts) || item.attempts < 0 || !(item.failedAt === null || typeof item.failedAt === "string")) throw new Error("API応答の形式が不正です。");
    return { type: item.type, jobId: item.jobId, failureCode: item.failureCode, attempts: item.attempts, failedAt: item.failedAt };
  });
  return { items, nextCursor: page.nextCursor };
}

export type AuditSummary = {
  eventId: string; action: string; actorType: string; occurredAt: string | null;
  decision: "allow" | "deny" | null; outcome: "success" | "failure" | "other" | null;
};
export type AuditSummaryPage = { items: AuditSummary[]; nextCursor: string | null };

export function parseAuditSummaryPage(value: unknown): AuditSummaryPage {
  const invalid = () => new Error("API応答の形式が不正です。");
  if (!value || typeof value !== "object") throw invalid();
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || page.items.length > 100 || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw invalid();
  const items = page.items.map((raw): AuditSummary => {
    if (!raw || typeof raw !== "object") throw invalid();
    const item = raw as Record<string, unknown>;
    if (typeof item.eventId !== "string" || !/^ae_[0-9a-f]{64}$/.test(item.eventId) || typeof item.action !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(item.action) || !["patient", "staff", "platform", "service", "unknown"].includes(String(item.actorType)) || !(item.occurredAt === null || typeof item.occurredAt === "string" && Number.isFinite(Date.parse(item.occurredAt))) || ![null, "allow", "deny"].includes(item.decision as string | null) || ![null, "success", "failure", "other"].includes(item.outcome as string | null)) throw invalid();
    return { eventId: item.eventId, action: item.action, actorType: item.actorType as string, occurredAt: item.occurredAt as string | null, decision: item.decision as AuditSummary["decision"], outcome: item.outcome as AuditSummary["outcome"] };
  });
  return { items, nextCursor: page.nextCursor };
}

export function createApiClient(config: {
  apiBaseUrl: string;
  idToken: () => Promise<string>;
  appCheckToken: () => Promise<string | null>;
  emulator: boolean;
}) {
  async function authHeaders() {
    const token = await config.idToken();
    if (!token) throw new ApiError(401);
    const appCheck = await config.appCheckToken();
    if (!appCheck && !config.emulator) throw new ApiError(401);
    return { Authorization: `Bearer ${token}`, ...(appCheck ? { "X-Firebase-AppCheck": appCheck } : {}) };
  }
  return {
    async reviewFacilities(cursor?: string, signal?: AbortSignal) {
      const headers = await authHeaders();
      const query = new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${config.apiBaseUrl}/operator/facilities?${query}`, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal, headers });
      if (!response.ok) throw new ApiError(response.status);
      return parseReviewFacilities(await response.json());
    },
    async verificationRecords(facilityId: string, cursor?: string, signal?: AbortSignal) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(facilityId)) throw new Error("施設IDを確認してください。");
      const headers = await authHeaders();
      const query = new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) });
      const response = await fetch(`${config.apiBaseUrl}/operator/facilities/${encodeURIComponent(facilityId)}/verification-records?${query}`, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal, headers });
      if (!response.ok) throw new ApiError(response.status);
      return parseVerificationSummaries(await response.json());
    },
    async reviewFacility(facilityId: string, decision: "verified" | "rejected", input: { checks: ReviewChecks; verificationRecordId: string; reason?: string }, signal?: AbortSignal): Promise<void> {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(facilityId) || !input.verificationRecordId.trim() || input.verificationRecordId.length > 200 || Object.values(input.checks).some((value) => typeof value !== "boolean") || (decision === "verified" && !Object.values(input.checks).every(Boolean)) || (decision === "rejected" && (!input.reason?.trim() || input.reason.length > 500))) throw new Error("検証項目・文書参照・却下理由を確認してください。");
      const headers = await authHeaders();
      const response = await fetch(`${config.apiBaseUrl}/operator/facilities/${encodeURIComponent(facilityId)}/${decision === "verified" ? "verify" : "reject"}`, {
        method: "POST", cache: "no-store", credentials: "omit", redirect: "error", signal,
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ checks: input.checks, verificationRecordId: input.verificationRecordId.trim(), ...(decision === "rejected" ? { reason: input.reason!.trim() } : {}) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new ApiError(response.status, response.status === 403 && body?.error?.code === "REAUTH_REQUIRED");
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("facilityId" in body) || body.facilityId !== facilityId || !("verificationStatus" in body) || body.verificationStatus !== decision) throw new Error("審査結果を確認できませんでした。");
    },
    async auditEvents(cursor?: string, signal?: AbortSignal): Promise<AuditSummaryPage> {
      const headers = await authHeaders();
      const query = new URLSearchParams({ limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${config.apiBaseUrl}/operator/audit-events?${query}`, {
        method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal, headers,
      });
      if (!response.ok) throw new ApiError(response.status);
      return parseAuditSummaryPage(await response.json());
    },
    async disableFacility(facilityId: string, reason: string, signal?: AbortSignal): Promise<void> {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(facilityId) || !reason.trim() || reason.length > 500) throw new Error("施設IDと停止理由を確認してください。");
      const headers = await authHeaders();
      const response = await fetch(`${config.apiBaseUrl}/operator/facilities/${encodeURIComponent(facilityId)}/disable`, {
        method: "POST", cache: "no-store", credentials: "omit", redirect: "error", signal,
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        // Inspect one known code only; never expose API messages or private fields.
        const body = await response.json().catch(() => null);
        throw new ApiError(response.status, response.status === 403 && body?.error?.code === "REAUTH_REQUIRED");
      }
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("facilityId" in body) || body.facilityId !== facilityId || !("receivingEnabled" in body) || body.receivingEnabled !== false) throw new Error("停止結果を確認できませんでした。");
    },
    async jobFailures(type: JobType, cursor?: string, signal?: AbortSignal): Promise<JobFailurePage> {
      const headers = await authHeaders();
      const query = new URLSearchParams({ type, limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${config.apiBaseUrl}/operator/job-failures?${query}`, {
        method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal,
        headers,
      });
      if (!response.ok) throw new ApiError(response.status);
      return parseJobFailurePage(await response.json());
    },
  };
}
