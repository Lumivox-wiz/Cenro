"""最小 WebDAV 服务，只为验证客户端的请求构造与响应解析。

支持 MKCOL / PROPFIND / PUT / GET / DELETE + Basic 认证。
用法：python scripts/dav-test-server.py <root> <port>
"""
import base64
import os
import sys
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "./dav-root")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
USER, PASSWORD = "test", "test"

PROPFIND_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">{items}</d:multistatus>"""

ITEM = """<d:response>
<d:href>{href}</d:href>
<d:propstat><d:prop>
<d:resourcetype>{rtype}</d:resourcetype>
{length}
<d:getlastmodified>{mtime}</d:getlastmodified>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
</d:response>"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _auth_ok(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        raw = base64.b64decode(header[6:]).decode()
        return raw == f"{USER}:{PASSWORD}"

    def _need_auth(self):
        if self._auth_ok():
            return False
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="dav"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _path(self):
        rel = unquote(self.path.split("?")[0]).lstrip("/")
        full = os.path.abspath(os.path.join(ROOT, rel))
        if not full.startswith(ROOT):
            raise ValueError("escape")
        return full

    def do_MKCOL(self):
        if self._need_auth():
            return
        try:
            path = self._path()
        except ValueError:
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if os.path.isdir(path):
            self.send_response(405)
        else:
            try:
                os.makedirs(path)
                self.send_response(201)
            except FileNotFoundError:
                self.send_response(409)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PROPFIND(self):
        if self._need_auth():
            return
        path = self._path()
        if not os.path.isdir(path):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        rel = "/" + os.path.relpath(path, ROOT).replace(os.sep, "/")
        if rel == "/.":
            rel = "/"
        href ="/dav" + ("" if rel == "/" else rel) + "/"
        items = [
            ITEM.format(href=href, rtype="<d:collection/>", length="", mtime=formatdate(usegmt=True))
        ]
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            if not os.path.isfile(full):
                continue
            stat = os.stat(full)
            items.append(
                ITEM.format(
                    href=f"/dav{rel.rstrip('/')}/{name}",
                    rtype="",
                    length=f"<d:getcontentlength>{stat.st_size}</d:getcontentlength>",
                    mtime=formatdate(stat.st_mtime, usegmt=True),
                )
            )
        body = PROPFIND_BODY.format(items="".join(items)).encode()
        self.send_response(207)
        self.send_header("Content-Type", "application/xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        if self._need_auth():
            return
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        path = self._path()
        if not os.path.isdir(os.path.dirname(path)):
            self.send_response(409)
        else:
            existed = os.path.exists(path)
            with open(path, "wb") as f:
                f.write(data)
            self.send_response(204 if existed else 201)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self._need_auth():
            return
        path = self._path()
        if not os.path.isfile(path):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_DELETE(self):
        if self._need_auth():
            return
        path = self._path()
        if os.path.isfile(path):
            os.remove(path)
            self.send_response(204)
        else:
            self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    print(f"dav root={ROOT} http://127.0.0.1:{PORT}/dav user={USER} pass={PASSWORD}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
