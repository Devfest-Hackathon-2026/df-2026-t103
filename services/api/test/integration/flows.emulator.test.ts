import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  FieldValue,
  Timestamp,
  type Firestore,
  type ReadWriteTransactionOptions,
  type Transaction,
} from "firebase-admin/firestore";
import type { TestDeps } from "../helpers/deps.js";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import {
  authHeader,
  buildTestApp,
  seedAccount,
  seedCurrentConsents,
  seedLegalDocuments,
} from "../helpers/app.js";
import {
  clearEmulatorFirestore,
  makeEmulatorDeps,
  type EmulatorDeps,
} from "../helpers/emulator.js";
import { AUDIT_ACTIONS } from "../../src/domain/auditEvents.js";
import type { DeliveryDoc } from "../../src/domain/firestoreDocs.js";

/**
 * 主要E2E（docs/03 §10 E2E-001〜006）のサーバ側観点を
 * 実 Firestore エミュレータで検証する結合テスト（Issue #25）。
 * HTTP → サービス → トランザクション → 永続化の全経路を通し、
 * 副作用ドキュメント・監査イベントを実FS上で確認する。
 */

const PATIENT = "emu-patient-1";
const OTHER_PATIENT = "emu-patient-2";
const STAFF_A = "emu-staff-a";
const STAFF_B = "emu-staff-b";
const FAC_A = "emu-fac-a";
const FAC_B = "emu-fac-b";

function idem(key: string): Record<string, string> {
  return { "idempotency-key": key };
}

const DISCLOSURE = DEV_LEGAL_DOCUMENTS.documents.hospital_disclosure!;

/** P-032 で取得した施設別送信同意を含む API-029 ペイロード（#219）。 */
function deliveryPayload(questionnaireId: string, facilityId: string) {
  const shareScope = {
    includeProfile: true,
    includeConfirmedMedications: true,
    includePrescriptionImages: false,
  };
  return {
    questionnaireId,
    questionnaireRevision: 1,
    facilityId,
    shareScope,
    consent: {
      accepted: true,
      documentVersion: DISCLOSURE.version,
      documentHash: DISCLOSURE.documentHash,
      shareScope,
    },
  };
}

/** 施設別同意の state doc（legalConsents/fc_{uid}_{facilityId}）をシードする。 */
async function seedFacilityConsentState(
  deps: TestDeps,
  uid: string,
  facilityId: string,
  opts: { revoked?: boolean } = {},
): Promise<string> {
  const path = `legalConsents/fc_${uid}_${facilityId}`;
  await deps.db.doc(path).set({
    subjectUid: uid,
    consentType: "hospital_disclosure",
    documentVersion: DISCLOSURE.version,
    documentHash: DISCLOSURE.documentHash,
    decision: "granted",
    method: "explicit_checkbox",
    registrationSource: "facility_consent",
    scope: { facilityId, purpose: "medical_intake_preparation" },
    occurredAt: Timestamp.fromDate(deps.clock.now()),
    revokedAt: opts.revoked ? Timestamp.fromDate(deps.clock.now()) : null,
    schemaVersion: "1",
  });
  return path;
}

/**
 * updateFunction が全ての読み書きをステージし終えた直後に例外を投げ、
 * コミット前の部分失敗を再現する Firestore ラッパ（原子性検証用）。
 */
class CommitBombFirestore {
  bombAfterWrites = false;

  constructor(private readonly inner: Firestore) {}

  doc(path: string) {
    return this.inner.doc(path);
  }
  collection(path: string) {
    return this.inner.collection(path);
  }
  collectionGroup(id: string) {
    return this.inner.collectionGroup(id);
  }
  batch() {
    return this.inner.batch();
  }
  runTransaction<T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
    transactionOptions?: ReadWriteTransactionOptions,
  ): Promise<T> {
    return this.inner.runTransaction(async (tx) => {
      const result = await updateFunction(tx);
      if (this.bombAfterWrites) {
        throw new Error("injected pre-commit failure");
      }
      return result;
    }, transactionOptions);
  }
}

async function seedMembership(
  deps: TestDeps,
  uid: string,
  facilityId: string,
): Promise<void> {
  await deps.db.collection("facilityMemberships").doc().set({
    userUid: uid,
    facilityId,
    role: "facility_staff",
    status: "active",
    mfaEnforced: false,
    createdAt: FieldValue.serverTimestamp(),
    revokedAt: null,
  });
}

async function seedFacility(
  deps: TestDeps,
  facilityId: string,
  opts: { receivingEnabled?: boolean; verificationStatus?: string } = {},
): Promise<void> {
  const ts = FieldValue.serverTimestamp();
  await deps.db.doc(`facilities/${facilityId}`).set({
    facilityId,
    legalName: "結合テスト病院",
    displayName: "結合テスト病院",
    verificationStatus: opts.verificationStatus ?? "verified",
    receivingEnabled: opts.receivingEnabled ?? true,
    serviceAgreementVersion: "v1",
    createdAt: ts,
    updatedAt: ts,
  });
}

/** POST /intakes → symptoms → next-question → answer → summary → finalize。 */
async function makeFinalizedQuestionnaire(
  app: FastifyInstance,
  uid: string,
): Promise<string> {
  const uniq = Math.random().toString(36).slice(2);
  const c = await app.inject({
    method: "POST",
    url: "/v1/intakes",
    headers: { ...authHeader(uid), ...idem(`ik-${uniq}`) },
    payload: { locale: "ja-JP" },
  });
  expect(c.statusCode).toBe(201);
  const { intakeId } = c.json() as { intakeId: string };

  const s = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/symptoms`,
    headers: authHeader(uid),
    payload: {
      initialSymptomText: "1週間頭が痛い",
      bodyLocations: ["head"],
      expectedIntakeRevision: 1,
    },
  });
  expect(s.statusCode).toBe(200);

  const q = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/next-question`,
    headers: authHeader(uid),
    payload: { expectedIntakeRevision: 2 },
  });
  expect(q.statusCode).toBe(200);
  const { questionId } = (q.json() as { question: { questionId: string } })
    .question;

  const a = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/answers`,
    headers: authHeader(uid),
    payload: {
      questionId,
      questionRevision: 1,
      selectedCodes: ["GT_WEEK"],
      freeText: null,
      answerState: "answered",
      expectedIntakeRevision: 3,
    },
  });
  expect(a.statusCode).toBe(200);
  const arev = (a.json() as { intakeRevision: number }).intakeRevision;

  const sum = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/summary`,
    headers: authHeader(uid),
    payload: { expectedIntakeRevision: arev },
  });
  expect(sum.statusCode).toBe(200);
  const srev = (sum.json() as { intakeRevision: number }).intakeRevision;

  const f = await app.inject({
    method: "POST",
    url: `/v1/intakes/${intakeId}/finalize`,
    headers: { ...authHeader(uid), ...idem(`fin-${uniq}`) },
    payload: { expectedIntakeRevision: srev, summaryReviewConfirmed: true },
  });
  expect(f.statusCode).toBe(200);
  return (f.json() as { questionnaireId: string }).questionnaireId;
}

async function auditActions(deps: EmulatorDeps): Promise<string[]> {
  const snap = await deps.firestore.collection("auditEvents").get();
  return snap.docs.map((d) => d.data().action as string);
}

describe("E2E server-side perspectives / Firestore エミュレータ結合", () => {
  let deps: EmulatorDeps;
  let app: FastifyInstance;

  beforeEach(async () => {
    await clearEmulatorFirestore();
    deps = makeEmulatorDeps();
    await seedLegalDocuments(deps);
    app = buildTestApp(deps);
  });

  afterEach(async () => {
    await app.close();
    await clearEmulatorFirestore();
  });

  it("E2E-001: 問診確定→配送→病院閲覧で配送版ハッシュと監査が実FSに残る", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
    await seedAccount(deps, STAFF_A);
    await seedCurrentConsents(deps, STAFF_A);
    await seedMembership(deps, STAFF_A, FAC_A);
    await seedFacility(deps, FAC_A);

    const questionnaireId = await makeFinalizedQuestionnaire(app, PATIENT);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-e2e1") },
      payload: deliveryPayload(questionnaireId, FAC_A),
    });
    expect(res.statusCode).toBe(202);
    const { deliveryId } = res.json() as { deliveryId: string };

    // 実FS上の delivery ドキュメント
    const stored = (
      await deps.firestore.doc(`deliveries/${deliveryId}`).get()
    ).data() as DeliveryDoc;
    expect(stored.facilityId).toBe(FAC_A);
    expect(stored.questionnaireId).toBe(questionnaireId);
    expect(stored.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);

    // consentId は本送信の同意証跡 doc を指し、版/hash も保存される（#219）
    const sendConsent = (
      await deps.firestore.doc(`legalConsents/${stored.consentId}`).get()
    ).data();
    expect(sendConsent).toBeTruthy();
    expect(sendConsent!.subjectUid).toBe(PATIENT);
    expect(sendConsent!.scope?.deliveryId).toBe(deliveryId);
    expect(stored.consentDocumentVersion).toBe(DISCLOSURE.version);
    expect(stored.consentDocumentHash).toBe(DISCLOSURE.documentHash);
    // (uid, facilityId) state doc も実FS上に作成される
    expect(
      (await deps.firestore.doc(`legalConsents/fc_${PATIENT}_${FAC_A}`).get())
        .exists,
    ).toBe(true);

    // 病院側閲覧: サーバが返すハッシュは永続化された配送版ハッシュと一致
    const view = await app.inject({
      method: "GET",
      url: `/v1/hospitals/${FAC_A}/deliveries/${deliveryId}`,
      headers: authHeader(STAFF_A),
    });
    expect(view.statusCode).toBe(200);
    const detail = view.json() as {
      snapshotSha256: string;
      questionnaireSnapshot: { chiefComplaint?: { value: string | null } };
    };
    expect(detail.snapshotSha256).toBe(stored.snapshotSha256);
    expect(detail.questionnaireSnapshot.chiefComplaint?.value).toBe(
      "1週間頭が痛い",
    );

    // audit trail（配送作成 + 病院閲覧 allow）
    const actions = await auditActions(deps);
    expect(actions).toContain(AUDIT_ACTIONS.DELIVERY_CREATED);
    expect(actions).toContain(AUDIT_ACTIONS.DELIVERY_VIEWED);
  });

  it("E2E-002: 通信断リトライで回答が二重記録されない（同一再送は409→最新で1件）", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);

    const uniq = Math.random().toString(36).slice(2);
    const c = await app.inject({
      method: "POST",
      url: "/v1/intakes",
      headers: { ...authHeader(PATIENT), ...idem(`ik-${uniq}`) },
      payload: { locale: "ja-JP" },
    });
    const { intakeId } = c.json() as { intakeId: string };
    await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/symptoms`,
      headers: authHeader(PATIENT),
      payload: {
        initialSymptomText: "3日前から頭痛",
        bodyLocations: ["head"],
        expectedIntakeRevision: 1,
      },
    });
    const q = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/next-question`,
      headers: authHeader(PATIENT),
      payload: { expectedIntakeRevision: 2 },
    });
    const { questionId } = (q.json() as { question: { questionId: string } })
      .question;

    const payload = {
      questionId,
      questionRevision: 1,
      selectedCodes: ["LT_WEEK"],
      freeText: "昨日の夜から",
      answerState: "answered",
      expectedIntakeRevision: 3,
    };
    const first = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers: authHeader(PATIENT),
      payload,
    });
    expect(first.statusCode).toBe(200);

    // 通信断を想定した同一本文の再送: revision は1つ進んでいるため409。
    // クライアントは最新状態を再取得して復帰する（重複書き込みは起きない）。
    const replay = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/answers`,
      headers: authHeader(PATIENT),
      payload,
    });
    expect(replay.statusCode).toBe(409);

    // 実FS上で回答は1件のみ（重複なし・上書き保存）
    const answers = await deps.firestore
      .collection(`intakes/${intakeId}/answers`)
      .get();
    expect(answers.size).toBe(1);
    expect(answers.docs[0]!.data().questionId).toBe(questionId);
  });

  it("E2E-003: 薬剤誤抽出の修正→「服薬状況は不明」で未確認登録される", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);

    // OCR誤認識を利用者が修正し、服薬状況=不明・未確認のまま登録
    const res = await app.inject({
      method: "POST",
      url: "/v1/medications",
      headers: { ...authHeader(PATIENT), ...idem("med-e2e3") },
      payload: {
        displayName: "正しい薬剤名", // OCR候補の誤値を利用者が上書き
        strength: null, // 誤抽出の強度は明示的にクリア
        currentStatus: "not_sure",
        confirmationStatus: "unconfirmed",
      },
    });
    expect(res.statusCode).toBe(201);
    const { medicationId } = res.json() as { medicationId: string };

    // 実FS上で「本人の申告、未確認」として保持される
    const doc = (
      await deps.firestore.doc(`medications/${medicationId}`).get()
    ).data()!;
    expect(doc.displayName).toBe("正しい薬剤名");
    expect(doc.strength ?? null).toBeNull();
    expect(doc.currentStatus).toBe("not_sure");
    expect(doc.confirmationStatus).toBe("unconfirmed");
    expect(doc.userConfirmedAt ?? null).toBeNull();

    // 一覧でも未確認のまま返る（誤った元候補を勝手に確定扱いしない）
    const list = await app.inject({
      method: "GET",
      url: "/v1/medications",
      headers: authHeader(PATIENT),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { medications: Array<{ medicationId: string; confirmationStatus: string }> })
      .medications;
    const item = items.find((m) => m.medicationId === medicationId);
    expect(item?.confirmationStatus).toBe("unconfirmed");
  });

  it("E2E-004: 他院の Delivery は404で拒否・存在も区別不可・deny監査のみ残る", async () => {
    await seedAccount(deps, STAFF_B);
    await seedCurrentConsents(deps, STAFF_B);
    await seedMembership(deps, STAFF_B, FAC_B);
    await seedFacility(deps, FAC_A);
    await seedFacility(deps, FAC_B);

    // fac-a 宛の delivery を直接シード
    const now = FieldValue.serverTimestamp();
    await deps.db.doc("deliveries/dlv-fac-a-1").set({
      senderUid: PATIENT,
      facilityId: FAC_A,
      questionnaireId: "qn-1",
      questionnaireRevisionId: "rev-1",
      consentId: "consent-1",
      shareScope: {
        includeProfile: true,
        includeConfirmedMedications: false,
        includePrescriptionImages: false,
      },
      patientIdentitySnapshot: {},
      questionnaireSnapshot: {},
      snapshotSha256: "a".repeat(64),
      status: "delivered",
      idempotencyKeyHash: "h",
      facilityRetentionPolicyVersion: "v1",
      createdAt: now,
      deliveredAt: now,
    } satisfies Partial<DeliveryDoc>);

    const res = await app.inject({
      method: "GET",
      url: `/v1/hospitals/${FAC_B}/deliveries/dlv-fac-a-1`,
      headers: authHeader(STAFF_B),
    });
    // 別施設doc・存在しないdoc ともに 404（存在の有無が区別できない）
    expect(res.statusCode).toBe(404);
    const missing = await app.inject({
      method: "GET",
      url: `/v1/hospitals/${FAC_B}/deliveries/dlv-no-such`,
      headers: authHeader(STAFF_B),
    });
    expect(missing.statusCode).toBe(404);

    // 拒否の監査イベントのみ記録される
    const snap = await deps.firestore.collection("auditEvents").get();
    const viewed = snap.docs
      .map((d) => d.data())
      .filter((d) => d.action === AUDIT_ACTIONS.DELIVERY_VIEWED);
    expect(viewed.length).toBeGreaterThanOrEqual(1);
    expect(viewed.every((d) => d.decision === "deny")).toBe(true);
  });

  it("E2E-005: 退会申請後は更新系が403、取消で復帰する", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);

    const req = await app.inject({
      method: "POST",
      url: "/v1/me/deletion-request",
      headers: { ...authHeader(PATIENT), ...idem("del-1") },
      payload: {},
    });
    expect(req.statusCode).toBe(202);

    // 実FS上で accountStatus が pending_deletion
    const account = (
      await deps.firestore.doc(`accounts/${PATIENT}`).get()
    ).data()!;
    expect(account.accountStatus).toBe("pending_deletion");

    // 全更新が拒否（profile PATCH は active tier）
    const blocked = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: authHeader(PATIENT),
      payload: { familyName: "更新" },
    });
    expect(blocked.statusCode).toBe(403);

    // 取消（再認証ウィンドウ内）で復帰
    const cancel = await app.inject({
      method: "POST",
      url: "/v1/me/deletion-request/cancel",
      headers: { ...authHeader(PATIENT), ...idem("cancel-1") },
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    expect(
      (await deps.firestore.doc(`accounts/${PATIENT}`).get()).data()!
        .accountStatus,
    ).toBe("active");
  });

  it("E2E-006: receivingEnabled=false の施設への送信は412、既存Deliveryは不変", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
    await seedFacility(deps, FAC_A, { receivingEnabled: false });

    // 停止前に配送済みの既存Delivery（影響を受けないことを確認する対象）
    const now = FieldValue.serverTimestamp();
    await deps.db.doc("deliveries/dlv-existing-1").set({
      senderUid: PATIENT,
      facilityId: FAC_A,
      questionnaireId: "qn-old",
      questionnaireRevisionId: "rev-1",
      consentId: "consent-1",
      shareScope: {
        includeProfile: true,
        includeConfirmedMedications: false,
        includePrescriptionImages: false,
      },
      patientIdentitySnapshot: {},
      questionnaireSnapshot: {},
      snapshotSha256: "b".repeat(64),
      status: "delivered",
      idempotencyKeyHash: "h",
      facilityRetentionPolicyVersion: "v1",
      createdAt: now,
      deliveredAt: now,
    } satisfies Partial<DeliveryDoc>);

    const questionnaireId = await makeFinalizedQuestionnaire(app, PATIENT);

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-e2e6") },
      payload: deliveryPayload(questionnaireId, FAC_A),
    });
    expect(res.statusCode).toBe(412);

    // 既存Deliveryは影響を受けず、新規も作成されない
    const deliveries = await deps.firestore.collection("deliveries").get();
    expect(deliveries.size).toBe(1);
    expect(deliveries.docs[0]!.id).toBe("dlv-existing-1");
    expect(deliveries.docs[0]!.data().status).toBe("delivered");
  });

  it("テナント境界（IDOR）: 他人の intake は参照も更新もできない", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
    await seedAccount(deps, OTHER_PATIENT);
    await seedCurrentConsents(deps, OTHER_PATIENT);

    const uniq = Math.random().toString(36).slice(2);
    const c = await app.inject({
      method: "POST",
      url: "/v1/intakes",
      headers: { ...authHeader(PATIENT), ...idem(`ik-${uniq}`) },
      payload: { locale: "ja-JP" },
    });
    const { intakeId } = c.json() as { intakeId: string };

    // 存在の有無も区別できない拒否
    const read = await app.inject({
      method: "GET",
      url: `/v1/intakes/${intakeId}`,
      headers: authHeader(OTHER_PATIENT),
    });
    expect(read.statusCode).toBe(404);
    const write = await app.inject({
      method: "POST",
      url: `/v1/intakes/${intakeId}/symptoms`,
      headers: authHeader(OTHER_PATIENT),
      payload: {
        initialSymptomText: "悪意ある更新",
        bodyLocations: ["head"],
        expectedIntakeRevision: 1,
      },
    });
    expect(write.statusCode).toBe(404);

    // 実FS上でデータは変更されていない
    const intake = (
      await deps.firestore.doc(`intakes/${intakeId}`).get()
    ).data()!;
    expect(intake.initialSymptomText ?? null).toBeNull();
    expect(intake.status).toBe("draft");
  });

  it("同意ゲート: 現行同意が無いと active tier API は 412（SEC-16/18）", async () => {
    await seedAccount(deps, PATIENT);
    // 同意はシードしない（legal_pending 状態を再現）

    const res = await app.inject({
      method: "POST",
      url: "/v1/intakes",
      headers: { ...authHeader(PATIENT), ...idem("consent-gate") },
      payload: { locale: "ja-JP" },
    });
    expect(res.statusCode).toBe(412);
    expect(
      (await deps.firestore.collection("intakes").get()).size,
    ).toBe(0);
  });

  it("冪等再試行: 同キー配送POSTは delivery を1件のみ作成し同IDを返す", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
    await seedFacility(deps, FAC_A);
    const questionnaireId = await makeFinalizedQuestionnaire(app, PATIENT);

    const payload = deliveryPayload(questionnaireId, FAC_A);
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-idem") },
      payload,
    });
    expect(r1.statusCode).toBe(202);
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-idem") },
      payload,
    });
    expect(r2.statusCode).toBe(202);
    expect(
      (r2.json() as { deliveryId: string }).deliveryId,
    ).toBe((r1.json() as { deliveryId: string }).deliveryId);

    const deliveries = await deps.firestore.collection("deliveries").get();
    expect(deliveries.size).toBe(1);

    // 冪等リプレイで同意証跡は重複しない（state doc + 送信証跡の 2 件）
    const disclosureConsents = await deps.firestore
      .collection("legalConsents")
      .where("consentType", "==", "hospital_disclosure")
      .get();
    expect(disclosureConsents.size).toBe(2);

    // 同キー+異本文は409
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-idem") },
      payload: { ...payload, questionnaireRevision: 2 },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("同意撤回レース: 撤回と配送作成が競合しても最終状態が一貫する (#219)", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
    await seedFacility(deps, FAC_A);
    const consentPath = await seedFacilityConsentState(deps, PATIENT, FAC_A);
    const questionnaireId = await makeFinalizedQuestionnaire(app, PATIENT);

    // 撤回 tx と配送 POST を同時発行する。
    // エミュレータは doc ロックで直列化するため、本物の backend の
    // read→write 競合（ABORTED→再評価）は再現できないが、
    // 「どちらが先にコミットされても最終状態が一貫する」不変条件は検証できる。
    const revokeTx = deps.firestore.runTransaction(async (t) => {
      t.update(deps.firestore.doc(consentPath), {
        revokedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-race") },
      payload: deliveryPayload(questionnaireId, FAC_A),
    });
    await revokeTx;

    // 直列化された線形化結果: 撤回が先なら拒否、配送が先なら送信時点の同意は有効
    expect([202, 412]).toContain(res.statusCode);
    const consentDoc = (
      await deps.firestore.doc(consentPath).get()
    ).data()!;
    if (res.statusCode === 202) {
      // 配送が先: 同意証跡は作成済み、撤回はその後に適用される
      expect(consentDoc.revokedAt).not.toBeNull();
      expect(
        (await deps.firestore.collection("deliveries").get()).size,
      ).toBe(1);
    } else {
      // 撤回が先: 配送・送信証跡は作られない
      expect(
        (await deps.firestore.collection("deliveries").get()).size,
      ).toBe(0);
      const rejects = await deps.firestore
        .collection("auditEvents")
        .where("action", "==", AUDIT_ACTIONS.DELIVERY_REJECTED)
        .get();
      expect(rejects.size).toBe(1);
    }

    // どちらが勝っても撤回済みの同意での新規送信は拒否される
    const res2 = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-race-2") },
      payload: deliveryPayload(questionnaireId, FAC_A),
    });
    expect(res2.statusCode).toBe(412);
  });

  it("部分失敗の原子性: コミット前に失敗すると配送・証跡・冪等キーのいずれも残らない (#219)", async () => {
    await seedAccount(deps, PATIENT);
    await seedCurrentConsents(deps, PATIENT);
    await seedFacility(deps, FAC_A);
    const questionnaireId = await makeFinalizedQuestionnaire(app, PATIENT);

    // 既存冪等キー数（intake/finalize 分）を記録し、増えないことを確認する
    const keyCountBefore = (
      await deps.firestore.collection("idempotencyKeys").get()
    ).size;

    // updateFunction が全読み書きをステージ後に失敗 → コミットされない
    const bomb = new CommitBombFirestore(deps.firestore);
    bomb.bombAfterWrites = true;
    deps.db = bomb;

    const res = await app.inject({
      method: "POST",
      url: "/v1/deliveries",
      headers: { ...authHeader(PATIENT), ...idem("dlv-atomic") },
      payload: deliveryPayload(questionnaireId, FAC_A),
    });
    expect(res.statusCode).toBe(500);

    // 部分コミットなし: delivery・同意証跡・冪等キー・tx内監査のいずれも残らない
    expect(
      (await deps.firestore.collection("deliveries").get()).size,
    ).toBe(0);
    const disclosureConsents = await deps.firestore
      .collection("legalConsents")
      .where("consentType", "==", "hospital_disclosure")
      .get();
    expect(disclosureConsents.size).toBe(0);
    expect(
      (await deps.firestore.collection("idempotencyKeys").get()).size,
    ).toBe(keyCountBefore);
    const createdAudits = await deps.firestore
      .collection("auditEvents")
      .where("action", "==", AUDIT_ACTIONS.DELIVERY_CREATED)
      .get();
    expect(createdAudits.size).toBe(0);
  });
});
