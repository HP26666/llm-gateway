# Claude Code Minimal Gateway

This gateway gives Claude Code one local Anthropic-compatible endpoint and keeps Claude Code's own model naming intact.

It routes by Claude model family:

- `opus` and any `claude-...opus...` model -> GLM
- `sonnet` and any `claude-...sonnet...` model -> Kimi
- `haiku` and any `claude-...haiku...` model -> GLM `glm-4.7`

It only implements the two endpoints Claude Code needs here:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`

## Files

- [server.mjs](/C:/Users/fjy20/.claude/llm-gateway/server.mjs)
- [start-gateway.bat](/C:/Users/fjy20/.claude/llm-gateway/start-gateway.bat)
- [start-gateway.ps1](/C:/Users/fjy20/.claude/llm-gateway/start-gateway.ps1)
- [package.json](/C:/Users/fjy20/.claude/llm-gateway/package.json)
- [gateway.env.example](/C:/Users/fjy20/.claude/llm-gateway/gateway.env.example)

## Default Upstream Assumptions

The defaults are aligned with your current setup:

- Kimi base URL: `https://api.kimi.com/coding/`
- Kimi model: `kimi-for-coding`
- GLM base URL: `https://open.bigmodel.cn/api/anthropic`
- GLM model: `glm-5.1`
- GLM haiku upstream model: `glm-4.7`

You can override all of them through environment variables or PowerShell parameters.

## Start On Windows

The easiest option is the batch file. It can be started directly from Explorer, `cmd`, or PowerShell.

1. Copy `gateway.env.example` to `gateway.env`
2. Fill in `KIMI_AUTH_TOKEN` and `GLM_AUTH_TOKEN`
3. Run:

```bat
start-gateway.bat
```

You can also override values inline:

```bat
start-gateway.bat GLM_AUTH_TOKEN=your-glm-token KIMI_AUTH_TOKEN=your-kimi-token
```

If you still prefer PowerShell, `start-gateway.ps1` remains available.

Example:

```powershell
$env:GLM_AUTH_TOKEN = "your-glm-token"
.\start-gateway.ps1 -KimiToken "your-kimi-token"
```

If your Kimi side needs a different auth style, you can override it:

```powershell
.\start-gateway.ps1 `
  -KimiToken "your-kimi-token" `
  -GlmToken "your-glm-token" `
  -KimiAuthHeader "Authorization" `
  -KimiAuthScheme "Bearer"
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/health
```

## Claude Code Settings

Point Claude Code at the local gateway, but do not remap `ANTHROPIC_DEFAULT_*` to custom IDs. That is the key to keeping the built-in Claude model names and feature detection, including auto mode.

```json
{
  "model": "sonnet",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4000"
  }
}
```

If your current config already pins `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, or `ANTHROPIC_DEFAULT_OPUS_MODEL` to provider-specific IDs, remove those entries. Otherwise Claude Code will keep seeing the provider IDs instead of Claude model names, and capability gating such as auto mode may stay disabled.

If you want the local gateway itself to require a token, set `GATEWAY_SHARED_TOKEN` when starting it, then also set:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your-local-gateway-token"
  }
}
```

## Notes

- The gateway rewrites only the `model` field and forwards the rest of the Anthropic request body unchanged.
- It forwards `anthropic-beta` and `anthropic-version` headers automatically.
- It accepts both aliases like `sonnet` and full Anthropic model names like `claude-sonnet-4-6`.
- Unknown model names return `400` so misrouting is easy to spot.
