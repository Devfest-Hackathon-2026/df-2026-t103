import type { Deps } from "../deps.js";
import type { FastifyRequest } from "fastify";
import type { ConsentState } from "../auth/context.js";
import { evaluateConsents } from "../auth/gates.js";
import { getProfile } from "../repos/accounts.js";
import { getDeletionStatus, type DeletionStatusBody } from "./deletion.js";

export interface MeResponse {
  uid: string;
  accountStatus: string | null;
  onboardingState: string;
  emailVerified: boolean;
  requiredConsents: ConsentState;
  profileComplete: boolean;
  deletionRequest: DeletionStatusBody;
}

/**
 * API-001 GET /me。利用状態・同意不足（legal_pending相当）を返す。
 * アカウント未作成（Google/Passkey直後）は legal_pending を報告する（SEC-16）。
 */
export async function getMe(deps: Deps, req: FastifyRequest): Promise<MeResponse> {
  const ctx = req.requestContext;
  const uid = ctx.auth!.uid;
  const account = ctx.account ?? null;

  const consentState =
    ctx.consentState ?? (await evaluateConsents(deps, req));

  const profile = await getProfile(deps.db, uid);
  const deletionRequest = await getDeletionStatus(deps, uid);

  return {
    uid,
    accountStatus: account?.accountStatus ?? null,
    onboardingState:
      account?.onboardingState ??
      (consentState.current ? "profile_pending" : "legal_pending"),
    emailVerified: ctx.auth?.emailVerified ?? account?.emailVerified ?? false,
    requiredConsents: consentState,
    profileComplete: profile?.profileComplete ?? false,
    deletionRequest,
  };
}
