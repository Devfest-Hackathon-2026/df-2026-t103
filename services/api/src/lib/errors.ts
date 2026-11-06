import type { FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { type ZodError } from "zod";
import { resolveRequestId } from "./requestId.js";

export interface FieldError {
  field: string;
  message: string;
}

/** 03_機能仕様書 §4.2 の標準エラーコード。 */
export const ErrorCodes = {
  VALIDATION_FAILED: "VALIDATION_FAILED",
  REGISTRATION_CONFLICT: "REGISTRATION_CONFLICT",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  APP_CHECK_FAILED: "APP_CHECK_FAILED",
  FORBIDDEN: "FORBIDDEN",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  NOT_FOUND: "NOT_FOUND",
  REVISION_CONFLICT: "REVISION_CONFLICT",
  ALREADY_DELIVERED: "ALREADY_DELIVERED",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  MODEL_SCHEMA_REJECTED: "MODEL_SCHEMA_REJECTED",
  RATE_LIMITED: "RATE_LIMITED",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly fieldErrors: FieldError[] | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options?: {
      fieldErrors?: FieldError[];
      retryable?: boolean;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {});
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = options?.fieldErrors;
    this.retryable = options?.retryable ?? false;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }

  static validation(fieldErrors: FieldError[], message = "入力内容を確認してください。") {
    return new ApiError(400, ErrorCodes.VALIDATION_FAILED, message, { fieldErrors });
  }

  static unauthenticated(message = "認証が必要です。") {
    return new ApiError(401, ErrorCodes.UNAUTHENTICATED, message);
  }

  static forbidden(message = "この操作は許可されていません。") {
    return new ApiError(403, ErrorCodes.FORBIDDEN, message);
  }

  static notFound(message = "リソースが見つかりません。") {
    return new ApiError(404, ErrorCodes.NOT_FOUND, message);
  }

  static precondition(message = "必要な前提条件が満たされていません。") {
    return new ApiError(412, ErrorCodes.PRECONDITION_FAILED, message);
  }

  static rateLimited(retryAfterSeconds: number) {
    return new ApiError(429, ErrorCodes.RATE_LIMITED, "しばらく時間を置いて再試行してください。", {
      retryable: true,
      retryAfterSeconds,
    });
  }

  static conflict(code: ErrorCode, message: string) {
    return new ApiError(409, code, message);
  }

  static upstreamUnavailable(service = "upstream") {
    return new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      `外部サービスが利用できません（${service}）。`,
      { retryable: true },
    );
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** ZodError を標準エラーの fieldErrors 形式へ変換する。 */
export function zodFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

export function assertParsed<T>(
  result: { success: true; data: T } | { success: false; error: ZodError },
): T {
  if (!result.success) {
    throw ApiError.validation(zodFieldErrors(result.error));
  }
  return result.data;
}

interface ErrorReplyBody {
  error: {
    code: ErrorCode;
    message: string;
    fieldErrors?: FieldError[];
    requestId: string;
    retryable: boolean;
  };
}

/** Fastify がハンドラ到達前に返すクライアントエラー（statusCode 400系）か。 */
function fastifyClientErrorStatus(err: unknown): number | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    typeof err.statusCode === "number" &&
    err.statusCode >= 400 &&
    err.statusCode < 500
  ) {
    return err.statusCode;
  }
  return undefined;
}

const CLIENT_ERROR_CODE: Record<number, ErrorCode> = {
  400: ErrorCodes.VALIDATION_FAILED,
  401: ErrorCodes.UNAUTHENTICATED,
  403: ErrorCodes.FORBIDDEN,
  404: ErrorCodes.NOT_FOUND,
  413: ErrorCodes.FILE_TOO_LARGE,
  415: ErrorCodes.VALIDATION_FAILED,
  429: ErrorCodes.RATE_LIMITED,
};

export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  err: unknown,
): void {
  const requestId =
    request.requestContext?.requestId ?? request.id ?? resolveRequestId(undefined);
  let apiError: ApiError;
  const clientStatus = fastifyClientErrorStatus(err);
  if (isApiError(err)) {
    apiError = err;
  } else if (hasZodFastifySchemaValidationErrors(err)) {
    // fastify-type-provider-zod の validatorCompiler が返すルートスキーマ検証エラー
    apiError = ApiError.validation(
      err.validation.map((issue) => ({
        field: issue.instancePath.replace(/^\//u, "").replace(/\//gu, ".") || "(root)",
        message: issue.message ?? "不正な値です。",
      })),
    );
  } else if (clientStatus !== undefined) {
    // JSONパース失敗・非対応Content-Type・ボディ超過等のフレームワーク400系は
    // 500ではなく元のステータスを保持した標準エラー形式で返す
    request.log.warn({ err }, "client error");
    apiError = new ApiError(
      clientStatus,
      CLIENT_ERROR_CODE[clientStatus] ?? ErrorCodes.VALIDATION_FAILED,
      "リクエストを処理できません。",
    );
  } else {
    request.log.error({ err }, "unhandled error");
    apiError = new ApiError(500, ErrorCodes.INTERNAL, "内部エラーが発生しました。");
  }

  if (apiError.retryAfterSeconds !== undefined) {
    void reply.header("Retry-After", String(apiError.retryAfterSeconds));
  }

  const body: ErrorReplyBody = {
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId,
      retryable: apiError.retryable,
    },
  };
  if (apiError.fieldErrors && apiError.fieldErrors.length > 0) {
    body.error.fieldErrors = apiError.fieldErrors;
  }
  void reply.status(apiError.statusCode).send(body);
}
