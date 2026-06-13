# LLM Gateway

零运行时依赖的本地 LLM 网关，兼容 Claude Code 需要的 Anthropic 接口，把 `opus` / `sonnet` / `sonnet[1m]` / `haiku` 四个模型族路由到任意上游 Provider（如 GLM、Kimi、DeepSeek）。

**只有一种启动方式**：启动后自动启动网关，然后进入交互式 CLI 界面，所有配置都在 CLI 内完成。

## 目录结构

```
llm-gateway/
├── main.mjs             # 唯一入口：端口冲突处理 → 启动 runtime → CLI
├── server.mjs           # 请求处理：/v1/messages 代理、/admin/* 内部 API、/health
├── gateway-runtime.mjs  # HTTP 服务生命周期（start/stop/restartOnPort）
├── config.mjs           # data/gateway.json 加载/原子保存/v2→v3 迁移/BOM 容错
├── admin.mjs            # /admin/* 内部 API（仅 127.0.0.1，供 CLI/脚本调用）
├── route-utils.mjs      # 路由解析 + 终端日志缓存（emitLog/suppressConsole）
├── port-utils.mjs       # 跨平台端口探测、占用进程查询、杀进程
├── cli.mjs              # 终端 CLI（与 runtime 同进程）
├── data/gateway.json    # 运行时配置（首次启动自动生成）
├── sgw.bat              # Windows 一键启动
└── archive/             # 旧版本归档（不再运行）
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

主界面只显示三类信息：监听地址、四个 family 的当前路由、Provider 概览。**默认不显示日志/历史**，避免视觉过载。状态栏只显示中性提示（`状态: 就绪` / `状态: 上次操作成功`），失败时才显示错误信息。

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

命令: 1=新建Provider 2=BaseUrl 3=Key 4=Model 5=切换Family
      6=修改端口     7=历史   8=日志 9=导出   0=删除Provider
      r=刷新  q=退出
```

所有显示都按视觉宽度截断，长 URL / 长 note 不会撑破边框。`2/3/4` 进入子菜单后可执行 `1=新增 2=修改 3=删除 0=返回`。

### 命令说明

| 键 | 动作 |
|---|---|
| `1` | 新建 Provider（可选顺带填一个 baseUrl 和一个 apiKey） |
| `2` | BaseUrl 子菜单（新增 / 修改 / 删除） |
| `3` | Key 子菜单（新增 / 修改 / 删除） |
| `4` | Model 子菜单（新增 / 修改 / 删除） |
| `5` | 切换某个 family 的 `provider + baseUrl + key + model` |
| `6` | 修改监听端口（事务式，失败时旧端口保留工作；占用时会询问是否杀进程） |
| `7` | 查看历史（独立视图，回车返回） |
| `8` | 查看最近网关日志（实时刷新视图，按 `q` / `Esc` / `Ctrl-C` 返回） |
| `9` | 导出当前配置 JSON 到文件（默认写入 `data/export/`，也可自定义路径） |
| `0` | 删除 Provider |
| `r` | 刷新 |
| `q` | 退出 |

## 配置数据模型（V3）

```json
{
  "version": 3,
  "gateway": {
    "host": "127.0.0.1",
    "port": 8000,
    "sharedToken": null
  },
  "providers": {
    "glm": {
      "id": "glm",
      "name": "GLM",
      "authHeader": "Authorization",
      "authScheme": "Bearer",
      "baseUrls": [
        { "id": "b_glm_xxx", "url": "https://open.bigmodel.cn/api/anthropic", "note": "主线路" },
        { "id": "b_glm_yyy", "url": "https://proxy.example.com", "note": "代理" }
      ],
      "keys": [
        { "id": "k_glm_xxx", "token": "...", "note": "LSXkey", "createdAt": "..." }
      ],
      "models": [
        { "id": "m_glm_xxx", "model": "glm-5.1", "name": "GLM 5.1" },
        { "id": "m_glm_yyy", "model": "glm-4.7", "name": "GLM 4.7 备用" }
      ]
    }
  },
  "modelFamilies": {
    "opus":       { "providerId": "glm", "baseUrlId": "b_glm_xxx", "keyId": "k_glm_xxx", "modelId": "m_glm_xxx" },
    "sonnet":     { "providerId": null,  "baseUrlId": null,         "keyId": null,         "modelId": null },
    "sonnet[1m]": { "providerId": null,  "baseUrlId": null,         "keyId": null,         "modelId": null },
    "haiku":      { "providerId": null,  "baseUrlId": null,         "keyId": null,         "modelId": null }
  },
  "history": []
}
```

语义要点：

- **Provider 名称唯一**：同名字 provider 只能存在一个（不区分大小写）。CLI/HTTP 创建时都会校验
- **Provider 是聚合对象**：下面挂 `baseUrls`、`keys`、`models` 三类子资源，本身只是容器
- **BaseUrl**：每个 provider 可有多条，每条带 `note`，方便区分线路/入口
- **Key**：每个 provider 可有多把，每把带 `note`；key 不再有 `active` 字段，family 路由完全由 `binding.keyId` 决定
- **Model**：每个 provider 可有多个；`model` 是真实发往上游的型号（如 `glm-5.1`），`name` 是给用户看到的显示名（如 `GLM 5.1 主用`）
- **Family 绑定**：必须显式选择 `provider + baseUrl + key + model` 四元组；不存在"默认 baseUrl / 默认 key"概念
- 启动时旧 V2 配置（单字段 `baseUrl`、`name+note` 的 model、缺 `baseUrlId` 的 family、含 `active` 的 key）会自动迁移到 V3

## 模型族路由识别

网关根据 Claude Code 发来的 `model` 字段做映射：

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
- 端口切换（**事务式**）：先尝试在新端口 listen 新 server，成功后才关闭旧 server；失败时旧端口保留工作，配置文件不会被污染为新端口
  - 实际流程：`runtime.restartOnPort(newPort)` await 完成后，admin 才 `saveConfig` 并返回 200
  - 失败时 admin 返回 500，`config.gateway.port` 仍是旧值

每次切换都会在终端和 `8=日志` 视图中留下 `[config-change]` 记录。

## Admin API（内部）

所有 `/admin/*` 路由仅响应来自 `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 的请求，不再要求任何 admin token。供 CLI 与脚本化场景使用。

```text
GET    /admin/config
GET    /admin/config/export
GET    /admin/history
GET    /admin/health

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
GET    /admin/families/:family/status

POST   /admin/runtime/port/probe                       { port }            → { free, occupant }
POST   /admin/runtime/process/kill                     { pid }
PATCH  /admin/runtime/port                             { port, killIfOccupied? }
```

调用时建议附带 header `X-Admin-Source: cli` / `X-Admin-Source: script`，便于历史记录区分来源。

## Claude Code 接入

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8000"
  }
}
```

如果为网关本身设置了 `gateway.sharedToken`（可选），还需让 Claude Code 发送：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-local-gateway-token"
  }
}
```

`sharedToken` 是 Claude Code 请求网关时使用的本地令牌。

## 终端日志

启动 banner 和请求/配置变更日志都会被缓存到 CLI `8=日志` 视图（最近 200 条）。在 CLI 模式下，这些日志**默认不会直接打印到主界面**，避免抢屏；需要时按 `8` 进入实时日志视图查看。

```text
Claude gateway listening on http://127.0.0.1:8000 | families: opus->glm:glm-5.1, ...

[2026-06-14T10:21:02.000Z] /v1/messages claude-sonnet-4-6 [sonnet] -> kimi:kimi-for-coding (200)

[config-change] 2026-06-14T10:20:30.000Z family=opus from=GLM · glm-5.1 · 主线路 · default to=GLM · glm-4.7 · 代理 · LSXkey source=cli
[config-change] 2026-06-14T10:22:00.000Z port from=8000 to=9000 source=cli
```

日志默认不在 CLI 主界面显示，需要时按 `8` 查看。

## 健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

返回当前 host、port 和四个 family 的最新绑定结果。

## 回退与备份

- CLI `9=导出` 会把完整配置 JSON 写入文件；默认路径类似 `data/export/gateway-YYYYMMDD-HHMMSS.json`
- 导出时可直接回车使用默认路径，输入 `q` 取消，也可输入目录或完整文件路径
- `archive/` 保留了旧版本文件，仅供历史参考（不再运行）
- 旧版本 `data/gateway.json`（V1/V2）会在下次启动时自动迁移到 V3
- 如需手动备份，直接复制 `data/gateway.json` 即可
