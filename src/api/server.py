"""
Transcribblr — HTTP Server
Pure routing layer. All business logic lives in the service modules.
"""

import os
import json
import threading
import time
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import config
import srt
import audio
import romaji
from logger import log, get_logger, get_recent_logs


def _parse_multipart_file(body: bytes, boundary: str):
    """Extract the first file field from a multipart body. Returns (filename, data) or (None, error)."""
    sep = ('--' + boundary).encode()
    for part in body.split(sep)[1:]:
        if part.startswith(b'--'):
            break
        if b'\r\n\r\n' not in part:
            continue
        header_block, file_data = part.split(b'\r\n\r\n', 1)
        if file_data.endswith(b'\r\n'):
            file_data = file_data[:-2]
        cd = next(
            (l.decode('utf-8', errors='replace')
             for l in header_block.split(b'\r\n')
             if l.lower().startswith(b'content-disposition')),
            ''
        )
        import re as _re
        m = _re.search(r'filename="([^"]+)"', cd)
        if m:
            return os.path.basename(m.group(1)), file_data
    return None, 'no file found in upload'

# ── Paths ─────────────────────────────────────────────────────────────────────

API_DIR  = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(API_DIR)
WEB_DIR  = os.path.join(ROOT_DIR, 'web')

INDEX_PATH  = os.path.join(WEB_DIR, 'index.html')
CONFIG_PATH = os.path.join(ROOT_DIR, 'config.json')
ENV_PATH    = os.path.join(ROOT_DIR, '.env')

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

        elif path == '/input-files':
            files = []
            if config.INPUT_DIR and os.path.isdir(config.INPUT_DIR):
                for fname in sorted(os.listdir(config.INPUT_DIR)):
                    fpath = os.path.join(config.INPUT_DIR, fname)
                    if os.path.isfile(fpath):
                        files.append({'name': fname, 'size': os.path.getsize(fpath)})
            self.send_json(200, {'files': files, 'dir': config.INPUT_DIR or ''})

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

        elif self.path == '/process':
            try:
                payload    = json.loads(body)
                files      = payload.get('files', [])
                opts       = payload.get('options', {})
                do_demucs  = bool(opts.get('demucs', False))
                do_vad     = bool(opts.get('vad', False))

                self.send_response(200)
                self.send_header('Content-Type', 'application/x-ndjson')
                self.send_header('Transfer-Encoding', 'chunked')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()

                def emit(data):
                    line = (json.dumps(data) + '\n').encode()
                    self.wfile.write(f'{len(line):x}\r\n'.encode())
                    self.wfile.write(line)
                    self.wfile.write(b'\r\n')
                    self.wfile.flush()

                import subprocess, re as _re, shutil, sys as _sys, tempfile

                VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm'}
                AUDIO_EXTS = {'.mp3', '.m4a', '.wav', '.flac', '.ogg'}

                for fname in files:
                    emit({'type': 'start', 'file': fname})
                    stem = os.path.splitext(fname)[0]
                    ext  = os.path.splitext(fname)[1].lower()
                    input_path   = os.path.join(config.INPUT_DIR, fname)
                    wav_path     = os.path.join(config.CONVERTED_DIR, stem + '.wav')
                    project_path = os.path.join(config.PROJECTS_DIR, stem + '.json')

                    try:
                        # ── Create / load project JSON ────────────────────────
                        if os.path.exists(project_path):
                            with open(project_path, encoding='utf-8') as f:
                                project = json.load(f)
                        else:
                            project = {
                                'name': stem,
                                'input_file': fname,
                                'created': datetime.now(timezone.utc).isoformat(),
                                'status': 'pending',
                            }

                        # ── Convert to WAV ────────────────────────────────────
                        if ext not in VIDEO_EXTS | AUDIO_EXTS:
                            emit({'type': 'done', 'file': fname, 'ok': False,
                                  'error': 'unsupported file type'})
                            continue

                        if not os.path.exists(input_path):
                            raise FileNotFoundError(f'Input file not found: {input_path}')

                        if os.path.exists(wav_path):
                            emit({'type': 'step', 'file': fname, 'msg': 'WAV already exists — skipping conversion'})
                        else:
                            emit({'type': 'step', 'file': fname, 'msg': 'Converting to WAV (16kHz mono)…'})
                            cmd = [
                                'ffmpeg', '-i', input_path,
                                '-ar', '16000', '-ac', '1',
                                '-c:a', 'pcm_s16le', '-vn', '-y',
                                wav_path
                            ]
                            try:
                                proc = subprocess.Popen(
                                    cmd,
                                    stderr=subprocess.PIPE,
                                    stdout=subprocess.DEVNULL,
                                    universal_newlines=True,
                                    bufsize=1,
                                )
                            except FileNotFoundError:
                                raise RuntimeError('ffmpeg not found — install ffmpeg and add it to PATH')
                            duration = None
                            last_pct = -1
                            for line in proc.stderr:
                                m = _re.search(r'Duration:\s*(\d+):(\d+):(\d+\.?\d*)', line)
                                if m:
                                    h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                                    duration = h * 3600 + mi * 60 + s
                                m = _re.search(r'time=(\d+):(\d+):(\d+\.?\d*)', line)
                                if m and duration:
                                    h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                                    pct = min(99, int((h * 3600 + mi * 60 + s) / duration * 100))
                                    if pct != last_pct:
                                        emit({'type': 'progress', 'file': fname, 'pct': pct})
                                        last_pct = pct
                            proc.wait()
                            if proc.returncode != 0:
                                raise RuntimeError('ffmpeg exited with code ' + str(proc.returncode))

                        project['wav_file'] = stem + '.wav'
                        project['status']   = 'converted'

                        # ── Demucs vocal extraction ───────────────────────────
                        vocals_wav = None
                        if do_demucs:
                            vocals_out = os.path.join(config.VOCALS_DIR, stem + '.vocals.wav')
                            if os.path.exists(vocals_out):
                                emit({'type': 'step', 'file': fname,
                                      'msg': 'Vocals already extracted — skipping Demucs'})
                                vocals_wav = vocals_out
                            else:
                                emit({'type': 'step', 'file': fname, 'msg': 'Extracting vocals (Demucs)…'})
                                tmp_dir = tempfile.mkdtemp(prefix='transcribblr_')
                                try:
                                    cmd = [
                                        'demucs', '-n', 'htdemucs',
                                        '--two-stems', 'vocals',
                                        '--device', 'cpu',
                                        '-o', tmp_dir,
                                        wav_path,
                                    ]
                                    try:
                                        proc = subprocess.Popen(
                                            cmd,
                                            stdout=subprocess.PIPE,
                                            stderr=subprocess.STDOUT,
                                            universal_newlines=True,
                                            bufsize=1,
                                        )
                                    except FileNotFoundError:
                                        raise RuntimeError('demucs not found — install with: pip install demucs')
                                    last_pct = -1
                                    for line in proc.stdout:
                                        m = _re.search(r'(\d+)%', line)
                                        if m:
                                            pct = int(m.group(1))
                                            if pct != last_pct:
                                                emit({'type': 'progress', 'file': fname, 'pct': pct})
                                                last_pct = pct
                                    proc.wait()
                                    if proc.returncode != 0:
                                        raise RuntimeError('Demucs failed with code ' + str(proc.returncode))

                                    demucs_out = os.path.join(tmp_dir, 'htdemucs', stem, 'vocals.wav')
                                    if not os.path.exists(demucs_out):
                                        raise RuntimeError(f'Demucs output not found: {demucs_out}')

                                    os.makedirs(config.VOCALS_DIR, exist_ok=True)
                                    shutil.copy2(demucs_out, vocals_out)
                                    vocals_wav = vocals_out
                                    emit({'type': 'step', 'file': fname, 'msg': '✓ Vocals extracted'})
                                finally:
                                    shutil.rmtree(tmp_dir, ignore_errors=True)

                            project['vocals_file'] = stem + '.vocals.wav'
                            project['status']      = 'vocals_extracted'

                        # ── VAD (silence removal) ─────────────────────────────
                        if do_vad:
                            vad_input = vocals_wav or wav_path
                            vad_out   = os.path.join(config.VOCALS_DIR, stem + '.vad.wav')
                            if os.path.exists(vad_out):
                                emit({'type': 'step', 'file': fname,
                                      'msg': 'VAD already processed — skipping'})
                            else:
                                emit({'type': 'step', 'file': fname, 'msg': 'Running VAD…'})
                                vad_script = os.path.join(API_DIR, 'vad_worker.py')
                                os.makedirs(config.VOCALS_DIR, exist_ok=True)
                                cmd = [
                                    _sys.executable, vad_script,
                                    vad_input, vad_out,
                                    '--vad_threshold',      '0.40',
                                    '--vad_pad_ms',         '500',
                                    '--vad_min_speech_ms',  '250',
                                    '--vad_min_silence_ms', '400',
                                    '--vad_fade_ms',        '30',
                                    '--refine_max_ext_ms',  '400',
                                    '--merge_gap_ms',       '200',
                                    '--crossfade_ms',       '20',
                                ]
                                proc = subprocess.Popen(
                                    cmd,
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT,
                                    universal_newlines=True,
                                    bufsize=1,
                                )
                                for line in proc.stdout:
                                    line = line.strip()
                                    if line:
                                        emit({'type': 'step', 'file': fname, 'msg': line})
                                proc.wait()
                                if proc.returncode != 0:
                                    raise RuntimeError('VAD worker failed with code ' + str(proc.returncode))

                            project['vad_file'] = stem + '.vad.wav'
                            project['status']   = 'vad_done'

                        # ── Convert to streamable m4a ─────────────────────────
                        os.makedirs(config.STREAMABLE_DIR, exist_ok=True)

                        def _to_m4a(src, dst, label):
                            if os.path.exists(dst):
                                emit({'type': 'step', 'file': fname,
                                      'msg': f'{label}.m4a already exists — skipping'})
                                return
                            emit({'type': 'step', 'file': fname,
                                  'msg': f'Converting {label} to streamable m4a…'})
                            cmd = [
                                'ffmpeg', '-y', '-i', src,
                                '-c:a', 'aac', '-b:a', '32k', '-ar', '22050', '-ac', '1',
                                '-map_metadata', '-1', '-movflags', '+faststart', dst,
                            ]
                            try:
                                proc = subprocess.Popen(
                                    cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                    universal_newlines=True, bufsize=1,
                                )
                            except FileNotFoundError:
                                raise RuntimeError('ffmpeg not found — install ffmpeg and add it to PATH')
                            duration = None
                            last_pct = -1
                            for line in proc.stderr:
                                m = _re.search(r'Duration:\s*(\d+):(\d+):(\d+\.?\d*)', line)
                                if m:
                                    h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                                    duration = h * 3600 + mi * 60 + s
                                m = _re.search(r'time=(\d+):(\d+):(\d+\.?\d*)', line)
                                if m and duration:
                                    h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                                    pct = min(99, int((h * 3600 + mi * 60 + s) / duration * 100))
                                    if pct != last_pct:
                                        emit({'type': 'progress', 'file': fname, 'pct': pct})
                                        last_pct = pct
                            proc.wait()
                            if proc.returncode != 0:
                                raise RuntimeError(f'ffmpeg failed converting {label} to m4a')

                        def _to_video(src, dst):
                            if os.path.exists(dst):
                                emit({'type': 'step', 'file': fname,
                                      'msg': 'video.mp4 already exists — skipping'})
                                return
                            emit({'type': 'step', 'file': fname,
                                  'msg': 'Converting video to streamable mp4…'})
                            cmd = [
                                'ffmpeg', '-y', '-i', src,
                                '-vf', 'scale=640:-2',
                                '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
                                '-c:a', 'aac', '-b:a', '64k',
                                '-map_metadata', '-1', '-movflags', '+faststart', dst,
                            ]
                            try:
                                proc = subprocess.Popen(
                                    cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                    universal_newlines=True, bufsize=1,
                                )
                            except FileNotFoundError:
                                raise RuntimeError('ffmpeg not found — install ffmpeg and add it to PATH')
                            duration = None
                            last_pct = -1
                            for line in proc.stderr:
                                m = _re.search(r'Duration:\s*(\d+):(\d+):(\d+\.?\d*)', line)
                                if m:
                                    h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                                    duration = h * 3600 + mi * 60 + s
                                m = _re.search(r'time=(\d+):(\d+):(\d+\.?\d*)', line)
                                if m and duration:
                                    h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                                    pct = min(99, int((h * 3600 + mi * 60 + s) / duration * 100))
                                    if pct != last_pct:
                                        emit({'type': 'progress', 'file': fname, 'pct': pct})
                                        last_pct = pct
                            proc.wait()
                            if proc.returncode != 0:
                                raise RuntimeError('ffmpeg failed converting video to mp4')

                        if ext in VIDEO_EXTS:
                            video_mp4 = os.path.join(config.STREAMABLE_DIR, stem + '.video.mp4')
                            _to_video(input_path, video_mp4)
                            project['video_mp4'] = stem + '.video.mp4'

                        full_m4a = os.path.join(config.STREAMABLE_DIR, stem + '.full.m4a')
                        _to_m4a(wav_path, full_m4a, 'full')
                        project['full_m4a'] = stem + '.full.m4a'

                        vocals_src = next(
                            (p for p in [
                                os.path.join(config.VOCALS_DIR, stem + '.vad.wav'),
                                os.path.join(config.VOCALS_DIR, stem + '.vocals.wav'),
                            ] if os.path.exists(p)),
                            None
                        )
                        if vocals_src:
                            vocals_m4a = os.path.join(config.STREAMABLE_DIR, stem + '.vocals.m4a')
                            _to_m4a(vocals_src, vocals_m4a, 'vocals')
                            project['vocals_m4a'] = stem + '.vocals.m4a'

                        project['status'] = 'ready'

                        with open(project_path, 'w', encoding='utf-8') as f:
                            json.dump(project, f, indent=2)

                        log.info(f"Processed: {fname} → {stem}.wav")
                        emit({'type': 'done', 'file': fname, 'ok': True,
                              'project': stem + '.json', 'wav': stem + '.wav'})

                    except Exception as e:
                        log.error(f"process error for {fname}: {e}")
                        emit({'type': 'done', 'file': fname, 'ok': False, 'error': str(e)})

                emit({'type': 'complete'})
                self.wfile.write(b'0\r\n\r\n')
                self.wfile.flush()
            except Exception as e:
                log.error(f"process error: {e}")

        elif self.path == '/upload':
            try:
                ct = self.headers.get('Content-Type', '')
                import re as _re
                m = _re.search(r'boundary=([^\s;]+)', ct)
                if not m:
                    self.send_json(400, {'ok': False, 'error': 'no boundary in Content-Type'})
                    return
                boundary = m.group(1).strip('"')
                fname, result = _parse_multipart_file(body, boundary)
                if fname is None:
                    self.send_json(400, {'ok': False, 'error': result})
                    return
                if not config.INPUT_DIR:
                    self.send_json(500, {'ok': False, 'error': 'INPUT_DIR not configured'})
                    return
                os.makedirs(config.INPUT_DIR, exist_ok=True)
                dest = os.path.join(config.INPUT_DIR, fname)
                with open(dest, 'wb') as f:
                    f.write(result)
                log.info(f"Uploaded: {fname} ({len(result)//1024}KB) → {dest}")
                self.send_json(200, {'ok': True, 'filename': fname})
            except Exception as e:
                log.error(f"upload error: {e}")
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
    elif os.path.exists(ENV_PATH):
        config.load_from_env(ENV_PATH)
    srv = start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        srv.shutdown()
