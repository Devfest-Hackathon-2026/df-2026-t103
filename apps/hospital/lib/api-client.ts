export type JobType = "ocr" | "deletion";
export type JobFailure = { type: JobType; jobId: string; failureCode: string | null; attempts: number; failedAt: string | null };
export type JobFailurePage = { items: JobFailure[]; nextCursor: string | null };

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "認証またはクライアントの検証に失敗しました。再ログインしてください。" : status === 403 ? "運営管理者の権限がありません。" : "APIから取得できませんでした。時間をおいて再試行してください。");
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

export function createApiClient(config: {
  apiBaseUrl: string;
  idToken: () => Promise<string>;
  appCheckToken: () => Promise<string | null>;
  emulator: boolean;
}) {
  return {
    async jobFailures(type: JobType, cursor?: string, signal?: AbortSignal): Promise<JobFailurePage> {
      const token = await config.idToken();
      if (!token) throw new ApiError(401);
      const appCheck = await config.appCheckToken();
      if (!appCheck && !config.emulator) throw new ApiError(401);
      const query = new URLSearchParams({ type, limit: "20" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${config.apiBaseUrl}/operator/job-failures?${query}`, {
        method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, ...(appCheck ? { "X-Firebase-AppCheck": appCheck } : {}) },
      });
      if (!response.ok) throw new ApiError(response.status);
      return parseJobFailurePage(await response.json());
    },
  };
}
