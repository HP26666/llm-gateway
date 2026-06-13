import http from "node:http";

export function createGatewayRuntime({ config, requestHandler }) {
  let server = null;
  let currentHost = config.gateway.host;
  let currentPort = config.gateway.port;

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

  async function restartOnPort(newPort) {
    if (!server) {
      throw new Error("runtime has not started");
    }
    if (!Number.isFinite(newPort) || newPort <= 0 || newPort > 65535) {
      throw new Error(`invalid port: ${newPort}`);
    }
    if (newPort === currentPort) {
      return { from: currentPort, to: newPort, changed: false };
    }

    const oldServer = server;
    const previousPort = currentPort;
    const host = currentHost;

    // 事务式：先尝试在新端口起 server，成功后再关闭旧的。
    // 失败时旧 server 不动，调用方收到错误，对外仍可服务。
    const candidate = http.createServer(requestHandler);
    try {
      await listen(candidate, host, newPort);
    } catch (error) {
      const message = error && typeof error === "object" && "code" in error
        ? `${error.code}: ${error.message}`
        : (error?.message || String(error));
      // 立刻清理失败的 candidate
      try {
        candidate.close();
      } catch {
        // ignore
      }
      throw new Error(`failed to listen on ${host}:${newPort}: ${message}`);
    }

    // 新端口已 listen，关闭旧 server
    await new Promise((resolve) => {
      oldServer.close(() => resolve());
    });

    server = candidate;
    currentPort = newPort;
    config.gateway.port = newPort;

    return { from: previousPort, to: newPort, changed: true };
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
    restartOnPort,
    getBaseUrl,
    getServer,
    getHost,
    getPort,
    isRunning,
  };
}
