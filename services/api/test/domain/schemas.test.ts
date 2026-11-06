import { describe, expect, it } from "vitest";
import {
  consentMapSchema,
  profilePatchSchema,
  registerBodySchema,
} from "../../src/domain/schemas.js";

const validConsents = {
  terms_of_service: { accepted: true, documentVersion: "2026-11-01" },
  privacy_policy_ack: { accepted: true, documentVersion: "2026-11-01" },
  health_data_collection: { accepted: true, documentVersion: "2026-11-01" },
};

describe("registerBodySchema", () => {
  it("有効な入力を受理する", () => {
    const r = registerBodySchema.safeParse({
      email: "User@Example.com",
      password: "abcd1234",
      consents: validConsents,
      locale: "ja-JP",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("user@example.com");
  });

  it("locale 省略時は ja-JP がデフォルト", () => {
    const r = registerBodySchema.safeParse({
      email: "a@b.co",
      password: "abcd1234",
      consents: validConsents,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.locale).toBe("ja-JP");
  });

  it.each([
    ["メール形式不正", { email: "not-an-email" }],
    ["パスワード短すぎ", { password: "ab1" }],
    ["パスワードに数字なし", { password: "abcdefgh" }],
    ["パスワードに英字なし", { password: "12345678" }],
  ])("%s は拒否される", (_name, patch) => {
    const r = registerBodySchema.safeParse({
      email: "a@b.co",
      password: "abcd1234",
      consents: validConsents,
      ...patch,
    });
    expect(r.success).toBe(false);
  });

  it("未知フィールドは strict で拒否される", () => {
    const r = registerBodySchema.safeParse({
      email: "a@b.co",
      password: "abcd1234",
      consents: validConsents,
      admin: true,
    });
    expect(r.success).toBe(false);
  });

  it("空の consents は拒否される", () => {
    const r = registerBodySchema.safeParse({
      email: "a@b.co",
      password: "abcd1234",
      consents: {},
    });
    expect(r.success).toBe(false);
  });
});

describe("consentMapSchema", () => {
  it("未知の同意種別は拒否される", () => {
    const r = consentMapSchema.safeParse({
      unknown_type: { accepted: true, documentVersion: "v1" },
    });
    expect(r.success).toBe(false);
  });
});

describe("profilePatchSchema", () => {
  it("有効な部分更新を受理する", () => {
    const r = profilePatchSchema.safeParse({
      familyName: "田中",
      givenName: "太郎",
      birthDate: "1990-05-15",
      phoneNumber: "090-1234-5678",
      postalCode: "123-4567",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phoneNumber).toBe("09012345678");
      expect(r.data.postalCode).toBe("1234567");
    }
  });

  it("未来の生年月日は拒否される", () => {
    const r = profilePatchSchema.safeParse({ birthDate: "2999-01-01" });
    expect(r.success).toBe(false);
  });

  it("存在しない日付は拒否される", () => {
    const r = profilePatchSchema.safeParse({ birthDate: "1990-02-30" });
    expect(r.success).toBe(false);
  });

  it("カタカナ以外のカナ氏名は拒否される", () => {
    const r = profilePatchSchema.safeParse({ familyNameKana: "たなか" });
    expect(r.success).toBe(false);
  });

  it("不正な電話番号は拒否される", () => {
    const r = profilePatchSchema.safeParse({ phoneNumber: "12345" });
    expect(r.success).toBe(false);
  });

  it("不正な郵便番号は拒否される", () => {
    const r = profilePatchSchema.safeParse({ postalCode: "12345" });
    expect(r.success).toBe(false);
  });
});
