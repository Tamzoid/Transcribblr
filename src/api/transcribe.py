"""
Transcribblr — WhisperX transcription
Lazy-loads WhisperX large-v3 once per VAD config, runs multi-pass transcription
over a project's pending subtitles, and writes results back as text.ja with
entry['new'] = True so the UI can flag unreviewed records.

Mirrors the multi-pass strategy from the Colab Step 5 notebook but runs
in-process (no subprocess worker / queue) since this server already owns
the GPU.
"""

import os
import json
import time
import threading

from logger import log
import process_context as pc

# ── Pass presets — same numbers as the Colab notebook ─────────────────────────
PASSES = [
    {'vad_onset': 0.5, 'vad_offset': 0.363, 'padding_ms': 0,   'timeout_s': 120},
    {'vad_onset': 0.3, 'vad_offset': 0.1,   'padding_ms': 200, 'timeout_s': 180},
    {'vad_onset': 0.1, 'vad_offset': 0.05,  'padding_ms': 500, 'timeout_s': 180},
]

CONTEXT_MAX_GAP_S    = 15
CONTEXT_MAX_WINDOW_S = 60
TARGET_MARKER        = '????'

MODEL_SIZE   = 'large-v3'
LANGUAGE     = 'ja'
COMPUTE_TYPE = 'float16'

_model       = None
_model_vad   = None  # (onset, offset) currently configured
_load_lock   = threading.Lock()


def is_loaded():
    return _model is not None


def unload():
    """Free the model + GPU memory. Called before context.py loads C3TR so
    the two large models don't fight over VRAM."""
    global _model, _model_vad
    if _model is None:
        return
    with _load_lock:
        if _model is None:
            return
        log.info('Unloading WhisperX model…')
        try:
            del _model
        except Exception:
            pass
        _model = None
        _model_vad = None
        try:
            import gc, torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


def _ensure_loaded(vad_onset, vad_offset, on_step=None):
    """Load the model on first call OR reload if VAD config changed."""
    global _model, _model_vad
    target = (round(vad_onset, 4), round(vad_offset, 4))
    if _model is not None and _model_vad == target:
        return

    def step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    with _load_lock:
        if _model is not None and _model_vad == target:
            return

        # Free C3TR first to clear VRAM (best-effort — succeeds when unloaded
        # to a single GPU, no-op when context module isn't loaded).
        try:
            import context as _ctx
            if _ctx.is_loaded():
                step('Unloading C3TR to free VRAM for WhisperX…')
                _ctx.unload()
        except Exception:
            pass

        if _model is not None:
            step(f'Reconfiguring WhisperX VAD (onset={target[0]}, offset={target[1]})…')
            try:
                del _model
                import gc, torch
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            globals()['_model'] = None

        step('Importing whisperx…')
        try:
            import whisperx
        except ImportError as e:
            raise RuntimeError(
                'whisperx is not installed. In Colab run:\n'
                '  pip install git+https://github.com/m-bain/whisperX.git'
            ) from e
        import torch
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        compute = COMPUTE_TYPE if device == 'cuda' else 'int8'

        step(f'Loading WhisperX {MODEL_SIZE} (device={device}, compute={compute}, '
             f'vad onset={target[0]}, offset={target[1]})…')
        m = whisperx.load_model(
            MODEL_SIZE,
            device=device,
            language=LANGUAGE,
            compute_type=compute,
            asr_options={'initial_prompt': None},
            vad_options={'vad_onset': target[0], 'vad_offset': target[1]},
        )
        globals()['_model']     = m
        globals()['_model_vad'] = target
        step('✅ WhisperX model loaded')


# ── Prompt assembly per chunk ────────────────────────────────────────────────

def _scene_prompt_for_time(prompts: dict, t: float) -> str:
    """Pick the prompt for the active scene, falling back to the default."""
    if not prompts:
        return ''
    best_key = None
    best_start = -1.0
    for key in prompts.keys():
        if key == 'default':
            continue
        try:
            start = float(key)
        except ValueError:
            continue
        if start <= t and start > best_start:
            best_start = start
            best_key = key
    if best_key:
        entry = prompts.get(best_key)
        if isinstance(entry, dict):
            return (entry.get('ja') or '').strip()
    default = prompts.get('default')
    if isinstance(default, dict):
        return (default.get('ja') or '').strip()
    return ''


def _rolling_context(subs, current_idx, char_budget):
    """Pull non-???? lines around current_idx until we hit gap/window/budget
    limits — matches the Step 5 helper one-for-one."""
    if char_budget <= 0:
        return ''
    cur = subs[current_idx]
    cur_start_ms = int(cur.get('start', 0) * 1000)
    cur_end_ms   = int(cur.get('end', 0) * 1000)
    gap_max  = CONTEXT_MAX_GAP_S    * 1000
    span_max = CONTEXT_MAX_WINDOW_S * 1000

    def lane_ja(e):
        t = e.get('text')
        if isinstance(t, dict):
            return (t.get('ja') or '').strip()
        if isinstance(t, str):
            return t.strip()
        return ''

    back, fwd, used = [], [], 0
    for i in range(current_idx - 1, -1, -1):
        ja = lane_ja(subs[i]).lstrip('★')
        if not ja or TARGET_MARKER in ja:
            continue
        line_end_ms   = int(subs[i].get('end', 0) * 1000)
        line_start_ms = int(subs[i].get('start', 0) * 1000)
        if (cur_start_ms - line_end_ms) > gap_max: break
        if (cur_start_ms - line_start_ms) > span_max: break
        if used + len(ja) + 1 > char_budget: break
        back.insert(0, ja)
        used += len(ja) + 1
    for i in range(current_idx + 1, len(subs)):
        ja = lane_ja(subs[i]).lstrip('★')
        if not ja or TARGET_MARKER in ja:
            continue
        line_start_ms = int(subs[i].get('start', 0) * 1000)
        line_end_ms   = int(subs[i].get('end', 0) * 1000)
        if (line_start_ms - cur_end_ms) > gap_max: break
        if (line_end_ms   - cur_end_ms) > span_max: break
        if used + len(ja) + 1 > char_budget: break
        fwd.append(ja)
        used += len(ja) + 1
    return ''.join(back + fwd)


def _build_initial_prompt(scene_prompt, rolling, hint):
    parts = []
    if scene_prompt: parts.append(scene_prompt)
    if rolling:      parts.append(rolling)
    if hint.get('prefix'):   parts.append(hint['prefix'])
    elif hint.get('middle'): parts.append(hint['middle'])
    elif hint.get('suffix'): parts.append(hint['suffix'])
    full = ''.join(parts)
    if len(full) > pc.WARN_LIMIT:
        full = full[-pc.WARN_LIMIT:]
    return full


# ── Audio chunk export ───────────────────────────────────────────────────────

def _export_chunk(audio_seg, start_ms, end_ms, out_path):
    """Slice audio with pydub. Caller must clean up out_path."""
    audio_seg[start_ms:end_ms].export(out_path, format='wav')


# ── Main loop ────────────────────────────────────────────────────────────────

def transcribe_project(project_path: str, audio_path: str, options: dict,
                       on_step=None, on_progress=None):
    """
    options = {
      'sensitivity': 'Low' | 'Medium' | 'High',
      'indices': [int, ...]   # specific records, or omit to do all ???? entries
    }
    """
    def step(msg):
        log.info(f'[transcribe] {msg}')
        if on_step:
            on_step(msg)

    if not os.path.exists(project_path):
        raise FileNotFoundError(f'project json missing: {project_path}')
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f'audio missing: {audio_path}')

    with open(project_path, encoding='utf-8') as f:
        project = json.load(f)

    subs = project.get('subtitles') or []
    if not isinstance(subs, list) or not subs:
        raise RuntimeError('project has no subtitles list')

    ctx     = project.get('context') or {}
    prompts = ctx.get('prompts') or {}
    if not prompts:
        step('No prompts cached on context — building them now…')
        prompts = pc.build_prompts(ctx)
        ctx['prompts'] = prompts
        project['context'] = ctx

    # Pick passes
    sens = (options.get('sensitivity') or 'High').lower()
    if sens == 'low':       active = list(PASSES)
    elif sens == 'medium':  active = list(PASSES[1:])
    else:                   active = list(PASSES[-1:])
    step(f'Sensitivity {sens.title()} — {len(active)}/{len(PASSES)} pass(es)')

    # Pick targets
    if options.get('indices'):
        targets = [int(i) for i in options['indices'] if 0 <= int(i) < len(subs)]
    else:
        targets = pc.find_pending_indices(subs)
    if not targets:
        step('Nothing to transcribe — no ???? records.')
        return {'transcribed': 0, 'failed': 0, 'total': 0}

    step(f'{len(targets)} record(s) to transcribe')

    # Load audio once
    step('Loading audio…')
    try:
        from pydub import AudioSegment
    except ImportError as e:
        raise RuntimeError('pydub not installed') from e
    audio = AudioSegment.from_file(audio_path)
    step(f'Audio loaded: {len(audio)/1000:.1f}s')

    import tempfile
    chunk_dir = tempfile.mkdtemp(prefix='transcribblr_chunks_')

    transcribed = 0
    failed_total = 0
    remaining = list(targets)

    try:
        for pass_num, pass_cfg in enumerate(active, start=1):
            if not remaining:
                break
            step(f'── Pass {pass_num}/{len(active)} — VAD onset={pass_cfg["vad_onset"]}, '
                 f'offset={pass_cfg["vad_offset"]}, padding={pass_cfg["padding_ms"]}ms '
                 f'({len(remaining)} chunk(s)) ──')
            _ensure_loaded(pass_cfg['vad_onset'], pass_cfg['vad_offset'], on_step=on_step)

            failed_this_pass = []
            for n, idx in enumerate(remaining):
                e = subs[idx]
                start_ms = int((e.get('start') or 0) * 1000)
                end_ms   = int((e.get('end')   or 0) * 1000)
                pad      = pass_cfg['padding_ms']
                p_start  = max(0, start_ms - pad)
                p_end    = min(len(audio), end_ms + pad)
                chunk_path = os.path.join(chunk_dir, f'chunk_{idx:04d}.wav')

                try:
                    _export_chunk(audio, p_start, p_end, chunk_path)
                except Exception as ex:
                    step(f'  ✗ {idx}: chunk export failed: {ex}')
                    failed_this_pass.append(idx)
                    continue

                # Existing JA on this record may be a partial hint
                ja_now = ''
                if isinstance(e.get('text'), dict):
                    ja_now = (e['text'].get('ja') or '').strip()
                elif isinstance(e.get('text'), str):
                    ja_now = e.get('text', '').strip()
                hint = pc.parse_partial_hint_parts(ja_now)

                scene_prompt = _scene_prompt_for_time(prompts, e.get('start') or 0)
                # Reserve budget for scene_prompt + runtime buffer; rest goes to rolling.
                budget = max(0, pc.WARN_LIMIT - len(scene_prompt) - pc.RUNTIME_BUFFER_CHARS)
                rolling = _rolling_context(subs, idx, budget)
                prompt  = _build_initial_prompt(scene_prompt, rolling, hint)

                try:
                    if hasattr(_model, 'options') and hasattr(_model.options, 'initial_prompt'):
                        _model.options.initial_prompt = prompt or None
                    result = _model.transcribe(chunk_path, language=LANGUAGE, batch_size=16)
                    segs = result.get('segments') or []
                    text = ' '.join((s.get('text') or '').strip() for s in segs).strip()
                except Exception as ex:
                    step(f'  ✗ {idx}: whisperx error: {ex}')
                    failed_this_pass.append(idx)
                    continue
                finally:
                    try: os.remove(chunk_path)
                    except OSError: pass

                if not text:
                    step(f'  · {idx}: (no speech)')
                    failed_this_pass.append(idx)
                    continue

                # Write back
                if not isinstance(e.get('text'), dict):
                    e['text'] = {'ja': '', 'ro': '', 'en': ''}
                e['text']['ja'] = text
                e['text']['ro'] = ''  # romaji regenerated lazily by /romaji
                e['new'] = True
                transcribed += 1

                step(f'  ✓ {idx}: {text[:80]}{"…" if len(text) > 80 else ""}')
                if on_progress:
                    on_progress({
                        'idx': idx, 'status': 'transcribed', 'text': text,
                        'pass': pass_num,
                        'remaining': len(remaining) - (n + 1),
                    })

                # Persist after every successful transcription so a crash mid-job
                # doesn't lose work.
                try:
                    with open(project_path, 'w', encoding='utf-8') as f:
                        json.dump(project, f, indent=2, ensure_ascii=False)
                except Exception as ex:
                    log.warning(f'mid-job save failed: {ex}')

            step(f'Pass {pass_num} complete — '
                 f'{len(remaining) - len(failed_this_pass)} transcribed, '
                 f'{len(failed_this_pass)} carried to next pass')
            remaining = failed_this_pass

        failed_total = len(remaining)

    finally:
        try:
            import shutil
            shutil.rmtree(chunk_dir, ignore_errors=True)
        except Exception:
            pass
        # Final save
        try:
            with open(project_path, 'w', encoding='utf-8') as f:
                json.dump(project, f, indent=2, ensure_ascii=False)
        except Exception as ex:
            log.error(f'final save failed: {ex}')

    return {'transcribed': transcribed, 'failed': failed_total, 'total': len(targets)}
