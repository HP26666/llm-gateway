// 回归：CLI 主界面 describeRouteLabel 必须兼容新形态（candidates 列表）family。
// 历史缺陷：升级 candidates schema 后，describeRouteLabel 仍直接读 binding 顶层
// providerId 等字段，导致 CLI 主界面四个 family 全显示 "(未配置)"。
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../config.mjs";
import { describeRouteLabel } from "../cli.mjs";

const PROVIDERS = {
  glm: {
    id: "glm", name: "GLM", authHeader: "Authorization", authScheme: "Bearer",
    baseUrls: [{ id: "b_glm", url: "https://x/api/anthropic", note: "default" }],
    keys: [{ id: "key_glm", token: "tok", note: "default", createdAt: "1970-01-01T00:00:00.000Z" }],
    models: [{ id: "model_glm_51", model: "glm-5.1", name: "GLM 5.1" }],
  },
};

function configWith(familyBinding) {
  return normalizeConfig({
    version: 3,
    gateway: { host: "127.0.0.1", port: 4000, sharedToken: null },
    providers: PROVIDERS,
    modelFamilies: { opus: familyBinding },
    history: [],
  });
}

const QUAD = { providerId: "glm", baseUrlId: "b_glm", keyId: "key_glm", modelId: "model_glm_51" };

test("describeRouteLabel 对新形态 candidates binding 显示主候选（不显示未配置）", () => {
  const config = configWith({ candidates: [QUAD], strategy: "failover", circuitBreaker: null });
  const label = describeRouteLabel(config, config.modelFamilies.opus);
  assert.match(label, /GLM/);
  assert.doesNotMatch(label, /未配置|失效/);
});

test("describeRouteLabel 对旧四元组 binding 向后兼容", () => {
  const config = configWith(QUAD);
  const label = describeRouteLabel(config, config.modelFamilies.opus);
  assert.match(label, /GLM/);
});

test("describeRouteLabel 空 candidates binding 返回 (未配置)", () => {
  const config = configWith({ candidates: [], strategy: "failover", circuitBreaker: null });
  assert.equal(describeRouteLabel(config, config.modelFamilies.opus), "(未配置)");
});

test("describeRouteLabel 候选失效（provider 已删）返回 (配置已失效)", () => {
  const config = configWith({ candidates: [QUAD], strategy: "failover", circuitBreaker: null });
  const noProvider = { ...config, providers: {} };
  assert.equal(describeRouteLabel(noProvider, config.modelFamilies.opus), "(配置已失效)");
});
