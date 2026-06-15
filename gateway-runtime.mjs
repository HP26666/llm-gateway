import http from "node:http";

export function createGatewayRuntime({ config, requestHandler }) {
  let server = null;
  let currentHost = config.gateway.host;
  let currentPort = config.gateway.port;
  // 端口切换并发锁：同一时刻只允许一次 preparePortSwitch 进行中。
  // admin.handleChangePort 入口检测 isSwitchInFlight 后抛 409。
  let inflightSwitch = null;

  // 追踪每个 server 的 in-flight socket，端口热切换时手工 destroy，
  // 避免 oldServer.close() 等待 keep-alive 连接（包含发起切换的 PATCH 请求本身）而死锁。
  const trackedSockets = new Map();

  function trackServer(s) {
    const set = new Set();
    trackedSockets.set(s, set);
    s.on("connection", (socket) => {
      set.add(socket);
      socket.once("close", () => set.delete(socket));
    });
  }

  function destroyTrackedSockets(s, excludeSocket = null) {
    const set = trackedSockets.get(s);
    if (!set) return;
    for (const socket of set) {
      if (socket === excludeSocket) continue;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    trackedSockets.delete(s);
  }

  function refreshHostPort() {
    currentHost = config.gateway.host;
    currentPort = config.gateway.port;
  }

  function listen(serverInstance, host, port) {
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        serverInstance?.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        serverInstance?.removeListener("error", onError);
        resolve(serverInstance);
      };
      serverInstance.once("error", onError);
      serverInstance.once("listening", onListening);
      serverInstance.listen(port, host);
    });
  }

  async function start() {
    refreshHostPort();
    server = http.createServer(requestHandler);
    trackServer(server);
    await listen(server, currentHost, currentPort);
    return server;
  }

  function close() {
    return new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      const closing = server;
      server = null;
      closing.close(() => resolve());
    });
  }

  // V5.2 §5.1：并发锁必须在第一个 await 之前占住。
  // - 第二个真正并发的 preparePortSwitch 必须稳定失败，message 匹配 'already in progress'。
  // - prepare 内部任意阶段失败时正确释放锁；commit/rollback 完成后释放锁。
  // - 锁本身使用 sentinel Promise：commit/rollback 中一个先完成即释放。
  async function preparePortSwitch(newPort, options = {}) {
    if (inflightSwitch) {
      throw new Error("port switch already in progress");
    }
    if (!server) {
      throw new Error("runtime has not started");
    }
    if (!Number.isFinite(newPort) || newPort <= 0 || newPort > 65535) {
      throw new Error(`invalid port: ${newPort}`);
    }

    // 立即占住锁（任何 await 之前），确保真正并发的第二个 prepare 看到 inflightSwitch
    // 并稳定抛出 'already in progress'。锁由本事务的 commit / rollback 释放。
    let activeLock = null;
    const sentinel = new Promise((resolve) => { activeLock = resolve; });
    inflightSwitch = sentinel;

    const oldServer = server;
    const previousPort = currentPort;
    const host = currentHost;
    const excludeSocket = options.excludeSocket ?? null;
    if (newPort === currentPort) {
      // 不需要切换：返回一个 no-op 事务（commit 直接 resolve，rollback 也不做事）。
      // noop 也算完成一个事务，释放锁。
      const releaseOnce = (() => {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (inflightSwitch === sentinel) inflightSwitch = null;
          activeLock();
        };
      })();
      return {
        noop: true,
        previousPort,
        newPort,
        commit: async () => {
          releaseOnce();
          return { from: previousPort, to: newPort, changed: false };
        },
        rollback: async () => { releaseOnce(); },
        candidate: null,
        oldServer,
        host,
        excludeSocket,
      };
    }

    // 校验阶段：先尝试在新端口起 candidate。
    const candidate = http.createServer(requestHandler);
    trackServer(candidate);
    try {
      await listen(candidate, host, newPort);
    } catch (error) {
      // listen 失败：释放锁，关闭 candidate，向上抛错
      if (inflightSwitch === sentinel) inflightSwitch = null;
      activeLock();
      const message = error && typeof error === "object" && "code" in error
        ? `${error.code}: ${error.message}`
        : (error?.message || String(error));
      try { candidate.close(); } catch { /* ignore */ }
      trackedSockets.delete(candidate);
      throw new Error(`failed to listen on ${host}:${newPort}: ${message}`);
    }

    let committed = false;
    let rolledBack = false;

    function releaseLockOnce() {
      if (inflightSwitch === sentinel) inflightSwitch = null;
      activeLock();
    }

    async function commit() {
      if (committed) return { from: previousPort, to: newPort, changed: true };
      if (rolledBack) throw new Error("port switch already rolled back");

      // 关闭旧 server。关键：close() 不会主动断 keep-alive，PATCH 自占 socket 不 destroy 会死锁。
      const closePromise = new Promise((resolve) => {
        oldServer.close(() => resolve());
      });
      destroyTrackedSockets(oldServer, excludeSocket);
      if (!excludeSocket) {
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2000));
        await Promise.race([closePromise, timeoutPromise]);
      } else {
        closePromise.catch(() => {});
      }

      server = candidate;
      currentPort = newPort;
      committed = true;
      releaseLockOnce();
      return { from: previousPort, to: newPort, changed: true };
    }

    async function rollback() {
      if (committed) throw new Error("port switch already committed");
      if (rolledBack) {
        releaseLockOnce();
        return;
      }
      // 关闭 candidate，保留 old server
      try { candidate.close(); } catch { /* ignore */ }
      trackedSockets.delete(candidate);
      rolledBack = true;
      releaseLockOnce();
    }

    return {
      noop: false,
      previousPort,
      newPort,
      commit,
      rollback,
      candidate,
      oldServer,
      host,
      excludeSocket,
    };
  }

  function isSwitchInFlight() {
    return inflightSwitch !== null;
  }

  function getBaseUrl() {
    return `http://${currentHost}:${currentPort}`;
  }

  function getServer() {
    return server;
  }

  function getHost() {
    return currentHost;
  }

  function getPort() {
    return currentPort;
  }

  function isRunning() {
    return server !== null && server.listening === true;
  }

  return {
    start,
    close,
    preparePortSwitch,
    isSwitchInFlight,
    getBaseUrl,
    getServer,
    getHost,
    getPort,
    isRunning,
  };
}
