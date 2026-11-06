import type { AccountDoc } from "../domain/firestoreDocs.js";
import type { ConsentType, VerifiedToken } from "../domain/types.js";
import type { LegalDocumentSet } from "../domain/legalDocuments.js";
import type { RouteAccess } from "./gates.js";

export interface ConsentState {
  /** 必須同意が全て現行版で granted か。 */
  current: boolean;
  /** 不足または旧版の consentType。 */
  missing: ConsentType[];
}

export interface RequestContext {
  requestId: string;
  /** 認証済みトークン（public/internal ルートでは undefined）。 */
  auth?: VerifiedToken;
  /** 認証時に読み込んだアカウント。未作成なら null。 */
  account?: AccountDoc | null;
  /** 認証時に評価した同意状態。 */
  consentState?: ConsentState;
  /** リクエスト内で再利用する法務文書セット。 */
  legalDocs?: LegalDocumentSet | null | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    requestContext: RequestContext;
  }
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}
