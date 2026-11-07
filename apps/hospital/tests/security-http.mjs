import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

// Starts the actual production build on a disposable loopback port. No cloud,
// credentials, browsers or patient fixtures are used.
test("production HTTP responses retain CSP, fresh script nonces and no-store", { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "0"], {
    env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
      const read = (chunk) => {
        output += chunk.toString();
        const address = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (address && /Ready in/.test(output)) { clearTimeout(timer); resolve(address); }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
    });
    const marker = "SYNTHETIC_PRIVATE_INPUT_90";
    const nonces = new Set();
    for (const path of ["/", "/", "/not-found.html", "/faviconXico-private"]) {
      const response = await fetch(`${origin}${path}`, { headers: {
        cookie: `session=${marker}`,
        authorization: `Bearer ${marker}`,
        "x-nonce": "attacker",
        "content-security-policy": "script-src 'unsafe-inline'",
      } });
      assert.equal(response.status, path === "/" ? 200 : 404);
      const csp = response.headers.get("content-security-policy");
      const nonce = csp?.match(/'nonce-([^']+)'/)?.[1];
      assert.ok(nonce);
      assert.ok(!nonces.has(nonce), "Nonce must change for every response");
      nonces.add(nonce);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|attacker/);
      assert.match(response.headers.get("cache-control"), /no-store/);
      assert.doesNotMatch(response.headers.get("cache-control"), /s-maxage|public|immutable/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("set-cookie"), null);
      const html = await response.text();
      assert.doesNotMatch(html, new RegExp(`${marker}|attacker`));
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
      assert.ok(scripts.length > 0, "Next.js bootstrap scripts must be present");
      for (const [, attrs] of scripts) assert.ok(attrs.includes(`nonce="${nonce}"`), "Bootstrap script must match CSP");
      if (path === "/") {
        const asset = html.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js)"/)?.[1];
        assert.ok(asset);
        const assetResponse = await fetch(new URL(asset, origin));
        assert.equal(assetResponse.status, 200);
      }
    }
    // Router prefetches and RSC are also covered; no request-header opt-out.
    for (const headers of [{ "next-router-prefetch": "1", purpose: "prefetch" }, { RSC: "1" }]) {
      const response = await fetch(origin, { headers });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control"), /no-store/);
      assert.ok(response.headers.has("content-security-policy"));
      const body = await response.text();
      assert.ok(!body.includes(marker));
    }
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      await closed;
    }
  }
});
