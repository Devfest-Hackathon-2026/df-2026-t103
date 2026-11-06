import type { AppConfig } from "./config.js";
import type { OcrTaskQueue } from "./deps.js";

/**
 * Cloud Tasks REST API による HTTP タスクの enqueue（@google-cloud/tasks 未導入のため最小実装）。
 * タスクは OIDC 付き POST で `/v1/internal/jobs/ocr/{jobId}/run` を呼び、
 * 内部トークン認証ではなく Cloud Tasks の OIDC で認可する（infra issue で OIDC 検証を実装）。
 * 現在の実装では内部ジョブエンドポイントが x-internal-job-token を要求するため、
 * OIDC 検証が入るまではタスクに共有トークンを付与する。
 */
export class CloudTasksOcrQueue implements OcrTaskQueue {
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(private readonly config: AppConfig) {}

  async enqueueOcrJob(jobId: string): Promise<void> {
    const { projectId, ocrTasksLocation, ocrTasksQueue, ocrTasksTargetUrl } =
      this.config;
    if (!ocrTasksQueue || !ocrTasksTargetUrl) {
      throw new Error("OCR tasks queue is not configured");
    }
    const token = await this.metadataToken();
    const url =
      `https://cloudtasks.googleapis.com/v2/projects/${projectId}` +
      `/locations/${ocrTasksLocation}/queues/${ocrTasksQueue}/tasks`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.internalJobToken) {
      headers["x-internal-job-token"] = this.config.internalJobToken;
    }
    const task: Record<string, unknown> = {
      httpRequest: {
        httpMethod: "POST",
        url: `${ocrTasksTargetUrl}/v1/internal/jobs/ocr/${encodeURIComponent(jobId)}/run`,
        headers,
      },
    };
    if (this.config.ocrTasksOidcSa) {
      (task.httpRequest as Record<string, unknown>).oidcToken = {
        serviceAccountEmail: this.config.ocrTasksOidcSa,
      };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task }),
    });
    if (!res.ok) {
      throw new Error(`cloudtasks enqueue failed: ${res.status}`);
    }
  }

  /** メタデータサーバからアクセストークンを取得（Cloud Run 上で有効）。 */
  private async metadataToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt > now + 60_000) {
      return this.accessToken.token;
    }
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "metadata-flavor": "Google" } },
    );
    if (!res.ok) {
      throw new Error("metadata server token unavailable");
    }
    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = {
      token: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
    return body.access_token;
  }
}
