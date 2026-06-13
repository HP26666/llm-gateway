import { exec } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";

const execAsync = promisify(exec);

const SAFE_PID = /^\d{1,8}$/;

export async function checkPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    const cleanup = (result) => {
      try {
        tester.removeAllListeners();
      } catch {
        // ignore
      }
      resolve(result);
    };
    tester.once("error", () => cleanup(false));
    tester.once("listening", () => {
      tester.close(() => cleanup(true));
    });
    tester.listen(port, host);
  });
}

function parseNetstatListeningPid(stdout, port) {
  const lines = String(stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddr = parts[1] || "";
    if (!localAddr.endsWith(`:${port}`)) continue;
    const state = parts[3] || "";
    if (state.toUpperCase() !== "LISTENING") continue;
    const pidStr = parts[parts.length - 1];
    if (!SAFE_PID.test(pidStr)) continue;
    const pid = Number(pidStr);
    if (pid === 0) continue;
    return pid;
  }
  return null;
}

async function describeProcessWindows(pid) {
  try {
    const { stdout } = await execAsync(
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { windowsHide: true },
    );
    const firstLine = String(stdout || "").split(/\r?\n/)[0] || "";
    if (!firstLine.trim() || firstLine.startsWith("信息")) {
      return { name: "?", cmdline: "" };
    }
    const cells = firstLine.split(/","/).map((s) => s.replace(/^"|"$/g, ""));
    const name = cells[0] || "?";
    return { name, cmdline: "" };
  } catch {
    return { name: "?", cmdline: "" };
  }
}

async function describeProcessPosix(pid) {
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o comm=,args=`);
    const line = String(stdout || "").trim();
    if (!line) {
      return { name: "?", cmdline: "" };
    }
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) {
      return { name: line, cmdline: "" };
    }
    const name = line.slice(0, spaceIdx);
    const cmdline = line.slice(spaceIdx + 1);
    return { name, cmdline };
  } catch {
    return { name: "?", cmdline: "" };
  }
}

async function describeProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { name: "?", cmdline: "" };
  }
  if (process.platform === "win32") {
    return describeProcessWindows(pid);
  }
  return describeProcessPosix(pid);
}

async function findPortOccupantWindows(port) {
  try {
    const { stdout } = await execAsync(`netstat -ano -p TCP`, { windowsHide: true });
    const pid = parseNetstatListeningPid(stdout, port);
    if (!pid) {
      return null;
    }
    const info = await describeProcessWindows(pid);
    return { pid, ...info };
  } catch {
    return null;
  }
}

async function findPortOccupantMac(port) {
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    const lines = String(stdout || "").split(/\r?\n/).slice(1);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const pidStr = parts[1];
      if (!SAFE_PID.test(pidStr)) continue;
      const pid = Number(pidStr);
      if (pid === 0) continue;
      const info = await describeProcessPosix(pid);
      return { pid, name: info.name || parts[0], cmdline: info.cmdline };
    }
    return null;
  } catch {
    return null;
  }
}

async function findPortOccupantLinux(port) {
  try {
    const { stdout } = await execAsync(`ss -lptn sport = :${port}`);
    const lines = String(stdout || "").split(/\r?\n/).slice(1);
    for (const line of lines) {
      const match = line.match(/pid=(\d+)/);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isFinite(pid) || pid === 0) continue;
      const info = await describeProcessPosix(pid);
      return { pid, ...info };
    }
    return null;
  } catch {
    return null;
  }
}

export async function findPortOccupant(port) {
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  if (process.platform === "win32") {
    return findPortOccupantWindows(port);
  }
  if (process.platform === "darwin") {
    return findPortOccupantMac(port);
  }
  return findPortOccupantLinux(port);
}

export async function killProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      await execAsync(`taskkill /PID ${pid} /F`, { windowsHide: true });
    } else {
      await execAsync(`kill -9 ${pid}`);
    }
    return true;
  } catch {
    return false;
  }
}

export function isValidPort(value) {
  const port = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(port) && port > 0 && port <= 65535;
}
