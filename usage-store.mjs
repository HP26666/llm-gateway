// usage-store.mjs
// 用量统计：追加写 jsonl + 内存聚合。独立于 config/saveQueue——追加写天然原子，
// 不需要事务；按天分文件避免单文件无限增长。
//
// 数据流：server.mjs 每个请求完成时 recordUsage 一行 → data/usage-YYYYMMDD.jsonl
//        admin /admin/usage/:range 读若干天文件 → 聚合 → CLI 渲染图表
//
// 文件格式（每行一个 JSON）：
//   {"ts":"2026-06-26T10:21:02.123Z","family":"opus","providerId":"glm",
//    "modelId":"m_glm_x","keyId":"k_glm","in":120,"out":350,
//    "cacheR":0,"cacheW":0,"status":200,"ms":842}

import { appendFile, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logRaw } from "./route-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USAGE_DIR = path.join(__dirname, "data");
const USAGE_FILE_PREFIX = "usage-";
const USAGE_FILE_SUFFIX = ".jsonl";
const RETENTION_DAYS = 30;

const VALID_RANGES = new Set(["today", "7d", "30d"]);
const RANGE_DAYS = { today: 1, "7d": 7, "30d": 30 };

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 日期 → 文件名日期键 YYYYMMDD（本地时区，符合用户"今天"直觉）。
function dayKey(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function usageFilePath(day = dayKey()) {
  return path.join(USAGE_DIR, `${USAGE_FILE_PREFIX}${day}${USAGE_FILE_SUFFIX}`);
}

// 进程内一次性建目录：data/ 通常已被 config.mjs 建好，这里兜底。
let dirEnsured = false;
async function ensureUsageDir() {
  if (dirEnsured) return;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(USAGE_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // ignore：appendFile 失败时会在 recordUsage 内降级记录警告
  }
}

// 记录一条用量。失败只 warn，绝不影响主请求路径。
export async function recordUsage(entry) {
  await ensureUsageDir();
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      family: entry.family ?? null,
      providerId: entry.providerId ?? null,
      modelId: entry.modelId ?? null,
      keyId: entry.keyId ?? null,
      in: Number(entry.in) || 0,
      out: Number(entry.out) || 0,
      cacheR: Number(entry.cacheR) || 0,
      cacheW: Number(entry.cacheW) || 0,
      status: Number(entry.status) || 0,
      ms: Number(entry.ms) || 0,
    }) + "\n";
  try {
    await appendFile(usageFilePath(), line, "utf8");
  } catch (err) {
    logRaw(`[warn][usage] failed to record: ${err.message}`);
  }
}

// 读取某一天文件的全部条目。文件不存在/损坏行直接跳过。
async function readDayEntries(day) {
  let raw;
  try {
    raw = await readFile(usageFilePath(day), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // 单行损坏不影响其余行
    }
  }
  return entries;
}

// 聚合用量数据。range: "today" | "7d" | "30d"。
// 返回结构供 CLI 直接渲染：
//   { range, timeBuckets[], bucketLabels[], peak, peakLabel,
//     byFamily{ fam -> {tokens,reqs,in,out} }, byProvider{ pid -> {tokens,reqs} },
//     totals{ in,out,cacheR,cacheW,reqs,errors,total } }
export async function aggregateUsage(range) {
  const normalizedRange = VALID_RANGES.has(range) ? range : "today";
  const days = RANGE_DAYS[normalizedRange];

  const now = new Date();
  // cutoff = 范围最早一天的 00:00（本地时区）
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  cutoff.setHours(0, 0, 0, 0);

  // 并行读取范围内每天的文件
  const dayDates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dayDates.push(d);
  }
  const perDay = await Promise.all(dayDates.map((d) => readDayEntries(dayKey(d))));
  const entries = perDay.flat();

  // 按 cutoff 过滤（处理跨午夜边界：今日文件可能含昨晚的条目）
  const cutoffMs = cutoff.getTime();
  const filtered = entries.filter((e) => {
    const t = new Date(e.ts).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  });

  const isHourly = days === 1;
  const bucketCount = isHourly ? 24 : days;
  const timeBuckets = new Array(bucketCount).fill(0);

  const byFamily = {};
  const byProvider = {};
  let totalIn = 0;
  let totalOut = 0;
  let totalCacheR = 0;
  let totalCacheW = 0;
  let totalReqs = 0;
  let errorReqs = 0;

  const todayKey = dayKey(now);
  for (const e of filtered) {
    const inT = Number(e.in) || 0;
    const outT = Number(e.out) || 0;
    const tokens = inT + outT;
    const status = Number(e.status) || 0;

    totalIn += inT;
    totalOut += outT;
    totalCacheR += Number(e.cacheR) || 0;
    totalCacheW += Number(e.cacheW) || 0;
    totalReqs += 1;
    if (status >= 400) errorReqs += 1;

    // 时间桶
    const d = new Date(e.ts);
    if (isHourly) {
      if (dayKey(d) === todayKey) {
        const h = d.getHours();
        if (h >= 0 && h < 24) timeBuckets[h] += tokens;
      }
    } else {
      const dayDiff = Math.floor((d.getTime() - cutoffMs) / 86_400_000);
      if (dayDiff >= 0 && dayDiff < bucketCount) {
        timeBuckets[dayDiff] += tokens;
      }
    }

    // 按 family
    const fam = e.family || "(unknown)";
    if (!byFamily[fam]) byFamily[fam] = { tokens: 0, reqs: 0, in: 0, out: 0 };
    byFamily[fam].tokens += tokens;
    byFamily[fam].reqs += 1;
    byFamily[fam].in += inT;
    byFamily[fam].out += outT;

    // 按 provider
    const prov = e.providerId || "(unknown)";
    if (!byProvider[prov]) byProvider[prov] = { tokens: 0, reqs: 0 };
    byProvider[prov].tokens += tokens;
    byProvider[prov].reqs += 1;
  }

  // 桶标签
  const bucketLabels = isHourly
    ? Array.from({ length: 24 }, (_, h) => pad2(h))
    : dayDates.map((d) => `${d.getMonth() + 1}/${d.getDate()}`);

  // 峰值
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < timeBuckets.length; i++) {
    if (timeBuckets[i] > peak) {
      peak = timeBuckets[i];
      peakIdx = i;
    }
  }

  return {
    range: normalizedRange,
    timeBuckets,
    bucketLabels,
    peak,
    peakLabel: bucketLabels[peakIdx] ?? "",
    byFamily,
    byProvider,
    totals: {
      in: totalIn,
      out: totalOut,
      cacheR: totalCacheR,
      cacheW: totalCacheW,
      reqs: totalReqs,
      errors: errorReqs,
      total: totalIn + totalOut,
    },
  };
}

// 清理超过保留期的旧文件。惰性调用（每次查询用量时检查一次即可）。
// 失败静默：清理是锦上添花，不能影响用量查询。
let lastCleanupTs = 0;
export async function cleanupOldUsageFiles() {
  const now = Date.now();
  // 每 6 小时最多清理一次
  if (now - lastCleanupTs < 6 * 3600_000) return;
  lastCleanupTs = now;

  let files;
  try {
    files = await readdir(USAGE_DIR);
  } catch {
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffDay = dayKey(cutoff);

  for (const name of files) {
    if (!name.startsWith(USAGE_FILE_PREFIX) || !name.endsWith(USAGE_FILE_SUFFIX)) continue;
    const day = name.slice(USAGE_FILE_PREFIX.length, -USAGE_FILE_SUFFIX.length);
    if (day.length === 8 && day < cutoffDay) {
      try {
        await unlink(path.join(USAGE_DIR, name));
      } catch {
        // ignore
      }
    }
  }
}
