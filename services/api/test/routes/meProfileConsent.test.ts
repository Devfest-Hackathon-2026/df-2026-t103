import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";

/**
 * #135 の回帰テスト。
 * GET /v1/me/profile は現行同意必須（fail-closed）で、同意ゲートの
 * 設定不備 500・同意取得失敗 503 も応答契約に現れることを固定する。
 * 「旧同意で全体停止」か「非PHIの一部のみ返却」かは仕様判断中のため、
 * ここでは現行実装の全体停止（PHI非返却）だけを回帰として確認する。
 */
const UID = "u-profile-consent-135";
const PHI_TEXT = "合成の病歴（回帰テスト用）";
const medicalHistory = [
  {
    conditionText: PHI_TEXT,
    selfReported: true,
    updatedAt: "2026-11-01T00:00:00.000Z",
  },
];

async function seedProfile(deps: TestDeps): Promise<void> {
  await deps.db.doc(`patientProfiles/${UID}`).set({
    patientUid: UID,
    profileComplete: true,
    medicalHistory,
  });
}

describe("GET /v1/me/profile の同意ゲート契約（#135）", () => {
  it("撤回済み同意は 412 でプロフィール（PHI）を返さない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    await seedCurrentConsents(deps, UID);

    // 現行版で granted 済みの必須同意をすべて撤回済みにする
    const consents = await deps.db
      .collection("legalConsents")
      .where("subjectUid", "==", UID)
      .get();
    expect(consents.size).toBe(DEV_LEGAL_DOCUMENTS.requiredConsents.length);
    for (const doc of consents.docs) {
      await doc.ref.update({ revokedAt: Timestamp.fromDate(deps.clock.now()) });
    }

    await seedProfile(deps);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/profile",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(412);
    expect(res.json().error.code).toBe("PRECONDITION_FAILED");
    expect(res.json().profile).toBeUndefined();
    expect(res.body).not.toContain(PHI_TEXT);
    await app.close();
  });

  it("法務設定が未作成なら 500（設定不備）で PHI を返さない", async () => {
    const deps = makeTestDeps();
    // appConfigs/publicLegalVersion をシードしない（getLegalDocuments が undefined）
    await seedAccount(deps, UID);
    await seedCurrentConsents(deps, UID);
    await seedProfile(deps);
    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/profile",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL");
    expect(res.body).not.toContain(PHI_TEXT);
    await app.close();
  });

  it("同意履歴の取得失敗は 503 retryable で PHI を返さない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    await seedProfile(deps);
    // legalConsents クエリのみ失敗させ、法務設定 read は正常に通す
    const realCollection = deps.db.collection.bind(deps.db);
    deps.db.collection = ((name: string) => {
      if (name !== "legalConsents") return realCollection(name);
      const failing: Record<string, unknown> = {};
      failing.where = () => failing;
      failing.orderBy = () => failing;
      failing.limit = () => failing;
      failing.get = () => Promise.reject(new Error("firestore unavailable"));
      return failing;
    }) as TestDeps["db"]["collection"];

    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/profile",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(res.json().error.retryable).toBe(true);
    expect(res.body).not.toContain(PHI_TEXT);
    await app.close();
  });

  it("OpenAPI の GET 応答に 500/503 を宣言する（PATCH と同一）", async () => {
    const deps = makeTestDeps();
    const app = buildTestApp(deps);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as {
      paths: Record<
        string,
        {
          get?: { responses: Record<string, unknown> };
          patch?: { responses: Record<string, unknown> };
        }
      >;
    };
    const profile = spec.paths["/v1/me/profile"]!;
    for (const code of ["401", "403", "404", "412", "429", "500", "503"]) {
      expect(profile.get?.responses[code]).toBeTruthy();
    }
    for (const code of ["500", "503"]) {
      expect(profile.patch?.responses[code]).toBeTruthy();
    }
    await app.close();
  });
});

describe("GET /v1/consents の同意証跡による押し出し対策（#219）", () => {
  it("送信証跡が100件を超えても必須同意が currentByType と履歴に残る", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    await seedCurrentConsents(deps, UID);

    // 配送は1送信あたり証跡 doc を1件書く（旧実装では100件超の送信で
    // 登録系同意が履歴の先頭100件から押し出され currentByType が壊れた）
    const disclosure = DEV_LEGAL_DOCUMENTS.documents.hospital_disclosure!;
    for (let i = 0; i < 110; i++) {
      await deps.db.collection("legalConsents").doc().set({
        subjectUid: UID,
        consentType: "hospital_disclosure",
        documentVersion: disclosure.version,
        documentHash: disclosure.documentHash,
        decision: "granted",
        method: "explicit_checkbox",
        registrationSource: "delivery_send",
        scope: { facilityId: "fac-1", deliveryId: `dlv_${i}` },
        occurredAt: Timestamp.fromDate(
          new Date(deps.clock.now().getTime() + i),
        ),
        revokedAt: null,
        schemaVersion: "1",
      });
    }

    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/consents",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      consents: Array<{ registrationSource: string; consentType: string }>;
      currentByType: Record<string, string>;
    };

    // 必須3種が現行同意として解決される（種別ごとのクエリで求める）
    for (const type of DEV_LEGAL_DOCUMENTS.requiredConsents) {
      expect(body.currentByType[type]).toBe(
        DEV_LEGAL_DOCUMENTS.documents[type]!.version,
      );
    }
    // 送信証跡は不可侵の過去証跡であり「現在の同意」に数えない。
    // fc_ state doc が無いため hospital_disclosure は未同意のまま。
    expect(body.currentByType["hospital_disclosure"]).toBeUndefined();
    // 履歴は表示対象 source のみ（送信証跡は含めない）
    expect(body.consents.length).toBeGreaterThan(0);
    expect(
      body.consents.every((c) => c.registrationSource !== "delivery_send"),
    ).toBe(true);
    await app.close();
  });

  it("施設同意を撤回済みでも残存する送信証跡が現行同意を偽装しない", async () => {
    const deps = makeTestDeps();
    await seedLegalDocuments(deps);
    await seedAccount(deps, UID);
    await seedCurrentConsents(deps, UID);
    const disclosure = DEV_LEGAL_DOCUMENTS.documents.hospital_disclosure!;

    // 撤回済みの施設別同意 state doc
    await deps.db.doc(`legalConsents/fc_${UID}_fac-1`).set({
      subjectUid: UID,
      consentType: "hospital_disclosure",
      documentVersion: disclosure.version,
      documentHash: disclosure.documentHash,
      decision: "granted",
      method: "explicit_checkbox",
      registrationSource: "facility_consent",
      scope: { facilityId: "fac-1" },
      occurredAt: Timestamp.fromDate(deps.clock.now()),
      revokedAt: Timestamp.fromDate(deps.clock.now()),
      schemaVersion: "1",
    });
    // 過去の送信証跡（granted・撤回されない）は残る
    await deps.db.collection("legalConsents").doc().set({
      subjectUid: UID,
      consentType: "hospital_disclosure",
      documentVersion: disclosure.version,
      documentHash: disclosure.documentHash,
      decision: "granted",
      method: "explicit_checkbox",
      registrationSource: "delivery_send",
      scope: { facilityId: "fac-1", deliveryId: "dlv_past" },
      occurredAt: Timestamp.fromDate(deps.clock.now()),
      revokedAt: null,
      schemaVersion: "1",
    });

    const app = buildTestApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/consents",
      headers: authHeader(UID),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { currentByType: Record<string, string> };
    // 撤回済み state doc は現行同意に含めず、送信証跡も現行同意を偽装しない
    expect(body.currentByType["hospital_disclosure"]).toBeUndefined();
    await app.close();
  });
});
