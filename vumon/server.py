"""vu-monitor-2000 web server.

Serves the monitor page, the admin page, a small JSON API for the stream
list, and a same-origin proxy for HLS playlists and segments.

The proxy matters: browsers only let the Web Audio API read samples from
media that is same-origin or served with CORS headers. Most broadcast CDNs
don't send CORS headers, so without the proxy the meters would read silence.

Python standard library only.
"""

from __future__ import annotations

import base64
import hmac
import json
import logging
import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urljoin, urlsplit
from urllib.request import Request, urlopen

VERSION = "1.0.0"
log = logging.getLogger("vumon")

WEB_DIR = Path(__file__).parent / "web"
USER_AGENT = f"vu-monitor-2000/{VERSION}"
UPSTREAM_TIMEOUT = 15
MAX_PLAYLIST_BYTES = 4 * 1024 * 1024
URI_ATTR = re.compile(r'URI="([^"]*)"')

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------

class Settings:
    def __init__(self) -> None:
        self.data_dir = Path(os.environ.get("VUMON_DATA_DIR", "./data"))
        self.host = os.environ.get("VUMON_HOST", "0.0.0.0")
        self.port = int(os.environ.get("VUMON_PORT", "8080"))
        self.admin_user = os.environ.get("VUMON_ADMIN_USER", "admin")
        self.admin_password = os.environ.get("VUMON_ADMIN_PASSWORD", "")
        self.log_level = os.environ.get("VUMON_LOG_LEVEL", "INFO").upper()


# --------------------------------------------------------------------------
# Stream store
# --------------------------------------------------------------------------

def _clean_stream(raw: dict, existing: dict | None = None) -> dict:
    """Validate and normalise a stream record from the admin API."""
    s = dict(existing or {})
    if "name" in raw or existing is None:
        name = str(raw.get("name", "")).strip()
        if not name:
            raise ValueError("Name is required")
        s["name"] = name[:80]
    if "url" in raw or existing is None:
        url = str(raw.get("url", "")).strip()
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError("URL must start with http:// or https://")
        s["url"] = url
    for key, default in (("enabled", True), ("proxy", True)):
        if key in raw:
            s[key] = bool(raw[key])
        else:
            s.setdefault(key, default)
    if "notes" in raw:
        s["notes"] = str(raw.get("notes") or "").strip()[:200]
    else:
        s.setdefault("notes", "")
    return s


class StreamStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.streams: list[dict] = []
        self.revision = 0
        self.extra_hosts: set[str] = set()  # hosts seen inside proxied playlists
        self._load()

    def _load(self) -> None:
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text("utf-8"))
                self.streams = list(data.get("streams", []))
                self.revision = int(data.get("revision", 0))
            except (OSError, ValueError) as exc:
                log.error("Could not read %s: %s (starting empty)", self.path, exc)
        log.info("Loaded %d stream(s) from %s", len(self.streams), self.path)

    def _save(self) -> None:
        self.revision += 1
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"revision": self.revision, "streams": self.streams}, indent=2),
            "utf-8",
        )
        os.replace(tmp, self.path)

    def snapshot(self) -> dict:
        with self.lock:
            return {"revision": self.revision, "streams": [dict(s) for s in self.streams]}

    def add(self, raw: dict) -> dict:
        s = _clean_stream(raw)
        s["id"] = uuid.uuid4().hex[:10]
        with self.lock:
            self.streams.append(s)
            self._save()
        return s

    def update(self, sid: str, raw: dict) -> dict:
        with self.lock:
            for i, cur in enumerate(self.streams):
                if cur["id"] == sid:
                    s = _clean_stream(raw, cur)
                    self.streams[i] = s
                    self._save()
                    return s
        raise KeyError(sid)

    def delete(self, sid: str) -> None:
        with self.lock:
            before = len(self.streams)
            self.streams = [s for s in self.streams if s["id"] != sid]
            if len(self.streams) == before:
                raise KeyError(sid)
            self._save()

    def reorder(self, ids: list[str]) -> None:
        with self.lock:
            by_id = {s["id"]: s for s in self.streams}
            ordered = [by_id.pop(i) for i in ids if i in by_id]
            ordered.extend(by_id.values())  # anything not listed keeps its place at the end
            self.streams = ordered
            self._save()

    # -- proxy allow-list ------------------------------------------------

    def host_allowed(self, host: str) -> bool:
        host = host.lower()
        with self.lock:
            if host in self.extra_hosts:
                return True
            return any(urlsplit(s["url"]).hostname == host for s in self.streams)

    def allow_host(self, host: str | None) -> None:
        if host:
            with self.lock:
                self.extra_hosts.add(host.lower())


# --------------------------------------------------------------------------
# HLS helpers
# --------------------------------------------------------------------------

def is_playlist(content_type: str, url: str, head: bytes) -> bool:
    ct = content_type.lower()
    if "mpegurl" in ct:
        return True
    if urlsplit(url).path.lower().endswith(".m3u8"):
        return True
    return head.lstrip(b"\xef\xbb\xbf \r\n\t").startswith(b"#EXTM3U")


def rewrite_playlist(text: str, base_url: str, store: StreamStore) -> str:
    """Point every URI in a playlist back through our proxy."""

    def proxied(uri: str) -> str:
        absolute = urljoin(base_url, uri.strip())
        store.allow_host(urlsplit(absolute).hostname)
        return "proxy?u=" + quote(absolute, safe="")

    out = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            out.append(line)
        elif stripped.startswith("#"):
            out.append(URI_ATTR.sub(lambda m: f'URI="{proxied(m.group(1))}"', line))
        else:
            out.append(proxied(stripped))
    return "\n".join(out) + "\n"


def open_upstream(url: str, range_header: str | None = None, timeout: float = UPSTREAM_TIMEOUT):
    headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if range_header:
        headers["Range"] = range_header
    return urlopen(Request(url, headers=headers), timeout=timeout)


def probe(url: str) -> dict:
    """Fetch a URL once and describe what it is, for the admin 'Test' button."""
    started = time.monotonic()
    try:
        with open_upstream(url, timeout=10) as resp:
            ctype = resp.headers.get("Content-Type", "")
            final = resp.geturl()
            head = resp.read(256 * 1024)
    except HTTPError as exc:
        return {"ok": False, "error": f"HTTP {exc.code} {exc.reason}"}
    except (URLError, OSError, ValueError) as exc:
        reason = getattr(exc, "reason", exc)
        return {"ok": False, "error": f"Could not connect: {reason}"}
    ms = round((time.monotonic() - started) * 1000)
    info: dict = {"ok": True, "contentType": ctype, "finalUrl": final, "ms": ms}

    if not is_playlist(ctype, final, head[:64]):
        if ctype.startswith("audio/") or ctype in ("application/ogg", "video/mp2t"):
            info.update(kind="direct", summary=f"Direct audio stream ({ctype})")
        else:
            info.update(ok=False, kind="unknown",
                        error=f"Not an HLS playlist or audio stream (Content-Type: {ctype or 'none'})")
        return info

    text = head.decode("utf-8", "replace")
    if "#EXT-X-STREAM-INF" in text:
        variants = []
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF"):
                bw = re.search(r"(?:AVERAGE-)?BANDWIDTH=(\d+)", line)
                codecs = re.search(r'CODECS="([^"]*)"', line)
                variants.append({
                    "bandwidth": int(bw.group(1)) if bw else None,
                    "codecs": codecs.group(1) if codecs else "",
                })
        audio_groups = len(re.findall(r"#EXT-X-MEDIA:.*TYPE=AUDIO", text))
        info.update(kind="master", variants=variants, audioRenditions=audio_groups,
                    summary=f"HLS master playlist, {len(variants)} variant(s)")
    else:
        segs = text.count("#EXTINF")
        td = re.search(r"#EXT-X-TARGETDURATION:(\d+)", text)
        live = "#EXT-X-ENDLIST" not in text
        info.update(kind="media", segments=segs,
                    targetDuration=int(td.group(1)) if td else None, live=live,
                    summary=f"HLS media playlist, {segs} segment(s), "
                            f"{'live' if live else 'VOD (not live)'}")
    return info


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = f"vu-monitor-2000/{VERSION}"
    settings: Settings
    store: StreamStore

    # -- plumbing --------------------------------------------------------

    def log_message(self, fmt, *args):  # route through logging
        log.debug("%s - %s", self.address_string(), fmt % args)

    def send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"error": message}, status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024:
            raise ValueError("Request too large")
        raw = self.rfile.read(length) if length else b"{}"
        data = json.loads(raw or b"{}")
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data

    def authorised(self) -> bool:
        pw = self.settings.admin_password
        if not pw:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                user, _, given = base64.b64decode(header[6:]).decode("utf-8").partition(":")
            except ValueError:
                return False
            return hmac.compare_digest(user, self.settings.admin_user) and \
                hmac.compare_digest(given, pw)
        return False

    def challenge(self) -> None:
        body = b"Admin login required"
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="vu-monitor-2000 admin", charset="UTF-8"')
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- routing ---------------------------------------------------------

    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("HEAD")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method: str) -> None:
        parts = urlsplit(self.path)
        path = parts.path
        try:
            if path == "/api/status":
                return self.send_json({"ok": True, "version": VERSION,
                                       "streams": len(self.store.streams)})
            if path == "/api/streams" and method == "GET":
                snap = self.store.snapshot()
                snap["streams"] = [s for s in snap["streams"] if s.get("enabled", True)]
                return self.send_json(snap)
            if path == "/proxy" and method in ("GET", "HEAD"):
                return self.proxy(parse_qs(parts.query).get("u", [""])[0], method)

            if path == "/admin" or path.startswith("/admin/"):
                if not self.authorised():
                    return self.challenge()
                if path.startswith("/admin/api/"):
                    return self.admin_api(method, path[len("/admin/api/"):])
                if path == "/admin":
                    self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                    self.send_header("Location", "admin/")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                return self.static("admin.html" if path == "/admin/" else path[len("/admin/"):],
                                   method)

            if method in ("GET", "HEAD"):
                return self.static("index.html" if path == "/" else path.lstrip("/"), method)
            self.send_error_json(405, "Method not allowed")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:  # keep the server up whatever happens
            log.exception("Error handling %s %s", method, self.path)
            try:
                self.send_error_json(500, "Internal error")
            except OSError:
                pass

    # -- static files ----------------------------------------------------

    def static(self, rel: str, method: str) -> None:
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR.resolve() not in target.parents or not target.is_file():
            return self.send_error_json(404, "Not found")
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(body)

    # -- admin API -------------------------------------------------------

    def admin_api(self, method: str, sub: str) -> None:
        if sub == "streams" and method == "GET":
            return self.send_json(self.store.snapshot())
        try:
            if sub == "streams" and method == "POST":
                return self.send_json(self.store.add(self.read_json()), 201)
            if sub == "streams/order" and method == "PUT":
                ids = self.read_json().get("ids", [])
                self.store.reorder([str(i) for i in ids])
                return self.send_json(self.store.snapshot())
            if sub.startswith("streams/"):
                sid = sub[len("streams/"):]
                if method == "PUT":
                    return self.send_json(self.store.update(sid, self.read_json()))
                if method == "DELETE":
                    self.store.delete(sid)
                    return self.send_json({"ok": True})
            if sub == "test" and method == "POST":
                url = str(self.read_json().get("url", "")).strip()
                if urlsplit(url).scheme not in ("http", "https"):
                    return self.send_json({"ok": False, "error": "URL must start with http:// or https://"})
                return self.send_json(probe(url))
        except KeyError:
            return self.send_error_json(404, "No such stream")
        except ValueError as exc:
            return self.send_error_json(400, str(exc))
        self.send_error_json(404, "Not found")

    # -- proxy -----------------------------------------------------------

    def proxy(self, url: str, method: str) -> None:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return self.send_error_json(400, "Bad URL")
        if not self.store.host_allowed(parts.hostname):
            # Only hosts of configured streams (and hosts their playlists point
            # to) can be fetched, so the proxy can't be used to reach anything else.
            return self.send_error_json(403, "Host not in the stream list")

        try:
            resp = open_upstream(url, self.headers.get("Range"))
        except HTTPError as exc:
            return self.send_error_json(exc.code, f"Upstream HTTP {exc.code}")
        except (URLError, OSError) as exc:
            log.warning("Proxy fetch failed for %s: %s", url, getattr(exc, "reason", exc))
            return self.send_error_json(502, "Upstream unreachable")

        with resp:
            final = resp.geturl()
            self.store.allow_host(urlsplit(final).hostname)  # follow redirects to CDNs
            ctype = resp.headers.get("Content-Type", "")
            first = resp.read(64) if method == "GET" else b""

            if method == "GET" and is_playlist(ctype, final, first):
                raw = first + resp.read(MAX_PLAYLIST_BYTES)
                body = rewrite_playlist(raw.decode("utf-8", "replace"), final, self.store).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return

            self.send_response(resp.status)
            for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
                if resp.headers.get(h):
                    self.send_header(h, resp.headers[h])
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if method == "HEAD":
                return
            self.wfile.write(first)
            # Segments are copied straight through; for a continuous (Icecast
            # style) stream this keeps going until the browser disconnects.
            shutil.copyfileobj(resp, self.wfile, 64 * 1024)


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main() -> None:
    settings = Settings()
    logging.basicConfig(level=settings.log_level,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    store = StreamStore(settings.data_dir / "streams.json")

    handler = type("BoundHandler", (Handler,), {"settings": settings, "store": store})
    server = ThreadingHTTPServer((settings.host, settings.port), handler)
    server.daemon_threads = True

    if settings.admin_password:
        log.info("Admin page is password protected (user '%s')", settings.admin_user)
    else:
        log.warning("VUMON_ADMIN_PASSWORD is not set: anyone who can reach the admin page "
                    "can change the stream list")
    log.info("vu-monitor-2000 %s listening on http://%s:%d", VERSION, settings.host, settings.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
