import type { Auth } from "firebase-admin/auth";
import type { AppCheck } from "firebase-admin/app-check";
import type { AppConfig } from "../config.js";
import type {
  AppCheckVerifier,
  AuthVerifier,
  VerifiedToken,
} from "../domain/types.js";

/** Admin SDK による Firebase ID token 検証（aud/iss/exp/sub はSDKが検証）。 */
export class AdminAuthVerifier implements AuthVerifier {
  constructor(private readonly auth: Auth) {}

  async verifyIdToken(
    token: string,
    checkRevoked: boolean,
  ): Promise<VerifiedToken | null> {
    try {
      const decoded = await this.auth.verifyIdToken(token, checkRevoked);
      const providers =
        (decoded.firebase as { identities?: Record<string, unknown> } | undefined)
          ?.identities
          ? Object.keys(decoded.firebase.identities)
          : [];
      return {
        uid: decoded.uid,
        authTimeSeconds: decoded.auth_time ?? 0,
        emailVerified: decoded.email_verified,
        signInProvider: decoded.firebase?.sign_in_provider,
        providers,
      };
    } catch {
      return null;
    }
  }
}

/** Admin SDK による App Check token 検証。 */
export class AdminAppCheckVerifier implements AppCheckVerifier {
  constructor(private readonly appCheck: AppCheck) {}

  async verify(token: string): Promise<boolean> {
    try {
      await this.appCheck.verifyToken(token);
      return true;
    } catch {
      return false;
    }
  }
}

/** エミュレータ等で App Check を省略する permissive 実装。 */
export class PermissiveAppCheckVerifier implements AppCheckVerifier {
  async verify(_token: string): Promise<boolean> {
    return true;
  }
}

export function createAppCheckVerifier(
  config: AppConfig,
  appCheck: AppCheck,
): AppCheckVerifier {
  return config.appCheckMode === "enforce"
    ? new AdminAppCheckVerifier(appCheck)
    : new PermissiveAppCheckVerifier();
}
