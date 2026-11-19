/**
 * 最小 CONNECT 隧道代理。
 *
 * 用途：本机 hosts 把 github.com 等域名指到 127.0.0.1（Steam++ 加速器），
 * 而 Tauri CLI 内置的 rustls 不读 Windows 证书库，走 MITM 会直接断开。
 * 这个代理收到 CONNECT 后用 8.8.8.8 解析真实 IP，做纯 TCP 转发，
 * TLS 握手发生在客户端与真实服务器之间，证书链校验完全正常。
 *
 * 用法：
 *   node scripts/tunnel-proxy.js            # 监听 127.0.0.1:18080
 *   HTTPS_PROXY=http://127.0.0.1:18080 npx tauri bundle --bundles nsis
 */

const http = require("http");
const net = require("net");
const dns = require("dns");

const PORT = Number(process.env.TUNNEL_PORT || 18080);

// 独立解析器，绕开系统 hosts
const resolver = new dns.Resolver();
resolver.setServers(["8.8.8.8", "1.1.1.1"]);

// 解析结果缓存，避免每个连接都查一次
const cache = new Map();

function resolveHost(host) {
  if (net.isIP(host)) return Promise.resolve(host);
  if (cache.has(host)) return Promise.resolve(cache.get(host));
  return new Promise((resolve, reject) => {
    resolver.resolve4(host, (err, addrs) => {
      if (err || !addrs || addrs.length === 0) {
        reject(err || new Error(`no A record for ${host}`));
        return;
      }
      cache.set(host, addrs[0]);
      resolve(addrs[0]);
    });
  });
}

const server = http.createServer((req, res) => {
  // 普通的 HTTP 请求也做转发，避免某些客户端不用 CONNECT
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end("bad url");
    return;
  }
  resolveHost(url.hostname)
    .then((ip) => {
      const upstream = http.request(
        {
          host: ip,
          port: Number(url.port) || 80,
          method: req.method,
          path: url.pathname + url.search,
          headers: { ...req.headers, host: url.host },
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => res.writeHead(502).end(e.message));
      req.pipe(upstream);
    })
    .catch((e) => res.writeHead(502).end(e.message));
});

server.on("connect", (req, clientSocket, head) => {
  const [host, portText] = req.url.split(":");
  const port = Number(portText) || 443;

  resolveHost(host)
    .then((ip) => {
      const upstream = net.connect(port, ip, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });

      const abort = (msg) => {
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (msg) console.error(`[tunnel] ${host}:${port} ${msg}`);
      };

      upstream.on("error", (e) => abort(e.message));
      clientSocket.on("error", (e) => abort(e.message));
      clientSocket.on("close", () => upstream.destroy());
      upstream.on("close", () => clientSocket.destroy());
      console.log(`[tunnel] CONNECT ${host}:${port} -> ${ip}`);
    })
    .catch((e) => {
      console.error(`[tunnel] resolve fail ${host}: ${e.message}`);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`tunnel proxy listening on 127.0.0.1:${PORT}`);
});
