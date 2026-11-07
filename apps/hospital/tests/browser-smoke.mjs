import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Optional real-browser extension of test:api. Uses the real UI + SDK + BE;
// no page routes, API responses, or Firebase services are intercepted.
export async function browserSmoke({ apiBaseUrl, authHost, email, password, facilityId, rejectedFacilityId, assertStillPending, assertStillReceiving }) {
  const profile = await mkdtemp(join(tmpdir(), "hospital-browser-"));
  const origin = "http://127.0.0.1:33090";
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "33090"], {
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "development", NEXT_PUBLIC_USE_FIREBASE_EMULATOR: "true", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo-mmr-dev", NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL: `http://${authHost}`, NEXT_PUBLIC_API_BASE_URL: apiBaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let chrome;
  let socket;
  try {
    await ready(next, (text) => text.includes("Ready in"));
    chrome = spawn(process.env.HOSPITAL_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
    const output = await ready(chrome, (text) => /DevTools listening on (ws:\/\/[^\s]+)/.test(text));
    const endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1];
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    const pending = new Map();
    let sequence = 0;
    socket.addEventListener("message", (event) => {
      const result = JSON.parse(event.data);
      const callback = pending.get(result.id);
      if (callback) { pending.delete(result.id); callback(result); }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 15000);
      pending.set(id, (result) => { clearTimeout(timer); if (result.error) reject(new Error(`Browser command failed: ${method}`)); else resolve(result.result); });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      assert.ok(!result.exceptionDetails, "Browser evaluation must succeed");
      return result.result.value;
    };
    const poll = async (expression) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const alert = await evaluate("document.querySelector('[role=alert]')?.textContent || ''");
      throw new Error(`Browser UI did not reach expected state: ${alert}`);
    };
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.cspViolations=[]; document.addEventListener('securitypolicyviolation', e => window.cspViolations.push(e.effectiveDirective));" }, sessionId);
    await send("Page.navigate", { url: `${origin}/operator` }, sessionId);
    await poll("!!document.querySelector('input[name=email]') && !!document.querySelector('button:not(:disabled)')");
    await evaluate(`document.querySelector('[name=email]').value=${JSON.stringify(email)}; document.querySelector('[name=password]').value=${JSON.stringify(password)}; document.querySelector('form').requestSubmit();`);
    await poll("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('一覧を取得'))");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('一覧を取得')).click()");
    await poll("!!document.querySelector('tbody tr')");
    const body = await evaluate("document.body.innerText");
    assert.ok(body.includes("engine_unavailable"));
    assert.ok(!body.includes("SYNTHETIC_PRIVATE_VALUE"));
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='監査一覧を取得・再試行').click()");
    await poll("!!document.querySelector('[data-audit-summary] tbody tr')");
    const auditBody = await evaluate("document.querySelector('[data-audit-summary]').innerText");
    assert.ok(auditBody.includes("職員権限・状態変更"));
    assert.ok(!auditBody.includes("SYNTHETIC_AUDIT_PRIVATE_VALUE"));
    const selectReview = async (id) => {
      await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='施設一覧を取得・再試行').click()");
      await poll("!!document.querySelector('[data-review-facilities]')");
      await evaluate(`[...document.querySelectorAll('[data-review-facilities] button')].find(b=>b.textContent===${JSON.stringify(`施設 ${id} の審査・証跡`)}).click()`);
      await poll("!!document.querySelector('[data-facility-review-form]')");
    };
    await selectReview(facilityId);
    await evaluate("document.querySelectorAll('[data-facility-review-form] input[type=checkbox]').forEach(i=>i.checked=true); document.querySelector('[name=verificationRecordId]').value='SYNTHETIC_REFERENCE'; document.querySelector('[data-facility-review-form]').requestSubmit()");
    await poll("!!document.querySelector('[data-review-confirmation]')");
    await assertStillPending();
    await evaluate("document.querySelector('[data-review-confirmation] button').click()");
    await poll("[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('承認を確認しました'))");
    await selectReview(rejectedFacilityId);
    await evaluate("const select=document.querySelector('[data-facility-review-form] select'); select.value='rejected'; select.dispatchEvent(new Event('change',{bubbles:true}));");
    await poll("!!document.querySelector('[name=reason]')");
    await evaluate("document.querySelector('[name=verificationRecordId]').value='SYNTHETIC_REFERENCE'; document.querySelector('[name=reason]').value='SYNTHETIC_REVIEW_PRIVATE_VALUE'; document.querySelector('[data-facility-review-form]').requestSubmit()");
    await poll("!!document.querySelector('[data-review-confirmation]')");
    await evaluate("document.querySelector('[data-review-confirmation] button').click()");
    await poll("[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('却下を確認しました'))");
    await evaluate(`document.querySelector('[name=facilityId]').value=${JSON.stringify(facilityId)}; document.querySelector('[name=reason]').value='Synthetic emergency drill'; document.querySelector('[name=facilityId]').form.requestSubmit();`);
    await poll("[...document.querySelectorAll('button')].some(b=>b.textContent==='この施設の受信を停止する')");
    await assertStillReceiving();
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='この施設の受信を停止する').click()");
    await poll("[...document.querySelectorAll('[role=status]')].some(e=>e.textContent.includes('受信停止を確認しました'))");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('ログアウト')).click()");
    await poll("!!document.querySelector('input[name=email]') && !document.querySelector('tbody') && !document.querySelector('[data-audit-summary]')");
    assert.deepEqual(await evaluate("window.cspViolations"), [], "Real UI/Auth/BE workflow must not violate CSP");
    const loginHtml = await (await fetch(`${origin}/login`)).text();
    assert.match(loginHtml, /<form[^>]*method="post"/);
    assert.match(loginHtml, /<button[^>]*type="submit"[^>]*disabled=""/);
    await send("Page.navigate", { url: `${origin}/login` }, sessionId);
    await poll("!!document.querySelector('#hx-login-email') && !!document.querySelector('button[type=submit]:not(:disabled)')");
    assert.equal(await evaluate("document.querySelector('form').method"), "post");
    assert.equal(await evaluate("location.search"), "");
  } finally {
    socket?.close();
    for (const process of [chrome, next]) {
      if (process && process.exitCode === null) { const exited = once(process, "exit"); process.kill("SIGTERM"); await exited; }
    }
    await rm(profile, { recursive: true, force: true });
  }
}

function ready(process, condition) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Browser test process startup timed out")), 15000);
    process.once("error", (error) => { clearTimeout(timer); reject(error); });
    process.once("exit", () => { clearTimeout(timer); reject(new Error("Browser test process exited before startup")); });
    const read = (chunk) => { output += String(chunk); if (condition(output)) { clearTimeout(timer); resolve(output); } };
    process.stdout.on("data", read);
    process.stderr.on("data", read);
  });
}
