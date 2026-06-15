// V5.2 §5.4 / §6.3: 端口切换成功路径只持久化 1 次。
// 通过 admin 真实 HTTP endpoint + spy saveConfig 验证。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGatewayRuntime } from "../gateway-runtime.mjs";
import { createGatewayRequestHandler } from "../server.mjs";
import { __setSaveConfigForTest } from "../admin.mjs";

function makeConfig(port) {
  return {
    gateway: { host: "127.0.0.1", port, sharedToken: null },
    providers: {},
    modelFamilies: {
      opus: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      sonnet: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      "sonnet[1m]": { providerId: null, baseUrlId: null, keyId: null, modelId: null },
      haiku: { providerId: null, baseUrlId: null, keyId: null, modelId: null },
    },
  };
}

test("V5.2 admin 端口切换成功路径只持久化 1 次", async (t) => {
  let saveCount = 0;
  let lastSavedPort = null;
  // 纯内存 spy：只统计调用次数 + 记录参数，绝不写真实 data/gateway.json。
  // （review fix：旧 spy 内部调 realSaveConfig 会把开发机本地配置覆盖成测试端口）
  const spy = async (cfg) => {
    saveCount += 1;
    lastSavedPort = cfg?.gateway?.port ?? null;
  };
  __setSaveConfigForTest(spy);
  t.after(() => __setSaveConfigForTest(null));

  // 先起一个 noop 临时 handler 占位（createGatewayRuntime 需要 requestHandler 入参），
  // 但 requestHandler 实际不会跑——admin endpoint 走 createGatewayRequestHandler 内部调用链。
  // 由于 server.mjs 的 createGatewayRequestHandler 在被 start 之前就绑死，
  // 我们需要先把 config.gateway.port 改到目标测试端口，再起 runtime。
  const port = 18800;
  const config = makeConfig(port);
  const metrics = {};

  // runtime server 的 handler：V5.3 回环探测会 fetch /health，handler 必须能响应（任意 200 即可）。
  // admin endpoint 实际走 createGatewayRequestHandler 实例，不依赖这个 handler 的业务逻辑。
  const placeholderHandler = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  };

  const runtime = createGatewayRuntime({
    config,
    requestHandler: placeholderHandler,
  });
  await runtime.start();
  t.after(() => runtime.close());

  // 关键：现在拿一个绑定到 admin route 的 server，专门测 admin。
  // 复用 createGatewayRequestHandler，传 ctx.runtime，让 admin 能拿到 runtime。
  const { createServer } = await import("node:http");
  const adminHandler = createGatewayRequestHandler(config, metrics, { runtime });
  const adminServer = createServer((req, res) => {
    adminHandler(req, res);
  });
  await new Promise((r) => adminServer.listen(18899, "127.0.0.1", r));
  t.after(() => new Promise((r) => adminServer.close(r)));

  // PATCH 切到 18801
  const res = await fetch(`http://127.0.0.1:18899/admin/runtime/port`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port: 18801 }),
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}; body=${await res.text()}`);

  // 关键断言：成功路径只持久化 1 次
  assert.equal(saveCount, 1, `expected exactly 1 saveConfig call on success, got ${saveCount}`);
  // 且落盘参数就是目标端口（证明 spy 拿到的 cfg 是切换后的状态）
  assert.equal(lastSavedPort, 18801, `expected saved port 18801, got ${lastSavedPort}`);

  // 确认 runtime 真的切到了新端口
  assert.equal(runtime.getPort(), 18801);
});
