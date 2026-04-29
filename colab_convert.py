#@title Transcribblr — Convert Audio
# Run this once per file (or when new files are added).
# Converts vocals + full audio into streamable .m4a files in 3a--Streamable.
import os, subprocess

BASE    = '/content/drive/MyDrive/AI/Subtitles'
SOURCES = {
    'vocals': f'{BASE}/3--Vocals_Only',
    'full':   f'{BASE}/2--Converted_Audio',
}
OUT_DIR = f'{BASE}/3a--Streamable'
os.makedirs(OUT_DIR, exist_ok=True)

EXTS = ('.wav', '.mp3', '.m4a', '.flac', '.ogg')

def find(stem, directory):
    for ext in EXTS:
        p = os.path.join(directory, stem + ext)
        if os.path.exists(p): return p
    return None

def convert(src, dst):
    r = subprocess.run([
        'ffmpeg', '-y', '-i', src,
        '-c:a', 'aac', '-b:a', '32k', '-ar', '22050', '-ac', '1',
        '-map_metadata', '-1', '-movflags', '+faststart', dst
    ], capture_output=True)
    return r.returncode == 0, r.stderr.decode()[-200:]

# Collect all stems from both source dirs
stems = set()
for d in SOURCES.values():
    if os.path.exists(d):
        for f in os.listdir(d):
            if f.lower().endswith(EXTS):
                stems.add(os.path.splitext(f)[0])

print(f"Found {len(stems)} audio files to process\n")

for stem in sorted(stems):
    for label, directory in SOURCES.items():
        src = find(stem, directory)
        if not src: continue
        dst = os.path.join(OUT_DIR, f'{stem}.{label}.m4a')
        if os.path.exists(dst):
            print(f"  ✅ {stem}.{label} already converted")
            continue
        print(f"  📦 Converting {stem}.{label}…", end=' ', flush=True)
        ok, err = convert(src, dst)
        if ok:
            print(f"✅ ({os.path.getsize(dst)/1024/1024:.1f} MB)")
        else:
            print(f"❌ {err}")

print("\n✨ Done")
