import type { VerifiedToken } from "../../src/domain/types.js";
import type {
  AppCheckVerifier,
  AuthVerifier,
} from "../../src/domain/types.js";
import type {
  AuthAdmin,
  ContentScanner,
  StorageGateway,
  StoredObjectInfo,
  UploadUrlInstruction,
} from "../../src/deps.js";

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

  async updateUser(
    uid: string,
    props: { disabled?: boolean; emailVerified?: boolean },
  ): Promise<unknown> {
    if (this.failOn.has("update")) throw new Error("auth/update failed");
    const u = this.users.get(uid);
    if (!u) throw new Error("auth/user-not-found");
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
    throw new Error("auth/user-not-found");
  }

  async deleteUser(uid: string): Promise<void> {
    if (this.failOn.has("delete")) throw new Error("auth/delete failed");
    this.users.delete(uid);
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

