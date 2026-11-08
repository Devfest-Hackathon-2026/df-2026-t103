import assert from 'node:assert/strict';

// Runs against a built server/container with no credentials or patient fixtures.
const origin = process.argv[2];
assert.ok(origin, 'Pass the disposable server origin');
const nonces = new Set();
for (let attempt = 0; attempt < 2; attempt++) {
  const response = await fetch(`${origin}/login`, {headers: {'x-nonce': 'attacker'}});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const csp = response.headers.get('content-security-policy');
  const nonce = csp?.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce && nonce !== 'attacker' && !nonces.has(nonce));
  nonces.add(nonce);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.ok(scripts.length > 0);
  for (const [, attrs] of scripts) assert.ok(attrs.includes(`nonce="${nonce}"`));
  const asset = html.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js)"/)?.[1];
  assert.ok(asset, 'The packaged server must include static assets');
  assert.equal((await fetch(new URL(asset, origin))).status, 200);
}
const protectedPage = await fetch(`${origin}/facilities`, {redirect: 'manual'});
assert.equal(protectedPage.status, 307);
assert.equal(new URL(protectedPage.headers.get('location'), origin).pathname, '/login');
assert.match(protectedPage.headers.get('cache-control'), /no-store/);
console.log('Packaged hospital server: login, assets, nonce CSP, no-store and auth redirect passed');
