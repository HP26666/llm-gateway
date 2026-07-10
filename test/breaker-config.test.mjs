// 熔断/TTFB 参数配置测试：
// 1. normalizeCircuitBreaker 对 ttfbTimeoutMs 等字段的 clamp 清洗
// 2. admin PUT /families/:family/candidates 带 circuitBreaker 端到端
// 3. 不传 circuitBreaker 时保持旧值回填（向后兼容）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { normalizeConfig } from "../config.mjs";
import { createGatewayRequestHandler } from "../server.mjs";
import { __setSaveConfigForTest } from "../admin.mjs";

const PROVIDERS = {
  p1: {
    id: "p1", name: "p1", authHeader: "Authorization", authScheme: "Bearer",
    baseUrls: [{ id: "b1", url: "http://127.0.0.1:9", note: "n" }],
    keys: [{ id: "k1", token: "tok", note: "n", createdAt: "1970-01-01T00:00:00.000Z" }],
    models: [{ id: "m1", model: "glm-4", name: "glm" }],
  },
};

// ===== normalizeCircuitBreaker clamp 测试 =====

test("normalizeCircuitBreaker: ttfbTimeoutMs clamp 到 [1000, 120000]", () => {
  const n1 = normalizeConfig({
    gateway: { host: "127.0.0.1", port: 4000 },
    providers: PROVIDERS,
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        circuitBreaker: { ttfbTimeoutMs: 100 },
      },
    },
    history: [],
  });
  assert.equal(n1.modelFamilies.opus.circuitBreaker.ttfbTimeoutMs, 1000, "低于下限 clamp 到 1000");

  const n2 = normalizeConfig({
    gateway: { host: "127.0.0.1", port: 4000 },
    providers: PROVIDERS,
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        circuitBreaker: { ttfbTimeoutMs: 999_999 },
      },
    },
    history: [],
  });
  assert.equal(n2.modelFamilies.opus.circuitBreaker.ttfbTimeoutMs, 120_000, "高于上限 clamp 到 120000");

  const n3 = normalizeConfig({
    gateway: { host: "127.0.0.1", port: 4000 },
    providers: PROVIDERS,
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        circuitBreaker: { ttfbTimeoutMs: 45000 },
      },
    },
    history: [],
  });
  assert.equal(n3.modelFamilies.opus.circuitBreaker.ttfbTimeoutMs, 45_000, "合法值原样保留");
});

test("normalizeCircuitBreaker: failureThreshold/successThreshold clamp 到 ≥1", () => {
  const n = normalizeConfig({
    gateway: { host: "127.0.0.1", port: 4000 },
    providers: PROVIDERS,
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        circuitBreaker: { failureThreshold: 0, successThreshold: -5, coolDownMs: 5000 },
      },
    },
    history: [],
  });
  assert.equal(n.modelFamilies.opus.circuitBreaker.failureThreshold, 1, "failureThreshold≥1");
  assert.equal(n.modelFamilies.opus.circuitBreaker.successThreshold, 1, "successThreshold≥1");
  assert.equal(n.modelFamilies.opus.circuitBreaker.coolDownMs, 5000);
});

test("normalizeCircuitBreaker: 空对象/无效对象返回 null", () => {
  const n = normalizeConfig({
    gateway: { host: "127.0.0.1", port: 4000 },
    providers: PROVIDERS,
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        circuitBreaker: {},
      },
    },
    history: [],
  });
  assert.equal(n.modelFamilies.opus.circuitBreaker, null, "空对象 → null（用全局默认）");
});

// ===== admin PUT /families/:family/candidates 端到端 =====

function makeTestConfig() {
  return {
    version: 3,
    gateway: { host: "127.0.0.1", port: 4000, sharedToken: null, adminToken: null },
    providers: structuredClone(PROVIDERS),
    circuitBreaker: null,
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        strategy: "failover",
        circuitBreaker: null,
      },
      sonnet: { candidates: [], strategy: "failover", circuitBreaker: null },
      "sonnet[1m]": { candidates: [], strategy: "failover", circuitBreaker: null },
      haiku: { candidates: [], strategy: "failover", circuitBreaker: null },
    },
    history: [],
  };
}

async function startAdminServer(config) {
  const metrics = {};
  const handler = createGatewayRequestHandler(config, metrics, {});
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

test("admin PUT candidates 带 circuitBreaker：正确存入 config", async (t) => {
  const config = makeTestConfig();
  // spy：只更新内存 config，不写磁盘
  __setSaveConfigForTest(async () => {});
  t.after(() => __setSaveConfigForTest(null));

  const { server, url } = await startAdminServer(config);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`${url}/admin/families/opus/candidates`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
      strategy: "failover",
      circuitBreaker: { ttfbTimeoutMs: 60000, failureThreshold: 5 },
    }),
  });
  assert.equal(res.status, 200);

  assert.equal(config.modelFamilies.opus.circuitBreaker.ttfbTimeoutMs, 60000);
  assert.equal(config.modelFamilies.opus.circuitBreaker.failureThreshold, 5);
});

test("admin PUT candidates 不传 circuitBreaker：保持旧值回填（向后兼容）", async (t) => {
  const config = makeTestConfig();
  // 预设一个 circuitBreaker 覆盖
  config.modelFamilies.opus.circuitBreaker = { ttfbTimeoutMs: 45000, failureThreshold: 2 };
  __setSaveConfigForTest(async () => {});
  t.after(() => __setSaveConfigForTest(null));

  const { server, url } = await startAdminServer(config);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`${url}/admin/families/opus/candidates`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
      strategy: "failover",
      // 不传 circuitBreaker
    }),
  });
  assert.equal(res.status, 200);

  // 旧值应被保留
  assert.equal(config.modelFamilies.opus.circuitBreaker.ttfbTimeoutMs, 45000);
  assert.equal(config.modelFamilies.opus.circuitBreaker.failureThreshold, 2);
});

test("admin PUT candidates 传 circuitBreaker:null：清除覆盖", async (t) => {
  const config = makeTestConfig();
  config.modelFamilies.opus.circuitBreaker = { ttfbTimeoutMs: 45000, failureThreshold: 2 };
  __setSaveConfigForTest(async () => {});
  t.after(() => __setSaveConfigForTest(null));

  const { server, url } = await startAdminServer(config);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`${url}/admin/families/opus/candidates`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
      strategy: "failover",
      circuitBreaker: null,
    }),
  });
  assert.equal(res.status, 200);

  assert.equal(config.modelFamilies.opus.circuitBreaker, null, "null 清除覆盖，用全局默认");
});
