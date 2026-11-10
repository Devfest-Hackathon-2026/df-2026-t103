import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

/** firebase/ ディレクトリ（rules 本体の所在）。 */
const FIREBASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** エミュレータ固定プロジェクト（実プロジェクトへ接続しないための demo- プレフィックス）。 */
export const PROJECT_ID = "demo-mmr-dev";

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/**
 * 環境変数からエミュレータ接続先を取り出す。
 * 未設定・形式不正・ループバック以外は例外（実サービスへの暗黙接続を防ぐ）。
 */
function emulatorHostAndPort(envVar: string): { host: string; port: number } {
  const raw = process.env[envVar];
  if (!raw) {
    throw new Error(
      `${envVar} が未設定です。docker compose のエミュレータ向けに設定するか、` +
        `firebase emulators:exec 経由で実行してください（compose 既定: ` +
        `firestore=localhost:8081 database=localhost:9000 storage=localhost:9199）。`,
    );
  }
  const withoutScheme = raw.replace(/^https?:\/\//, "");
  const sep = withoutScheme.lastIndexOf(":");
  const host = sep === -1 ? withoutScheme : withoutScheme.slice(0, sep);
  const port = Number(withoutScheme.slice(sep + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${envVar} の形式が不正です: ${raw}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${envVar} はループバック接続のみ許可します: ${raw}`);
  }
  // 0.0.0.0 は bind アドレスであり接続先にはならないため正規化する
  return { host: host === "0.0.0.0" ? "127.0.0.1" : host, port };
}

function readRules(fileName: string): string {
  return readFileSync(join(FIREBASE_DIR, fileName), "utf8");
}

/**
 * チェックイン済みの rules 本体をエミュレータへロードしたテスト環境を作る。
 * firebase.json 経由ではなくファイル内容を直接渡すため、常に現行ファイルが対象になる。
 *
 * 注意: テストは deny-all ルールのため実データを一切シードしない（開発者の
 * compose エミュレータ内データを汚染しない設計）。
 */
export async function makeRulesTestEnv(): Promise<RulesTestEnvironment> {
  const firestore = emulatorHostAndPort("FIRESTORE_EMULATOR_HOST");
  const database = emulatorHostAndPort("FIREBASE_DATABASE_EMULATOR_HOST");
  const storage = emulatorHostAndPort("FIREBASE_STORAGE_EMULATOR_HOST");
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host: firestore.host,
      port: firestore.port,
      rules: readRules("firestore.rules"),
    },
    database: {
      host: database.host,
      port: database.port,
      rules: readRules("database.rules.json"),
    },
    storage: {
      host: storage.host,
      port: storage.port,
      rules: readRules("storage.rules"),
    },
  });
}
