// debug-log.mjs
// 问题级日志持久化：当 failover / 熔断 / 上游异常 / 连接失败 / 流中断等发生时，
// 自动把相关日志行追加写到 data/debug-YYYYMMDD.log，不再依赖用户手动从 CLI 复制。
//
// 设计与 usage-store.mjs 一致：
// - 按天分文件（追加写天然原子，避免单文件无限增长）
// - 失败静默（绝不影响主请求路径）
// - 惰性清理（写入时检查，每 6h 最多清一次，删 7 天前的文件）
//
// 调用方：route-utils.mjs 的 emitLog 在每条日志通过时判定是否问题级，是则异步调 writeDebugLog。
// 写入不 await、不 await、不 await——fire and forget。

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEBUG_DIR = path.join(__dirname, "data");
const DEBUG_FILE_PREFIX = "debug-";
const DEBUG_FILE_SUFFIX = ".log";
const RETENTION_DAYS = 7;
const CLEANUP_INTERVAL_MS = 6 * 3600_000; // 每小时最多清理一次

// 问题级日志前缀：只有这些开头的日志行才写 debug 文件。
// 已从源码 grep 确认全部日志前缀格式，确保不遗漏。
const PROBLEM_PREFIXES = [
  "[error]",         // gateway-error / stream-error / responses-* / admin-error
  "[warn]",          // retry TTFB/connection/429/5xx/generic / usage warn
  "[failover]",      // 所有 failover 切换
  "[info][breaker]", // 熔断状态转换（probe ok / HALF_OPEN→CLOSED 等）
];

export function isProblemLog(line) {
  if (typeof line !== "string" || line.length === 0) return false;
  return PROBLEM_PREFIXES.some((p) => line.startsWith(p));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function dayKey(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

function debugFilePath(day = dayKey()) {
  return path.join(DEBUG_DIR, `${DEBUG_FILE_PREFIX}${day}${DEBUG_FILE_SUFFIX}`);
}

// 进程内一次性建目录：data/ 通常已被 config.mjs 建好，这里兜底。
let dirEnsured = false;
async function ensureDebugDir() {
  if (dirEnsured) return;
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // ignore：appendFile 失败时静默
  }
}

// 惰性清理：超过保留期的旧文件。每 6h 最多跑一次。
let lastCleanupTs = 0;
async function cleanupOldDebugLogs() {
  const now = Date.now();
  if (now - lastCleanupTs < CLEANUP_INTERVAL_MS) return;
  lastCleanupTs = now;

  let files;
  try {
    files = await readdir(DEBUG_DIR);
  } catch {
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffDay = dayKey(cutoff);

  for (const name of files) {
    if (!name.startsWith(DEBUG_FILE_PREFIX) || !name.endsWith(DEBUG_FILE_SUFFIX)) continue;
    const day = name.slice(DEBUG_FILE_PREFIX.length, -DEBUG_FILE_SUFFIX.length);
    if (day.length === 8 && day < cutoffDay) {
      try {
        await unlink(path.join(DEBUG_DIR, name));
      } catch {
        // ignore
      }
    }
  }
}

// 追加一行到当天的 debug 文件。带时间戳前缀，失败静默。
// 异步调用方不需要 await（fire and forget）。
export async function writeDebugLog(line) {
  await ensureDebugDir();
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}\n`;
  try {
    await appendFile(debugFilePath(), entry, "utf8");
  } catch {
    // 静默：debug 日志不能影响主路径
  }
  // 惰性清理（不 await 失败）
  cleanupOldDebugLogs().catch(() => {});
}

// 仅供测试：重置目录缓存和清理时间戳，保证测试隔离。
export function __resetForTest() {
  dirEnsured = false;
  lastCleanupTs = 0;
}
