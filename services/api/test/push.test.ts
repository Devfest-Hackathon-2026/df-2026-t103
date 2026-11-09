import type { Messaging } from "firebase-admin/messaging";
import { describe, expect, it, vi } from "vitest";
import { AdminPushGateway } from "../src/push.js";
import { buildNotificationPayload } from "../src/domain/notifications.js";

function gateway() {
  const send = vi.fn().mockResolvedValue("synthetic-message-id");
  return { send, push: new AdminPushGateway({ send } as unknown as Messaging) };
}
const token = "synthetic-device-token";
const approved = () => buildNotificationPayload("QUESTIONNAIRE_READY", "q-synthetic-123");

describe("AdminPushGateway payload boundary", () => {
  it("passes only the approved serialized payload to the SDK", async () => {
    const { send, push } = gateway();
    const payload = approved();
    await expect(push.sendToDevice({ token, ...payload })).resolves.toEqual({
      ok: true, messageId: "synthetic-message-id",
    });
    const message = {
      token,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
    };
    expect(send).toHaveBeenCalledExactlyOnceWith(message);
    expect(JSON.parse(JSON.stringify(send.mock.calls[0]![0]))).toEqual(message);
  });
  it("allows either template without an optional refId", async () => {
    const { send, push } = gateway();
    for (const template of ["OCR_EXTRACTION_READY", "QUESTIONNAIRE_READY"] as const) {
      await expect(push.sendToDevice({ token, ...buildNotificationPayload(template) })).resolves.toMatchObject({ ok: true });
    }
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rejects extra data and invalid type/refId before SDK send", async () => {
    for (const data of [
      { ...approved().data, symptoms: "合成の頭痛・薬剤・住所" },
      { ...approved().data, patientUid: "synthetic-patient" },
      { ...approved().data, token: "synthetic-secret" },
      { type: "OCR_EXTRACTION_READY" }, { type: "UNKNOWN" }, {},
      { type: "QUESTIONNAIRE_READY", refId: "" },
      { type: "QUESTIONNAIRE_READY", refId: 42 },
    ]) {
      const { send, push } = gateway();
      await expect(push.sendToDevice({ token, ...approved(), data: data as Record<string, string> }))
        .resolves.toEqual({ ok: false, code: "unknown" });
      expect(send).not.toHaveBeenCalled();
    }
  });
  it("rejects non-catalog text without leaking it in the result", async () => {
    const { send, push } = gateway();
    const result = await push.sendToDevice({ token, ...approved(), body: "PRIVATE_SYNTHETIC_SYMPTOM" });
    expect(result).toEqual({ ok: false, code: "unknown" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SYNTHETIC");
    expect(send).not.toHaveBeenCalled();
  });
  it("retains SDK error classification for approved messages", async () => {
    const { send, push } = gateway();
    send.mockRejectedValue({ code: "messaging/registration-token-not-registered" });
    await expect(push.sendToDevice({ token, ...approved() })).resolves.toEqual({ ok: false, code: "unregistered" });
  });
});
