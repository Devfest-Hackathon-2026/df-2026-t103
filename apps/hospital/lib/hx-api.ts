/** /api/hx/* BFF へのブラウザ側呼び出し。認証情報は HttpOnly Cookie のみ。 */

export class HxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function messageFor(status: number): string {
  switch (status) {
    case 400:
      return "入力内容を確認してください。";
    case 401:
      return "認証の有効期限が切れました。再度ログインしてください。";
    case 403:
      return "この操作を行う権限がありません。";
    case 404:
      return "対象が見つかりません。";
    case 409:
      return "他の操作と競合しました。最新の状態を確認してください。";
    case 412:
      return "前提条件を満たしていません。画面の説明を確認してください。";
    case 429:
      return "操作が集中しています。時間をおいて再試行してください。";
    default:
      return "APIから取得できませんでした。時間をおいて再試行してください。";
  }
}

/** body は JSON.stringify 済みでなくオブジェクトで渡す。レスポンスは JSON のみ受理する。 */
export async function hxApi<T = unknown>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/hx/${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-hx-client": "portal",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: init.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new HxApiError(0, "network_error", "通信できませんでした。接続状態を確認してください。");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // APIのエラーエンベロープは { error: { code, message } }
    const errObj = data && typeof data === "object" ? (data as { error?: unknown }).error : null;
    const code =
      errObj && typeof errObj === "object" &&
      typeof (errObj as { code?: unknown }).code === "string"
        ? (errObj as { code: string }).code
        : "error";
    throw new HxApiError(response.status, code, messageFor(response.status));
  }
  return data as T;
}
