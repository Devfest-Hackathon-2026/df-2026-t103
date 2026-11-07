import {
  FieldValue,
  Timestamp,
  type DocumentData,
} from "firebase-admin/firestore";
import type { Deps } from "../deps.js";
import type { LegalDocumentSet } from "../domain/legalDocuments.js";
import type {
  AccountDoc,
  LegalConsentDoc,
  RegistrationOperationDoc,
} from "../domain/firestoreDocs.js";
import {
  registerBodySchema,
  type RegisterBody,
} from "../domain/schemas.js";
import {
  validateConsentSubmission,
  type ValidatedGrant,
} from "../domain/consents.js";
import { ApiError, ErrorCodes, assertParsed } from "../lib/errors.js";
import { requestHash } from "../lib/idempotency.js";
import { hmacParts } from "../lib/hash.js";
import { getLegalDocuments } from "../repos/legalConfig.js";
import { registrationOperationRef } from "../repos/operations.js";
import { audit, auditUidHash } from "../lib/audit.js";
import { AUDIT_ACTIONS } from "../domain/auditEvents.js";
import type { Transaction } from "../repos/helpers.js";

export interface RegisterResult {
  registrationStatus: "created";
  nextAction: "sign_in";
  onboardingState: "profile_pending";
}

const OPERATION_TTL_MS = 24 * 3600_000;
const ACCOUNT_STATUSES = new Set([
  "onboarding_pending",
  "active",
  "suspended",
  "pending_deletion",
  "deleted",
]);
const AUTH_ENABLE_ACCOUNT_STATUSES = new Set([
  "onboarding_pending",
  "active",
]);
const ONBOARDING_STATES = new Set([
  "not_started",
  "legal_pending",
  "profile_pending",
  "completed",
]);

function errorClass(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: unknown }).code);
  }
  return "unknown";
}

function isAuthError(err: unknown, code: string): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

async function loadOperation(
  deps: Deps,
  operationHash: string,
): Promise<RegistrationOperationDoc | undefined> {
  const snap = await registrationOperationRef(deps.db, operationHash).get();
  return snap.exists ? (snap.data() as RegistrationOperationDoc) : undefined;
}

async function saveOperation(
  deps: Deps,
  operation: RegistrationOperationDoc,
  patch: Partial<RegistrationOperationDoc>,
): Promise<"saved" | "enabled" | "preserved_checkpoint" | "missing" | "mismatch" | "invalid_state"> {
  const operationHash = operation.operationHash;
  const ref = registrationOperationRef(deps.db, operationHash);
  return deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return "missing";

    const current = snap.data() as RegistrationOperationDoc;
    if (
      current.operationHash !== operationHash ||
      current.requestHash !== operation.requestHash ||
      current.uid !== operation.uid
    ) {
      return "mismatch";
    }
    const targetStatus = patch.status;
    if (targetStatus === "enabled") {
      if (current.status === "enabled" || current.status === "consents_committed") {
        const accountSnap = await tx.get(deps.db.doc(`accounts/${operation.uid}`));
        if (!isAuthEnableEligibleAccount(accountSnap.data(), operation.uid)) {
          return "invalid_state";
        }
        if (current.status === "enabled") return "enabled";
      } else {
        return "invalid_state";
      }
    } else {
      // Account, consents and this status are committed atomically. A delayed
      // retry/error path must not regress that durable checkpoint.
      if (current.status === "consents_committed" || current.status === "enabled") {
        return "preserved_checkpoint";
      }
      if (
        targetStatus !== undefined &&
        current.status !== "reserved" &&
        current.status !== "auth_created" &&
        current.status !== "failed"
      ) {
        return "invalid_state";
      }
    }

    tx.set(
      ref,
      {
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
      } as DocumentData,
      { merge: true },
    );
    return targetStatus === "enabled" ? "enabled" : "saved";
  });
}

function isConsistentRegistrationAccount(
  data: DocumentData | undefined,
  uid: string,
): boolean {
  return (
    !!data &&
    data.uid === uid &&
    typeof data.accountStatus === "string" &&
    ACCOUNT_STATUSES.has(data.accountStatus) &&
    typeof data.onboardingState === "string" &&
    ONBOARDING_STATES.has(data.onboardingState)
  );
}

function isAuthEnableEligibleAccount(
  data: DocumentData | undefined,
  uid: string,
): boolean {
  const accountStatus = data?.accountStatus;
  return (
    isConsistentRegistrationAccount(data, uid) &&
    typeof accountStatus === "string" &&
    AUTH_ENABLE_ACCOUNT_STATUSES.has(accountStatus)
  );
}

async function verifyEnabledOperation(
  deps: Deps,
  operation: RegistrationOperationDoc,
  operationHash: string,
  reqHash: string,
): Promise<"verified" | "missing" | "mismatch" | "invalid_state"> {
  try {
    return await deps.db.runTransaction(async (tx) => {
      const operationRef = registrationOperationRef(deps.db, operationHash);
      const operationSnap = await tx.get(operationRef);
      if (!operationSnap.exists) return "missing";

      const current = operationSnap.data() as RegistrationOperationDoc;
      if (
        current.operationHash !== operationHash ||
        current.requestHash !== reqHash ||
        current.uid !== operation.uid ||
        typeof operation.uid !== "string" ||
        operation.uid.length === 0
      ) {
        return "mismatch";
      }
      if (current.status !== "enabled") return "invalid_state";

      const accountSnap = await tx.get(deps.db.doc(`accounts/${operation.uid}`));
      return isConsistentRegistrationAccount(accountSnap.data(), operation.uid)
        ? "verified"
        : "invalid_state";
    });
  } catch (cause) {
    throw new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "登録済み状態の確認に失敗しました。時間を置いて再試行してください。",
      { retryable: true, cause },
    );
  }
}

async function verifyCommittedCheckpoint(
  deps: Deps,
  operation: RegistrationOperationDoc,
  operationHash: string,
  reqHash: string,
): Promise<
  | "consents_committed"
  | "enabled"
  | "missing"
  | "mismatch"
  | "invalid_state"
> {
  try {
    return await deps.db.runTransaction(async (tx) => {
      const operationSnap = await tx.get(
        registrationOperationRef(deps.db, operationHash),
      );
      if (!operationSnap.exists) return "missing";

      const current = operationSnap.data() as RegistrationOperationDoc;
      if (
        current.operationHash !== operationHash ||
        current.requestHash !== reqHash ||
        current.uid !== operation.uid ||
        typeof operation.uid !== "string" ||
        operation.uid.length === 0
      ) {
        return "mismatch";
      }
      if (current.status !== "consents_committed" && current.status !== "enabled") {
        return "invalid_state";
      }

      const accountSnap = await tx.get(deps.db.doc(`accounts/${operation.uid}`));
      const account = accountSnap.data();
      return isAuthEnableEligibleAccount(account, operation.uid)
        ? current.status
        : "invalid_state";
    });
  } catch (cause) {
    throw new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "登録再開状態の確認に失敗しました。時間を置いて再試行してください。",
      { retryable: true, cause },
    );
  }
}

async function assertEnabledOperation(
  deps: Deps,
  operation: RegistrationOperationDoc,
  operationHash: string,
  reqHash: string,
  requestId: string,
): Promise<void> {
  const verification = await verifyEnabledOperation(
    deps,
    operation,
    operationHash,
    reqHash,
  );
  if (verification === "verified") return;

  await audit(deps, {
    actorType: "service",
    action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
    outcome: "conflict",
    requestId,
    resourceType: "registrationOperation",
    resourceIdHash: operationHash,
    details: { reason: verification },
  });
  throw ApiError.conflict(
    ErrorCodes.REGISTRATION_CONFLICT,
    "登録済み状態を確認できないため処理を中断しました。サポートへお問い合わせください。",
  );
}

/**
 * API-041 メール新規登録（02 §5.1.1 / 03 §5.1 / 04 §5.14）。
 * 順序: 入力検証 → 操作台帳照合 → 同意/版検証 → 操作予約 → Auth作成(disabled)
 * → Firestore transaction(account+consents+op) → Auth有効化 → 201。
 * いずれの段階失敗でも同一 Idempotency-Key で安全に再開できる。
 */
export async function registerEmail(
  deps: Deps,
  params: { body: unknown; idempotencyKey: string; requestId: string },
): Promise<RegisterResult> {
  const body: RegisterBody = assertParsed(
    registerBodySchema.safeParse(params.body),
  );

  const operationHash = hmacParts(
    deps.config.hmacSecret,
    "email_registration",
    params.idempotencyKey,
  );
  const reqHash = requestHash(deps, body);

  // ---- 操作台帳の照合（読み取りのみ、同意検証前にメールを永続化しない） ----
  let operation = await loadOperation(deps, operationHash);
  if (operation) {
    if (
      operation.operationHash !== operationHash ||
      operation.requestHash !== reqHash
    ) {
      await audit(deps, {
        actorType: "service",
        action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
        outcome: "conflict",
        requestId: params.requestId,
        resourceType: "registrationOperation",
        resourceIdHash: operationHash,
      });
      throw ApiError.conflict(
        ErrorCodes.REGISTRATION_CONFLICT,
        "同じ登録キーで異なる内容が送信されました。",
      );
    }
    if (operation.status === "enabled") {
      await assertEnabledOperation(
        deps,
        operation,
        operationHash,
        reqHash,
        params.requestId,
      );
      return {
        registrationStatus: "created",
        nextAction: "sign_in",
        onboardingState: "profile_pending",
      };
    }
  }

  // ---- 必須同意・版検証（Auth作成・操作予約より前） ----
  // 既存操作がある場合は予約時の版セット(legalVersionSet)でピン検証する。
  // 文書版の更新をまたいだ再試行が「版不一致412」で恒久的に詰まないよう、
  // 予約済み版を現行版より優先する（新規必須種別が追加された場合のみ現行を要求）。
  let legalDocs;
  try {
    legalDocs = await getLegalDocuments(deps.db);
  } catch (err) {
    throw new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "同意文書の取得に失敗しました。",
      { retryable: true, cause: err },
    );
  }
  if (!legalDocs) {
    throw new ApiError(500, ErrorCodes.INTERNAL, "同意文書の設定が見つかりません。");
  }
  const validationSet = mergeVersionSet(legalDocs, operation?.legalVersionSet);
  const grants = validateConsentSubmission(validationSet, body.consents);

  const now = deps.clock.now();
  if (!operation || isExpired(operation, now)) {
    operation = await reserveOperation(
      deps,
      operationHash,
      reqHash,
      buildVersionSet(validationSet),
      now,
      // 期限切れ上書き時は既存UIDを引き継ぐ。新UIDではAuth側の
      // email-already-existsに阻まれて登録を復旧できなくなる。
      {
        overwrite: operation !== undefined,
        uid: operation?.uid,
        requestId: params.requestId,
      },
    );
  }

  try {
    // ---- Admin SDK createUser（disabled=true） ----
    if (operation.status === "reserved" || operation.status === "failed") {
      try {
        await deps.authAdmin.createUser({
          uid: operation.uid,
          email: body.email,
          password: body.password,
          emailVerified: false,
          disabled: true,
        });
      } catch (err) {
        if (isAuthError(err, "auth/email-already-exists")) {
          await reconcileEmailConflict(deps, operation, body, params, operationHash);
        } else if (!isAuthError(err, "auth/uid-already-exists")) {
          throw err;
        }
        // uid-already-exists: 前回試行で作成済み（UIDはサーバ生成の乱数）。続行する。
      }
      operation = { ...operation, status: "auth_created" };
      await saveOperation(deps, operation, { status: "auth_created" });
    }

    // ---- Firestore transaction: account + legalConsents + operation ----
    // 操作台帳の状態更新も同一tx内で行う。tx後に失敗すると台帳が
    // auth_created のまま残り、同一キー再試行で同意書が二重発行されるのを防ぐ。
    if (operation.status === "auth_created" || operation.status === "reserved") {
      const commitOutcome = await deps.db.runTransaction(async (tx) => {
        const opRef = registrationOperationRef(deps.db, operationHash);
        const accountRef = deps.db.doc(`accounts/${operation!.uid}`);
        const opSnap = await tx.get(opRef);
        if (!opSnap.exists) return "missing_operation" as const;

        const currentOperation = opSnap.data() as RegistrationOperationDoc;
        if (
          currentOperation.operationHash !== operationHash ||
          currentOperation.requestHash !== reqHash ||
          currentOperation.uid !== operation!.uid
        ) {
          return "operation_mismatch" as const;
        }

        const currentStatus = currentOperation.status;
        const alreadyCommitted =
          currentStatus === "consents_committed" || currentStatus === "enabled";
        if (
          !alreadyCommitted &&
          currentStatus !== "reserved" &&
          currentStatus !== "auth_created" &&
          currentStatus !== "failed"
        ) {
          return "unexpected_status" as const;
        }

        const accountSnap = await tx.get(accountRef);
        if (alreadyCommitted) {
          return isConsistentRegistrationAccount(
            accountSnap.data(),
            operation!.uid,
          )
            ? ("already_committed" as const)
            : ("account_mismatch" as const);
        }
        if (accountSnap.exists) return "account_mismatch" as const;

        const ts = FieldValue.serverTimestamp();
        const account: AccountDoc = {
          uid: operation!.uid,
          accountStatus: "onboarding_pending",
          onboardingState: "profile_pending",
          emailVerified: false,
          providers: ["password"],
          schemaVersion: "1",
          createdAt: ts,
          updatedAt: ts,
        };
        tx.create(accountRef, account as unknown as DocumentData);
        writeConsentDocs(tx, deps, operation!.uid, grants, "email_registration");
        tx.set(
          opRef,
          { status: "consents_committed", updatedAt: ts } as DocumentData,
          { merge: true },
        );
        return "committed" as const;
      });

      if (
        commitOutcome !== "committed" &&
        commitOutcome !== "already_committed"
      ) {
        await audit(deps, {
          actorType: "service",
          action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
          outcome: "conflict",
          requestId: params.requestId,
          resourceType: "registrationOperation",
          resourceIdHash: operationHash,
          details: { reason: commitOutcome },
        });
        throw ApiError.conflict(
          ErrorCodes.REGISTRATION_CONFLICT,
          "登録操作の状態を確認できないため処理を中断しました。サポートへお問い合わせください。",
        );
      }
      operation = { ...operation, status: "consents_committed" };
    }

    // ---- Auth 有効化前のcheckpoint再確認 ----
    if (operation.status === "consents_committed") {
      const checkpoint = await verifyCommittedCheckpoint(
        deps,
        operation,
        operationHash,
        reqHash,
      );
      if (checkpoint === "enabled") {
        operation = { ...operation, status: "enabled" };
      } else if (checkpoint !== "consents_committed") {
        await audit(deps, {
          actorType: "service",
          action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
          outcome: "conflict",
          requestId: params.requestId,
          resourceType: "registrationOperation",
          resourceIdHash: operationHash,
          details: { reason: checkpoint },
        });
        throw ApiError.conflict(
          ErrorCodes.REGISTRATION_CONFLICT,
          "Auth有効化前に登録台帳とaccountの所有状態を確認できません。サポートへお問い合わせください。",
        );
      } else {
        await deps.authAdmin.updateUser(operation.uid, { disabled: false });
        operation = { ...operation, status: "enabled" };
        const saveResult = await saveOperation(deps, operation, {
          status: "enabled",
        });
        if (saveResult !== "enabled") {
          await audit(deps, {
            actorType: "service",
            action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
            outcome: "conflict",
            requestId: params.requestId,
            resourceType: "registrationOperation",
            resourceIdHash: operationHash,
            details: { reason: saveResult },
          });
          throw ApiError.conflict(
            ErrorCodes.REGISTRATION_CONFLICT,
            "Auth有効化後に登録台帳の所有状態を確認できません。サポートへお問い合わせください。",
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    deps.logger.error(
      { err, operationHash: operationHash.slice(0, 16), status: operation.status },
      "registration flow failed",
    );
    await saveOperation(deps, operation, {
      status: "failed",
      lastErrorClass: errorClass(err),
    }).catch(() => undefined);
    await audit(deps, {
      actorType: "service",
      action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
      outcome: "failed",
      requestId: params.requestId,
      resourceType: "registrationOperation",
      resourceIdHash: operationHash,
      details: { errorClass: errorClass(err) },
    });
    throw new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "登録処理が完了しませんでした。時間を置いて再試行してください。",
      { retryable: true },
    );
  }

  await assertEnabledOperation(
    deps,
    operation,
    operationHash,
    reqHash,
    params.requestId,
  );

  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, operation.uid),
    action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
    outcome: "created",
    requestId: params.requestId,
    resourceType: "registrationOperation",
    resourceIdHash: operationHash,
  });

  return {
    registrationStatus: "created",
    nextAction: "sign_in",
    onboardingState: "profile_pending",
  };
}

function isExpired(op: RegistrationOperationDoc, now: Date): boolean {
  // Once Firestore has atomically committed account/consents, expiry must not
  // erase the checkpoint while the same operation is being resumed.
  if (op.status === "consents_committed" || op.status === "enabled") return false;
  const exp = op.expiresAt as { toMillis?: () => number } | undefined;
  const expMs =
    exp && typeof exp.toMillis === "function" ? exp.toMillis() : undefined;
  return op.status === "expired" || (expMs !== undefined && expMs <= now.getTime());
}

/**
 * 既存操作の legalVersionSet を現行文書セットへマージする。
 * 予約時の版を優先しつつ、予約時に存在しなかった新規必須種別は現行版で要求する。
 */
function mergeVersionSet(
  legalDocs: LegalDocumentSet,
  stored: RegistrationOperationDoc["legalVersionSet"] | undefined,
): LegalDocumentSet {
  if (!stored || Object.keys(stored).length === 0) return legalDocs;
  const documents: LegalDocumentSet["documents"] = { ...legalDocs.documents };
  const required = new Set(legalDocs.requiredConsents);
  for (const [type, v] of Object.entries(stored)) {
    const consentType = type as keyof typeof documents;
    documents[consentType] = {
      version: v.version,
      documentHash: v.documentHash,
      publishedAt: "",
    };
    required.add(type as (typeof legalDocs.requiredConsents)[number]);
  }
  return {
    documents,
    requiredConsents: [...required],
    updatedAt: legalDocs.updatedAt,
  };
}

function buildVersionSet(
  legalDocs: LegalDocumentSet,
): RegistrationOperationDoc["legalVersionSet"] {
  const set: RegistrationOperationDoc["legalVersionSet"] = {};
  for (const type of legalDocs.requiredConsents) {
    const doc = legalDocs.documents[type];
    if (doc) {
      set[type] = { version: doc.version, documentHash: doc.documentHash };
    }
  }
  return set;
}

/**
 * email-already-exists の突き合わせ。
 * - 保持者が本操作のUIDなら前回作成済み → 続行
 * - 保持者が別操作の disabled Auth ユーザーなら、account の有無だけで削除せず409
 * - 上記以外は既存メール → 409
 */
async function reconcileEmailConflict(
  deps: Deps,
  operation: RegistrationOperationDoc,
  body: RegisterBody,
  params: { requestId: string },
  operationHash: string,
): Promise<void> {
  const existing = await deps.authAdmin
    .getUserByEmail(body.email)
    .catch(() => undefined);
  if (existing && existing.uid === operation.uid) {
    return;
  }
  await audit(deps, {
    actorType: "service",
    action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
    outcome: "conflict",
    requestId: params.requestId,
    resourceType: "registrationOperation",
    resourceIdHash: operationHash,
  });
  throw ApiError.conflict(
    ErrorCodes.REGISTRATION_CONFLICT,
    "このメールアドレスでは登録できません。",
  );
}

async function reserveOperation(
  deps: Deps,
  operationHash: string,
  reqHash: string,
  legalVersionSet: RegistrationOperationDoc["legalVersionSet"],
  now: Date,
  opts: {
    overwrite?: boolean;
    uid?: string | undefined;
    requestId?: string;
  } = {},
): Promise<RegistrationOperationDoc> {
  // 期限切れ上書き時は既存UIDを再利用して孤児Authとの齟齬を防ぐ
  const uid = opts.uid ?? deps.db.collection("registrationOperations").doc().id;
  const doc: RegistrationOperationDoc = {
    operationHash,
    requestHash: reqHash,
    uid,
    status: "reserved",
    legalVersionSet,
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
    expiresAt: Timestamp.fromMillis(
      now.getTime() + OPERATION_TTL_MS,
    ),
  };
  const ref = registrationOperationRef(deps.db, operationHash);
  if (opts.overwrite) {
    // The earlier read may be stale: another retry can have committed the
    // Firestore checkpoint (or renewed the reservation) since then. Re-read
    // and decide in a transaction so a stale expiry cannot reset its status.
    const outcome = await deps.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "missing" as const };

      const current = snap.data() as RegistrationOperationDoc;
      if (
        current.operationHash !== operationHash ||
        current.requestHash !== reqHash
      ) {
        return { kind: "conflict" as const };
      }
      if (!isExpired(current, now)) {
        return { kind: "existing" as const, operation: current };
      }

      const renewed = { ...doc, uid: current.uid };
      tx.set(ref, renewed as unknown as DocumentData);
      return { kind: "renewed" as const, operation: renewed };
    });

    if (outcome.kind === "missing" || outcome.kind === "conflict") {
      await audit(deps, {
        actorType: "service",
        action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
        outcome: "conflict",
        ...(opts.requestId !== undefined
          ? { requestId: opts.requestId }
          : {}),
        resourceType: "registrationOperation",
        resourceIdHash: operationHash,
      });
      throw ApiError.conflict(
        ErrorCodes.REGISTRATION_CONFLICT,
        "登録操作を安全に再開できません。新しい登録キーでやり直してください。",
      );
    }
    return outcome.operation;
  }

  try {
    await ref.create(doc as unknown as DocumentData);
  } catch (writeErr) {
    // 同時予約の競合: 既存台帳を読み直して処理を再開する。
    // 既存docが無い場合は一過性エラー等の書込失敗なので原因をそのまま投げる
    // （競合でもないのに conflict 監査を残さない）
    const existing = await ref.get();
    if (existing.exists) {
      const data = existing.data() as RegistrationOperationDoc;
      if (data.operationHash === operationHash && data.requestHash === reqHash) {
        return data;
      }
    } else {
      throw writeErr;
    }
    await audit(deps, {
      actorType: "service",
      action: AUDIT_ACTIONS.REGISTRATION_ATTEMPT,
      outcome: "conflict",
      ...(opts.requestId !== undefined
        ? { requestId: opts.requestId }
        : {}),
      resourceType: "registrationOperation",
      resourceIdHash: operationHash,
    });
    throw ApiError.conflict(
      ErrorCodes.REGISTRATION_CONFLICT,
      "同じ登録キーで異なる内容が送信されました。",
    );
  }
  return doc;
}

function writeConsentDocs(
  tx: Transaction,
  deps: Deps,
  uid: string,
  grants: ValidatedGrant[],
  registrationSource: LegalConsentDoc["registrationSource"],
): void {
  for (const grant of grants) {
    const ref = deps.db.collection("legalConsents").doc();
    const consent: LegalConsentDoc = {
      subjectUid: uid,
      consentType: grant.consentType,
      documentVersion: grant.documentVersion,
      documentHash: grant.documentHash,
      decision: grant.decision,
      method: "explicit_checkbox",
      registrationSource,
      occurredAt: FieldValue.serverTimestamp(),
      revokedAt: null,
      schemaVersion: "1",
    };
    tx.create(ref, consent as unknown as DocumentData);
  }
}
