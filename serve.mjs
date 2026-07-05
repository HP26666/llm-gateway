// 纯后台服务入口：加载 data/gateway.json 配置并启动 HTTP 网关，不进入交互式 CLI。
// 与 sgw（main.mjs）共用同一个请求处理逻辑（createGatewayRequestHandler），
// 区别仅在于不启动 CLI —— 因此终端不会被 TUI 抢占：每条请求日志（logRequest）
// 和配置变更日志会直接打印到 stdout，便于挂后台时实时查看调用情况。
import { loadConfig } from "./config.mjs";
import { createGatewayRuntime } from "./gateway-runtime.mjs";
import { checkPortFree, findPortOccupant } from "./port-utils.mjs";
import { logRaw, logStartupBanner } from "./route-utils.mjs";
import { createGatewayRequestHandler } from "./server.mjs";

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

async function serve() {
  const config = await loadConfig();
  const { host, port } = config.gateway;

  // 后台模式不做交互式询问：端口被占就直接退出并打印占用进程，避免静默杀掉别人的进程。
  const free = await checkPortFree(port, host);
  if (!free) {
    const occupant = await findPortOccupant(port);
    logRaw(`[startup] 端口 ${host}:${port} 已被占用，后台模式不自动杀进程，请先释放后重试。`);
    if (occupant?.pid) {
      const parts = [`PID=${occupant.pid}`];
      if (occupant.name) parts.push(`name=${occupant.name}`);
      if (occupant.cmdline) parts.push(`cmd=${occupant.cmdline}`);
      logRaw(`[startup] 占用进程: ${parts.join(" ")}`);
    }
    process.exit(1);
  }

  const metrics = {};
  const ctx = { runtime: null };
  const requestHandler = createGatewayRequestHandler(config, metrics, ctx);
  const runtime = createGatewayRuntime({ config, requestHandler });
  ctx.runtime = runtime;

  await runtime.start();
  logStartupBanner(config);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logRaw(`\n[shutdown] received ${signal}`);
    const forceTimer = setTimeout(() => {
      logRaw("[shutdown] forcing exit after timeout");
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();
    try {
      await runtime.close();
    } catch (err) {
      logRaw(`[shutdown] close error: ${err.message}`);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

serve().catch((err) => {
  console.error(`[startup] ${err.message}`);
  process.exit(1);
});
