.DEFAULT_GOAL := help
.DELETE_ON_ERROR:

# ============================================================================
# もしもし問診 — 開発環境 Makefile
# 使い方: `make up` で全起動 / `make down` で全停止 / `make help` で一覧
# 詳細: docs/07_環境構築手順書.md, docs/08_Docker_Makefile運用.md
# ============================================================================

COMPOSE          := docker compose
RUN_DIR          := .local/run
LOG_DIR          := .local/logs
APP_DIRS         := apps/hospital apps/patient services/api

API_PORT         ?= 8080
HOSPITAL_PORT    ?= 3000
PATIENT_WEB_PORT ?= 5050
EMU_UI_PORT      ?= 4000

# .env.local / .secret.local を Make 変数として読み込む（KEY=value・引用符なし）。
# ファイルが無い場合は `make env` で雛形から生成される。
-include .env.local
-include .secret.local
.EXPORT_ALL_VARIABLES:

PATIENT_DART_DEFINES ?= --dart-define=API_BASE_URL=http://localhost:$(API_PORT)/v1 --dart-define=USE_FIREBASE_EMULATOR=true --dart-define=FIREBASE_PROJECT_ID=demo-mmr-dev

# ---- アプリ実装の有無で起動対象を自動決定 ------------------------------
HAS_API      := $(wildcard services/api/package.json)
HAS_HOSPITAL := $(wildcard apps/hospital/package.json)
HAS_PATIENT  := $(wildcard apps/patient/pubspec.yaml)

COMPOSE_SERVICES := firebase
ifneq ($(HAS_API),)
  COMPOSE_SERVICES += api
endif
ifneq ($(HAS_HOSPITAL),)
  COMPOSE_SERVICES += hospital
endif

.PHONY: help env dirs doctor urls \
        up down restart rebuild ps clean \
        watch-start watch-stop \
        patient-start patient-stop \
        start-firebase start-api start-hospital \
        stop-firebase stop-api stop-hospital stop-patient stop-watch \
        restart-firebase restart-api restart-hospital restart-patient restart-watch \
        logs logs-firebase logs-api logs-hospital logs-patient logs-watch \
        install-templates

##@ 基本

help: ## コマンド一覧を表示
	@echo "もしもし問診 — 開発環境 Makefile"
	@echo ""
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36mmake %-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

env: .env.local .secret.local ## .env.local / .secret.local を雛形から生成
	@echo "env files ready (.env.local / .secret.local)"

.env.local: .env.example
	@cp .env.example .env.local
	@echo "created .env.local from .env.example"

.secret.local: .secret.example
	@cp .secret.example .secret.local
	@echo "created .secret.local from .secret.example — 秘密値を設定してください"

dirs:
	@mkdir -p $(RUN_DIR) $(LOG_DIR) $(APP_DIRS)

doctor: ## 必須ツールの導入状態を確認
	@echo "docker        : $$(docker --version 2>/dev/null || echo 'not found')"
	@echo "compose       : $$(docker compose version 2>/dev/null || echo 'not found')"
	@echo "make          : $$(make --version 2>/dev/null | head -1 || echo 'not found')"
	@echo "flutter       : $$(flutter --version 2>/dev/null | head -1 || echo 'not found (患者アプリのホスト起動に必要)')"
	@echo "node          : $$(node --version 2>/dev/null || echo 'not found (Docker利用時は不要)')"
	@docker info >/dev/null 2>&1 && echo "docker daemon : running" || echo "docker daemon : NOT running — Docker Desktop等を起動してください"

urls: ## 各サービスのURLを表示
	@echo ""
	@echo "  hospital (Next.js)   : http://localhost:$(HOSPITAL_PORT)$(if $(HAS_HOSPITAL),,  [未作成: apps/hospital])"
	@echo "  api                  : http://localhost:$(API_PORT)$(if $(HAS_API),,  [未作成: services/api])"
	@echo "  Firebase Emulator UI : http://localhost:$(EMU_UI_PORT)"
	@echo "  patient (Flutter Web): http://localhost:$(PATIENT_WEB_PORT)$(if $(HAS_PATIENT),,  [未作成: apps/patient])"
	@echo ""

##@ 起動・停止

up: env dirs ## 全サービスを起動（Docker＋フロント＋ファイル監視。未実装アプリは自動スキップ）
	@docker info >/dev/null 2>&1 || { echo "error: Docker daemonが起動していません。Docker Desktop等を起動してください"; exit 1; }
	$(COMPOSE) up -d --build $(COMPOSE_SERVICES)
	@$(MAKE) --no-print-directory watch-start
ifneq ($(HAS_PATIENT),)
	@$(MAKE) --no-print-directory patient-start
else
	@echo "patient: apps/patient が未作成のためスキップ（Flutter実装後に自動で起動対象になります）"
endif
	@$(MAKE) --no-print-directory urls

down: ## 全サービスを停止（コンテナ・ファイル監視・患者アプリ）
	@$(MAKE) --no-print-directory watch-stop
	@$(MAKE) --no-print-directory patient-stop
	$(COMPOSE) down --remove-orphans
	@echo "all stopped"

restart: ## 全サービスを再起動
	@$(MAKE) --no-print-directory down
	@$(MAKE) --no-print-directory up

rebuild: ## Dockerイメージを再ビルドして起動
	$(COMPOSE) build $(COMPOSE_SERVICES)
	$(COMPOSE) up -d $(COMPOSE_SERVICES)

ps: ## 起動中サービスの状態を表示
	@$(COMPOSE) ps
	@for p in watch patient; do \
		if [ -f $(RUN_DIR)/$$p.pid ] && kill -0 "$$(cat $(RUN_DIR)/$$p.pid)" 2>/dev/null; then \
			echo "$$p (host): running (pid $$(cat $(RUN_DIR)/$$p.pid))"; \
		else \
			echo "$$p (host): stopped"; \
		fi; \
	done

clean: down ## 全停止＋開発用ボリューム・実行状態を削除（エミュレータデータも消去）
	$(COMPOSE) down -v --remove-orphans
	rm -rf $(RUN_DIR) $(LOG_DIR)

##@ 個別サービスの起動

start-firebase: env dirs ## Firebaseエミュレータのみ起動
	$(COMPOSE) up -d --build firebase

start-api: env dirs ## APIのみ起動（services/api が必要）
	$(COMPOSE) up -d --build api

start-hospital: env dirs ## 病院ポータルのみ起動（apps/hospital が必要）
	$(COMPOSE) up -d --build hospital

patient-start: dirs ## 患者FlutterアプリをWebサーバとして起動
ifeq ($(HAS_PATIENT),)
	@echo "patient: apps/patient/pubspec.yaml がありません。スキップします"
else
	@if [ -f $(RUN_DIR)/patient.pid ] && kill -0 "$$(cat $(RUN_DIR)/patient.pid)" 2>/dev/null; then \
		echo "patient: already running"; \
	else \
		(cd apps/patient && exec flutter run -d web-server --web-hostname=localhost --web-port=$(PATIENT_WEB_PORT) $(PATIENT_DART_DEFINES)) > $(LOG_DIR)/patient.log 2>&1 & \
		echo $$! > $(RUN_DIR)/patient.pid; \
		echo "patient: starting on http://localhost:$(PATIENT_WEB_PORT) (log: $(LOG_DIR)/patient.log)"; \
	fi
endif

watch-start: dirs ## compose watch（ファイル変更の自動適用）を開始
	@if [ -f $(RUN_DIR)/watch.pid ] && kill -0 "$$(cat $(RUN_DIR)/watch.pid)" 2>/dev/null; then \
		echo "watch: already running (pid $$(cat $(RUN_DIR)/watch.pid))"; \
	else \
		nohup $(COMPOSE) watch > $(LOG_DIR)/compose-watch.log 2>&1 & \
		echo $$! > $(RUN_DIR)/watch.pid; \
		echo "watch: started (log: $(LOG_DIR)/compose-watch.log)"; \
	fi

##@ 個別サービスの停止

stop-firebase: ## Firebaseエミュレータのみ停止
	$(COMPOSE) stop firebase

stop-api: ## APIのみ停止
	$(COMPOSE) stop api

stop-hospital: ## 病院ポータルのみ停止
	$(COMPOSE) stop hospital

stop-patient: patient-stop ## 患者アプリのみ停止（patient-stopの別名）

patient-stop: ## 患者アプリを停止
	@if [ -f $(RUN_DIR)/patient.pid ]; then \
		kill "$$(cat $(RUN_DIR)/patient.pid)" 2>/dev/null || true; \
		rm -f $(RUN_DIR)/patient.pid; \
	fi
	@pkill -f "web-port[= ]$(PATIENT_WEB_PORT)" 2>/dev/null || true
	@pkill -f "frontend_server.*$(CURDIR)" 2>/dev/null || true
	@echo "patient: stopped"

stop-watch: watch-stop ## ファイル監視のみ停止（watch-stopの別名）

watch-stop: ## compose watch を停止
	@if [ -f $(RUN_DIR)/watch.pid ]; then \
		kill "$$(cat $(RUN_DIR)/watch.pid)" 2>/dev/null || true; \
		rm -f $(RUN_DIR)/watch.pid; \
	fi
	@pkill -f "docker compose watch" 2>/dev/null || true
	@echo "watch: stopped"

##@ 個別サービスの再起動

restart-firebase: ## Firebaseエミュレータを再起動
	$(COMPOSE) restart firebase

restart-api: ## APIを再起動
	$(COMPOSE) restart api

restart-hospital: ## 病院ポータルを再起動
	$(COMPOSE) restart hospital

restart-patient: patient-stop patient-start ## 患者アプリを再起動

restart-watch: watch-stop watch-start ## ファイル監視を再起動

##@ ログ

logs: ## 全Dockerサービスのログを表示（Ctrl+Cで終了）
	$(COMPOSE) logs -f $(COMPOSE_SERVICES)

logs-firebase: ## Firebaseエミュレータのログを表示
	$(COMPOSE) logs -f firebase

logs-api: ## APIのログを表示
	$(COMPOSE) logs -f api

logs-hospital: ## 病院ポータルのログを表示
	$(COMPOSE) logs -f hospital

logs-patient: ## 患者アプリのログを表示
	tail -f $(LOG_DIR)/patient.log

logs-watch: ## ファイル監視のログを表示
	tail -f $(LOG_DIR)/compose-watch.log

##@ その他

install-templates: ## .github/template/ をGitHubの正式パスへコピー（PR/Issueテンプレ有効化）
	@mkdir -p .github/ISSUE_TEMPLATE
	@cp .github/template/pull_request_template.md .github/PULL_REQUEST_TEMPLATE.md
	@cp .github/template/bug_report.md .github/ISSUE_TEMPLATE/bug_report.md
	@cp .github/template/feature_request.md .github/ISSUE_TEMPLATE/feature_request.md
	@echo "installed: .github/PULL_REQUEST_TEMPLATE.md, .github/ISSUE_TEMPLATE/"
