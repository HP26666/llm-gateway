// admin 鉴权(adminToken / X-Admin-Token)+ SSRF 防护(baseUrl 校验)测试。
// 走真实 HTTP endpoint 验证:
//  - adminToken=null:无 header 可访问(向后兼容)
//  - adminToken 已设:缺/错 token → 401,正确 token → 200/写成功
//  - SSRF:内网/回环/链路本地/保留段/非 http(s) baseUrl → 400;公网域名/IP 放行
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGatewayRequestHandler } from "../server.mjs";
import { __setSaveConfigForTest } from "../admin.mjs";

function makeConfig(overrides = {}) {
  const gateway = {
    host: "127.0.0.1",
    port: 18900,
    sharedToken: null,
    adminToken: null,
    ...(overrides.gateway || {}),
  };
  return {
    gateway,
    providers: {},
    circuitBreaker: null,
    modelFamilies: {
      opus: { candidates: [], strategy: "failover", circuitBreaker: null },
      sonnet: { candidates: [], strategy: "failover", circuitBreaker: null },
      "sonnet[1m]": { candidates: [], strategy: "failover", circuitBreaker: null },
      haiku: { candidates: [], strategy: "failover", circuitBreaker: null },
    },
    history: [],
  };
}

// 起一个仅绑 admin handler 的临时 server;saveConfig 用空 spy 不落盘。
async function withAdminServer(config, fn) {
  __setSaveConfigForTest(async () => {});
  const handler = createGatewayRequestHandler(config, {});
  const server = createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
    __setSaveConfigForTest(null);
  }
}

test("adminToken=null:无 header 可访问(向后兼容)", async () => {
  await withAdminServer(makeConfig(), async (base) => {
    const res = await fetch(`${base}/admin/config`);
    assert.equal(res.status, 200);
  });
});

test("adminToken 已设:缺 token / 错 token → 401,正确 token → 200", async () => {
  const config = makeConfig({ gateway: { adminToken: "s3cret-key" } });
  await withAdminServer(config, async (base) => {
    const noHeader = await fetch(`${base}/admin/config`);
    assert.equal(noHeader.status, 401);

    const wrong = await fetch(`${base}/admin/config`, {
      headers: { "x-admin-token": "wrong" },
    });
    assert.equal(wrong.status, 401);

    const right = await fetch(`${base}/admin/config`, {
      headers: { "x-admin-token": "s3cret-key" },
    });
    assert.equal(right.status, 200);
  });
});

test("adminToken 已设:写接口同样需要正确 token", async () => {
  const config = makeConfig({ gateway: { adminToken: "s3cret-key" } });
  await withAdminServer(config, async (base) => {
    const blocked = await fetch(`${base}/admin/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p1" }),
    });
    assert.equal(blocked.status, 401);

    const ok = await fetch(`${base}/admin/providers`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "s3cret-key" },
      body: JSON.stringify({ name: "p1" }),
    });
    assert.equal(ok.status, 201);
  });
});

test("SSRF:拒绝内网/回环/链路本地/保留段/非 http(s) baseUrl", async () => {
  await withAdminServer(makeConfig(), async (base) => {
    const created = await fetch(`${base}/admin/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p1" }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    const pid = body.provider.id;

    const bad = [
      "http://127.0.0.1/",
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://0.0.0.0/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "ftp://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ];
    for (const url of bad) {
      const res = await fetch(`${base}/admin/providers/${pid}/baseUrls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      assert.equal(res.status, 400, `expected 400 for ${url}, got ${res.status}`);
    }

    // 公网域名 + 公网 IP 放行
    for (const url of ["https://api.example.com/", "https://8.8.8.8/"]) {
      const res = await fetch(`${base}/admin/providers/${pid}/baseUrls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      assert.equal(res.status, 201, `expected 201 for ${url}, got ${res.status}`);
    }
  });
});

test("SSRF:createProvider 的 legacy baseUrl 同样校验", async () => {
  await withAdminServer(makeConfig(), async (base) => {
    const bad = await fetch(`${base}/admin/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p1", baseUrl: "http://169.254.169.254/" }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${base}/admin/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "p2", baseUrl: "https://api.example.com/" }),
    });
    assert.equal(ok.status, 201);
  });
});
