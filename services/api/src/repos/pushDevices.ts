import {
  FieldValue,
  type DocumentData,
  type DocumentReference,
  type Transaction,
} from "firebase-admin/firestore";
import type { PushDeviceDoc } from "../domain/firestoreDocs.js";
import { queryDocs } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";
import { hmacParts } from "../lib/hash.js";
import type { Deps } from "../deps.js";

/** 1ユーザーあたりの送信対象デバイス上限（異常な登録数による送信増幅を抑止）。 */
export const PUSH_DEVICE_SEND_LIMIT = 20;

/**
 * deviceId を FCM トークンから決定論的に導出する。
 * 同一トークンの再登録は同じ doc を更新するため冪等。
 * トークン自体を doc id に使わない（長さ・文字種・列挙耐性のため）。
 */
export function pushDeviceIdForToken(deps: Deps, token: string): string {
  return `pdv_${hmacParts(deps.config.hmacSecret, "push-device", token)}`;
}

/**
 * デバイス登録のupsert（呼び出し元のトランザクション内で実行）。
 * 既存docがあれば ownership を最新の登録者に更新する（トークンは
 * アプリインストールに紐づき、アカウント切替時は最後に登録した
 * ユーザーが受信者となる）。FCMが一度 unregistered を返した
 * トークンも再登録で active に復活させる。
 */
export async function upsertPushDeviceInTx(
  tx: Transaction,
  ref: DocumentReference,
  params: {
    patientUid: string;
    token: string;
    platform: PushDeviceDoc["platform"];
  },
): Promise<void> {
  const now = FieldValue.serverTimestamp();
  const snap = await tx.get(ref);
  if (!snap.exists) {
    const doc: PushDeviceDoc = {
      patientUid: params.patientUid,
      token: params.token,
      platform: params.platform,
      status: "active",
      invalidatedReason: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    tx.create(ref, doc as unknown as DocumentData);
    return;
  }
  await tx.update(ref, {
    patientUid: params.patientUid,
    token: params.token,
    platform: params.platform,
    status: "active",
    invalidatedReason: null,
    updatedAt: now,
    lastSeenAt: now,
  });
}

/** 送信対象の active デバイスを列挙する。 */
export async function listActivePushDevices(
  db: FirestoreLike,
  patientUid: string,
): Promise<Array<{ id: string; data: PushDeviceDoc }>> {
  return queryDocs<PushDeviceDoc>(db, "pushDevices", [
    { field: "patientUid", op: "==", value: patientUid },
    { field: "status", op: "==", value: "active" },
  ], { limit: PUSH_DEVICE_SEND_LIMIT });
}

function timestampMillis(v: unknown): number | undefined {
  if (
    v !== null &&
    typeof v === "object" &&
    "toMillis" in v &&
    typeof (v as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (v as { toMillis: () => number }).toMillis();
  }
  return undefined;
}

/**
 * FCM がトークン失効を返したデバイスを無効化する。
 * `expectedLastSeenAt`（送信試行時点で読んだ値）と現行値が異なる場合、
 * 送信試行後に再登録が走ったと判断して無効化をスキップする。
 * 再登録は lastSeenAt を必ず更新するため、これで競合時の
 * 「再登録直後の active を invalid で上書き」を防ぐ。
 */
export async function invalidatePushDevice(
  db: FirestoreLike,
  deviceId: string,
  reason: string,
  expectedLastSeenAt?: unknown,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`pushDevices/${deviceId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const expected = timestampMillis(expectedLastSeenAt);
    const current = timestampMillis(
      (snap.data() as PushDeviceDoc | undefined)?.lastSeenAt,
    );
    // 比較不能な場合は変更を検知できないので無効化を進める
    if (
      expected !== undefined &&
      current !== undefined &&
      current !== expected
    ) {
      return;
    }
    await tx.update(ref, {
      status: "invalid",
      invalidatedReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}
