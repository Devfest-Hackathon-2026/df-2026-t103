import { describe, expect, it } from "vitest";
import { validateConsentSubmission } from "../../src/domain/consents.js";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import { ApiError } from "../../src/lib/errors.js";
import type { ConsentMap } from "../../src/domain/schemas.js";

const legal = { ...DEV_LEGAL_DOCUMENTS, updatedAt: undefined };

const grantedAll: ConsentMap = {
  terms_of_service: { accepted: true, documentVersion: "2026-11-01" },
  privacy_policy_ack: { accepted: true, documentVersion: "2026-11-01" },
  health_data_collection: { accepted: true, documentVersion: "2026-11-01" },
};

describe("validateConsentSubmission", () => {
  it("全必須同意が現行版で granted なら通る", () => {
    const grants = validateConsentSubmission(legal, grantedAll);
    expect(grants).toHaveLength(3);
    expect(grants.every((g) => g.decision === "granted")).toBe(true);
  });

  it("必須同意の欠落は 400 VALIDATION_FAILED", () => {
    const { terms_of_service: _dropped, ...partial } = grantedAll;
    try {
      validateConsentSubmission(legal, partial);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).statusCode).toBe(400);
    }
  });

  it("必須同意の accepted=false は 400", () => {
    try {
      validateConsentSubmission(legal, {
        ...grantedAll,
        terms_of_service: { accepted: false, documentVersion: "2026-11-01" },
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(400);
    }
  });

  it("documentVersion が現行版と不一致なら 412", () => {
    try {
      validateConsentSubmission(legal, {
        ...grantedAll,
        terms_of_service: { accepted: true, documentVersion: "2020-01-01" },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).statusCode).toBe(412);
    }
  });

  it("必須でない同意の denied は証跡として記録できる", () => {
    const grants = validateConsentSubmission(legal, {
      ...grantedAll,
      hospital_disclosure: { accepted: false, documentVersion: "2026-11-01" },
    });
    const opt = grants.find((g) => g.consentType === "hospital_disclosure");
    expect(opt?.decision).toBe("denied");
  });

  it("文書セットに存在しない同意種別は 400", () => {
    try {
      validateConsentSubmission(legal, {
        ...grantedAll,
        optional_analytics: { accepted: true, documentVersion: "2026-11-01" },
      });
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).statusCode).toBe(400);
    }
  });
});
