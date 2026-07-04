import http from "http";
import https from "https";
import tls from "tls";
import { URL } from "url";

function getProxyUrl(target: URL): URL | null {
  if (shouldBypassProxy(target.hostname)) return null;

  const proxy =
    target.protocol === "https:"
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;

  return proxy ? new URL(proxy) : null;
}

function shouldBypassProxy(hostname: string): boolean {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (!noProxy) return false;

  return noProxy.split(",").some((entry) => {
    const rule = entry.trim();
    if (!rule) return false;
    if (rule === "*") return true;
    if (rule.startsWith(".")) return hostname.endsWith(rule);
    return hostname === rule || hostname.endsWith(`.${rule}`);
  });
}

function proxyHeaders(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};

  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  const token = Buffer.from(`${username}:${password}`).toString("base64");

  return {
    "Proxy-Authorization": `Basic ${token}`,
  };
}

export async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const target = new URL(url);
  const proxy = getProxyUrl(target);
  const body = proxy
    ? await requestViaProxy(target, proxy, timeoutMs)
    : await requestDirect(target, timeoutMs);

  return JSON.parse(body) as T;
}

function requestDirect(target: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(
      target,
      {
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => collectResponse(res, resolve, reject)
    );

    req.on("timeout", () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function requestViaProxy(target: URL, proxy: URL, timeoutMs: number): Promise<string> {
  if (target.protocol !== "https:") {
    return requestHttpViaProxy(target, proxy, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    const targetPort = Number(target.port || 443);
    const connectReq = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        ...proxyHeaders(proxy),
      },
      timeout: timeoutMs,
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed with status ${res.statusCode}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
      });

      tlsSocket.on("secureConnect", () => {
        const req = https.request(
          {
            hostname: target.hostname,
            port: targetPort,
            path: `${target.pathname}${target.search}`,
            method: "GET",
            agent: false,
            createConnection: () => tlsSocket,
            timeout: timeoutMs,
            headers: {
              Host: target.host,
            },
          },
          (response) => collectResponse(response, resolve, reject)
        );

        req.on("timeout", () => {
          req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
        });
        req.on("error", reject);
        req.end();
      });

      tlsSocket.on("error", reject);
    });

    connectReq.on("timeout", () => {
      connectReq.destroy(new Error(`proxy CONNECT timeout after ${timeoutMs}ms`));
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}

function requestHttpViaProxy(target: URL, proxy: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: proxy.hostname,
        port: Number(proxy.port || 80),
        method: "GET",
        path: target.href,
        timeout: timeoutMs,
        headers: {
          Host: target.host,
          ...proxyHeaders(proxy),
        },
      },
      (res) => collectResponse(res, resolve, reject)
    );

    req.on("timeout", () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

function collectResponse(
  res: http.IncomingMessage,
  resolve: (body: string) => void,
  reject: (err: Error) => void
): void {
  const chunks: Buffer[] = [];

  res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  res.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
      reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      return;
    }
    resolve(body);
  });
  res.on("error", reject);
}
