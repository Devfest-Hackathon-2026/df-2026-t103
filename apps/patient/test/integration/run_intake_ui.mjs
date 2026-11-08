// Run only inside disposable Firebase emulators. No real project/data access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { initFirebase } from '../../../../services/api/src/firebase.ts';
import { loadConfig } from '../../../../services/api/src/config.ts';
import { DEV_LEGAL_DOCUMENTS } from '../../../../services/api/src/domain/legalDocuments.ts';

assert.equal(process.env.FIREBASE_PROJECT_ID, 'demo-mmr-dev');
assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9099');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8081');
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const firebase = initFirebase(loadConfig());
await firebase.firestore.doc('appConfigs/publicLegalVersion').set(DEV_LEGAL_DOCUMENTS);
const api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: `${root}/services/api`, env: { ...process.env, LOG_LEVEL: 'silent' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Consume logs without publishing tokens, payloads, or patient information.
api.stdout.resume(); api.stderr.resume();
const email = 'synthetic-intake-ui@example.test';
const password = 'local-only-intake-123!';
async function request(path, body, token, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:8080/v1${path}`, {
    method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'Idempotency-Key': 'synthetic-intake-ui-registration' },
    body: JSON.stringify(body), redirect: 'error',
  });
  assert.ok(response.ok, `Fixture API request failed: ${response.status}`);
  return response.json();
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch('http://127.0.0.1:8080/health')).ok; } catch { /* startup */ }
    if (ready) break;
    if (api.exitCode !== null) throw new Error('Local API exited during startup');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Local API must be ready');
  await request('/auth/register', { email, password, locale: 'ja-JP',
    consents: Object.fromEntries(DEV_LEGAL_DOCUMENTS.requiredConsents.map(type =>
      [type, { accepted: true, documentVersion: DEV_LEGAL_DOCUMENTS.documents[type].version }])) });
  const user = await firebase.auth.getUserByEmail(email);
  await firebase.auth.updateUser(user.uid, { emailVerified: true });
  const auth = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  assert.ok(auth.ok);
  const { idToken } = await auth.json();
  await request('/me/profile', { familyName: '合成', givenName: '試験',
    familyNameKana: 'ゴウセイ', givenNameKana: 'シケン', birthDate: '1990-01-01',
    phoneNumber: '09000000000', postalCode: '1000001',
    address: { prefecture: '東京都', city: '合成市', line1: '試験用' } }, idToken, 'PATCH');
  const flutter = spawn(process.env.FLUTTER_BIN || 'flutter', ['test',
    '--dart-define=RUN_INTAKE_UI_INTEGRATION=true', 'test/integration/patient_intake_ui_test.dart'], {
    cwd: `${root}/apps/patient`, env: process.env, stdio: 'inherit',
  });
  assert.equal((await once(flutter, 'exit'))[0], 0, 'Real UI test must pass');
  const docs = await firebase.firestore.collection('intakes').where('patientUid', '==', user.uid).get();
  assert.equal(docs.size, 1, 'UI operation must create exactly one real intake');
  assert.equal(docs.docs[0].data().initialSymptomText, '合成テストの症状入力です');
  assert.equal(docs.docs[0].data().revision, 2);
  assert.equal(docs.docs[0].data().status, 'questioning');
  console.log('Verified real UI → Auth Emulator → Fastify API → Firestore: one intake, revision 2.');
} finally {
  const exited = once(api, 'exit');
  api.kill('SIGTERM');
  await exited;
  await firebase.firestore.terminate();
}
