import {
  FieldValue,
  Timestamp,
  type DocumentData,
} from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type {
  AuditEventDoc,
  MedicationDoc,
  UploadDoc,
} from "../domain/firestoreDocs.js";
import type { OcrCandidate } from "../domain/ocr.js";
import type {
  MedicationCreateBody,
  MedicationPatchBody,
} from "../domain/schemas.js";
import type {
  MedicationConfirmationStatus,
  MedicationSourceType,
} from "../domain/types.js";
import { ApiError } from "../lib/errors.js";
import { requestHash, runIdempotent } from "../lib/idempotency.js";
import {
  audit,
  auditInTransaction,
  auditResourceHash,
  auditUidHash,
  logAuditEvent,
} from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import { getDoc } from "../repos/helpers.js";
import {
  getMedication,
  listMedications as repoListMedications,
} from "../repos/medications.js";
import { getOcrJob } from "../repos/ocrJobs.js";

export interface MedicationResponse {
  medicationId: string;
  displayName: string;
  genericName: string | null;
  strength: string | null;
  instructionsText: string | null;
  quantity: string | null;
  prescribedAt: string | null;
  currentStatus: string;
  confirmationStatus: string;
  sourceType: string;
  uploadId: string | null;
  ocrJobId: string | null;
  attachToQuestionnaire: boolean;
  userConfirmedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ExtractionResponse {
  jobId: string;
  status: string;
  errorCode: string | null;
  candidates: OcrCandidate[];
}

function toIso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value) {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  return null;
}

export function toMedicationResponse(
  medicationId: string,
  doc: MedicationDoc,
): MedicationResponse {
  return {
    medicationId,
    displayName: doc.displayName,
    genericName: doc.genericName ?? null,
    strength: doc.strength ?? null,
    instructionsText: doc.instructionsText ?? null,
    quantity: doc.quantity ?? null,
    prescribedAt: doc.prescribedAt ?? null,
    currentStatus: doc.currentStatus,
    confirmationStatus: doc.confirmationStatus,
    sourceType: doc.sourceType,
    uploadId: doc.uploadId ?? null,
    ocrJobId: doc.ocrJobId ?? null,
    attachToQuestionnaire: doc.attachToQuestionnaire,
    userConfirmedAt: toIso(doc.userConfirmedAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

/**
 * API-022 GET /medications/extractions/{jobId}。
 * 抽出候補の照会。候補は常に unconfirmed — 確定は POST /medications のみ。
 */
export async function getExtraction(
  deps: Deps,
  params: { uid: string; jobId: string; requestId?: string },
): Promise<ExtractionResponse> {
  const job = await getOcrJob(deps.db, params.jobId);
  if (!job || job.patientUid !== params.uid) {
    throw ApiError.notFound("抽出結果が見つかりません。");
  }
  // 閲覧監査: 抽出候補は薬剤名等のPHIを含むため閲覧証跡を残す（値自体は記録しない）
  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, params.uid),
    action: AUDIT_ACTIONS.OCR_EXTRACTION_READ,
    resourceType: "ocrJobs",
    resourceIdHash: auditResourceHash(deps, params.jobId),
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    outcome: "ok",
  });
  return {
    jobId: params.jobId,
    status: job.status,
    errorCode: job.errorCode,
    candidates: job.candidates,
  };
}

/**
 * API-023 POST /medications。
 * 本人確認済みの薬剤登録。OCR由来は ocrJobId(+candidateId) で出所を保持し、
 * 候補値を既定として利用者の入力で上書きする（FR-M04, E2E-003）。
 */
export async function createMedication(
  deps: Deps,
  params: {
    uid: string;
    body: MedicationCreateBody;
    idempotencyKey: string;
    requestId: string;
  },
): Promise<MedicationResponse> {
  const { body } = params;

  // OCR由来の解決（外部サービス呼び出しではないが所有者検証を先に行う）
  let sourceType: MedicationSourceType = "manual";
  let sourceUploadId: string | undefined;
  let candidate: OcrCandidate | undefined;
  if (body.ocrJobId) {
    const job = await getOcrJob(deps.db, body.ocrJobId);
    if (!job || job.patientUid !== params.uid) {
      throw ApiError.notFound("抽出結果が見つかりません。");
    }
    if (job.status !== "succeeded") {
      throw ApiError.precondition(
        "この抽出結果はまだ利用できません。",
      );
    }
    if (body.candidateId) {
      candidate = job.candidates.find(
        (c) => c.candidateId === body.candidateId,
      );
      if (!candidate) {
        throw ApiError.validation([
          { field: "candidateId", message: "指定された候補が見つかりません。" },
        ]);
      }
    }
    const upload = (
      await getDoc<UploadDoc>(deps.db, `uploads/${job.uploadId}`)
    ).data;
    sourceType =
      upload?.sourcePurpose === "medication_notebook"
        ? "medication_notebook"
        : "prescription_photo";
    sourceUploadId = job.uploadId;
  } else if (body.candidateId) {
    throw ApiError.validation([
      { field: "candidateId", message: "ocrJobId も指定してください。" },
    ]);
  }

  const confirmationStatus: MedicationConfirmationStatus =
    body.confirmationStatus ?? "confirmed";
  const { result, replayed } = await runIdempotent<{ medicationId: string }>(
    deps,
    {
      namespace: "medication_create",
      key: params.idempotencyKey,
      principal: params.uid,
      requestHash: requestHash(deps, body),
      execute: async (tx) => {
        const ref = deps.db.collection("medications").doc();
        const now = deps.clock.now();
        const doc: MedicationDoc = {
          patientUid: params.uid,
          displayName: body.displayName,
          // OCR候補を既定値として利用者入力で上書き（FR-M04 の人手確認）
          ...(body.genericName !== undefined
            ? { genericName: body.genericName }
            : {}),
          strength:
            body.strength !== undefined
              ? body.strength
              : (candidate?.strength ?? null),
          instructionsText:
            body.instructionsText !== undefined
              ? body.instructionsText
              : (candidate?.dosage ?? null),
          quantity:
            body.quantity !== undefined
              ? body.quantity
              : (candidate?.quantity ?? null),
          prescribedAt:
            body.prescribedAt !== undefined
              ? body.prescribedAt
              : (candidate?.prescribedAt ?? null),
          currentStatus: body.currentStatus,
          confirmationStatus,
          sourceType,
          ...(sourceUploadId !== undefined
            ? { uploadId: sourceUploadId }
            : {}),
          ...(body.ocrJobId !== undefined
            ? { ocrJobId: body.ocrJobId }
            : {}),
          attachToQuestionnaire: body.attachToQuestionnaire ?? false,
          ...(confirmationStatus === "confirmed"
            ? { userConfirmedAt: Timestamp.fromDate(now) }
            : {}),
          createdAt: Timestamp.fromDate(now),
          updatedAt: Timestamp.fromDate(now),
        };
        tx.create(ref, doc as unknown as DocumentData);
        return { medicationId: ref.id };
      },
    },
  );

  // 冪等リプレイでは新規作成が起きていないため監査も発行しない
  if (!replayed) {
    await audit(deps, {
      actorType: "patient",
      actorUidHash: auditUidHash(deps, params.uid),
      action: AUDIT_ACTIONS.MEDICATION_CREATED,
      resourceType: "medications",
      resourceIdHash: auditResourceHash(deps, result.medicationId),
      requestId: params.requestId,
      outcome: confirmationStatus,
    });
  }

  const created = await getMedication(deps.db, result.medicationId);
  if (!created) {
    throw new ApiError(500, "INTERNAL", "薬剤の登録に失敗しました。");
  }
  return toMedicationResponse(result.medicationId, created);
}

/** API-024 GET /medications。 */
export async function listMedications(
  deps: Deps,
  uid: string,
): Promise<{ medications: MedicationResponse[] }> {
  const rows = await repoListMedications(deps.db, uid);
  return {
    medications: rows.map((r) => toMedicationResponse(r.id, r.data)),
  };
}

/** API-025 PATCH /medications/{id}。 */
export async function patchMedication(
  deps: Deps,
  params: {
    uid: string;
    medicationId: string;
    body: MedicationPatchBody;
    requestId?: string;
  },
): Promise<MedicationResponse> {
  const ref = deps.db.doc(`medications/${params.medicationId}`);
  const snap = await ref.get();
  const doc = snap.data() as MedicationDoc | undefined;
  if (!snap.exists || !doc || doc.patientUid !== params.uid) {
    throw ApiError.notFound("薬剤が見つかりません。");
  }
  const { body } = params;
  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  // undefined = 変更なし、null = 値の消去
  for (const key of [
    "displayName",
    "genericName",
    "strength",
    "instructionsText",
    "quantity",
    "prescribedAt",
    "currentStatus",
    "confirmationStatus",
    "attachToQuestionnaire",
  ] as const) {
    if (body[key] !== undefined) update[key] = body[key];
  }
  if (body.confirmationStatus === "confirmed") {
    update.userConfirmedAt = FieldValue.serverTimestamp();
  }
  await ref.update(update);
  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, params.uid),
    action: AUDIT_ACTIONS.MEDICATION_UPDATED,
    resourceType: "medications",
    resourceIdHash: auditResourceHash(deps, params.medicationId),
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    outcome: "updated",
  });
  const after = (await ref.get()).data() as MedicationDoc;
  return toMedicationResponse(params.medicationId, after);
}

/** API-026 DELETE /medications/{id}。物理削除（PHI最小化）。 */
export async function deleteMedication(
  deps: Deps,
  params: { uid: string; medicationId: string; requestId?: string },
): Promise<void> {
  const ref = deps.db.doc(`medications/${params.medicationId}`);
  const committedAudits: AuditEventDoc[] = [];
  // 削除と証跡を同一txにし、同時DELETE競合で監査が二重発行されないようにする
  await deps.db.runTransaction(async (tx) => {
    committedAudits.length = 0;
    const snap = await tx.get(ref);
    const doc = snap.data() as MedicationDoc | undefined;
    if (!snap.exists || !doc || doc.patientUid !== params.uid) {
      throw ApiError.notFound("薬剤が見つかりません。");
    }
    tx.delete(ref);
    committedAudits.push(
      auditInTransaction(tx, deps, {
        actorType: "patient",
        actorUidHash: auditUidHash(deps, params.uid),
        action: AUDIT_ACTIONS.MEDICATION_DELETED,
        resourceType: "medications",
        resourceIdHash: auditResourceHash(deps, params.medicationId),
        ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
        outcome: "deleted",
      }),
    );
  });
  for (const e of committedAudits) logAuditEvent(deps, e);
}
