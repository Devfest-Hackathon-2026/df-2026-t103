import { initializeApp, getApp, getApps, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";
import { getDatabase, type Database } from "firebase-admin/database";
import { getAppCheck, type AppCheck } from "firebase-admin/app-check";
import type { AppConfig } from "./config.js";

export interface FirebaseHandles {
  app: App;
  auth: Auth;
  firestore: Firestore;
  storage: Storage;
  database: Database;
  appCheck: AppCheck;
}

let cached: FirebaseHandles | undefined;

/** Admin SDK を初期化してハンドルを返す。エミュレータ接続は環境変数に従う。 */
export function initFirebase(config: AppConfig): FirebaseHandles {
  if (cached) return cached;

  const app = getApps().length
    ? getApp()
    : initializeApp({
        projectId: config.projectId,
        storageBucket: config.storageBucket,
        databaseURL:
          config.databaseUrl ??
          `https://${config.projectId}-default-rtdb.firebaseio.com`,
      });

  cached = {
    app,
    auth: getAuth(app),
    firestore: getFirestore(app),
    storage: getStorage(app),
    database: getDatabase(app),
    appCheck: getAppCheck(app),
  };
  return cached;
}

/** テスト用: キャッシュをリセットする。 */
export function resetFirebaseForTest(): void {
  cached = undefined;
}
