import type { VerifiedToken } from "../../src/domain/types.js";
import type {
  AppCheckVerifier,
  AuthVerifier,
} from "../../src/domain/types.js";
import type {
  AuthAdmin,
  ContentScanner,
  LlmAdapter,
  OcrEngine,
  OcrTaskQueue,
  PlacesGateway,
  PlacesSearchParams,
  PlaceResult,
  PushFailureCode,
  PushGateway,
  PushSendResult,
  QuestionGenInput,
  QuestionGenOutput,
  StorageGateway,
  StoredObjectInfo,
  UploadUrlInstruction,
} from "../../src/deps.js";
import type { OcrEngineResult } from "../../src/domain/ocr.js";

/** "token-<uid>" 形式のトークンを受理する検証フェイク。 */
export class FakeAuthVerifier implements AuthVerifier {
  revoked = new Set<string>();
  /** auth_time をトークンごとに固定したい場合のオーバーライド。 */
  authTimeByToken = new Map<string, number>();
  nowSeconds = Math.floor(Date.now() / 1000);

  async verifyIdToken(
    token: string,
    _checkRevoked: boolean,
  ): Promise<VerifiedToken | null> {
    if (!token.startsWith("token-")) return null;
    const uid = token.slice("token-".length);
    if (!uid || this.revoked.has(uid)) return null;
    return {
      uid,
      authTimeSeconds: this.authTimeByToken.get(token) ?? this.nowSeconds,
      emailVerified: true,
      signInProvider: "password",
      providers: ["password"],
    };
  }
}

export class FakeAppCheckVerifier implements AppCheckVerifier {
  validTokens = new Set<string>(["valid-appcheck"]);
  async verify(token: string): Promise<boolean> {
    return this.validTokens.has(token);
  }
}

export class FakeAuthAdmin implements AuthAdmin {
  users = new Map<
    string,
    { email: string; password: string; emailVerified: boolean; disabled: boolean }
  >();
  failOn = new Set<"create" | "update" | "delete" | "revoke">();

  async createUser(props: {
    uid: string;
    email: string;
    password: string;
    emailVerified: boolean;
    disabled: boolean;
  }): Promise<{ uid: string }> {
    if (this.failOn.has("create")) throw new Error("auth/create failed");
    if (this.users.has(props.uid)) {
      const err = new Error("already exists") as Error & { code: string };
      err.code = "auth/uid-already-exists";
      throw err;
    }
    for (const u of this.users.values()) {
      if (u.email === props.email) {
        const err = new Error("email exists") as Error & { code: string };
        err.code = "auth/email-already-exists";
        throw err;
      }
    }
    this.users.set(props.uid, {
      email: props.email,
      password: props.password,
      emailVerified: props.emailVerified,
      disabled: props.disabled,
    });
    return { uid: props.uid };
  }

  private static notFound(): Error {
    const err = new Error("no user") as Error & { code: string };
    err.code = "auth/user-not-found";
    return err;
  }

  async updateUser(
    uid: string,
    props: { disabled?: boolean; emailVerified?: boolean },
  ): Promise<unknown> {
    if (this.failOn.has("update")) throw new Error("auth/update failed");
    const u = this.users.get(uid);
    if (!u) throw FakeAuthAdmin.notFound();
    if (props.disabled !== undefined) u.disabled = props.disabled;
    if (props.emailVerified !== undefined) u.emailVerified = props.emailVerified;
    return { uid };
  }

  async getUserByEmail(
    email: string,
  ): Promise<{ uid: string; disabled: boolean }> {
    for (const [uid, u] of this.users) {
      if (u.email === email) return { uid, disabled: u.disabled };
    }
    throw FakeAuthAdmin.notFound();
  }

  async deleteUser(uid: string): Promise<void> {
    if (this.failOn.has("delete")) throw new Error("auth/delete failed");
    if (!this.users.delete(uid)) throw FakeAuthAdmin.notFound();
  }

  async revokeRefreshTokens(_uid: string): Promise<void> {
    if (this.failOn.has("revoke")) throw new Error("auth/revoke failed");
  }
}

interface SeededObject {
  data: Uint8Array;
  contentType: string;
  generation: string;
}

/** インメモリ StorageGateway。seedObject で実オブジェクトを用意する。 */
export class FakeStorageGateway implements StorageGateway {
  deleted: Array<{
    bucket: string;
    path: string;
    generation?: string | undefined;
  }> = [];
  failOn = new Set<string>(); // "bucket/path"
  uploadUrlCalls: Array<{ bucket: string; objectPath: string }> = [];
  private objects = new Map<string, SeededObject>();

  private key(bucket: string, objectPath: string): string {
    return `${bucket}/${objectPath}`;
  }

  seedObject(
    bucket: string,
    objectPath: string,
    data: Uint8Array,
    contentType: string,
  ): void {
    this.objects.set(this.key(bucket, objectPath), {
      data,
      contentType,
      generation: `${Date.now()}-${this.objects.size}`,
    });
  }

  async deleteObject(
    bucket: string,
    objectPath: string,
    generation?: string,
  ): Promise<void> {
    if (this.failOn.has(`${bucket}/${objectPath}`)) {
      throw new Error("storage/delete failed");
    }
    this.deleted.push({ bucket, path: objectPath, generation });
    this.objects.delete(this.key(bucket, objectPath));
  }

  tombstoned: Array<{ bucket: string; path: string }> = [];

  async tombstoneObject(bucket: string, objectPath: string): Promise<void> {
    if (this.failOn.has(`${bucket}/${objectPath}`)) {
      throw new Error("storage/tombstone failed");
    }
    this.tombstoned.push({ bucket, path: objectPath });
    const key = this.key(bucket, objectPath);
    const obj = this.objects.get(key);
    this.objects.set(key, {
      data: new Uint8Array(0),
      contentType: "application/octet-stream",
      generation: `${obj?.generation ?? "0"}-t`,
    });
  }

  async inspectObject(
    bucket: string,
    objectPath: string,
  ): Promise<StoredObjectInfo | null> {
    const obj = this.objects.get(this.key(bucket, objectPath));
    if (!obj) return null;
    return {
      generation: obj.generation,
      sizeBytes: obj.data.length,
      contentType: obj.contentType,
      md5HashBase64: null,
    };
  }

  async createUploadUrl(params: {
    bucket: string;
    objectPath: string;
    mimeType: string;
    expiresAt: Date;
  }): Promise<UploadUrlInstruction> {
    this.uploadUrlCalls.push({ bucket: params.bucket, objectPath: params.objectPath });
    return {
      method: "PUT",
      url: `https://storage.test/${params.bucket}/${params.objectPath}?sig=fake`,
      headers: {
        "content-type": params.mimeType,
        "x-goog-if-generation-match": "0",
      },
      expiresAt: params.expiresAt.toISOString(),
    };
  }

  async readObjectPrefix(
    bucket: string,
    objectPath: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (this.failOn.has(`${bucket}/${objectPath}`)) {
      throw new Error("storage/read failed");
    }
    const obj = this.objects.get(this.key(bucket, objectPath));
    if (!obj) throw new Error("storage/object-not-found");
    return obj.data.slice(0, maxBytes);
  }

  async readObject(bucket: string, objectPath: string): Promise<Uint8Array> {
    const obj = this.objects.get(this.key(bucket, objectPath));
    if (!obj) throw new Error("storage/object-not-found");
    return obj.data;
  }
}

export class FakeOcrEngine implements OcrEngine {
  readonly name = "fake";
  result: OcrEngineResult = { ok: true, candidates: [] };
  calls = 0;
  shouldThrow = false;

  async extract(): Promise<OcrEngineResult> {
    this.calls++;
    if (this.shouldThrow) throw new Error("ocr/engine-threw");
    return this.result;
  }
}

export class FakeOcrTaskQueue implements OcrTaskQueue {
  enqueued: string[] = [];
  failNext = false;

  async enqueueOcrJob(jobId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("tasks/enqueue-failed");
    }
    this.enqueued.push(jobId);
  }
}

/** 試験用LLMアダプタ。戻り値・例外を自在に制御できる。 */
export class FakeLlmAdapter implements LlmAdapter {
  readonly name = "fake";
  result: QuestionGenOutput | null = null;
  shouldThrow: unknown = null;
  calls: QuestionGenInput[] = [];

  generateQuestions(input: QuestionGenInput): Promise<QuestionGenOutput> {
    this.calls.push(input);
    if (this.shouldThrow !== null) return Promise.reject(this.shouldThrow);
    return Promise.resolve(
      this.result ?? { questions: [], modelVersion: "fake-v1" },
    );
  }
}

export class FakeContentScanner implements ContentScanner {
  verdict: "clean" | "rejected" = "clean";
  reason: string | undefined;
  calls = 0;

  async scanUpload(): Promise<{ verdict: "clean" | "rejected"; reason?: string }> {
    this.calls++;
    return this.verdict === "rejected"
      ? { verdict: "rejected", ...(this.reason !== undefined ? { reason: this.reason } : {}) }
      : { verdict: "clean" };
  }
}

/** テスト用 Places Gateway。事前にシードした結果を返す。 */
export class FakePlacesGateway implements PlacesGateway {
  results: PlaceResult[] = [];
  calls: PlacesSearchParams[] = [];
  shouldThrow: unknown = null;

  async searchNearby(params: PlacesSearchParams): Promise<PlaceResult[]> {
    this.calls.push(params);
    if (this.shouldThrow !== null) return Promise.reject(this.shouldThrow);
    return this.results;
  }
}

/** テスト用 PushGateway。送信内容を記録し、結果を制御できる。 */
export class FakePushGateway implements PushGateway {
  calls: Array<{
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }> = [];
  /** トークン単位の失敗コード（未設定は成功）。 */
  failByToken = new Map<string, PushFailureCode>();
  /** 例外送出（sendToDevice自体のthrow経路の検証用）。 */
  shouldThrow = false;

  async sendToDevice(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }): Promise<PushSendResult> {
    this.calls.push(params);
    if (this.shouldThrow) throw new Error("push/send-threw");
    const code = this.failByToken.get(params.token);
    if (code) return { ok: false, code };
    return { ok: true, messageId: `msg-${this.calls.length}` };
  }
}

