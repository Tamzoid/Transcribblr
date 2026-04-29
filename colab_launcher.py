#@title Transcribblr
import os, sys, subprocess, time

from google.colab import drive
drive.mount('/content/drive', force_remount=True)

ROOT = '/content/drive/MyDrive/AI/Subtitles/Transcribblr_v2'
BASE = '/content/drive/MyDrive/AI/Subtitles'

print("📦 Installing dependencies…")
result = subprocess.run(
    [sys.executable, '-m', 'pip', 'install', '-r', f'{ROOT}/requirements.txt'],
    capture_output=True, text=True
)
if result.returncode != 0:
    print(result.stdout[-2000:])
    print(result.stderr[-2000:])
    raise RuntimeError("Dependency install failed — see above")
print("✅ Dependencies ready")

print("🔨 Building…")
result = subprocess.run([sys.executable, f'{ROOT}/build.py'], capture_output=True, text=True)
print(result.stdout)
if result.returncode != 0:
    print(result.stderr[-2000:])
    raise RuntimeError("Build failed — see above")

try: _server.shutdown(); _server.server_close(); time.sleep(1)
except: pass
for mod in list(sys.modules.keys()):
    if mod in ('server', 'config', 'srt', 'audio', 'romaji', 'logger'):
        del sys.modules[mod]

sys.path.insert(0, f'{ROOT}/api')
import server as transcribblr

_server = transcribblr.launch(settings={
    'srt_dir':        f'{BASE}/4--Raw_Subtitles',
    'streamable_dir': f'{BASE}/3a--Streamable',
    'log_dir':        f'{ROOT}/logs',
    'port':           8765,
})
