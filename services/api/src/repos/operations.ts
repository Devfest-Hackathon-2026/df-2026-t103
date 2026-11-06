import type {
  IdempotencyKeyDoc,
  RegistrationOperationDoc,
} from "../domain/firestoreDocs.js";
import { getDoc } from "./helpers.js";
import type { FirestoreLike } from "./helpers.js";

export function registrationOperationRef(db: FirestoreLike, operationHash: string) {
  return db.doc(`registrationOperations/${operationHash}`);
}

export async function getRegistrationOperation(
  db: FirestoreLike,
  operationHash: string,
): Promise<RegistrationOperationDoc | undefined> {
  const r = await getDoc<RegistrationOperationDoc>(
    db,
    `registrationOperations/${operationHash}`,
  );
  return r.data;
}

export function idempotencyKeyRef(db: FirestoreLike, keyHash: string) {
  return db.doc(`idempotencyKeys/${keyHash}`);
}

export async function getIdempotencyKey(
  db: FirestoreLike,
  keyHash: string,
): Promise<IdempotencyKeyDoc | undefined> {
  const r = await getDoc<IdempotencyKeyDoc>(db, `idempotencyKeys/${keyHash}`);
  return r.data;
}
