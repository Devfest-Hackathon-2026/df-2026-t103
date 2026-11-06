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
import type { Transaction } from "../repos/helpers.js";

export interface RegisterResult {
  registrationStatus: "created";
  nextAction: "sign_in";
  onboardingState: "profile_pending";
}

const OPERATION_TTL_MS = 24 * 3600_000;

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
  operationHash: string,
  patch: Partial<RegistrationOperationDoc>,
): Promise<void> {
  await registrationOperationRef(deps.db, operationHash).set(
    {
      ...patch,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
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
    if (operation.requestHash !== reqHash) {
      await audit(deps, {
        actorType: "service",
        action: "REGISTRATION_ATTEMPT",
        outcome: "conflict",
        requestId: params.requestId,
        resourceType: "registrationOperation",
        resourceIdHash: operationHash.slice(0, 32),
      });
      throw ApiError.conflict(
        ErrorCodes.REGISTRATION_CONFLICT,
        "同じ登録キーで異なる内容が送信されました。",
      );
    }
    if (operation.status === "enabled") {
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
  const legalDocs = await getLegalDocuments(deps.db);
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
      { overwrite: operation !== undefined, uid: operation?.uid },
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
      await saveOperation(deps, operationHash, { status: "auth_created" });
    }

    // ---- Firestore transaction: account + legalConsents + operation ----
    // 操作台帳の状態更新も同一tx内で行う。tx後に失敗すると台帳が
    // auth_created のまま残り、同一キー再試行で同意書が二重発行されるのを防ぐ。
    if (operation.status === "auth_created" || operation.status === "reserved") {
      await deps.db.runTransaction(async (tx) => {
        const opRef = registrationOperationRef(deps.db, operationHash);
        const accountRef = deps.db.doc(`accounts/${operation!.uid}`);
        const [opSnap, accountSnap] = await Promise.all([
          tx.get(opRef),
          tx.get(accountRef),
        ]);
        const committedStatus = (
          opSnap.data() as RegistrationOperationDoc | undefined
        )?.status;
        if (
          committedStatus === "consents_committed" ||
          committedStatus === "enabled"
        ) {
          return;
        }
        const ts = FieldValue.serverTimestamp();
        if (!accountSnap.exists) {
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
          tx.create(
            accountRef,
            account as unknown as DocumentData,
          );
        }
        writeConsentDocs(tx, deps, operation!.uid, grants, "email_registration");
        tx.set(
          opRef,
          { status: "consents_committed", updatedAt: ts } as DocumentData,
          { merge: true },
        );
      });
      operation = { ...operation, status: "consents_committed" };
    }

    // ---- Auth 有効化 ----
    if (operation.status === "consents_committed") {
      await deps.authAdmin.updateUser(operation.uid, { disabled: false });
      operation = { ...operation, status: "enabled" };
      await saveOperation(deps, operationHash, { status: "enabled" });
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    deps.logger.error(
      { err, operationHash: operationHash.slice(0, 16), status: operation.status },
      "registration flow failed",
    );
    await saveOperation(deps, operationHash, {
      status: "failed",
      lastErrorClass: errorClass(err),
    }).catch(() => undefined);
    await audit(deps, {
      actorType: "service",
      action: "REGISTRATION_ATTEMPT",
      outcome: "failed",
      requestId: params.requestId,
      resourceType: "registrationOperation",
      resourceIdHash: operationHash.slice(0, 32),
      details: { errorClass: errorClass(err) },
    });
    throw new ApiError(
      503,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      "登録処理が完了しませんでした。時間を置いて再試行してください。",
      { retryable: true },
    );
  }

  await audit(deps, {
    actorType: "patient",
    actorUidHash: auditUidHash(deps, operation.uid),
    action: "REGISTRATION_ATTEMPT",
    outcome: "created",
    requestId: params.requestId,
    resourceType: "registrationOperation",
    resourceIdHash: operationHash.slice(0, 32),
  });

  return {
    registrationStatus: "created",
    nextAction: "sign_in",
    onboardingState: "profile_pending",
  };
}

function isExpired(op: RegistrationOperationDoc, now: Date): boolean {
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
 * - 保持者が「disabled かつ account 未作成」の孤児（失敗した過去登録の残骸）
 *   なら削除して createUser を再試行 → 版更新等で残された登録を回復
 * - 上記以外は実ユーザーのメール → 409
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
  if (existing?.disabled) {
    const accountSnap = await deps.db.doc(`accounts/${existing.uid}`).get();
    if (!accountSnap.exists) {
      // 登録未完了の孤児Authユーザーを回収し、本操作のUIDで作成し直す
      await deps.authAdmin.deleteUser(existing.uid);
      await deps.authAdmin.createUser({
        uid: operation.uid,
        email: body.email,
        password: body.password,
        emailVerified: false,
        disabled: true,
      });
      await audit(deps, {
        actorType: "service",
        action: "REGISTRATION_ATTEMPT",
        outcome: "recovered",
        requestId: params.requestId,
        resourceType: "registrationOperation",
        resourceIdHash: operationHash.slice(0, 32),
      });
      return;
    }
  }
  await audit(deps, {
    actorType: "service",
    action: "REGISTRATION_ATTEMPT",
    outcome: "conflict",
    requestId: params.requestId,
    resourceType: "registrationOperation",
    resourceIdHash: operationHash.slice(0, 32),
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
  opts: { overwrite?: boolean; uid?: string | undefined } = {},
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
  try {
    if (opts.overwrite) {
      await ref.set(doc as unknown as DocumentData);
    } else {
      await ref.create(doc as unknown as DocumentData);
    }
  } catch {
    // 同時予約の競合: 既存台帳を読み直して処理を再開する。
    const existing = await ref.get();
    if (existing.exists) {
      const data = existing.data() as RegistrationOperationDoc;
      if (data.requestHash === reqHash) return data;
    }
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
