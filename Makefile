SHELL := /bin/sh
.DEFAULT_GOAL := help

NPM ?= npm
HOST ?= 127.0.0.1
PORT ?= 3001
DOCKER ?= docker
PROJECT ?=
RENDER_OUTPUT ?= output/signal40.mp4
COUNT ?= 20

.PHONY: help install setup dev start worker source-worker render-worker scheduler \
	format format-check lint typecheck openapi-lint openapi-breaking test test-evaluation test-render check verify audit build \
	db-generate db-migrations-verify db-migrate contracts-rehash \
	project-migrate render media-qc voice-local ingest-weixin ingest-real walk check-storage \
	drill-restore docker-build docker-up docker-down guard-%

help: ## 显示可用目标和参数
	@awk 'BEGIN {FS = ":.*## "; print "Signal 40\n\n用法: make <目标> [变量=值]\n\n目标:"} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## 使用 lockfile 安装依赖
	$(NPM) ci

setup: install db-migrate ## 安装依赖并迁移 PostgreSQL

dev: db-migrate ## 迁移 PostgreSQL 后启动开发服务器（HOST、PORT 可覆盖）
	$(NPM) run dev -- --hostname $(HOST) --port $(PORT)

start: ## 启动已构建的 Node 控制面（HOST、PORT 可覆盖）
	$(NPM) run start -- --hostname $(HOST) --port $(PORT)

worker: ## 兼容模式：启动可领取全部作业的 Worker
	$(NPM) run worker

source-worker: ## 启动只领取 RSS/JSON 采集作业的来源 Worker
	$(NPM) run worker:source

render-worker: ## 启动只领取配音、渲染和发布作业的媒体 Worker
	$(NPM) run worker:render

scheduler: ## 启动自动化调度器
	$(NPM) run scheduler

format: ## 格式化源码
	$(NPM) run format

format-check: ## 检查源码格式但不修改文件
	$(NPM) run format -- --check

lint: ## 运行静态检查
	$(NPM) run lint

openapi-lint: ## 使用 Redocly 校验 OpenAPI 3.1 契约
	$(NPM) run openapi:lint

openapi-breaking: guard-BASELINE ## 对比已发布 OpenAPI 基线（BASELINE=<openapi.yaml>）
	$(NPM) run openapi:breaking -- --baseline "$(BASELINE)"

typecheck: ## 运行 TypeScript 类型检查
	$(NPM) exec tsc -- --noEmit

test: ## 运行单元测试
	$(NPM) test

test-evaluation: ## 运行财经场景合约回归
	$(NPM) run test:evaluation

test-render: ## 运行真实渲染冒烟测试
	$(NPM) run test:render

check: lint typecheck openapi-lint test test-evaluation build ## 运行日常提交前检查

verify: check test-render drill-restore audit ## 运行完整本地发布验证

audit: ## 审计生产依赖漏洞
	$(NPM) audit --omit=dev

build: ## 构建生产产物
	$(NPM) run build

db-generate: ## 根据 schema 生成 Drizzle 迁移
	$(NPM) run db:generate

db-migrations-verify: ## 验证已登记迁移的不可变 checksum
	$(NPM) run db:migrations:verify

db-migrate: db-migrations-verify ## 验证并将迁移应用到 DATABASE_URL 指向的 PostgreSQL
	$(NPM) run db:migrate

contracts-rehash: ## 升级 PostgreSQL 中的旧合约指纹
	$(NPM) run contracts:rehash-local

project-migrate: guard-INPUT guard-OUTPUT ## 迁移项目协议（INPUT=<v1.json> OUTPUT=<v2.json>）
	$(NPM) run project:migrate -- "$(INPUT)" "$(OUTPUT)"

render: guard-PROJECT ## 渲染视频（PROJECT=<project.json> [RENDER_OUTPUT=<video.mp4>]）
	$(NPM) run render -- "$(PROJECT)" "$(RENDER_OUTPUT)"

media-qc: guard-PROJECT guard-VIDEO ## 检查成片（VIDEO=<video.mp4> PROJECT=<project.json>）
	$(NPM) run qc:media -- "$(VIDEO)" "$(PROJECT)"

voice-local: guard-PROJECT guard-AUDIO guard-OUTPUT_PROJECT ## 生成本地配音（PROJECT=... AUDIO=... OUTPUT_PROJECT=...）
	$(NPM) run voice:local -- "$(PROJECT)" "$(AUDIO)" "$(OUTPUT_PROJECT)"

ingest-weixin: guard-QUERY ## 通过 OpenCLI 采集微信来源（QUERY=<关键词> [COUNT=20]）
	$(NPM) run ingest:weixin -- "$(QUERY)" "$(COUNT)"

ingest-real: ## 从已配置的真实来源采集
	$(NPM) run ingest:real

walk: guard-PROJECT ## 推进项目工作流（PROJECT=<项目 ID> [STATE=<目标状态>]）
	$(NPM) run walk -- "$(PROJECT)" $(if $(STATE),"$(STATE)",)

check-storage: ## 验证 S3 兼容对象存储配置和读写
	$(NPM) run check:storage

drill-restore: ## 在隔离目录运行备份恢复演练
	$(NPM) run drill:restore

docker-build: ## 构建控制面、Worker 和调度器镜像
	$(DOCKER) compose build

docker-up: ## 启动 PostgreSQL、控制面、Worker 和调度器
	$(DOCKER) compose up -d

docker-down: ## 停止 Docker Compose 服务（保留 PostgreSQL volume）
	$(DOCKER) compose down

guard-%:
	@if [ -z "$($*)" ]; then \
		echo "错误：必须设置 $*=<值>" >&2; \
		exit 2; \
	fi
