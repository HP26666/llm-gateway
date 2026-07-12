// admin.mjs CRUD 全覆盖测试 + 引用完整性守卫。
//
// 此前 admin-security 只测了 auth + SSRF；breaker-config/admin-tx 只测了 family candidates 和端口切换。
// 本文件覆盖此前空白的：
//   - provider update/delete
//   - baseUrl add/update/delete
//   - key add/update/delete
//   - model add/update/delete
//   - ★ 引用完整性守卫：provider/key/model/baseUrl 被 family 引用时 delete → 409
//   - family switch（单四元组 PUT）
//   - family status（GET，含 metrics）
//   - export config
//   - 各种 404（资源不存在）和 400（参数缺失）分支
//   - history 记录（family 切换后 history unshift）
//
// 走真实 HTTP endpoint，saveConfig 用 spy 不落盘。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRequestHandler } from "../server.mjs";
import { __setSaveConfigForTest } from "../admin.mjs";

function makeConfig(overrides = {}) {
  return {
    gateway: { host: "127.0.0.1", port: 18900, sharedToken: null, adminToken: null },
    providers: {},
    circuitBreaker: null,
    modelFamilies: {
      opus: { candidates: [], strategy: "failover", circuitBreaker: null },
      sonnet: { candidates: [], strategy: "failover", circuitBreaker: null },
      "sonnet[1m]": { candidates: [], strategy: "failover", circuitBreaker: null },
      haiku: { candidates: [], strategy: "failover", circuitBreaker: null },
    },
    history: [],
    ...overrides,
  };
}

async function withServer(config, fn) {
  __setSaveConfigForTest(async () => {});
  const handler = createGatewayRequestHandler(config, {});
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
    __setSaveConfigForTest(null);
  }
}

const JSON_HEADERS = { "content-type": "application/json" };

// 创建一个完整的 provider（含 baseUrl/key/model），返回 { base, pid, bid, kid, mid }。
async function createFullProvider(base, name = "p1") {
  const res = await fetch(`${base}/admin/providers`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name,
      baseUrl: "https://api.example.com",
      apiKey: "tok-1",
      model: undefined, // createProvider 不支持顺带 model，需单独加
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const pid = body.provider.id;
  const bid = body.provider.baseUrls[0].id;
  const kid = body.provider.keys[0].id;

  // 加一个 model
  const mres = await fetch(`${base}/admin/providers/${pid}/models`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: "m-v1", name: "Model V1" }),
  });
  assert.equal(mres.status, 201);
  const mbody = await mres.json();
  const mid = mbody.model.id;

  return { pid, bid, kid, mid };
}

// ===== Provider update / delete =====

test("PATCH /admin/providers/:id：更新 provider 名称", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "renamed" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider.name, "renamed");
    assert.equal(config.providers[pid].name, "renamed", "内存 config 应同步更新");
  });
});

test("PATCH /admin/providers/:id：重名冲突 → 409", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid: pid1 } = await createFullProvider(base, "alpha");
    await createFullProvider(base, "beta");
    const res = await fetch(`${base}/admin/providers/${pid1}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "beta" }), // 改成第二个的名字
    });
    assert.equal(res.status, 409);
  });
});

test("PATCH /admin/providers/:id：不存在的 provider → 404", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/admin/providers/nonexistent`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(res.status, 404);
  });
});

test("DELETE /admin/providers/:id：删除未被引用的 provider → 200", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(config.providers[pid], undefined, "内存 config 应删除");
  });
});

test("★ DELETE /admin/providers/:id：被 family 引用时 → 409（引用完整性守卫）", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, bid, kid, mid } = await createFullProvider(base);
    // 绑定到 opus family
    const bindRes = await fetch(`${base}/admin/families/opus`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: pid, baseUrlId: bid, keyId: kid, modelId: mid }),
    });
    assert.equal(bindRes.status, 200);

    // 删除被引用的 provider → 409
    const delRes = await fetch(`${base}/admin/providers/${pid}`, { method: "DELETE" });
    assert.equal(delRes.status, 409);
    const body = await delRes.json();
    assert.match(body.error.message, /used by family/i);
    // provider 应仍在
    assert.ok(config.providers[pid], "provider 不应被删除");
  });
});

// ===== baseUrl add / update / delete =====

test("POST baseUrls：新增 baseUrl（公网 URL）", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}/baseUrls`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: "https://backup.example.com", note: "backup" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.baseUrl.note, "backup");
    assert.equal(config.providers[pid].baseUrls.length, 2);
  });
});

test("POST baseUrls：缺 url → 400", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}/baseUrls`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ note: "no-url" }),
    });
    assert.equal(res.status, 400);
  });
});

test("PATCH baseUrls/:bid：更新 url + note", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, bid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}/baseUrls/${bid}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: "https://new.example.com", note: "updated" }),
    });
    assert.equal(res.status, 200);
    assert.equal(config.providers[pid].baseUrls[0].url, "https://new.example.com");
    assert.equal(config.providers[pid].baseUrls[0].note, "updated");
  });
});

test("DELETE baseUrls/:bid：删除未引用的 baseUrl → 200", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    // 再加一个 baseUrl，删这个新的（旧的仍保留）
    const addRes = await fetch(`${base}/admin/providers/${pid}/baseUrls`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ url: "https://extra.example.com" }),
    });
    const newBid = (await addRes.json()).baseUrl.id;

    const delRes = await fetch(`${base}/admin/providers/${pid}/baseUrls/${newBid}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(config.providers[pid].baseUrls.find((b) => b.id === newBid), undefined);
  });
});

test("★ DELETE baseUrls/:bid：被 family 引用时 → 409", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, bid, kid, mid } = await createFullProvider(base);
    await fetch(`${base}/admin/families/opus`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: pid, baseUrlId: bid, keyId: kid, modelId: mid }),
    });
    const delRes = await fetch(`${base}/admin/providers/${pid}/baseUrls/${bid}`, { method: "DELETE" });
    assert.equal(delRes.status, 409);
  });
});

// ===== key add / update / delete =====

test("POST keys：新增 key", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}/keys`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "new-tok", note: "second" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.key.token, /\*\*\*/, "返回的 token 应被 mask");
    assert.equal(config.providers[pid].keys.length, 2);
  });
});

test("PATCH keys/:kid：更新 token", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, kid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}/keys/${kid}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "rotated-token" }),
    });
    assert.equal(res.status, 200);
    assert.equal(config.providers[pid].keys[0].token, "rotated-token", "内存 token 应更新");
  });
});

test("★ DELETE keys/:kid：被 family 引用时 → 409", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, bid, kid, mid } = await createFullProvider(base);
    await fetch(`${base}/admin/families/opus`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: pid, baseUrlId: bid, keyId: kid, modelId: mid }),
    });
    const delRes = await fetch(`${base}/admin/providers/${pid}/keys/${kid}`, { method: "DELETE" });
    assert.equal(delRes.status, 409);
  });
});

test("DELETE keys/:kid：未被引用 → 200", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    // 加第二个 key，删它
    const addRes = await fetch(`${base}/admin/providers/${pid}/keys`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ token: "extra-tok" }),
    });
    const newKid = (await addRes.json()).key.id;
    const delRes = await fetch(`${base}/admin/providers/${pid}/keys/${newKid}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
  });
});

// ===== model add / update / delete =====

test("PATCH models/:mid：更新 model + name", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, mid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/providers/${pid}/models/${mid}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "m-v2", name: "Model V2" }),
    });
    assert.equal(res.status, 200);
    assert.equal(config.providers[pid].models[0].model, "m-v2");
    assert.equal(config.providers[pid].models[0].name, "Model V2");
  });
});

test("★ DELETE models/:mid：被 family 引用时 → 409", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, bid, kid, mid } = await createFullProvider(base);
    await fetch(`${base}/admin/families/opus`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: pid, baseUrlId: bid, keyId: kid, modelId: mid }),
    });
    const delRes = await fetch(`${base}/admin/providers/${pid}/models/${mid}`, { method: "DELETE" });
    assert.equal(delRes.status, 409);
  });
});

test("DELETE models/:mid：未被引用 → 200", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid } = await createFullProvider(base);
    // 加第二个 model，删它
    const addRes = await fetch(`${base}/admin/providers/${pid}/models`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model: "extra-m" }),
    });
    const newMid = (await addRes.json()).model.id;
    const delRes = await fetch(`${base}/admin/providers/${pid}/models/${newMid}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
  });
});

// ===== Family switch / status =====

test("PUT /admin/families/:family：切换 family 并记录 history", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, bid, kid, mid } = await createFullProvider(base);
    const res = await fetch(`${base}/admin/families/sonnet`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: pid, baseUrlId: bid, keyId: kid, modelId: mid }),
    });
    assert.equal(res.status, 200);
    assert.equal(config.modelFamilies.sonnet.candidates.length, 1);
    // history 应记一条
    assert.equal(config.history.length, 1);
    assert.equal(config.history[0].family, "sonnet");
  });
});

test("PUT /admin/families/:family：引用不存在的资源 → 404", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/admin/families/opus`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: "ghost", baseUrlId: "ghost", keyId: "ghost", modelId: "ghost" }),
    });
    assert.equal(res.status, 404);
  });
});

test("PUT /admin/families/:family：不存在的 family → 404", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/admin/families/ghost`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: "x", baseUrlId: "x", keyId: "x", modelId: "x" }),
    });
    assert.equal(res.status, 404);
  });
});

test("GET /admin/families/:family/status：返回 route + stats", async () => {
  const config = makeConfig();
  const metrics = {};
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/admin/families/opus/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.family, "opus");
    assert.equal(body.route.candidateCount, 0);
    assert.equal(body.stats.count, 0);
  });
});

// ===== Export =====

test("GET /admin/config/export：返回脱敏配置", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    await createFullProvider(base);
    const res = await fetch(`${base}/admin/config/export`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // export 走 sanitizeConfig，key token 应被 mask
    for (const provider of Object.values(body.providers)) {
      for (const key of provider.keys) {
        assert.match(key.token, /\*\*\*/, "export 的 key token 应脱敏");
      }
    }
  });
});

// ===== History =====

test("GET /admin/history：返回历史列表", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const { pid, bid, kid, mid } = await createFullProvider(base);
    await fetch(`${base}/admin/families/opus`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ providerId: pid, baseUrlId: bid, keyId: kid, modelId: mid }),
    });
    const res = await fetch(`${base}/admin/history`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.history));
    assert.ok(body.history.length >= 1);
  });
});

// ===== 不存在的 admin 路由 → 404 =====

test("未匹配的 admin 路由 → 404", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/admin/nonexistent/route`);
    assert.equal(res.status, 404);
  });
});

test("GET /admin/usage/:range：非法 range 降级为 today（不报错）", async () => {
  const config = makeConfig();
  await withServer(config, async (base) => {
    const res = await fetch(`${base}/admin/usage/invalid-range`);
    // 降级为 today，返回 200
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.range, "today");
  });
});
