"""
Transcribblr — HTTP Server
Pure routing layer. All business logic lives in the service modules.
"""

import os
import json
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import config
import srt
import audio
import romaji
from logger import log, get_logger, get_recent_logs

# ── Paths ─────────────────────────────────────────────────────────────────────

API_DIR  = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(API_DIR)
WEB_DIR  = os.path.join(ROOT_DIR, 'web')

INDEX_PATH  = os.path.join(WEB_DIR, 'index.html')
CONFIG_PATH = os.path.join(ROOT_DIR, 'config.json')

STATIC_FILES = {
    'style.css':     'text/css',
    'api.js':        'application/javascript',
    'player.js':     'application/javascript',
    'editor.js':     'application/javascript',
    'filepicker.js': 'application/javascript',
    'ui.js':         'application/javascript',
    'app.js':        'application/javascript',
}

# ── HTTP Server ───────────────────────────────────────────────────────────────

class ReuseHTTPServer(HTTPServer):
    allow_reuse_address = True

    def server_bind(self):
        import socket
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass
        super().server_bind()


class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        log.debug(f"HTTP {fmt % args}")

    def send_json(self, code: int, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    # ── GET ───────────────────────────────────────────────────────────────────

    def do_GET(self):
        path = urlparse(self.path).path

        if path == '/':
            self._serve_file(INDEX_PATH, 'text/html; charset=utf-8',
                             extra_headers={'X-Frame-Options': 'ALLOWALL'})

        elif path.lstrip('/') in STATIC_FILES:
            fname = path.lstrip('/')
            self._serve_file(os.path.join(WEB_DIR, fname), STATIC_FILES[fname])

        elif path == '/config':
            self.send_json(200, {
                'selected':   config.state['selected'],
                'srt_dir':    config.SRT_DIR,
                'has_romaji': romaji.available,
            })

        elif path == '/files':
            self.send_json(200, {
                'files':    config.list_srt_files(),
                'selected': config.state['selected'],
            })

        elif path == '/data':
            selected = config.state['selected']
            log.debug(f"/data — selected: {selected!r}")
            if not selected:
                self.send_json(200, [])
                return
            entries = srt.load_srt(
                os.path.join(config.SRT_DIR, selected)
            )
            log.debug(f"/data — returning {len(entries)} records for {selected!r}")
            self.send_json(200, entries)

        elif path == '/ping':
            self.send_json(200, {'ok': True})

        elif path == '/audiosources':
            sources = {k: bool(v) for k, v in config.state['audio_paths'].items()}
            self.send_json(200, sources)

        elif path == '/logs':
            self.send_json(200, get_recent_logs())

        elif path.startswith('/audio'):
            self._serve_audio()

        else:
            log.warning(f"404: {path}")
            self.send_json(404, {'error': 'not found'})

    def _serve_file(self, fpath: str, content_type: str, extra_headers: dict = None):
        log.debug(f"Serving: {fpath} exists={os.path.exists(fpath)}")
        try:
            with open(fpath, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', len(body))
            self.send_header('Access-Control-Allow-Origin', '*')
            if extra_headers:
                for k, v in extra_headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except FileNotFoundError:
            log.error(f"File not found: {fpath}")
            self.send_json(404, {'error': f'{os.path.basename(fpath)} not found'})

    def _serve_audio(self):
        qs       = parse_qs(urlparse(self.path).query)
        src_key  = qs.get('src', ['vocals'])[0]
        file_key = qs.get('file', [None])[0]

        # If file param given, look up directly from streamable dir (avoids state race)
        if file_key and config.STREAMABLE_DIR:
            import audio as _audio
            stem = os.path.splitext(file_key)[0]
            ap = _audio.find_streamable(stem, '.' + src_key)
        else:
            ap = config.state['audio_paths'].get(src_key) or config.state['audio_path']

        log.info(f"Audio request: src={src_key}, file={file_key or config.state['selected']!r}, path={ap!r}")
        if not ap or not os.path.exists(ap):
            log.warning(f"Audio 404: src={src_key}, path={ap!r}")
            self.send_json(404, {'error': 'audio not found'})
            return

        size = os.path.getsize(ap)
        log.debug(f"Serving audio: {os.path.basename(ap)} ({size // 1024}KB)")
        self.send_response(200)
        self.send_header('Content-Type', 'audio/mp4')
        self.send_header('Content-Length', size)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        with open(ap, 'rb') as f:
            self.wfile.write(f.read())

    # ── POST ──────────────────────────────────────────────────────────────────

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length)

        if self.path == '/selectfile':
            try:
                name = json.loads(body).get('file', '')
                log.info(f"/selectfile — switching to {name!r}")
                audio.load_file(name)
                log.info(f"/selectfile — state now: {config.state['selected']!r}")
                self.send_json(200, {'ok': True, 'selected': config.state['selected']})
            except ValueError as e:
                log.warning(f"selectfile error: {e}")
                self.send_json(400, {'ok': False, 'error': str(e)})
            except Exception as e:
                log.error(f"selectfile unexpected error: {e}")
                self.send_json(500, {'ok': False, 'error': str(e)})

        elif self.path == '/save':
            try:
                entries = json.loads(body)
                if not config.state['selected']:
                    self.send_json(400, {'ok': False, 'error': 'no file selected'})
                    return
                srt.write_srt(
                    entries,
                    os.path.join(config.SRT_DIR, config.state['selected'])
                )
                self.send_json(200, {'ok': True, 'count': len(entries)})
            except Exception as e:
                log.error(f"save error: {e}")
                self.send_json(500, {'ok': False, 'error': str(e)})

        elif self.path == '/romaji':
            try:
                text   = json.loads(body).get('text', '')
                result = romaji.convert(text)
                self.send_json(200, {'romaji': result, 'ok': romaji.available})
            except Exception as e:
                log.error(f"romaji error: {e}")
                self.send_json(500, {'ok': False, 'error': str(e)})

        else:
            log.warning(f"404 POST: {self.path}")
            self.send_json(404, {'error': 'not found'})


# ── Public API ────────────────────────────────────────────────────────────────

def start(port: int = None) -> ReuseHTTPServer:
    p = port or config.PORT
    log.info(f"Binding to port {p}…")
    server = ReuseHTTPServer(('', p), Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    log.info(f"Server listening on port {p}")
    return server


def launch(port: int = None, settings: dict = None):
    if settings:
        config.configure(settings)
    srv = start(port)
    from google.colab.output import eval_js
    import time as _time
    log.info("Fetching Colab proxy URL…")
    url = None
    for _attempt in range(5):
        try:
            url = eval_js(f"google.colab.kernel.proxyPort({port or config.PORT})")
            if url: break
        except Exception as _e:
            log.warning(f"Proxy URL attempt {_attempt+1} failed: {_e}")
            _time.sleep(2)
    if not url:
        raise RuntimeError("Could not get Colab proxy URL after 5 attempts")
    log.info(f"Ready → {url}")
    # Use eval_js to inject HTML directly into cell output — works from any context
    html = f"""
<style>
#tr-wrap{{position:relative;width:100%}}
#tr-wrap iframe{{display:block;width:100%;height:850px;border:none}}
#tr-wrap.fs-mode{{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:#000}}
#tr-wrap.fs-mode iframe{{width:100%;height:100%}}
</style>
<div id="tr-wrap"><iframe src="{url}" allowfullscreen allow="autoplay; microphone"></iframe></div>
"""
    import json
    escaped_html = json.dumps(html)
    # Inject HTML and wire fullscreen listener via eval_js
    # (innerHTML doesn't execute scripts, so listener is added separately)
    eval_js(f"""
      var div = document.createElement('div');
      div.innerHTML = {escaped_html};
      var area = document.querySelector('#output-area') || document.body;
      area.appendChild(div);
      window.addEventListener('message', function(ev) {{
        if (!ev.data || ev.data.type !== 'srtfs') return;
        var w = document.getElementById('tr-wrap');
        if (!w) return;
        if (ev.data.action === 'enter') {{ w.classList.add('fs-mode'); }}
        else {{ w.classList.remove('fs-mode'); }}
      }});
      void 0;
    """)
    return srv


if __name__ == '__main__':
    if os.path.exists(CONFIG_PATH):
        config.load_from_file(CONFIG_PATH)
    srv = start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        srv.shutdown()
