# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- （暂无）

## [3.3.0] - 2026-07-04

### Added
- **OpenAI Codex 接入：Responses API ↔ Anthropic Messages 双向转换**
  - 新增端点 `POST /v1/responses`，供 Codex 桌面端/CLI（`wire_api="responses"`，2026 年唯一支持的协议）接入；现有 `/v1/messages`（Claude Code）链路零改动、零回归
  - 新增三个零依赖 adapter：
    - `responses-protocol.mjs`：SSE 解析/序列化、envelope、sequence 计数
    - `responses-request-adapter.mjs`：Responses→Anthropic 请求转换（input/tools/tool_choice/system）
    - `responses-response-adapter.mjs`：Anthropic→Responses 响应转换，含流式 SSE 状态机（text/tool_use/thinking）
  - `tryWithFailover` 加可选 `upstreamPath` 参数：Responses 入口把客户端 `/v1/responses` 与上游 `/v1/messages` 解耦；`/v1/messages` 调用方不传该参数，行为完全不变
  - 转换覆盖：`input`(message/function_call/function_call_output)↔messages、`tools`↔`input_schema`、`tool_choice` 三态、流式 SSE 事件状态机、`usage` 提取(含 cache_*)；连续同 role 内容自动合并（满足 Anthropic 交替约束 + 并行 tool_use 语义）
  - 复用全部核心机制：Family 路由 / failover / 熔断 / 用量统计 / Provider 配置零改动；Codex 的 `model` 直接配 family 名（opus/sonnet/haiku）
  - 流式用 `StringDecoder` 处理跨 TCP chunk 的多字节边界，避免中文 UTF-8 被拆成替换符
  - 阶段性丢弃：`reasoning`/`previous_response_id`/`text.format`/`parallel_tool_calls`（reasoning↔thinking 映射留待后续按 per-family capabilities 开关）
  - 配套测试 23 个（request/response adapter 单元 + failover/流式/工具调用集成），总测试 88→111 全绿
  - 真机验证：`/v1/responses` 走 DeepSeek Flash，非流式 + 流式 + reasoning + 中文全链路正常
- **Codex 侧配置**：`~/.codex/config.toml` 加 `[model_providers.<id>]`，`base_url=http://127.0.0.1:4000/v1`、`wire_api="responses"`、`env_key` 指向网关 sharedToken

## [3.2.0] - 2026-06-27

### Added
- 版本管理规范和 CHANGELOG 文档
- **多候选 failover + 熔断器**（commit `1991bec`）
  - 每个 family 可绑定多个候选四元组（provider+baseUrl+key+model），按 `strategy` 调度：`failover`（主备）/ `round_robin`（轮转）
  - 新增 `circuit-breaker.mjs`：标准三态机（CLOSED→OPEN→HALF_OPEN→CLOSED），模块级单例、被动统计（无主动探测/定时器，不耗额度）；全局默认 `failureThreshold=5` / `coolDownMs=60s` / `successThreshold=1`，per-family 可覆盖
  - failover 触发集：fetch throw / ≥500 / 429 / 401·402·403（400/404 等请求格式类不切）；全部候选失败时透传最后候选的真实状态码（非伪造 502）
  - `config.mjs` schema：`modelFamilies[family]` 升级为 `{ candidates, strategy, circuitBreaker }`，旧单四元组形态自动兼容（零迁移）
  - admin 新端点 `PUT /admin/families/:family/candidates`；CLI 按键 5 改为候选列表编辑器（追加/删除/置顶/切策略）
  - 配套测试：circuit-breaker / failover / compat（向后兼容）/ cli-display
- **用量统计**（commit `8fee3bf`）
  - 新增 `usage-store.mjs`：按天追加写 `data/usage-YYYYMMDD.jsonl`（天然原子、保留 30 天、每 6h 惰性清理）
  - 每个请求完成时 `recordUsage`（in/out/cacheR/cacheW/status/ms 等），失败只告警、不影响主请求
  - `aggregateUsage(range)`：支持 today / 7d / 30d，返回时间桶 + byFamily + byProvider + totals + peak
  - admin API `/admin/usage/:range`；CLI 按键 `u` 进用量视图（纯 Unicode sparkline，可切时间范围）
  - 配套测试：usage / footer-status

## [3.1.0] - 2026-06-17

### Added
- **CLI 方向键高亮选择器** - 所有选项界面支持 ↑↓←→ 移动选中、回车确认
  - 新增 `cli-select.mjs` 选择器原语（零依赖，原生 readline + ANSI）
  - 主界面命令面板接入 grid 二维导航（数字快捷键 + 方向键）
  - 支持输入流程中途取消（q/Esc/Ctrl-C），统一 `CancelledError`
  - 新增 `askCancelable` 多步输入流程
  - 集成测试 47 个用例全部通过（`test/cli-select.test.mjs`）
  - **回滚机制**：环境变量 `LLM_CLI_NO_KEYSELECT=1` 可一键回滚到纯 ask 模式

### Changed
- README 同步方向键选择器交互方式、操作说明、回滚说明

### Fixed
- GPT review 两轮修复（fallback 契约 / 日志死锁 / 取消 footer）

## [3.0.2] - 2026-06-16

### Added
- **演示模式** - CLI 默认隐藏真实上游型号，只显示用户设定的显示名
  - Model 选择三处（切换/修改/删除）改为仅显示 `m.name`
  - 主界面靠数据层兜底（每个 model 都有显示名时不暴露真实型号）
  - 恢复方式：`grep "演示模式" cli.mjs` 三处统一取消注释

## [3.0.1] - 2026-06-15

### Fixed
- **端口热切换死锁**（阻断级）
  - `gateway-runtime.mjs` 新增 `trackedSockets` + `destroyTrackedSockets(excludeSocket)`
  - `restartOnPort` 切换时跳过当前请求 socket，避免自己把自己 kill 掉
  - 外部调用 3ms、自占 socket 18ms 完成（旧版死锁 5min+）
  - `api()` 加 30s AbortController 超时

- **上游日志抢屏 CLI**（体验阻断）
  - 6 处 `console.warn/error` 改走 `logRaw`（server.mjs ×4、admin.mjs ×1、config.mjs ×1）
  - `route-utils.mjs` 新增 `errorBus` + `getLastUpstreamError`
  - CLI statusLine 优先显示"上游异常 > 上次操作 > 就绪"

- **终态 429 body 透传**（正确性 bug）
  - 删除 `await response.arrayBuffer()`，避免"ReadableStream is locked"
  - 终态 429 短路，避免覆盖 fetchWithRetry 已记的 rate-limited

- **并发端口切换锁**
  - `preparePortSwitch` 加 `inflightSwitch`，并发返回 409
  - 锁前移到第一个 await 之前占 sentinel

- **Windows 保留端口回环探测**（V5.3）
  - 6666 等保留端口 TCP connect 成功但 HTTP 失败（OS 不把流量交给 server）
  - 新增 `loopbackProbePort(host, port)`，HTTP `/health` 回环探测
  - listen 失败则 close candidate + 释放锁 + 抛错，旧端口继续服务

- **测试隔离加固**
  - admin-tx 测试的 saveConfig spy 改为纯内存（不再覆盖生产 `data/gateway.json`）

### Changed
- package.json 修复 `"test": "node --test"`（之前误把 `test/` 当模块路径）

## [3.0.0] - 2026-06-14

### Added
- **初始版本**（V2/V4 改造完成）
  - 零依赖本地 LLM 网关，兼容 Anthropic API
  - CLI + gateway 同进程双栈架构
  - Admin API（/admin/*）供内部管理
  - 端口冲突处理、进程查询、杀进程功能
  - 热切换端口、事务式配置保存
  - 路由解析、重试、流式转发
  - 终端日志缓存、实时日志视图

### Fixed
- **V4 阻断问题**（4 个）
  - 事务端口切换死锁
  - CRUD 并发安全
  - 删除 active 检查
  - 布局/对齐问题

- **V4 UI 问题**（3 轮补丁）
  - 主界面方框溢出导致窗口缩窄时折行
  - 命令面板所有项没对齐
  - 日志视图改为实时滚动（`tail -f` 风格）
  - 主界面残留子流程输出（`fullClear()` 清 scrollback）
  - 实时日志视图按键无反应（禁用 `rl.pause()`）
  - gateway 处理请求时的 logRequest 直接抢屏（`suppressConsole` + `emitLog`）
  - 导出改为真正写文件（默认 `./data/export/gateway-<timestamp>.json`）

### Changed
- README 完整文档（目录结构、CLI 命令、API、配置模型、导出备份）

---

## 版本规划原则

### [Unreleased]
- 正在开发中的功能，未发布到版本号

### [X.Y.Z] - YYYY-MM-DD
- **X（Major）**：不兼容的 API 变更、配置文件格式变化、CLI 参数变化
- **Y（Minor）**：向后兼容的新功能（如新 API、新 CLI 命令、新交互方式）
- **Z（Patch）**：向后兼容的问题修复（bug fix、UI 优化、性能改进）

### 发布流程
1. develop 分支合并到 main
2. 更新 package.json 的 version 字段
3. 更新 CHANGELOG.md 的 [Unreleased] → [X.Y.Z]
4. 打 git tag：`git tag -a vX.Y.Z -m "Release vX.Y.Z: ..."`
5. 推送：`git push origin main vX.Y.Z`

---

**从 3.1.0 开始严格遵循 SemVer 规范**
