"""FinStream 金融行情演示服务。

仅使用 Python 标准库实现：
- 静态页面服务（web/ 目录）
- GET /api/snapshot          全市场快照
- GET /api/history?symbol=.. 单个标的分时数据
- GET /api/stream            SSE 实时推送（每 tick 一帧）

启动：python server.py [--host 127.0.0.1] [--port 8000] [--interval 1.0]
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import queue
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from market import MarketEngine

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = (BASE_DIR / "web").resolve()

JSON_CT = "application/json; charset=utf-8"


def _now_ms() -> int:
    return int(time.time() * 1000)


class AppHandler(BaseHTTPRequestHandler):
    """所有 HTTP 路由入口。"""

    server_version = "FinStream/1.0"
    protocol_version = "HTTP/1.1"
    engine: MarketEngine  # 由 main() 注入

    # ------------------------------------------------------------------ 路由

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler 约定)
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/snapshot":
                self._handle_snapshot()
            elif path == "/api/history":
                self._handle_history(parsed.query)
            elif path == "/api/stream":
                self._handle_stream()
            elif path == "/healthz":
                self._send_json({"ok": True, "time": _now_ms()})
            else:
                self._serve_static(path)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as exc:  # 兜底，避免连接悬挂
            traceback_line = f"{type(exc).__name__}: {exc}"
            sys.stdout.write(f"[finweb] 处理 {path} 失败: {traceback_line}\n")
            try:
                self._send_json({"error": "服务器内部错误"}, HTTPStatus.INTERNAL_SERVER_ERROR)
            except OSError:
                pass

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    # ------------------------------------------------------------------ API

    def _handle_snapshot(self) -> None:
        self._send_json({"quotes": self.engine.snapshot(), "serverTime": _now_ms()})

    def _handle_history(self, raw_query: str) -> None:
        query = parse_qs(raw_query)
        symbol = (query.get("symbol") or [""])[0]
        limit_raw = (query.get("limit") or ["0"])[0]
        try:
            limit = max(0, int(limit_raw))
        except ValueError:
            limit = 0

        quote, points = self.engine.history(symbol, limit)
        if quote is None:
            self._send_json({"error": f"未知标的: {symbol}"}, HTTPStatus.NOT_FOUND)
            return
        self._send_json({"quote": quote, "points": points})

    def _handle_stream(self) -> None:
        """SSE：行情快照流 + 心跳。"""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        quotes, unsubscribe = self.engine.subscribe()
        try:
            self._sse_send("quotes", {"quotes": self.engine.snapshot(), "serverTime": _now_ms()})
            while True:
                try:
                    snapshot = quotes.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                self._sse_send("quotes", {"quotes": snapshot, "serverTime": _now_ms()})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            unsubscribe()
            self.close_connection = True

    def _sse_send(self, event: str, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        frame = f"event: {event}\ndata: {data}\n\n".encode("utf-8")
        self.wfile.write(frame)
        self.wfile.flush()

    # -------------------------------------------------------------- 静态资源

    def _serve_static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (WEB_DIR / rel).resolve()
        if not target.is_relative_to(WEB_DIR) or not target.is_file():
            self._send_json({"error": "页面不存在", "path": path}, HTTPStatus.NOT_FOUND)
            return

        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    # ------------------------------------------------------------------ 工具

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", JSON_CT)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        # 静态资源请求不刷屏，只记录 API 与错误
        if "/api/" in self.path or "/healthz" in self.path:
            sys.stdout.write(f"[finweb] {self.address_string()} {fmt % args}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="FinStream 金融行情演示服务")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，局域网访问用 0.0.0.0")
    parser.add_argument("--port", type=int, default=8000, help="监听端口")
    parser.add_argument("--interval", type=float, default=1.0, help="行情刷新间隔（秒）")
    parser.add_argument("--seed", type=int, default=None, help="随机种子，便于复现数据")
    args = parser.parse_args()

    engine = MarketEngine(interval=args.interval, seed=args.seed)
    engine.start()

    AppHandler.engine = engine
    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    server.daemon_threads = True

    sys.stdout.write(f"[finweb] 服务已启动: http://{args.host}:{args.port}\n")
    sys.stdout.write("[finweb] 按 Ctrl+C 停止服务\n")
    sys.stdout.flush()

    def handle_signal(signum, frame) -> None:  # noqa: ARG001
        sys.stdout.write("\n[finweb] 正在关闭服务…\n")
        engine.stop()
        # shutdown() 会等待 serve_forever 退出，必须放到其它线程避免死锁
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, handle_signal)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_signal)

    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        engine.stop()
        sys.stdout.write("[finweb] 已停止\n")


if __name__ == "__main__":
    main()
