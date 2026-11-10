// Installs hash-verified, synthetic legal text for the public registration UI.
// Emulator-only; the runner requires every Firebase endpoint to be loopback.
import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (
  !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !process.env.FIREBASE_DATABASE_EMULATOR_HOST ||
  !process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
  !process.env.FIREBASE_PROJECT_ID?.startsWith('demo-')
) {
  throw new Error('Refusing to seed public registration documents outside demo emulators');
}

const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
const documents = Object.fromEntries(
  [
    ['terms_of_service', '合成の利用規約です。'],
    ['privacy_policy_ack', '合成のプライバシー文書です。'],
    ['health_data_collection', '合成の健康情報取扱文書です。'],
    ['hospital_disclosure', '合成デモ施設への情報提供に関する文書です。'],
  ].map(([type, text]) => [
    type,
    {
      version: 'synthetic-e2e-v1',
      documentHash: `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
      publishedAt: '2026-01-01T00:00:00Z',
      text,
    },
  ]),
);

try {
  await getFirestore(app).doc('appConfigs/publicLegalVersion').set({
    requiredConsents: Object.keys(documents).filter((type) => type !== 'hospital_disclosure'),
    documents,
  });
} finally {
  await app.delete();
}
