import { describe, expect, it } from "vitest";
import { makeTestDeps, type TestDeps } from "../helpers/deps.js";
import {
  assertCatalogPayload,
  buildNotificationPayload,
  NOTIFICATION_TEMPLATES,
  notifyPatient,
} from "../../src/services/notifications.js";
import { pushDeviceIdForToken } from "../../src/repos/pushDevices.js";
import type {
  AuditEventDoc,
  PushDeviceDoc,
} from "../../src/domain/firestoreDocs.js";
import { classifyMessagingError } from "../../src/push.js";
import {
  invalidatePushDevice,
} from "../../src/repos/pushDevices.js";
import { Timestamp } from "firebase-admin/firestore";

const UID = "u-notify-1";
const TOKEN = "tok-active-1";
const TOKEN2 = "tok-active-2";

/** PHI混入を検証するための医療情報っぽい文字列。 */
const PHI_STRINGS = [
  "ロキソプロフェンNa錠",
  "頭痛",
  "高血圧",
  "山田太郎",
];

async function seedDevice(
  deps: TestDeps,
  token: string,
  patientUid = UID,
  status: PushDeviceDoc["status"] = "active",
): Promise<string> {
  const deviceId = pushDeviceIdForToken(deps, token);
  await deps.db.doc(`pushDevices/${deviceId}`).set({
    patientUid,
    token,
    platform: "android",
    status,
    invalidatedReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSeenAt: new Date(),
  } satisfies PushDeviceDoc as unknown as Record<string, unknown>);
  return deviceId;
}

async function auditEvents(
  deps: TestDeps,
): Promise<Array<AuditEventDoc & { id: string }>> {
  const snap = await deps.db.collection("auditEvents").get();
  return snap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as AuditEventDoc),
  }));
}

describe("buildNotificationPayload", () => {
  it("カタログの固定文言のみで構築し、dataは非PHIキーのみ", () => {
    const p = buildNotificationPayload("OCR_EXTRACTION_READY", "job-123");
    expect(p.title).toBe(NOTIFICATION_TEMPLATES.OCR_EXTRACTION_READY.title);
    expect(p.body).toBe(NOTIFICATION_TEMPLATES.OCR_EXTRACTION_READY.body);
    expect(p.data).toEqual({ type: "OCR_EXTRACTION_READY", refId: "job-123" });
    expect(Object.keys(p.data)).toEqual(["type", "refId"]);
  });

  it("refId省略時は type のみ", () => {
    const p = buildNotificationPayload("QUESTIONNAIRE_READY");
    expect(p.data).toEqual({ type: "QUESTIONNAIRE_READY" });
  });
});

describe("assertCatalogPayload（PHI混入の最終防衛線）", () => {
  it("カタログ文言は受理する", () => {
    for (const t of Object.values(NOTIFICATION_TEMPLATES)) {
      expect(() =>
        assertCatalogPayload({ title: t.title, body: t.body, data: {} }),
      ).not.toThrow();
    }
  });

  it("カタログ外の文言（症状・薬剤名・氏名相当）は拒否する", () => {
    for (const phi of PHI_STRINGS) {
      expect(() =>
        assertCatalogPayload({ title: "お知らせ", body: phi, data: {} }),
      ).toThrow();
      expect(() =>
        assertCatalogPayload({ title: phi, body: "お知らせ", data: {} }),
      ).toThrow();
    }
    // 片方だけ一致してもペアでなければ拒否
    expect(() =>
      assertCatalogPayload({
        title: NOTIFICATION_TEMPLATES.OCR_EXTRACTION_READY.title,
        body: "任意の本文",
        data: {},
      }),
    ).toThrow();
  });
});

describe("notifyPatient", () => {
  it("active デバイス全台へカタログ文言で送信する", async () => {
    const deps = makeTestDeps();
    const id1 = await seedDevice(deps, TOKEN);
    await seedDevice(deps, TOKEN2);
    // invalid 端末には送らない
    await seedDevice(deps, "tok-invalid", UID, "invalid");
    // 他ユーザーの端末には送らない
    await seedDevice(deps, "tok-other-user", "u-other");

    await notifyPatient(deps, {
      patientUid: UID,
      template: "OCR_EXTRACTION_READY",
      refId: "job-9",
    });

    expect(deps.fakePush.calls).toHaveLength(2);
    const tokens = deps.fakePush.calls.map((c) => c.token).sort();
    expect(tokens).toEqual([TOKEN, TOKEN2].sort());
    for (const call of deps.fakePush.calls) {
      expect(call.title).toBe(
        NOTIFICATION_TEMPLATES.OCR_EXTRACTION_READY.title,
      );
      expect(call.body).toBe(NOTIFICATION_TEMPLATES.OCR_EXTRACTION_READY.body);
      // PHI非含有: ペイロードは症状・薬剤名・氏名を含まない
      for (const phi of PHI_STRINGS) {
        expect(call.title).not.toContain(phi);
        expect(call.body).not.toContain(phi);
        expect(JSON.stringify(call.data ?? {})).not.toContain(phi);
      }
      expect(call.data).toEqual({
        type: "OCR_EXTRACTION_READY",
        refId: "job-9",
      });
    }

    const events = await auditEvents(deps);
    const sent = events.filter((e) => e.action === "NOTIFICATION_SENT");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.details).toEqual({ template: "OCR_EXTRACTION_READY" });
    // 監査のresourceIdHashはHMAC済み（生deviceIdではない）
    expect(sent[0]!.resourceIdHash).not.toBe(id1);
  });

  it("デバイスがなければ送信も監査もしない", async () => {
    const deps = makeTestDeps();
    await notifyPatient(deps, {
      patientUid: UID,
      template: "OCR_EXTRACTION_READY",
    });
    expect(deps.fakePush.calls).toHaveLength(0);
    expect(await auditEvents(deps)).toHaveLength(0);
  });

  it("unregistered を返されたトークンは invalid 化し他デバイスへは送信継続", async () => {
    const deps = makeTestDeps();
    const deadId = await seedDevice(deps, TOKEN);
    await seedDevice(deps, TOKEN2);
    deps.fakePush.failByToken.set(TOKEN, "unregistered");

    await notifyPatient(deps, {
      patientUid: UID,
      template: "QUESTIONNAIRE_READY",
    });

    expect(deps.fakePush.calls).toHaveLength(2);
    const dead = (
      await deps.db.doc(`pushDevices/${deadId}`).get()
    ).data() as PushDeviceDoc;
    expect(dead.status).toBe("invalid");
    expect(dead.invalidatedReason).toBe("unregistered");

    const events = await auditEvents(deps);
    expect(
      events.filter((e) => e.action === "NOTIFICATION_SENT"),
    ).toHaveLength(1);
    const failed = events.filter((e) => e.action === "NOTIFICATION_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.details).toEqual({
      template: "QUESTIONNAIRE_READY",
      errorCode: "unregistered",
    });
  });

  it("invalid_token もトークンを無効化する", async () => {
    const deps = makeTestDeps();
    const id = await seedDevice(deps, TOKEN);
    deps.fakePush.failByToken.set(TOKEN, "invalid_token");
    await notifyPatient(deps, { patientUid: UID, template: "OCR_EXTRACTION_READY" });
    const doc = (
      await deps.db.doc(`pushDevices/${id}`).get()
    ).data() as PushDeviceDoc;
    expect(doc.status).toBe("invalid");
    expect(doc.invalidatedReason).toBe("invalid_token");
  });

  it("unavailable ではトークンを失効させず active のまま保持する", async () => {
    const deps = makeTestDeps();
    const id = await seedDevice(deps, TOKEN);
    deps.fakePush.failByToken.set(TOKEN, "unavailable");
    await notifyPatient(deps, { patientUid: UID, template: "OCR_EXTRACTION_READY" });
    const doc = (
      await deps.db.doc(`pushDevices/${id}`).get()
    ).data() as PushDeviceDoc;
    expect(doc.status).toBe("active");
    const events = await auditEvents(deps);
    expect(events[0]!.action).toBe("NOTIFICATION_FAILED");
    expect(events[0]!.details).toMatchObject({ errorCode: "unavailable" });
  });

  it("disabled（エミュレータ送信無効）はトークン保持・監査も記録しない", async () => {
    const deps = makeTestDeps();
    const id = await seedDevice(deps, TOKEN);
    deps.fakePush.failByToken.set(TOKEN, "disabled");
    await notifyPatient(deps, { patientUid: UID, template: "OCR_EXTRACTION_READY" });
    const doc = (
      await deps.db.doc(`pushDevices/${id}`).get()
    ).data() as PushDeviceDoc;
    expect(doc.status).toBe("active");
    expect(await auditEvents(deps)).toHaveLength(0);
  });

  it("送信試行後に再登録された端末は無効化で上書きしない", async () => {
    const deps = makeTestDeps();
    const id = await seedDevice(deps, TOKEN);
    // 送信試行時点で観測した lastSeenAt
    const seen = Timestamp.fromMillis(1000);
    await deps.db.doc(`pushDevices/${id}`).update({ lastSeenAt: seen });
    // その後の再登録で lastSeenAt が進む（status=active のまま）
    await deps.db
      .doc(`pushDevices/${id}`)
      .update({ lastSeenAt: Timestamp.fromMillis(2000) });

    await invalidatePushDevice(deps.db, id, "unregistered", seen);
    const doc = (
      await deps.db.doc(`pushDevices/${id}`).get()
    ).data() as PushDeviceDoc;
    expect(doc.status).toBe("active");

    // lastSeenAt が変わっていなければ無効化する
    await deps.db
      .doc(`pushDevices/${id}`)
      .update({ lastSeenAt: seen });
    await invalidatePushDevice(deps.db, id, "unregistered", seen);
    const doc2 = (
      await deps.db.doc(`pushDevices/${id}`).get()
    ).data() as PushDeviceDoc;
    expect(doc2.status).toBe("invalid");
    expect(doc2.invalidatedReason).toBe("unregistered");
  });

  it("送信実装が例外を投げても呼び出し側へ伝播しない", async () => {
    const deps = makeTestDeps();
    await seedDevice(deps, TOKEN);
    deps.fakePush.shouldThrow = true;
    await expect(
      notifyPatient(deps, { patientUid: UID, template: "OCR_EXTRACTION_READY" }),
    ).resolves.toBeUndefined();
  });

  it("監査detailsに文言・トークン・PHIを含めない", async () => {
    const deps = makeTestDeps();
    await seedDevice(deps, TOKEN);
    await notifyPatient(deps, {
      patientUid: UID,
      template: "QUESTIONNAIRE_READY",
      refId: "qn-1",
    });
    const events = await auditEvents(deps);
    for (const ev of events) {
      const json = JSON.stringify(ev);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain("問診票が作成されました");
      for (const phi of PHI_STRINGS) expect(json).not.toContain(phi);
    }
  });
});

describe("classifyMessagingError", () => {
  const cases: Array<[string, string]> = [
    ["messaging/registration-token-not-registered", "unregistered"],
    // firebase-js-sdk#10135: httpsCallable が旧式トークンを裏で登録し
    // FID ベース登録を潰す経路でも返り得るエラー
    ["messaging/installation-id-not-registered", "unregistered"],
    ["messaging/invalid-registration-token", "invalid_token"],
    // invalid-argument はメッセージレベル汎用エラーのため unknown（誤無効化防止）
    ["messaging/invalid-argument", "unknown"],
    ["messaging/server-unavailable", "unavailable"],
    ["messaging/internal-error", "unavailable"],
    ["messaging/something-else", "unknown"],
    ["auth/id-token-expired", "unknown"],
  ];
  for (const [code, expected] of cases) {
    it(`${code} → ${expected}`, () => {
      const err = Object.assign(new Error("x"), { code });
      expect(classifyMessagingError(err)).toBe(expected);
    });
  }

  it("codeを持たない例外は unknown", () => {
    expect(classifyMessagingError(new Error("boom"))).toBe("unknown");
    expect(classifyMessagingError("string")).toBe("unknown");
    expect(classifyMessagingError(null)).toBe("unknown");
  });
});
