// 向后兼容回归：旧单四元组 family 形态（v3.1.0 及更早）在升级后必须零迁移可用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../config.mjs";
import { resolveCandidates, resolveBoundRoute, getFamilyBinding } from "../route-utils.mjs";

const PROVIDERS = {
  p1: {
    id: "p1", name: "p1", authHeader: "Authorization", authScheme: "Bearer",
    baseUrls: [{ id: "b1", url: "http://127.0.0.1:9", note: "n" }],
    keys: [{ id: "k1", token: "tok", note: "n", createdAt: "1970-01-01T00:00:00.000Z" }],
    models: [{ id: "m1", model: "glm-4", name: "glm" }],
  },
};

test("normalizeConfig 把旧单四元组 family 升级为 candidates 列表", () => {
  const old = {
    gateway: { host: "127.0.0.1", port: 4000, sharedToken: null },
    providers: PROVIDERS,
    modelFamilies: { opus: { providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" } },
    history: [],
  };
  const n = normalizeConfig(old);
  const opus = n.modelFamilies.opus;
  assert.ok(Array.isArray(opus.candidates), "应升级为 candidates 数组");
  assert.equal(opus.candidates.length, 1);
  assert.equal(opus.candidates[0].providerId, "p1");
  assert.equal(opus.candidates[0].modelId, "m1");
  assert.equal(opus.strategy, "failover");
  assert.equal(opus.circuitBreaker, null);
  assert.equal(n.circuitBreaker, null, "顶层应补 circuitBreaker:null");
  assert.equal(n.version, 3, "version 不变（纯加字段）");
});

test("normalizeConfig 保留新形态 candidates + strategy + circuitBreaker", () => {
  const modern = {
    gateway: { host: "127.0.0.1", port: 4000, sharedToken: null },
    providers: PROVIDERS,
    modelFamilies: {
      opus: {
        candidates: [{ providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" }],
        strategy: "round_robin",
        circuitBreaker: { failureThreshold: 3, coolDownMs: 5000 },
      },
    },
    circuitBreaker: { failureThreshold: 10 },
    history: [],
  };
  const n = normalizeConfig(modern);
  assert.equal(n.modelFamilies.opus.candidates.length, 1);
  assert.equal(n.modelFamilies.opus.strategy, "round_robin");
  assert.equal(n.modelFamilies.opus.circuitBreaker.failureThreshold, 3);
  assert.equal(n.circuitBreaker.failureThreshold, 10);
});

test("未 normalize 的旧形态内存 config 仍可被 resolve 路由（兼容层）", () => {
  const legacy = {
    gateway: { host: "127.0.0.1", port: 4000 },
    providers: PROVIDERS,
    modelFamilies: { opus: { providerId: "p1", baseUrlId: "b1", keyId: "k1", modelId: "m1" } },
  };
  const binding = getFamilyBinding(legacy, "opus");
  assert.equal(binding.candidates.length, 1);
  assert.equal(binding.strategy, "failover");

  const resolved = resolveCandidates(legacy, "opus");
  assert.equal(resolved.kind, "ok");
  assert.equal(resolved.candidates.length, 1);
  assert.equal(resolved.candidates[0].providerId, "p1");
  assert.equal(resolved.candidates[0].upstreamModel, "glm-4");

  const bound = resolveBoundRoute(legacy, "opus");
  assert.equal(bound.kind, "ok");
  assert.equal(bound.providerId, "p1");
});
