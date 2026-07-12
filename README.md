# LLM Gateway

零运行时依赖的本地 LLM 网关，同时兼容 **Anthropic Messages API**（`/v1/messages`，供 Claude Code）和 **OpenAI Responses API**（`/v1/responses`，供 Codex），把 `opus` / `sonnet` / `sonnet[1m]` / `haiku` 四个模型族路由到任意上游 Provider（如 GLM、Kimi、DeepSeek）。

支持多候选 failover、熔断器、用量统计，所有配置都在交互式 CLI 内完成。

## 目录结构

```
llm-gateway/
├── main.mjs                      # 唯一入口：端口冲突处理 → 启动 runtime → CLI
├── server.mjs                    # 请求处理：/v1/messages、/v1/responses 代理、/admin/*、/health
├── gateway-runtime.mjs           # HTTP 服务生命周期（start/close/preparePortSwitch）
├── config.mjs                    # data/gateway.json 加载/原子保存/迁移
├── admin.mjs                     # /admin/* 内部 API + adminToken 鉴权 + SSRF 防护
├── route-utils.mjs               # 路由解析 + 多候选 + 终端日志缓存
├── port-utils.mjs                # 跨平台端口探测、占用进程查询、杀进程
├── circuit-breaker.mjs           # 上游候选熔断器（三态机，被动统计）
├── usage-store.mjs               # 用量统计（按天 jsonl + 聚合）
├── debug-log.mjs                 # 问题级日志自动持久化
├── responses-protocol.mjs        # Responses API SSE 序列化/解析
├── responses-request-adapter.mjs # Responses → Anthropic 请求转换
├── responses-response-adapter.mjs# Anthropic → Responses 响应转换
├── cli.mjs                       # 终端 CLI（与 runtime 同进程）
├── cli-select.mjs                # 方向键高亮选择器原语
├── data/gateway.json             # 运行时配置（首次启动自动生成）
├── sgw.bat                       # Windows 一键启动
└── docs/                         # 架构/设计文档
```

## 运行要求

- Node.js 20+
- Windows / macOS / Linux 任意可运行 Node.js 的本地环境
- 仅监听 `127.0.0.1`，不暴露到外网

## 启动方式

### Windows

```bat
sgw.bat
```

### 通用

```bash
node main.mjs
```

启动流程：

1. 加载 `data/gateway.json`（不存在则创建空配置）
2. 检查监听端口是否被占用
   - 若被占用，会显示占用进程信息并询问是否杀掉，确认后 kill 并继续
3. 启动网关
4. 进入 CLI 主界面

终端首行日志示例：

```
Claude gateway listening on http://127.0.0.1:8000 | families: opus->glm:glm-5.1, sonnet>(未配置), sonnet[1m]>(未配置), haiku>(未配置)
```

## CLI 主界面

主界面只显示三类信息：监听地址、四个 family 的当前路由、Provider 概览。**默认不显示日志/历史**，避免视觉过载。

```
┌──────────────────────────────────────────────────────────────────────────┐
│ LLM Gateway CLI                                                           │
│ 监听: http://127.0.0.1:8000                                               │
├──────────────────────────────────────────────────────────────────────────┤
│ Family 路由                                                               │
│   opus        -> GLM Coding Plan · GLM 5.1 · 主线路 · default            │
│   sonnet      -> (未配置)                                                  │
│   ...                                                                     │
├──────────────────────────────────────────────────────────────────────────┤
│ Providers                                                                 │
│   GLM Coding Plan   | baseUrls:1 keys:1 models:2                         │
├──────────────────────────────────────────────────────────────────────────┤
│ 状态: 就绪                                                                │
└──────────────────────────────────────────────────────────────────────────┘

命令（数字/字母直接执行 · 方向键移动 · 回车确认高亮 · r 刷新 · q 退出 · Esc 回顶部）
  1=新建Provider    2=BaseUrl         3=Key            4=Model
  5=Family候选      6=修改端口        7=历史           8=日志
  9=导出            0=删除Provider    u=用量           q=退出
```

**命令面板支持方向键高亮选择**：↑↓←→ 在 3×4 网格中移动高亮（跨行/跨列），回车执行当前高亮项。数字 `1`~`9`/`0` 和 `r`/`u`/`q` **直接执行**对应命令（无需回车）。非 TTY 环境自动降级回数字输入模式。

### 命令说明

| 键 | 动作 |
|---|---|
| `1` | 新建 Provider（可选顺带填一个 baseUrl 和一个 apiKey） |
| `2` | BaseUrl 子菜单（新增 / 修改 / 删除） |
| `3` | Key 子菜单（新增 / 修改 / 删除） |
| `4` | Model 子菜单（新增 / 修改 / 删除） |
| `5` | **Family 候选编辑器**：追加/删除候选、设主候选（置顶）、切策略、熔断/TTFB 配置 |
| `6` | 修改监听端口（事务式，失败时旧端口保留工作；占用时会询问是否杀进程） |
| `7` | 查看历史（独立视图，回车返回） |
| `8` | 查看最近网关日志（实时刷新视图，按 `q` / `Esc` / `Ctrl-C` 返回） |
| `9` | 导出当前配置 JSON 到文件（默认写入 `data/export/`） |
| `0` | 删除 Provider |
| `u` | **用量统计视图**：Token 趋势 sparkline + 按 Family/Provider 分布，可切今日/7天/30天 |
| `r` | 刷新 |
| `q` | 退出 |

### 回退到纯数字模式

若方向键选择器在任何终端下异常，可设环境变量一键回滚：

```bash
LLM_CLI_NO_KEYSELECT=1 node main.mjs
```

## 配置数据模型（V3）

```json
{
  "version": 3,
  "gateway": {
    "host": "127.0.0.1",
    "port": 8000,
    "sharedToken": null,
    "adminToken": null
  },
  "providers": {
    "glm": {
      "id": "glm",
      "name": "GLM",
      "authHeader": "Authorization",
      "authScheme": "Bearer",
      "baseUrls": [
        { "id": "b_glm_xxx", "url": "https://open.bigmodel.cn/api/anthropic", "note": "主线路" }
      ],
      "keys": [
        { "id": "k_glm_xxx", "token": "...", "note": "LSXkey", "createdAt": "..." }
      ],
      "models": [
        { "id": "m_glm_xxx", "model": "glm-5.1", "name": "GLM 5.1" }
      ]
    }
  },
  "circuitBreaker": null,
  "modelFamilies": {
    "opus": {
      "candidates": [
        { "providerId": "glm", "baseUrlId": "b_glm_xxx", "keyId": "k_glm_xxx", "modelId": "m_glm_xxx" }
      ],
      "strategy": "failover",
      "circuitBreaker": null
    },
    "sonnet": {
      "candidates": [
        { "providerId": "glm", "baseUrlId": "b_glm_xxx", "keyId": "k_glm_xxx", "modelId": "m_glm_xxx" },
        { "providerId": "deepseek", "baseUrlId": "b_ds_xxx", "keyId": "k_ds_xxx", "modelId": "m_ds_xxx" }
      ],
      "strategy": "round_robin",
      "circuitBreaker": { "failureThreshold": 3, "coolDownMs": 60000, "successThreshold": 1, "ttfbTimeoutMs": 30000 }
    },
    "sonnet[1m]": { "candidates": [], "strategy": "failover", "circuitBreaker": null },
    "haiku":      { "candidates": [], "strategy": "failover", "circuitBreaker": null }
  },
  "history": []
}
```

语义要点：

- **Provider** 是聚合对象，下挂 `baseUrls`、`keys`、`models` 三类子资源；名称唯一（不区分大小写）
- **Model**：`model` 是真实发往上游的型号（如 `glm-5.1`），`name` 是给用户看到的显示名
- **Family 绑定**：每个 family 是 `{ candidates, strategy, circuitBreaker }` 对象
  - `candidates`：四元组数组（provider + baseUrl + key + model），可多候选
  - `strategy`：`failover`（主备）/ `round_robin`（轮转）/ `weighted`（预留）
  - `circuitBreaker`：per-family 覆盖，`null` = 用全局默认
- **向后兼容**：旧的单四元组形态（family 直接是 `{providerId,...}`）会自动包成 1 元素 candidates，零迁移

## 多候选 failover + 熔断器

每个 family 可绑定多个上游候选，按 strategy 调度。配合熔断器实现自动故障转移。

### 熔断器（circuit-breaker.mjs）

标准三态机 `CLOSED → OPEN → HALF_OPEN → CLOSED`：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `failureThreshold` | 3 | 连续失败几次后熔断（OPEN） |
| `coolDownMs` | 60000 | 熔断冷却时间，过后进 HALF_OPEN 待探活 |
| `successThreshold` | 1 | HALF_OPEN 期间成功几次后恢复（CLOSED） |
| `ttfbTimeoutMs` | 30000 | 首字节超时，超时视为失败 |

- **被动统计**：无定时器、无主动探测，不耗 API 额度；状态靠下次请求惰性判定
- 模块级单例，按候选四元组 key 索引，**跨 family、跨热切换保留状态**
- 连接失败（ECONNREFUSED/ENOTFOUND 等）**1 次即熔断**（`forceOpen`），不必累计到阈值
- 顶层 `circuitBreaker` 设全局默认，per-family 的 `circuitBreaker` 可覆盖单字段

### failover 触发集

请求命中以下状态时自动切换到下一个候选：

- `≥ 500`（服务端错误）
- `429`（限流）
- `401` / `402` / `403`（鉴权类，换候选可能有效）
- fetch throw（网络不可达等）

**不触发**：`400` / `404` 等请求格式错误（换哪个上游都一样错）。

切换只在**首字节前**发生，流式响应阶段不再切换（防止 token 乱码）。全部候选失败时透传最后一个候选的真实状态码（不伪造 502）。

## 用量统计

每个请求完成时自动记录 token 用量，按天写入 `data/usage-YYYYMMDD.jsonl`（保留 30 天，每 6 小时惰性清理旧文件）。

记录字段：`family` / `providerId` / `modelId` / `keyId` / `in` / `out` / `cacheR` / `cacheW` / `status` / `ms`。失败请求也记一条（token=0），保证错误率统计完整。recordUsage 异步落盘，失败不影响主请求。

- **CLI 查看**：按键 `u` 进用量视图，支持今日/7天/30天切换，展示 Token 趋势 sparkline + 按 Family/Provider 分布
- **Admin API**：`GET /admin/usage/:range`（range ∈ today | 7d | 30d）

问题级日志（failover / 熔断 / 上游异常 / 连接失败 / 流中断）也会自动追加到 `data/debug-YYYYMMDD.log`（保留 7 天），不再依赖手动从 CLI `8=日志` 视图复制。

## Responses API（Codex 接入）

除 `/v1/messages`（Claude Code）外，网关还提供 `POST /v1/responses`（OpenAI Codex 协议），走完整的 family 路由 + failover + 熔断 + 用量统计链路。

三个零依赖 adapter 完成双向转换：

- `responses-request-adapter.mjs`：Responses 请求 → Anthropic 请求
- `responses-response-adapter.mjs`：Anthropic 响应 → Responses 响应（含流式 SSE 状态机）
- `responses-protocol.mjs`：SSE 序列化/解析

### Codex 客户端配置

`~/.codex/config.toml`：

```toml
[model_providers.gateway]
base_url = "http://127.0.0.1:8000/v1"
wire_api = "responses"
env_key = "GATEWAY_SHARED_TOKEN"
```

Codex 的 `model` 字段直接配 family 名（`opus` / `sonnet` / `haiku`）。要走 `sonnet[1m]` 需显式把 model 配成 `sonnet[1m]`（Codex 不发 1m 信号）。

## 模型族路由识别

网关根据客户端发来的 `model` 字段做映射：

- `best` / `default` / `auto` → `opus`
- `opus` / `claude-opus-...` → `opus`
- `sonnet` / `claude-sonnet-...` → `sonnet`
- 带 `anthropic-beta: context-1m` 或 body 内 `betas` 含 `1m` 信号的 sonnet 请求 → `sonnet[1m]`
- `sonnet[1m]` / `claude-sonnet-...[1m]` → `sonnet[1m]`
- `haiku` / `claude-haiku-...` → `haiku`

请求体只重写 `model` 字段，其他字段（`messages`、`system`、`tools`、`stream` 等）原样透传。

## 热切换

CLI 中执行任何配置变更（family 切换、端口切换等）**无需重启**：

- family 切换：admin handler 直接修改共享 config 引用，下一次请求即生效
- 端口切换（**两阶段事务**）：runtime 不直接改 config
  - 流程：admin 调 `runtime.preparePortSwitch(newPort)` → 改 in-memory port → `saveConfig()` 落盘 → `tx.commit()` 推进 active server → 返回 200
  - 失败补偿：saveConfig 失败 → 回滚 in-memory port + `tx.rollback()` → 返回 500
  - 端口切换成功/失败后，admin 响应 200/500，runtime 与磁盘 config 始终一致

每次切换都会在终端和 `8=日志` 视图中留下 `[config-change]` 记录。

## Admin API（内部）

所有 `/admin/*` 路由仅响应来自 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 的回环请求。

### 鉴权

- **回环 IP 校验**：始终生效，只允许本机访问
- **adminToken（可选）**：当 `gateway.adminToken` 非空时，还要求请求头 `X-Admin-Token` 匹配（`timingSafeEqual` 常量时间比较，防侧信道）。为 `null` 时只靠回环 IP，向后兼容。CLI 会自动注入该头。

### 端点清单

```text
GET    /admin/config
GET    /admin/config/export
GET    /admin/history
GET    /admin/health
GET    /admin/usage/:range                            → today | 7d | 30d

POST   /admin/providers                                { name, baseUrl?, baseUrlNote?, apiKey?, keyNote? }
PATCH  /admin/providers/:id                            { name? }
DELETE /admin/providers/:id

POST   /admin/providers/:id/baseUrls                   { url, note? }
PATCH  /admin/providers/:id/baseUrls/:bid              { url?, note? }
DELETE /admin/providers/:id/baseUrls/:bid

POST   /admin/providers/:id/keys                       { token, note? }
PATCH  /admin/providers/:id/keys/:kid                  { token?, note? }
DELETE /admin/providers/:id/keys/:kid

POST   /admin/providers/:id/models                     { model, name? }
PATCH  /admin/providers/:id/models/:mid                { model?, name? }
DELETE /admin/providers/:id/models/:mid

PUT    /admin/families/:family                         { providerId, baseUrlId, keyId, modelId }
PUT    /admin/families/:family/candidates              { candidates, strategy, circuitBreaker }
GET    /admin/families/:family/status

POST   /admin/runtime/port/probe                       { port }            → { free, occupant }
POST   /admin/runtime/process/kill                     { pid }
PATCH  /admin/runtime/port                             { port, killIfOccupied? }
```

调用时建议附带 header `X-Admin-Source: cli` / `X-Admin-Source: script`，便于历史记录区分来源。

## 安全

- **回环绑定**：网关仅监听 `127.0.0.1`，不暴露外网
- **adminToken 鉴权**：admin 接口可选 token 保护（见上）
- **sharedToken**：`gateway.sharedToken` 非空时，客户端请求需带 `Authorization: Bearer <token>`
- **SSRF 防护**：创建/修改 baseUrl 时校验，拦截私网段（10/172.16/192.168）、回环、链路本地（169.254）、CGN（100.64）等，只允许 http(s) 公网地址

## Claude Code 接入

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8000"
  }
}
```

如果设置了 `gateway.sharedToken`，还需：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-local-gateway-token"
  }
}
```

不要把 `ANTHROPIC_DEFAULT_*_MODEL` 指向上游 provider ID——保持 Claude 原生模型名，网关会自动路由。

## 终端日志

启动 banner 和请求/配置变更日志都会缓存到 CLI `8=日志` 视图（最近 200 条）。CLI 模式下默认不打印到主界面，需要时按 `8` 进入实时日志视图。

```text
Claude gateway listening on http://127.0.0.1:8000 | families: opus->glm:glm-5.1, ...

[2026-06-14T10:21:02.000Z] /v1/messages claude-sonnet-4-6 [sonnet] -> kimi:kimi-for-coding (200)

[config-change] 2026-06-14T10:20:30.000Z family=opus from=GLM · glm-5.1 to=GLM · glm-4.7 source=cli
[config-change] 2026-06-14T10:22:00.000Z port from=8000 to=9000 source=cli
```

## 健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

返回当前 host、port 和四个 family 的最新绑定结果。

## 回退与备份

- CLI `9=导出` 把完整配置 JSON 写入 `data/export/gateway-YYYYMMDD-HHMMSS.json`（可自定义路径）
- 旧版本 `data/gateway.json`（V1/V2）会在下次启动时自动迁移到 V3
- 如需手动备份，直接复制 `data/gateway.json` 即可
