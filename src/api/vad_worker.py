import sys
import subprocess

# Pin numpy before anything else imports it
subprocess.run(
    [sys.executable, "-m", "pip", "install", "-q",
     "numpy<2.0", "torch", "torchaudio", "soundfile", "silero-vad"],
    check=True
)

import os
import argparse
import torch
import numpy as np
import soundfile as sf
import torchaudio

# =========================
# Args
# =========================
parser = argparse.ArgumentParser()
parser.add_argument("input_wav")
parser.add_argument("output_wav")
parser.add_argument("--vad_threshold",      type=float, default=0.40)
parser.add_argument("--vad_pad_ms",         type=int,   default=500)
parser.add_argument("--vad_min_speech_ms",  type=int,   default=250)
parser.add_argument("--vad_min_silence_ms", type=int,   default=400)
parser.add_argument("--vad_fade_ms",        type=int,   default=30)
parser.add_argument("--refine_max_ext_ms",  type=int,   default=400)
parser.add_argument("--merge_gap_ms",       type=int,   default=200)
parser.add_argument("--crossfade_ms",       type=int,   default=20)
args = parser.parse_args()

# =========================
# Load Silero VAD
# =========================
vad_model, vad_utils = torch.hub.load(
    "snakers4/silero-vad", "silero_vad",
    force_reload=False, trust_repo=True
)
(get_speech_timestamps, *_) = vad_utils

# =========================
# Load audio
# =========================
audio, sr = sf.read(args.input_wav, dtype="float32")
audio_mono = audio.mean(axis=1) if audio.ndim == 2 else audio
n_samples  = len(audio_mono)

# =========================
# Step 1: Silero VAD
# =========================
vad_tensor = torch.from_numpy(audio_mono)
if sr != 16000:
    vad_tensor = torchaudio.functional.resample(
        vad_tensor.unsqueeze(0), sr, 16000
    ).squeeze(0)
    vad_sr = 16000
else:
    vad_sr = sr

speech_ts = get_speech_timestamps(
    vad_tensor, vad_model,
    threshold=args.vad_threshold,
    sampling_rate=vad_sr,
    min_speech_duration_ms=args.vad_min_speech_ms,
    min_silence_duration_ms=args.vad_min_silence_ms,
    speech_pad_ms=0,  # We apply padding ourselves below
)

if not speech_ts:
    print("   ⚠️  No speech detected — writing silence", flush=True)
    sf.write(args.output_wav, np.zeros_like(audio), sr)
    sys.exit(0)

# Apply padding ourselves — Silero internally caps speech_pad_ms
scale       = sr / vad_sr
pad_samples = int(sr * args.vad_pad_ms / 1000)
segments = [
    (
        max(0,         int(seg["start"] * scale) - pad_samples),
        min(n_samples, int(seg["end"]   * scale) + pad_samples)
    )
    for seg in speech_ts
]
print(f"   🎙  Silero detected {len(segments)} segment(s)", flush=True)

# =========================
# Step 2: Boundary refinement
# — if the edge of a VAD segment is still energetically active
#   (i.e. cut while voice was still going), walk outward until
#   energy drops to the natural silence floor.
# =========================
refine_max_ext = int(sr * args.refine_max_ext_ms / 1000)
step_samples   = int(sr * 0.01)  # 10ms steps

def rms(arr):
    return np.sqrt(np.mean(arr ** 2)) if len(arr) > 0 else 0.0

# Estimate silence floor from quietest 10% of frames across the file
frame_size    = int(sr * 0.02)
frame_rms     = [rms(audio_mono[i:i+frame_size]) for i in range(0, n_samples - frame_size, frame_size)]
silence_floor = np.percentile(frame_rms, 10) * 3

refined = []
for s, e in segments:
    edge_window = min(step_samples * 3, (e - s) // 4)

    # Extend start backwards if edge is still active
    new_s = s
    if rms(audio_mono[s:s + edge_window]) > silence_floor and s > 0:
        candidate = s
        while candidate - step_samples >= max(0, s - refine_max_ext):
            candidate -= step_samples
            if rms(audio_mono[candidate:candidate + step_samples]) < silence_floor:
                break
        new_s = max(0, candidate)

    # Extend end forwards if edge is still active
    new_e = e
    if rms(audio_mono[e - edge_window:e]) > silence_floor and e < n_samples:
        candidate = e
        while candidate + step_samples <= min(n_samples, e + refine_max_ext):
            candidate += step_samples
            if rms(audio_mono[candidate - step_samples:candidate]) < silence_floor:
                break
        new_e = min(n_samples, candidate)

    refined.append((new_s, new_e))

extended = sum(1 for (os_, oe), (ns, ne) in zip(segments, refined) if ns < os_ or ne > oe)
print(f"   🔍  Boundary refinement extended {extended} segment(s)", flush=True)

# =========================
# Step 3: Merge close chunks
# =========================
merge_gap   = int(sr * args.merge_gap_ms   / 1000)
crossfade_s = int(sr * args.crossfade_ms   / 1000)

merged = [refined[0]]
for s, e in refined[1:]:
    prev_s, prev_e = merged[-1]
    if s - prev_e <= merge_gap:
        merged[-1] = (prev_s, e)
    else:
        merged.append((s, e))

print(f"   🔗  After merging: {len(merged)} chunk(s) (was {len(refined)})", flush=True)

# =========================
# Step 4: Build mask with fades
# =========================
fade_samples = int(sr * args.vad_fade_ms / 1000)
mask = np.zeros(n_samples, dtype=np.float32)

for s, e in merged:
    mask[s:e] = 1.0
    fin_end    = min(s + fade_samples, e)
    fout_start = max(e - fade_samples, s)
    mask[s:fin_end]    = np.linspace(0.0, 1.0, fin_end - s)
    mask[fout_start:e] = np.linspace(1.0, 0.0, e - fout_start)

# Smooth joins at merge points
if crossfade_s > 0:
    for i in range(1, len(merged)):
        prev_e = merged[i-1][1]
        curr_s = merged[i][0]
        if curr_s - prev_e <= merge_gap:
            cf_start = max(0, prev_e - crossfade_s)
            cf_end   = min(n_samples, curr_s + crossfade_s)
            mask[cf_start:cf_end] = np.clip(mask[cf_start:cf_end], 0.0, 1.0)

# =========================
# Step 5: Apply mask and write
# =========================
masked = audio * mask[:, None] if audio.ndim == 2 else audio * mask
sf.write(args.output_wav, masked, sr)

total_speech_s = mask.sum() / sr
print(f"   ✅ Speech kept: {total_speech_s:.1f}s across {len(merged)} final chunk(s)", flush=True)
