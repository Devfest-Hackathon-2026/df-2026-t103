import type { VerifiedToken } from "../../src/domain/types.js";
import type {
  AppCheckVerifier,
  AuthVerifier,
} from "../../src/domain/types.js";
import type { AuthAdmin, StorageDeleter } from "../../src/deps.js";

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

export class FakeStorageDeleter implements StorageDeleter {
  deleted: Array<{
    bucket: string;
    path: string;
    generation?: string | undefined;
  }> = [];
  failOn = new Set<string>(); // "bucket/path"

  async deleteObject(
    bucket: string,
    objectPath: string,
    generation?: string,
  ): Promise<void> {
    if (this.failOn.has(`${bucket}/${objectPath}`)) {
      throw new Error("storage/delete failed");
    }
    this.deleted.push({ bucket, path: objectPath, generation });
  }
}
