"""
Tests for HTTP server routes (server.py)
"""
import http.client
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src" / "api"))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get(port, path):
    conn = http.client.HTTPConnection('localhost', port, timeout=5)
    conn.request('GET', path)
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(raw), dict(resp.getheaders())
    except Exception:
        return resp.status, raw, dict(resp.getheaders())


def _post(port, path, data):
    conn = http.client.HTTPConnection('localhost', port, timeout=5)
    body = json.dumps(data).encode()
    conn.request('POST', path, body, {
        'Content-Type': 'application/json',
        'Content-Length': str(len(body)),
    })
    resp = conn.getresponse()
    raw = resp.read()
    conn.close()
    try:
        return resp.status, json.loads(raw)
    except Exception:
        return resp.status, raw


def _options(port, path):
    conn = http.client.HTTPConnection('localhost', port, timeout=5)
    conn.request('OPTIONS', path)
    resp = conn.getresponse()
    resp.read()
    headers = {k.lower(): v for k, v in resp.getheaders()}
    conn.close()
    return resp.status, headers


# ── Fixture ───────────────────────────────────────────────────────────────────

@pytest.fixture
def srv(temp_dir, sample_audio_dir):
    """Start a throwaway server on an OS-assigned port; yield the port number."""
    import config
    import server
    from srt import write_srt

    srt_dir = temp_dir / "srt"
    srt_dir.mkdir()
    write_srt(
        [{'start': 0.0, 'end': 5.0, 'text': 'Hello'}],
        str(srt_dir / "episode01.srt"),
    )

    config.SRT_DIR        = str(srt_dir)
    config.STREAMABLE_DIR = str(sample_audio_dir)
    config.state['selected']    = 'episode01.srt'
    config.state['audio_paths'] = {
        'vocals': str(sample_audio_dir / 'episode01.vocals.m4a'),
        'full':   str(sample_audio_dir / 'episode01.full.m4a'),
    }
    config.state['audio_path'] = str(sample_audio_dir / 'episode01.vocals.m4a')

    instance = server.ReuseHTTPServer(('', 0), server.Handler)
    port = instance.server_address[1]
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    yield port
    instance.shutdown()


# ── GET routes ────────────────────────────────────────────────────────────────

class TestGETRoutes:

    def test_ping(self, srv):
        status, body, _ = _get(srv, '/ping')
        assert status == 200
        assert body == {'ok': True}

    def test_config_shape(self, srv):
        status, body, _ = _get(srv, '/config')
        assert status == 200
        assert 'selected' in body
        assert 'srt_dir' in body
        assert 'has_romaji' in body

    def test_config_selected_matches_state(self, srv):
        status, body, _ = _get(srv, '/config')
        assert body['selected'] == 'episode01.srt'

    def test_files_lists_srt_files(self, srv):
        status, body, _ = _get(srv, '/files')
        assert status == 200
        assert 'episode01.srt' in body['files']
        assert 'selected' in body

    def test_data_returns_entries_when_file_selected(self, srv):
        status, body, _ = _get(srv, '/data')
        assert status == 200
        assert isinstance(body, list)
        assert len(body) == 1
        assert body[0]['text'] == 'Hello'

    def test_data_returns_empty_list_when_nothing_selected(self, srv):
        import config
        config.state['selected'] = ''
        status, body, _ = _get(srv, '/data')
        assert status == 200
        assert body == []

    def test_audiosources_shape(self, srv):
        status, body, _ = _get(srv, '/audiosources')
        assert status == 200
        assert 'vocals' in body
        assert 'full' in body
        assert isinstance(body['vocals'], bool)

    def test_logs_returns_list(self, srv):
        status, body, _ = _get(srv, '/logs')
        assert status == 200
        assert isinstance(body, list)

    def test_unknown_route_is_404(self, srv):
        status, body, _ = _get(srv, '/doesnotexist')
        assert status == 404
        assert 'error' in body

    def test_static_file_route_responds(self, srv):
        # style.css is registered; it may be 200 or 404 depending on whether
        # the web dir exists in this environment — just confirm it doesn't crash
        status, _, _ = _get(srv, '/style.css')
        assert status in (200, 404)

    def test_root_route_responds(self, srv):
        status, _, _ = _get(srv, '/')
        assert status in (200, 404)


# ── POST routes ───────────────────────────────────────────────────────────────

class TestPOSTRoutes:

    def test_selectfile_success(self, srv):
        status, body = _post(srv, '/selectfile', {'file': 'episode01.srt'})
        assert status == 200
        assert body['ok'] is True
        assert body['selected'] == 'episode01.srt'

    def test_selectfile_unknown_file_is_400(self, srv):
        status, body = _post(srv, '/selectfile', {'file': 'missing.srt'})
        assert status == 400
        assert body['ok'] is False
        assert 'error' in body

    def test_selectfile_empty_name_is_400(self, srv):
        status, body = _post(srv, '/selectfile', {'file': ''})
        assert status == 400
        assert body['ok'] is False

    def test_save_writes_entries(self, srv):
        entries = [{'start': 0.0, 'end': 3.0, 'text': 'Updated'}]
        status, body = _post(srv, '/save', entries)
        assert status == 200
        assert body['ok'] is True
        assert body['count'] == 1

    def test_save_with_no_file_selected_is_400(self, srv):
        import config
        config.state['selected'] = ''
        status, body = _post(srv, '/save', [])
        assert status == 400
        assert body['ok'] is False

    def test_save_persists_to_disk(self, srv, temp_dir):
        import config
        from srt import load_srt
        entries = [{'start': 1.0, 'end': 4.0, 'text': 'Persisted'}]
        _post(srv, '/save', entries)
        reloaded = load_srt(str(Path(config.SRT_DIR) / 'episode01.srt'))
        assert reloaded[0]['text'] == 'Persisted'

    def test_romaji_endpoint_returns_ok(self, srv):
        status, body = _post(srv, '/romaji', {'text': 'hello'})
        assert status == 200
        assert 'romaji' in body
        assert 'ok' in body

    def test_romaji_empty_text(self, srv):
        status, body = _post(srv, '/romaji', {'text': ''})
        assert status == 200
        assert body['romaji'] == ''

    def test_unknown_post_is_404(self, srv):
        status, body = _post(srv, '/notaroute', {})
        assert status == 404
        assert 'error' in body


# ── CORS ──────────────────────────────────────────────────────────────────────

class TestCORS:

    def test_options_returns_200(self, srv):
        status, _ = _options(srv, '/ping')
        assert status == 200

    def test_options_has_allow_origin(self, srv):
        _, headers = _options(srv, '/ping')
        assert 'access-control-allow-origin' in headers

    def test_options_has_allow_methods(self, srv):
        _, headers = _options(srv, '/ping')
        assert 'access-control-allow-methods' in headers

    def test_get_response_has_cors_header(self, srv):
        _, _, headers = _get(srv, '/ping')
        lower = {k.lower(): v for k, v in headers.items()}
        assert lower.get('access-control-allow-origin') == '*'

    def test_post_response_has_cors_header(self, srv):
        conn = http.client.HTTPConnection('localhost', srv, timeout=5)
        body = json.dumps({'text': 'hi'}).encode()
        conn.request('POST', '/romaji', body, {'Content-Length': str(len(body))})
        resp = conn.getresponse()
        resp.read()
        headers = {k.lower(): v for k, v in resp.getheaders()}
        conn.close()
        assert headers.get('access-control-allow-origin') == '*'


# ── Audio serving ─────────────────────────────────────────────────────────────

class TestAudioServing:

    def test_audio_served_from_state(self, srv):
        # Files are empty (touch()ed) so Content-Length=0, but response is 200
        status, _, _ = _get(srv, '/audio?src=vocals')
        assert status == 200

    def test_audio_with_file_param(self, srv):
        status, _, _ = _get(srv, '/audio?src=vocals&file=episode01.srt')
        assert status == 200

    def test_audio_defaults_to_vocals(self, srv):
        status, _, _ = _get(srv, '/audio')
        assert status == 200

    def test_audio_missing_returns_404(self, srv):
        import config
        config.state['audio_paths'] = {'vocals': '', 'full': ''}
        config.state['audio_path']  = ''
        status, body, _ = _get(srv, '/audio?src=vocals')
        assert status == 404
        assert 'error' in body

    def test_audio_unknown_src_returns_404(self, srv):
        import config
        config.state['audio_paths'] = {'vocals': '', 'full': ''}
        config.state['audio_path']  = ''
        status, body, _ = _get(srv, '/audio?src=nonexistent')
        assert status == 404
