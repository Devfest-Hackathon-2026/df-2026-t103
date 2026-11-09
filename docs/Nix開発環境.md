# もしもし問診 — Nix 開発環境

- 文書ID：MMR-ENV-002 / v1.0 / 2026-11-06
- 対象：Nix flakes を利用できる Linux / macOS 開発者
- 関連：[07_環境構築手順書](07_環境構築手順書.md)、[08_Docker_Makefile運用](08_Docker_Makefile運用.md)、[ADR-0001](adr/0001_ローカル開発基盤の構成.md)

本リポジトリのルート `flake.nix` は、ホスト側で実行する Flutter・Node.js・Docker CLI などの
開発ツールを再現可能な形で提供する。Firebase Emulator、API、病院ポータルは従来どおり
Docker Compose で動かすため、本 flake は Docker デーモンやコンテナを管理しない。

## 1. 対応プラットフォーム

`flake.nix` が `devShells` を公開するシステムは次の 3 つ。

| システム | 対応 | 備考 |
|---|---|---|
| `x86_64-linux` | 対応 | 一般的な Linux、WSL2（Ubuntu 等）を含む |
| `aarch64-linux` | 対応 | ARM64 Linux |
| `aarch64-darwin` | 対応 | Apple Silicon Mac |
| `x86_64-darwin` | **非対応** | この pin の nixpkgs の Flutter が Intel Mac 向けバイナリを提供していないため |
| Windows ネイティブ | 非対応 | WSL2 上の `x86_64-linux` として利用する |

- Intel Mac では本 flake の devShell は使えない。[07_環境構築手順書](07_環境構築手順書.md) §2.4 の
  手動 Flutter 導入（公式アーカイブ等）を使う。
- WSL2 では Docker Desktop の WSL integration を有効にする。
- `aarch64-darwin` でも **iOS のビルドには macOS 上の Xcode と CocoaPods が別途必要**。
  これらは flake に含めない。
- 動作確認は `x86_64-linux` で実施済み。`aarch64-linux` / `aarch64-darwin` は devShell の
  評価まで確認しており、実機でのビルド・実行は各環境で確認が必要。

## 2. 含まれるツール

`flake.lock` の pin 時点（nixpkgs `1d060086d60cb76a40cf37109f979d88a5bd6396`）の構成。

| ツール | バージョン | 用途 |
|---|---|---|
| Flutter（Dart 同梱） | 3.47.4 / Dart 3.13.3 | 患者アプリ |
| Node.js | 22.23.4 | API / Next.js をホストで直接動かす場合。Docker イメージの Node 22 系に合わせる |
| Firebase CLI wrapper | `firebase-tools@15.35.0` | 固定版を `npx` で実行。初回は npm registry から取得 |
| Google Cloud CLI | nixpkgs の固定版 | `gcloud`、ローカル認証と GCP 操作 |
| Docker CLI | 29.9.2 | `docker` コマンド |
| Docker Compose | 5.7.0 | `docker compose` / `docker-compose` |
| GNU Make | 4.4.1 | `Makefile` の実行 |
| Git | 2.56.0 | 取得・バージョン管理 |

- Dart は Flutter に同梱されるため、個別には導入しない。
- `docker-client` には Compose プラグインが含まれる。単体の `docker-compose` も同梱する。
- Firebase CLI wrapper はホストの devShell に含む。Firebase Emulator Suite 自体は従来どおり Docker Compose で動き、Java は通常のホスト devShell に含めない。
- #313 の実ブラウザ統合runner向けに、Linux では追加の `browser-integration` devShell を利用できる（§4.3）。通常の devShell に Java / Python / Firefox / Xvfb は追加しない。
- Android SDK / Android Emulator / Xcode / CocoaPods は含めない（§5）。

実際のバージョンは次で確認できる。

```bash
nix develop --command flutter --version
nix develop --command node --version
nix develop --command firebase --version
nix develop --command gcloud version
nix develop --command docker compose version
nix flake metadata
```

## 3. 前提条件

1. Nix（flakes 有効）を導入済みであること。

   ```bash
   nix --version
   ```

   flakes が無効な場合は `~/.config/nix/nix.conf` などで次を有効にする。

   ```ini
   experimental-features = nix-command flakes
   ```

2. Docker デーモンが起動していること。
   - Linux: Docker Engine を起動する（例：`sudo systemctl start docker`）。
   - NixOS: システム設定で `virtualisation.docker.enable = true;` を有効にし、利用ユーザーを
     `docker` グループに追加する。設定変更後は再ログインする。
   - macOS / Windows: Docker Desktop を起動する。
   - 確認: `docker info`

3. `flake.nix` / `flake.lock` が Git に追跡されていること。
   Nix は Git リポジトリ内では未追跡ファイルを評価しない。クローン済みなら通常は追跡済み。

## 4. 使い方

### 4.1 devShell に入る

```bash
nix develop
```

初回は Flutter などの closure を取得するため時間がかかる。以降は Nix store から再利用される。

shell 内で環境を確認する。

```bash
make doctor
flutter --version
node --version
docker compose version
```

`make doctor` は Docker デーモンの状態も表示する。デーモンが停止している場合は
`make up` の前に起動する。

### Google Cloud の認証

`gcloud` は devShell に含まれ、ホストにグローバルインストールする必要はない。
CLI のログイン（`gcloud auth login`）とアプリケーションデフォルト認証
（`gcloud auth application-default login`）は別物で、必要な場合に利用者が実行する。
どちらもブラウザ認証を伴い、資格情報を通常 `~/.config/gcloud` に保存するため、
devShell を抜けても残る。Git に含めず、共有プロジェクトを操作する前に対象と権限を確認する。
これらの認証コマンドは devShell 起動時に自動実行しない。

Firebase CLI wrapper は `firebase-tools@15.35.0` を明示 pin し、既存CIと同じ `npx` 呼び出しを行う。
初回実行時（npm cache に未取得の場合）は npm registry へのネットワーク接続が必要で、取得物は npm cache に保存され再利用される。
この取得は Nix store の lock/hash による固定ではなく、npm の配布物・依存関係と registry に依存する。
Firebase CLI のログインは必要な場合に利用者が
`firebase login` を手動で実行する。認証は devShell 起動時に行わず、実プロジェクトへの
操作やデプロイの前に対象プロジェクトとコマンドを確認する。

### 4.2 非対話でコマンドを実行する

```bash
nix develop --command flutter --version
nix develop --command node --version
nix develop --command firebase --version
nix develop --command docker compose version
nix develop --command make doctor
```

### 4.3 実ブラウザ統合runner（Linux）

患者アプリの実ブラウザ統合試験（#313）は Java 21、Python 3、Firefox、Xvfb も必要とするため、
これらは通常の devShell に含めず、Linux 限定の別 shell に分離している。

```bash
nix develop .#browser-integration
FIREBASE_BIN=firebase \
  FLUTTER_BIN=flutter FIREFOX_BIN=firefox \
  python3 apps/patient/tool/run_browser_integration.py
```

CI は `FIREBASE_BIN: npx -y firebase-tools@15.35.0` を使い、wrapper も同じ版を実行する。
runner はローカル Firebase Emulator を使用し、実 GCP には接続しない。
試験の隔離・cleanup上の制約は [統合試験手順](../apps/patient/test/integration/README.md) を参照。

### 4.4 開発サーバを起動する

```bash
nix develop
make up
```

`make up` は従来どおり `.env.local` / `.secret.local` を生成し、Docker Compose で
Firebase Emulator 等を起動したうえで、`apps/patient` があればホスト側の Flutter を起動する。
個別の操作は [08_Docker_Makefile運用](08_Docker_Makefile運用.md) を参照。

## 5. プラットフォーム別の制約

### Docker デーモン

本 flake は Docker CLI と Compose のみを提供し、**Docker デーモンは起動・管理しない**。
デーモンの導入と起動は OS 側の責任範囲とする。`make doctor` の `docker daemon` が
`running` になってから `make up` を実行する。

### iOS

iOS のビルド・実行には macOS と Xcode が必要で、CocoaPods も別途導入する。
`aarch64-darwin` の devShell は Flutter 本体とホストツールだけを提供する。
Linux / WSL2 では iOS ビルドはできない。

### Android

Android SDK、Android Studio、エミュレータは含めない。必要な場合は別途導入し、
`ANDROID_HOME` / `ANDROID_SDK_ROOT` を設定する。`flutter doctor` で不足を確認できる。

### Flutter のバージョン更新

Nix store の Flutter は読み取り専用のため、shell 内での `flutter upgrade` や
`flutter channel` による SDK 更新は行わない。バージョンは `flake.lock` の nixpkgs pin で固定する。
更新する場合はリポジトリ側で lock を更新し、検証後にコミットする。

```bash
nix flake update
nix develop --command flutter --version
```

### Linux デスクトップ（任意）

本 devShell は Flutter Web / Android のホストツールを主対象とし、Flutter Linux デスクトップの
ネイティブ依存（GTK、Clang、CMake、Ninja 等）は含めない。必要な場合は利用者側で追加する。

## 6. 再現性

- `flake.nix` は `nixpkgs` を `nixos-unstable` から取得する。
- `flake.lock` が nixpkgs のリビジョンとハッシュを固定する。現在の pin は
  `1d060086d60cb76a40cf37109f979d88a5bd6396`（2026-11-03）。
- Firebase CLI wrapper は `firebase-tools@15.35.0` を固定指定する。CLI本体と依存関係は初回実行時に npm registry から取得し、Nix lock には含まれない。
- `nix develop` は lock に従うため、同じ lock を使う限り同じツール構成になる。
- lock を更新した場合は、Flutter のバージョンと `make doctor` / 主要コマンドを再検証する。

## 7. トラブルシューティング

| 症状 | 対処 |
|---|---|
| `Path 'flake.nix' ... is not tracked by Git` | `flake.nix` / `flake.lock` を Git に追加してから実行する |
| `docker: command not found` | `nix develop` に入っているか確認する。ホスト側の Docker は不要 |
| `Cannot connect to the Docker daemon` | Docker デーモンを起動する。NixOS は `virtualisation.docker.enable` と `docker` グループを確認 |
| `permission denied ... docker.sock` | 利用ユーザーを `docker` グループに追加し、再ログインする |
| `flutter doctor` で Android / Xcode が不足 | 本 flake の対象外。Android SDK / Xcode を別途導入する |
| Flutter のバージョンを変えたい | `flutter upgrade` ではなく `nix flake update` で nixpkgs を更新する |

## 8. 秘密情報の扱い

- flake は `.env.local` / `.secret.local` を読み取らない。秘密値は従来どおり
  [07_環境構築手順書](07_環境構築手順書.md) §4 と [ADR-0002](adr/0002_ローカルのシークレット管理.md) に従って管理する。
- flake や lock に秘密値・実患者データを含めない。
- `nix develop` は flake の pure evaluation を使うため、環境変数を flake 評価に持ち込む必要はない。
