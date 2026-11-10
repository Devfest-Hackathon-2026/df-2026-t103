import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { connectStorageEmulator, getStorage } from "firebase/storage";

type DemoConfig = { projectId?: string; useEmulator?: string; authUrl?: string; firestoreHost?: string; storageHost?: string };

function localEndpoint(value: string | undefined, protocol: boolean): { host: string; port: number } {
  if (!value || !(protocol ? /^http:\/\/localhost:\d+$/ : /^localhost:\d+$/).test(value)) throw new Error("ローカルエミュレータの指定が必要です");
  const url = new URL(protocol ? value : `http://${value}`);
  const port = Number(url.port);
  if (!port || port > 65535) throw new Error("エミュレータのポートが不正です");
  return { host: url.hostname, port };
}

export function validateDemoConfig(config: DemoConfig) {
  if (config.projectId !== "demo-mmr-dev" || config.useEmulator !== "true") throw new Error("demo-mmr-dev のエミュレータのみ利用できます");
  return { auth: localEndpoint(config.authUrl, true), firestore: localEndpoint(config.firestoreHost, false), storage: localEndpoint(config.storageHost, false) };
}

let initializedApp: FirebaseApp | undefined;

// Explicit opt-in only. This module is not used by the demo screen.
export function initializeDemoFirebase() {
  const endpoints = validateDemoConfig({
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    useEmulator: process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATOR,
    authUrl: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_URL,
    firestoreHost: process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST,
    storageHost: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST,
  });
  const name = "hospital-demo";
  if (initializedApp) return initializedApp;
  if (getApps().some((app) => app.name === name)) throw new Error("デモアプリは既に存在します。ページを再読み込みしてください");
  const app = initializeApp({ apiKey: "demo-key", projectId: "demo-mmr-dev", appId: "demo-hospital", storageBucket: "demo-mmr-dev.appspot.com" }, name);
  connectAuthEmulator(getAuth(app), `http://${endpoints.auth.host}:${endpoints.auth.port}`, { disableWarnings: true });
  connectFirestoreEmulator(getFirestore(app), endpoints.firestore.host, endpoints.firestore.port);
  connectStorageEmulator(getStorage(app), endpoints.storage.host, endpoints.storage.port);
  initializedApp = app;
  return app;
}
