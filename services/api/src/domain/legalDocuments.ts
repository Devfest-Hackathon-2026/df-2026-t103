import type { ConsentType } from "./types.js";

export interface LegalDocumentVersion {
  version: string;
  documentHash: string;
  publishedAt: string;
  /** Reviewed plain text; its UTF-8 SHA-256 must match documentHash. */
  text?: string;
}

export interface LegalDocumentSet {
  /** consentType -> 現行版。 */
  documents: Partial<Record<ConsentType, LegalDocumentVersion>>;
  /** 必須同意の consentType 一覧（順序無関係）。 */
  requiredConsents: ConsentType[];
  updatedAt: string | undefined;
}

/**
 * ローカル開発（エミュレータ）向けのシード文書。
 * 本番は法務承認済みの内容で appConfigs/publicLegalVersion を管理する。
 */
export const DEV_LEGAL_DOCUMENTS: Omit<LegalDocumentSet, "updatedAt"> = {
  requiredConsents: [
    "terms_of_service",
    "privacy_policy_ack",
    "health_data_collection",
  ],
  documents: {
    terms_of_service: {
      version: "2026-11-01",
      documentHash:
        "sha256:2f1c9b4f6b4f6b6c9f2a7f3f9b6c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c",
      publishedAt: "2026-11-01T00:00:00Z",
    },
    privacy_policy_ack: {
      version: "2026-11-01",
      documentHash:
        "sha256:8a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c",
      publishedAt: "2026-11-01T00:00:00Z",
    },
    health_data_collection: {
      version: "2026-11-01",
      documentHash:
        "sha256:5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d",
      publishedAt: "2026-11-01T00:00:00Z",
    },
    hospital_disclosure: {
      version: "2026-11-01",
      documentHash:
        "sha256:1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e",
      publishedAt: "2026-11-01T00:00:00Z",
    },
  },
};
