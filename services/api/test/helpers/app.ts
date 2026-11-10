import type { FastifyInstance } from "fastify";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { buildApp } from "../../src/app.js";
import { DEV_LEGAL_DOCUMENTS } from "../../src/domain/legalDocuments.js";
import type { AccountDoc } from "../../src/domain/firestoreDocs.js";
import type { TestDeps } from "./deps.js";

/** 開発用同意文書セットをシードする。 */
export async function seedLegalDocuments(deps: TestDeps): Promise<void> {
  await deps.db.doc("appConfigs/publicLegalVersion").set({
    ...DEV_LEGAL_DOCUMENTS,
    updatedAt: Timestamp.fromDate(deps.clock.now()),
  });
}

export interface SeedAccountOptions {
  accountStatus?: AccountDoc["accountStatus"];
  onboardingState?: AccountDoc["onboardingState"];
  providers?: string[];
}

/** テスト用アカウントを直接書き込む。 */
export async function seedAccount(
  deps: TestDeps,
  uid: string,
  opts: SeedAccountOptions = {},
): Promise<void> {
  const ts = FieldValue.serverTimestamp();
  await deps.db.doc(`accounts/${uid}`).set({
    uid,
    accountStatus: opts.accountStatus ?? "active",
    onboardingState: opts.onboardingState ?? "completed",
    emailVerified: true,
    providers: opts.providers ?? ["password"],
    schemaVersion: "1",
    createdAt: ts,
    updatedAt: ts,
  } satisfies AccountDoc as unknown as Record<string, unknown>);
}

/** 必須3種の同意を現行版で granted として書き込む。 */
export async function seedCurrentConsents(
  deps: TestDeps,
  uid: string,
): Promise<void> {
  for (const type of DEV_LEGAL_DOCUMENTS.requiredConsents) {
    const doc = DEV_LEGAL_DOCUMENTS.documents[type]!;
    await deps.db.collection("legalConsents").doc().set({
      subjectUid: uid,
      consentType: type,
      documentVersion: doc.version,
      documentHash: doc.documentHash,
      decision: "granted",
      method: "explicit_checkbox",
      registrationSource: "email_registration",
      occurredAt: FieldValue.serverTimestamp(),
      revokedAt: null,
      schemaVersion: "1",
    });
  }
}

export function authHeader(uid: string): Record<string, string> {
  return { authorization: `Bearer token-${uid}` };
}

export function buildTestApp(deps: TestDeps): FastifyInstance {
  return buildApp(deps);
}
