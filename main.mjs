import readline from "node:readline";

import { loadConfig } from "./config.mjs";
import { createGatewayRuntime } from "./gateway-runtime.mjs";
import { checkPortFree, findPortOccupant, killProcess } from "./port-utils.mjs";
import { logRaw, logStartupBanner } from "./route-utils.mjs";
import { createGatewayRequestHandler } from "./server.mjs";
import { startCli } from "./cli.mjs";

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function askOnce(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function resolveStartupPortConflict(config) {
  const host = config.gateway.host;
  const port = config.gateway.port;

  const free = await checkPortFree(port, host);
  if (free) {
    return true;
  }

  const occupant = await findPortOccupant(port);
  logRaw(`[startup] 端口 ${host}:${port} 已被占用`);
  if (occupant?.pid) {
    const parts = [`PID=${occupant.pid}`];
    if (occupant.name) parts.push(`name=${occupant.name}`);
    if (occupant.cmdline) parts.push(`cmd=${occupant.cmdline}`);
    logRaw(`[startup] 占用进程: ${parts.join(" ")}`);
  } else {
    logRaw(`[startup] 无法定位占用进程 PID（可能为系统保留或权限不足）`);
  }

  const answer = (await askOnce(`是否杀掉占用进程并继续？(y/N) `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    return false;
  }

  if (!occupant?.pid) {
    logRaw(`[startup] 无 PID 可杀，启动中止`);
    return false;
  }

  const killed = await killProcess(occupant.pid);
  if (!killed) {
    logRaw(`[startup] 杀进程 ${occupant.pid} 失败，启动中止`);
    return false;
  }
  logRaw(`[startup] 已杀掉进程 ${occupant.pid}`);

  await sleep(500);
  return checkPortFree(port, host);
}

async function main() {
  const config = await loadConfig();

  const ok = await resolveStartupPortConflict(config);
  if (!ok) {
    console.error("[startup] 启动中止");
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
    console.warn(`\n[shutdown] received ${signal}`);
    const forceTimer = setTimeout(() => {
      console.warn("[shutdown] forcing exit after timeout");
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();
    try {
      await runtime.close();
    } catch (err) {
      console.error(`[shutdown] close error: ${err.message}`);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await startCli({ config, runtime });
  } catch (err) {
    console.error(`[cli] ${err.message}`);
  } finally {
    await runtime.close();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`[startup] ${err.message}`);
  process.exit(1);
});
