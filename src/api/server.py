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

# ── Background job queue ──────────────────────────────────────────────────────

_jobs = {}  # job_id → {'events': [], 'done': False, 'lock': Lock}


def _run_job(job_id, files, opts):
    import subprocess, re as _re, shutil, sys as _sys, tempfile

    job       = _jobs[job_id]
    do_demucs = bool(opts.get('demucs', False))
    do_vad    = bool(opts.get('vad', False))

    VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm'}
    AUDIO_EXTS = {'.mp3', '.m4a', '.wav', '.flac', '.ogg'}

    def emit(data):
        with job['lock']:
            job['events'].append(data)

    try:
        for fname in files:
            emit({'type': 'start', 'file': fname})
            stem         = os.path.splitext(fname)[0]
            ext          = os.path.splitext(fname)[1].lower()
            input_path   = os.path.join(config.INPUT_DIR, fname)
            wav_path     = os.path.join(config.CONVERTED_DIR, stem + '.wav')
            project_path = os.path.join(config.PROJECTS_DIR, stem + '.json')

            try:
                if os.path.exists(project_path):
                    with open(project_path, encoding='utf-8') as f:
                        project = json.load(f)
                else:
                    project = {
                        'name': stem, 'input_file': fname,
                        'created': datetime.now(timezone.utc).isoformat(),
                        'status': 'pending',
                    }

                if ext not in VIDEO_EXTS | AUDIO_EXTS:
                    emit({'type': 'done', 'file': fname, 'ok': False,
                          'error': 'unsupported file type'})
                    continue

                if not os.path.exists(input_path):
                    raise FileNotFoundError(f'Input file not found: {input_path}')

                # ── Convert to WAV ────────────────────────────────────────────
                if os.path.exists(wav_path):
                    emit({'type': 'step', 'file': fname,
                          'msg': 'WAV already exists — skipping conversion'})
                else:
                    emit({'type': 'step', 'file': fname, 'msg': 'Converting to WAV (16kHz mono)…'})
                    cmd = ['ffmpeg', '-i', input_path,
                           '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-vn', '-y', wav_path]
                    try:
                        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE,
                                                stdout=subprocess.DEVNULL,
                                                universal_newlines=True, bufsize=1)
                    except FileNotFoundError:
                        raise RuntimeError('ffmpeg not found — install ffmpeg and add it to PATH')
                    duration = None; last_pct = -1
                    for line in proc.stderr:
                        m = _re.search(r'Duration:\s*(\d+):(\d+):(\d+\.?\d*)', line)
                        if m:
                            h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                            duration = h*3600 + mi*60 + s
                        m = _re.search(r'time=(\d+):(\d+):(\d+\.?\d*)', line)
                        if m and duration:
                            h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                            pct = min(99, int((h*3600 + mi*60 + s) / duration * 100))
                            if pct != last_pct:
                                emit({'type': 'progress', 'file': fname, 'pct': pct})
                                last_pct = pct
                    proc.wait()
                    if proc.returncode != 0:
                        raise RuntimeError('ffmpeg exited with code ' + str(proc.returncode))

                project['wav_file'] = stem + '.wav'
                project['status']   = 'converted'

                # ── Demucs vocal extraction ───────────────────────────────────
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
                            cmd = ['demucs', '-n', 'htdemucs', '--two-stems', 'vocals',
                                   '--device', 'cpu', '-o', tmp_dir, wav_path]
                            try:
                                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                                        stderr=subprocess.STDOUT,
                                                        universal_newlines=True, bufsize=1)
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

                # ── VAD (silence removal) ─────────────────────────────────────
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
                        cmd = [_sys.executable, vad_script, vad_input, vad_out,
                               '--vad_threshold', '0.40', '--vad_pad_ms', '500',
                               '--vad_min_speech_ms', '250', '--vad_min_silence_ms', '400',
                               '--vad_fade_ms', '30', '--refine_max_ext_ms', '400',
                               '--merge_gap_ms', '200', '--crossfade_ms', '20']
                        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                                stderr=subprocess.STDOUT,
                                                universal_newlines=True, bufsize=1)
                        for line in proc.stdout:
                            line = line.strip()
                            if line:
                                emit({'type': 'step', 'file': fname, 'msg': line})
                        proc.wait()
                        if proc.returncode != 0:
                            raise RuntimeError('VAD worker failed with code ' + str(proc.returncode))
                    project['vad_file'] = stem + '.vad.wav'
                    project['status']   = 'vad_done'

                # ── Detect speech chunks → project subtitles ─────────────────
                if project.get('subtitles') is not None:
                    emit({'type': 'step', 'file': fname,
                          'msg': 'Subtitles already in project — skipping detection'})
                else:
                    emit({'type': 'step', 'file': fname, 'msg': 'Detecting speech chunks…'})
                    chunk_src = next(
                        (p for p in [
                            os.path.join(config.VOCALS_DIR, stem + '.vad.wav'),
                            os.path.join(config.VOCALS_DIR, stem + '.vocals.wav'),
                            wav_path,
                        ] if os.path.exists(p)), wav_path)
                    try:
                        from pydub import AudioSegment
                        from pydub.silence import detect_nonsilent
                        SILENCE_THRESH_DB = -50; MIN_SILENCE_MS = 400; MIN_CHUNK_MS = 300
                        PAD_START_MS = 400; PAD_END_MS = 400; MIN_SUBTITLE_MS = 2500
                        audio    = AudioSegment.from_wav(chunk_src)
                        total_ms = len(audio)
                        nonsilent = detect_nonsilent(audio, min_silence_len=MIN_SILENCE_MS,
                                                     silence_thresh=SILENCE_THRESH_DB, seek_step=10)
                        padded = []
                        for s, e in nonsilent:
                            if (e - s) >= MIN_CHUNK_MS:
                                padded.append((max(0, s - PAD_START_MS), min(total_ms, e + PAD_END_MS)))
                        merged = []
                        for chunk in padded:
                            if merged and (chunk[0] <= merged[-1][1] or
                                           chunk[0] - merged[-1][1] < MIN_SILENCE_MS):
                                merged[-1] = (merged[-1][0], max(merged[-1][1], chunk[1]))
                            else:
                                merged.append(list(chunk))
                        result = []; ci = 0
                        while ci < len(merged):
                            cur = list(merged[ci]); win = cur[0] + MIN_SUBTITLE_MS; cj = ci + 1
                            while cj < len(merged) and merged[cj][0] < win:
                                cur[1] = max(cur[1], merged[cj][1]); cj += 1
                            result.append(tuple(cur)); ci = cj
                        project['subtitles'] = [
                            {'index': i, 'start': round(s / 1000, 3),
                             'end': round(e / 1000, 3), 'text': '????'}
                            for i, (s, e) in enumerate(result)
                        ]
                        # Save subtitles immediately so they survive streamable failures
                        with open(project_path, 'w', encoding='utf-8') as f:
                            json.dump(project, f, indent=2)
                        emit({'type': 'step', 'file': fname,
                              'msg': f'✓ {len(result)} subtitle chunks detected'})
                    except ImportError:
                        emit({'type': 'step', 'file': fname,
                              'msg': '⚠ pydub not installed — skipping subtitle detection'})
                    except Exception as e:
                        emit({'type': 'step', 'file': fname,
                              'msg': f'⚠ Subtitle detection failed: {e}'})

                # ── Convert to streamable m4a / mp4 ──────────────────────────
                os.makedirs(config.STREAMABLE_DIR, exist_ok=True)

                def _ffmpeg_convert(src, dst, label, extra_args):
                    if os.path.exists(dst):
                        emit({'type': 'step', 'file': fname,
                              'msg': f'{label} already exists — skipping'})
                        return
                    emit({'type': 'step', 'file': fname,
                          'msg': f'Converting {label}…'})
                    cmd = ['ffmpeg', '-y', '-i', src] + extra_args + [dst]
                    try:
                        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE,
                                                stdout=subprocess.DEVNULL,
                                                universal_newlines=True, bufsize=1)
                    except FileNotFoundError:
                        raise RuntimeError('ffmpeg not found — install ffmpeg and add it to PATH')
                    duration = None; last_pct = -1
                    for line in proc.stderr:
                        m = _re.search(r'Duration:\s*(\d+):(\d+):(\d+\.?\d*)', line)
                        if m:
                            h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                            duration = h*3600 + mi*60 + s
                        m = _re.search(r'time=(\d+):(\d+):(\d+\.?\d*)', line)
                        if m and duration:
                            h, mi, s = float(m.group(1)), float(m.group(2)), float(m.group(3))
                            pct = min(99, int((h*3600 + mi*60 + s) / duration * 100))
                            if pct != last_pct:
                                emit({'type': 'progress', 'file': fname, 'pct': pct})
                                last_pct = pct
                    proc.wait()
                    if proc.returncode != 0:
                        raise RuntimeError(f'ffmpeg failed for {label}')

                AUDIO_M4A_ARGS = ['-c:a', 'aac', '-b:a', '32k', '-ar', '22050', '-ac', '1',
                                   '-map_metadata', '-1', '-movflags', '+faststart']
                VIDEO_MP4_ARGS = ['-vf', 'scale=640:-2', '-c:v', 'libx264', '-crf', '28',
                                   '-preset', 'fast', '-c:a', 'aac', '-b:a', '64k',
                                   '-map_metadata', '-1', '-movflags', '+faststart']

                if ext in VIDEO_EXTS:
                    video_mp4 = os.path.join(config.STREAMABLE_DIR, stem + '.video.mp4')
                    _ffmpeg_convert(input_path, video_mp4, 'video.mp4', VIDEO_MP4_ARGS)
                    project['video_mp4'] = stem + '.video.mp4'

                full_m4a = os.path.join(config.STREAMABLE_DIR, stem + '.full.m4a')
                _ffmpeg_convert(wav_path, full_m4a, 'full.m4a', AUDIO_M4A_ARGS)
                project['full_m4a'] = stem + '.full.m4a'

                vocals_src = next(
                    (p for p in [
                        os.path.join(config.VOCALS_DIR, stem + '.vad.wav'),
                        os.path.join(config.VOCALS_DIR, stem + '.vocals.wav'),
                    ] if os.path.exists(p)), None)
                if vocals_src:
                    vocals_m4a = os.path.join(config.STREAMABLE_DIR, stem + '.vocals.m4a')
                    _ffmpeg_convert(vocals_src, vocals_m4a, 'vocals.m4a', AUDIO_M4A_ARGS)
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

    except Exception as e:
        log.error(f"job error: {e}")
        emit({'type': 'complete'})

    with job['lock']:
        job['done'] = True

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
            projects = []
            if config.PROJECTS_DIR and os.path.isdir(config.PROJECTS_DIR):
                for fname in sorted(os.listdir(config.PROJECTS_DIR)):
                    if not fname.endswith('.json'):
                        continue
                    stem = fname[:-5]
                    try:
                        with open(os.path.join(config.PROJECTS_DIR, fname), encoding='utf-8') as f:
                            proj = json.load(f)
                    except Exception:
                        proj = {}
                    projects.append({
                        'name':         proj.get('name', stem),
                        'srt':          stem + '.srt',
                        'status':       proj.get('status', 'unknown'),
                        'has_subtitles': proj.get('subtitles') is not None,
                    })
            self.send_json(200, {
                'files':    projects,
                'selected': config.state['selected'],
            })

        elif path == '/data':
            selected = config.state['selected']
            log.debug(f"/data — selected: {selected!r}")
            if not selected:
                self.send_json(200, [])
                return
            stem = os.path.splitext(selected)[0]
            project_path = os.path.join(config.PROJECTS_DIR, stem + '.json')
            if os.path.exists(project_path):
                try:
                    with open(project_path, encoding='utf-8') as f:
                        proj = json.load(f)
                    subs = proj.get('subtitles')
                    if isinstance(subs, list):
                        log.info(f"/data — {len(subs)} records from project JSON for {selected!r}")
                        self.send_json(200, subs)
                        return
                    log.warning(f"/data — {os.path.basename(project_path)} has no usable 'subtitles' list "
                                f"(got {type(subs).__name__}); keys={list(proj.keys())} — falling back to SRT")
                except Exception as e:
                    log.warning(f"/data — project JSON error: {e}")
            else:
                log.warning(f"/data — project JSON not found at {project_path} — falling back to SRT")
            # Fall back to SRT file
            entries = srt.load_srt(os.path.join(config.SRT_DIR, selected))
            log.info(f"/data — {len(entries)} records from SRT for {selected!r}")
            self.send_json(200, entries)

        elif path == '/ping':
            self.send_json(200, {'ok': True})

        elif path == '/audiosources':
            sources = {k: bool(v) for k, v in config.state['audio_paths'].items()}
            self.send_json(200, sources)

        elif path == '/logs':
            self.send_json(200, get_recent_logs())

        elif path == '/process-status':
            qs    = parse_qs(urlparse(self.path).query)
            jid   = qs.get('job', [None])[0]
            since = int(qs.get('since', ['0'])[0])
            job   = _jobs.get(jid)
            if not job:
                self.send_json(404, {'error': 'job not found'})
                return
            with job['lock']:
                events = job['events'][since:]
                done   = job['done']
            nxt = since + len(events)
            self.send_json(200, {'events': events, 'done': done, 'next': nxt})
            if done and nxt >= len(_jobs.get(jid, {}).get('events', [])):
                _jobs.pop(jid, None)

        elif path == '/input-files':
            files = []
            if config.INPUT_DIR and os.path.isdir(config.INPUT_DIR):
                for fname in sorted(os.listdir(config.INPUT_DIR)):
                    fpath = os.path.join(config.INPUT_DIR, fname)
                    if os.path.isfile(fpath):
                        files.append({'name': fname, 'size': os.path.getsize(fpath)})
            self.send_json(200, {'files': files, 'dir': config.INPUT_DIR or ''})

        elif path == '/export-project':
            self._serve_project_zip()

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
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            if extra_headers:
                for k, v in extra_headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
        except FileNotFoundError:
            log.error(f"File not found: {fpath}")
            self.send_json(404, {'error': f'{os.path.basename(fpath)} not found'})

    def _serve_project_zip(self):
        import zipfile, io as _io
        qs   = parse_qs(urlparse(self.path).query)
        name = qs.get('file', [''])[0]
        if not name:
            self.send_json(400, {'error': 'missing file param'})
            return
        stem         = os.path.splitext(name)[0]
        project_path = os.path.join(config.PROJECTS_DIR, stem + '.json')
        if not os.path.exists(project_path):
            self.send_json(404, {'error': 'project not found'})
            return
        with open(project_path, encoding='utf-8') as f:
            proj = json.load(f)

        buf = _io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.write(project_path, stem + '.json')
            for key in ('full_m4a', 'vocals_m4a', 'video_mp4'):
                fname = proj.get(key)
                if not fname:
                    continue
                fpath = os.path.join(config.STREAMABLE_DIR, fname)
                if os.path.exists(fpath):
                    zf.write(fpath, fname)

        data     = buf.getvalue()
        zip_name = stem + '.zip'
        log.info(f"Project ZIP: {zip_name} ({len(data)//1024}KB)")
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Disposition', f'attachment; filename="{zip_name}"')
        self.send_header('Content-Length', len(data))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(data)

    def _serve_audio(self):
        qs       = parse_qs(urlparse(self.path).query)
        src_key  = qs.get('src', ['vocals'])[0]
        file_key = qs.get('file', [None])[0]

        # If file param given, look up directly from streamable dir (avoids state race)
        if file_key and config.STREAMABLE_DIR:
            import audio as _audio
            stem = os.path.splitext(file_key)[0]
            ap = _audio.find_streamable(stem, src_key=src_key)
        else:
            ap = config.state['audio_paths'].get(src_key) or config.state['audio_path']

        log.info(f"Media request: src={src_key}, file={file_key or config.state['selected']!r}, path={ap!r}")
        if not ap or not os.path.exists(ap):
            log.warning(f"Media 404: src={src_key}, path={ap!r}")
            self.send_json(404, {'error': 'media not found'})
            return

        ext = os.path.splitext(ap)[1].lower()
        ctype = 'video/mp4' if ext == '.mp4' else 'audio/mp4'

        size = os.path.getsize(ap)
        log.debug(f"Serving media: {os.path.basename(ap)} ({size // 1024}KB, {ctype})")
        self.send_response(200)
        self.send_header('Content-Type', ctype)
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
                selected = config.state['selected']
                stem = os.path.splitext(selected)[0]
                project_path = os.path.join(config.PROJECTS_DIR, stem + '.json')
                if os.path.exists(project_path):
                    with open(project_path, encoding='utf-8') as f:
                        proj = json.load(f)
                else:
                    proj = {'name': stem,
                            'created': datetime.now(timezone.utc).isoformat(),
                            'status': 'pending'}
                for i, e in enumerate(entries):
                    e['index'] = i
                proj['subtitles'] = entries
                with open(project_path, 'w', encoding='utf-8') as f:
                    json.dump(proj, f, indent=2)
                log.info(f"Saved {len(entries)} subtitles → {os.path.basename(project_path)}")
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

        elif self.path == '/import-project':
            try:
                import zipfile, io as _io, re as _re
                ct = self.headers.get('Content-Type', '')
                m = _re.search(r'boundary=([^\s;]+)', ct)
                if not m:
                    self.send_json(400, {'ok': False, 'error': 'no boundary in Content-Type'})
                    return
                boundary = m.group(1).strip('"')
                fname, data = _parse_multipart_file(body, boundary)
                if fname is None:
                    self.send_json(400, {'ok': False, 'error': data})
                    return
                buf = _io.BytesIO(data)
                if not zipfile.is_zipfile(buf):
                    self.send_json(400, {'ok': False, 'error': 'not a valid ZIP file'})
                    return
                buf.seek(0)
                with zipfile.ZipFile(buf, 'r') as zf:
                    names = zf.namelist()
                    json_files = [n for n in names if n.endswith('.json') and '/' not in n]
                    if not json_files:
                        self.send_json(400, {'ok': False, 'error': 'no project JSON found in ZIP'})
                        return
                    json_name = json_files[0]
                    stem = json_name[:-5]
                    os.makedirs(config.PROJECTS_DIR, exist_ok=True)
                    with open(os.path.join(config.PROJECTS_DIR, json_name), 'wb') as f:
                        f.write(zf.read(json_name))
                    os.makedirs(config.STREAMABLE_DIR, exist_ok=True)
                    media_exts = {'.m4a', '.mp4', '.mp3', '.wav'}
                    imported = [json_name]
                    for entry in names:
                        if entry == json_name or '/' in entry:
                            continue
                        if os.path.splitext(entry)[1].lower() in media_exts:
                            with open(os.path.join(config.STREAMABLE_DIR, entry), 'wb') as f:
                                f.write(zf.read(entry))
                            imported.append(entry)
                log.info(f"Imported project: {stem} ({len(imported)} files)")
                self.send_json(200, {'ok': True, 'stem': stem, 'files': imported})
            except Exception as e:
                log.error(f"import error: {e}")
                self.send_json(500, {'ok': False, 'error': str(e)})

        elif self.path == '/process':
            try:
                import uuid as _uuid
                payload  = json.loads(body)
                job_id   = _uuid.uuid4().hex[:8]
                _jobs[job_id] = {'events': [], 'done': False, 'lock': threading.Lock()}
                t = threading.Thread(
                    target=_run_job,
                    args=(job_id, payload.get('files', []), payload.get('options', {})),
                    daemon=True,
                )
                t.start()
                self.send_json(200, {'job_id': job_id})
            except Exception as e:
                log.error(f"process start error: {e}")
                self.send_json(500, {'ok': False, 'error': str(e)})

        elif self.path == '/import-subtitles':
            try:
                ct = self.headers.get('Content-Type', '')
                import re as _re
                m = _re.search(r'boundary=([^\s;]+)', ct)
                if not m:
                    self.send_json(400, {'ok': False, 'error': 'no boundary in Content-Type'})
                    return
                boundary = m.group(1).strip('"')
                fname, data = _parse_multipart_file(body, boundary)
                if fname is None:
                    self.send_json(400, {'ok': False, 'error': data})
                    return
                if not config.state['selected']:
                    self.send_json(400, {'ok': False, 'error': 'no project selected'})
                    return
                try:
                    text = data.decode('utf-8')
                except UnicodeDecodeError:
                    text = data.decode('utf-8', errors='replace')
                # Strip BOM if present
                if text and text[0] == '﻿':
                    text = text[1:]
                entries = srt.parse_subtitles(text, fname)
                if not entries:
                    self.send_json(400, {'ok': False,
                                         'error': 'no subtitle entries parsed — check file format'})
                    return
                selected = config.state['selected']
                stem = os.path.splitext(selected)[0]
                project_path = os.path.join(config.PROJECTS_DIR, stem + '.json')
                if os.path.exists(project_path):
                    with open(project_path, encoding='utf-8') as f:
                        proj = json.load(f)
                else:
                    proj = {'name': stem,
                            'created': datetime.now(timezone.utc).isoformat(),
                            'status': 'pending'}
                for i, e in enumerate(entries):
                    e['index'] = i
                proj['subtitles'] = entries
                with open(project_path, 'w', encoding='utf-8') as f:
                    json.dump(proj, f, indent=2)
                log.info(f"Imported {len(entries)} subtitles from {fname} → "
                         f"{os.path.basename(project_path)}")
                self.send_json(200, {'ok': True, 'count': len(entries),
                                     'entries': entries})
            except Exception as e:
                log.error(f"import-subtitles error: {e}")
                self.send_json(500, {'ok': False, 'error': str(e)})

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
