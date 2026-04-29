#@title Transcribblr
#@markdown Enter paths relative to `/content/drive/`
drive_dir = "MyDrive/AI/Subtitles/data"  #@param {type:"string"}
repo_dir  = "MyDrive/AI/Subtitles/Transcribbler"  #@param {type:"string"}

import os, sys, subprocess, time

from google.colab import drive
drive.mount('/content/drive', force_remount=True)

BASE_PATH = f'/content/drive/{drive_dir}'
REPO_PATH = f'/content/drive/{repo_dir}'
if not os.path.exists(os.path.join(REPO_PATH, '.git')):
    print("Cloning Transcribblr repository...")
    subprocess.run([
        'git', 'clone', 
        'https://github.com/Tamzoid/Transcribblr.git',
        REPO_PATH
    ], check=True)
else:
    print("Repository already cloned, pulling latest changes...")
    subprocess.run(['git', '-C', REPO_PATH, 'pull'], capture_output=True)


print("Installing dependencies...")
result = subprocess.run(
    [sys.executable, '-m', 'pip', 'install', '-r', f'{REPO_PATH}/src/requirements.txt'],
    capture_output=True, text=True
)
if result.returncode != 0:
    print(result.stdout[-2000:])
    print(result.stderr[-2000:])
    raise RuntimeError("Dependency install failed")
print("Dependencies installed")

print("Building web assets...")
result = subprocess.run(
    [sys.executable, f'{REPO_PATH}/build.py'],
    capture_output=True, text=True,
    cwd=REPO_PATH
)
print(result.stdout)
if result.returncode != 0:
    print(result.stderr[-2000:])
    raise RuntimeError("Build failed")

# Clean up any previous module imports
try:
    _server.shutdown()
    _server.server_close()
    time.sleep(1)
except:
    pass

for mod in list(sys.modules.keys()):
    if mod in ('server', 'config', 'srt', 'audio', 'romaji', 'logger'):
        del sys.modules[mod]

# Set up data paths on Drive
DATA_DIR = f'{BASE_PATH}_data'
os.makedirs(f'{DATA_DIR}/subtitles', exist_ok=True)
os.makedirs(f'{DATA_DIR}/audio', exist_ok=True)

# Start the server
sys.path.insert(0, f'{REPO_PATH}/src/api')
import server as transcribblr

_server = transcribblr.launch(settings={
    'data_path': DATA_DIR,
    'log_dir':   f'{REPO_PATH}/logs',
    'port':      8765,
})
