"""
Transcribblr — Context generation
Loads the C3TR-Adapter (Gemma-2-9B + PEFT) on first use, then exposes
build_context(description) which runs the same pipeline as the Colab
"Step 5a: Create Context File" notebook:
  1. Extract entities (characters / locations / groups) from a description
  2. Supplement locations with regex-bracketed Japanese terms
  3. Translate entities to English
  4. Generate a short Japanese summary suitable for Whisper's initial_prompt
"""

import json
import re
import unicodedata
import logging
import threading

from logger import log

# Suppress noisy library warnings
logging.getLogger("transformers").setLevel(logging.ERROR)
logging.getLogger("peft").setLevel(logging.ERROR)

# ── Lazy-loaded model state ───────────────────────────────────────────────────

_model = None
_tokenizer = None
_device = None
_load_lock = threading.Lock()

MODEL_ID      = "unsloth/gemma-2-9b-it-bnb-4bit"
PEFT_MODEL_ID = "webbigdata/C3TR-Adapter"


def _human_bytes(n):
    if n is None: return '?'
    n = float(n)
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return f"{n:.1f}{unit}" if unit != 'B' else f"{int(n)}B"
        n /= 1024
    return f"{n:.1f}TB"


def _with_heartbeat(label, on_step, fn, interval=4.0, hook_hf_progress=True):
    """Run fn() while:
      • Emitting '⏳ {label} — still working ({Ns elapsed})' every `interval`
        seconds via on_step (reassures the UI mid-download / mid-load).
      • Optionally hooking huggingface_hub's tqdm so download progress
        ('📥 model.safetensors 35% (3.2GB/9.1GB)') gets forwarded to on_step
        too. Throttled to one update per ≥2s OR ≥5% progress per file.
    """
    import time
    import threading as _t
    stop = _t.Event()
    started = time.time()

    def beat():
        while not stop.wait(interval):
            elapsed = int(time.time() - started)
            try:
                if on_step:
                    on_step(f"  ⏳ {label} — still working ({elapsed}s)")
                log.info(f"{label} — still working ({elapsed}s)")
            except Exception:
                pass

    # Optional: hook HF's tqdm so download bars forward to on_step.
    _hf_module = None
    _original_tqdm = None
    if hook_hf_progress and on_step:
        try:
            from huggingface_hub.utils import _tqdm as _hf_module
            _original_tqdm = _hf_module.tqdm

            class _ForwardingTqdm(_original_tqdm):
                def __init__(self, *a, **kw):
                    super().__init__(*a, **kw)
                    self._hb_last_emit = 0.0
                    self._hb_last_pct = -1.0
                def display(self, *a, **kw):
                    rv = super().display(*a, **kw)
                    try:
                        now = time.time()
                        total = self.total or 0
                        n = self.n or 0
                        pct = (n / total * 100) if total else 0
                        if (now - self._hb_last_emit >= 2.0
                            or pct - self._hb_last_pct >= 5.0
                            or (total and n >= total)):
                            self._hb_last_emit = now
                            self._hb_last_pct = pct
                            desc = (self.desc or 'download').strip(': ')
                            human_n = _human_bytes(n)
                            human_t = _human_bytes(total) if total else '?'
                            on_step(f"  📥 {desc} {pct:.0f}% ({human_n}/{human_t})")
                    except Exception:
                        pass
                    return rv
            _hf_module.tqdm = _ForwardingTqdm
        except Exception:
            _hf_module = None

    th = _t.Thread(target=beat, daemon=True)
    th.start()
    try:
        return fn()
    finally:
        stop.set()
        th.join(timeout=1)
        if _hf_module is not None and _original_tqdm is not None:
            try: _hf_module.tqdm = _original_tqdm
            except Exception: pass


def is_loaded() -> bool:
    return _model is not None


def unload():
    """Free the model + GPU memory. Used before WhisperX loads so the two
    multi-GB models don't fight over VRAM. Synchronize + ipc_collect ensures
    the cached blocks actually return to the OS, not just to torch's pool."""
    global _model, _tokenizer
    if _model is None:
        return
    with _load_lock:
        if _model is None:
            return
        log.info('Unloading C3TR model…')
        try:
            import torch
            if torch.cuda.is_available():
                try: _model.to('cpu')
                except Exception: pass
        except Exception:
            pass
        try:
            del _model
            del _tokenizer
        except Exception:
            pass
        _model = None
        _tokenizer = None
        try:
            import gc
            gc.collect()
            import torch
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.empty_cache()
                try: torch.cuda.ipc_collect()
                except Exception: pass
        except Exception:
            pass


def ensure_loaded(on_step=None):
    """Load the model on first call. Subsequent calls are no-ops."""
    global _model, _tokenizer, _device

    if _model is not None:
        return

    with _load_lock:
        if _model is not None:
            return

        def step(msg):
            log.info(msg)
            if on_step:
                on_step(msg)

        # Free other models first so the multi-GB residents don't fight
        # over VRAM. Best-effort — modules may not be loaded yet.
        try:
            import transcribe as _tx
            if _tx.is_loaded():
                step("Unloading Whisper to free VRAM for C3TR…")
                _tx.unload()
        except Exception:
            pass
        try:
            import translate_advanced as _adv
            if _adv.is_loaded():
                step("Unloading Qwen to free VRAM for C3TR…")
                _adv.unload()
        except Exception:
            pass

        step("Importing torch + transformers + peft…")
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
        from peft import PeftModel

        _device = "cuda" if torch.cuda.is_available() else "cpu"
        step(f"Using device: {_device}")
        if _device != "cuda":
            step("⚠ No CUDA detected — context generation will be very slow")

        dtype = (torch.bfloat16
                 if torch.cuda.is_available()
                 and torch.cuda.get_device_capability(0)[0] >= 8
                 else torch.float16)

        # Pin the whole model to GPU 0. Gemma-2-9b at 4-bit is ~5 GB, the
        # PEFT adapter adds ~50 MB — fits comfortably on a T4 (15 GB) or any
        # newer Colab GPU. Avoids the "Tensor.item() cannot be called on
        # meta tensors" failure that happens when device_map="auto" + a
        # cpu-offload-allowed BNB config decide to spread the model across
        # devices and PEFT loading then can't materialize the offloaded
        # layers. If a GPU truly can't fit the model, OOM is clearer than
        # meta-tensor errors.
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=dtype,
        )
        device_map = {"": 0} if torch.cuda.is_available() else "auto"
        if torch.cuda.is_available():
            free_bytes, _total = torch.cuda.mem_get_info()
            step(f"Pinning model to GPU 0 ({free_bytes / (1024**3):.1f} GiB free)")
        step(f"Loading base model: {MODEL_ID}… (first run can take 30–90s)")
        m = _with_heartbeat(
            f"Loading {MODEL_ID}", on_step,
            lambda: AutoModelForCausalLM.from_pretrained(
                MODEL_ID,
                quantization_config=bnb_config,
                torch_dtype=dtype,
                device_map=device_map,
            ),
        )
        step(f"Loading PEFT adapter: {PEFT_MODEL_ID}…")
        m = _with_heartbeat(
            f"Loading PEFT adapter {PEFT_MODEL_ID}", on_step,
            lambda: PeftModel.from_pretrained(model=m, model_id=PEFT_MODEL_ID),
        )

        t = AutoTokenizer.from_pretrained(MODEL_ID)
        t.pad_token = t.unk_token

        _model = m
        _tokenizer = t
        step("✅ Model loaded")


# ── Prompt runner ─────────────────────────────────────────────────────────────

def run_prompt(instruction: str, input_text: str, max_new_tokens: int = 512) -> str:
    """Run a single instruction+input through C3TR and return the response text."""
    ensure_loaded()
    import torch

    prompt = (
        "<start_of_turn>### Instruction:\n"
        f"{instruction}\n"
        "## Input:\n"
        f"**{input_text}**\n"
        "<end_of_turn>\n"
        "<start_of_turn>### Response:\n"
    )
    input_ids = _tokenizer(
        prompt, return_tensors="pt", padding=True, truncation=True
    ).input_ids.to(_device)
    with torch.no_grad():
        generated_ids = _model.generate(
            input_ids=input_ids,
            max_new_tokens=max_new_tokens,
            use_cache=True,
            do_sample=True,
            num_beams=3,
            temperature=0.5,
            top_p=0.3,
            repetition_penalty=1.0,
        )
    full_output = _tokenizer.decode(generated_ids[0], skip_special_tokens=True)
    return full_output.split("### Response:")[-1].strip().strip("*")


# ── Helpers ──────────────────────────────────────────────────────────────────

def contains_japanese(text: str) -> bool:
    return any(
        unicodedata.name(c, "").startswith(("CJK", "HIRAGANA", "KATAKANA"))
        for c in text
    )


def extract_json_block(text: str):
    """Extract a JSON object or array from a model response."""
    text = text.strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    for start_char, end_char in [('{', '}'), ('[', ']')]:
        start = text.find(start_char)
        end   = text.rfind(end_char)
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None


def translate_list_to_english(items: list) -> list:
    """Translate a list of Japanese strings to English as a parallel array."""
    if not items:
        return []
    instruction = (
        "Translate each item in the following JSON array from Japanese to English. "
        "Return ONLY a JSON array of translated strings in the same order. "
        "No explanation, no markdown fences."
    )
    response = run_prompt(instruction, json.dumps(items, ensure_ascii=False), max_new_tokens=256)
    parsed = extract_json_block(response)
    if isinstance(parsed, list) and len(parsed) == len(items):
        return parsed

    log.warning("Batch translation failed, falling back to individual translation…")
    results = []
    for item in items:
        en = run_prompt(
            "Translate Japanese to English. Return only the translation.",
            item, max_new_tokens=64,
        )
        results.append(en)
    return results


def translate_to_english(text: str) -> str:
    return run_prompt(
        "Translate Japanese to English. Return only the translation.",
        text, max_new_tokens=256,
    ).strip()


def translate_list_to_japanese(items: list) -> list:
    """Translate a list of English strings to Japanese as a parallel array."""
    if not items:
        return []
    instruction = (
        "Translate each item in the following JSON array from English to Japanese. "
        "For Western proper nouns (character names, place names) use katakana. "
        "For native Japanese terms use the natural kanji/kana form. "
        "Return ONLY a JSON array of translated strings in the same order. "
        "No explanation, no markdown fences."
    )
    response = run_prompt(instruction, json.dumps(items, ensure_ascii=False), max_new_tokens=256)
    parsed = extract_json_block(response)
    if isinstance(parsed, list) and len(parsed) == len(items):
        return parsed
    log.warning("Batch EN→JA translation failed, falling back to individual translation…")
    results = []
    for item in items:
        ja = run_prompt(
            "Translate English to Japanese. Use katakana for foreign proper nouns. "
            "Return only the translation.",
            item, max_new_tokens=64,
        )
        results.append(ja)
    return results


def translate_to_japanese(text: str) -> str:
    if not text:
        return ''
    return run_prompt(
        "Translate English to Japanese. Use katakana for foreign proper nouns. "
        "Return only the translation.",
        text, max_new_tokens=256,
    ).strip()


def extract_bracketed_terms(text: str) -> list:
    """Extract terms from Japanese bracket patterns the LLM often misses."""
    found = []
    bracket_patterns = [
        r'「([^」]+)」', r'『([^』]+)』', r'【([^】]+)】',
        r'≪([^≫]+)≫', r'＜([^＞]+)＞',
    ]
    for pattern in bracket_patterns:
        found.extend(re.findall(pattern, text))
    preceding = re.findall(
        r'([゠-ヿ一-鿿][゠-ヿ一-鿿・\-ー]+)'
        r'(?=[「『【≪＜])',
        text,
    )
    found.extend(preceding)
    seen, out = set(), []
    for term in found:
        term = term.strip()
        if len(term) >= 2 and term not in seen:
            seen.add(term)
            out.append(term)
    return out


def strip_character_names(description: str, characters: list) -> str:
    result = description
    for name in characters:
        result = result.replace(name, "")
    result = re.sub(r'[。、]{2,}', '。', result)
    return result.strip('。、').strip()


def deduplicate(items: list) -> list:
    seen, out = set(), []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def extract_entities(description: str) -> dict:
    instruction = (
        "Extract named entities from the following text. "
        "Return ONLY a JSON object with these exact keys:\n"
        '  "characters": list of ALL named characters — includes heroes, villains, '
        "antagonists, aliens, monsters, non-human beings, and alter-egos or hero aliases. "
        "A superhero or villain name counts as a character even if it's also a title. "
        "If a character has both a real name and an alias/alter-ego, include BOTH.\n"
        '  "locations": list of ALL named places — includes real locations, fantasy areas, '
        "sci-fi zones, named dimensions, named forests, named rooms or domains, "
        "and any proper-noun place name including those in quotation marks.\n"
        '  "groups": list of named teams, clans, guilds, squads, gangs, or organisations\n'
        "Rules:\n"
        "- Proper nouns only, no descriptions\n"
        "- No duplicates\n"
        "- Return raw JSON only, no markdown fences, no explanation"
    )
    response = run_prompt(instruction, description, max_new_tokens=512)
    parsed = extract_json_block(response)
    if parsed and isinstance(parsed, dict):
        characters = parsed.get("characters", [])
        locations  = parsed.get("locations",  [])
        groups     = parsed.get("groups",     [])
    else:
        log.warning(f"Could not parse entities from LLM. Raw response:\n{response}")
        characters, locations, groups = [], [], []

    bracketed = extract_bracketed_terms(description)
    if bracketed:
        all_known = set(characters + groups)
        for term in bracketed:
            if term not in all_known and term not in locations:
                locations.append(term)

    return {
        "characters": deduplicate(characters),
        "locations":  deduplicate(locations),
        "groups":     deduplicate(groups),
    }


def generate_whisper_description(description: str, characters: list,
                                  source_is_english: bool = False) -> tuple:
    """Returns (ja, en) — a short Japanese description plus its English mirror."""
    instruction = (
        "Summarise the following text into a short Japanese description "
        "suitable as context for a speech recognition system. "
        "Focus only on nouns describing the setting and situation: "
        "where it takes place, what kind of scene it is, what is happening. "
        "Do NOT include any personal names or character names. "
        "Maximum 60 Japanese characters. "
        "No adjectives. No verbs. No explanations. "
        "Return only the Japanese summary, nothing else."
    )
    ja = run_prompt(instruction, description, max_new_tokens=128).strip()
    ja = strip_character_names(ja, characters)
    if source_is_english and not contains_japanese(ja):
        ja = translate_to_japanese(ja)
    en = translate_to_english(ja)
    return ja, en


def _is_mostly_japanese(s: str) -> bool:
    """True if at least one Japanese (CJK/kana) char is present."""
    return contains_japanese(s)


def _bilingualise(items: list) -> tuple:
    """Given a mixed list of EN/JA strings, return parallel (ja, en) lists.
    Already-correct items are kept as-is; only the missing-language side is
    translated. Translations are batched per direction."""
    if not items:
        return [], []
    n = len(items)
    ja_out = [None] * n
    en_out = [None] * n
    en_idx, ja_idx = [], []
    for i, item in enumerate(items):
        if contains_japanese(item):
            ja_out[i] = item; ja_idx.append(i)
        else:
            en_out[i] = item; en_idx.append(i)
    if en_idx:
        ja_translations = translate_list_to_japanese([items[i] for i in en_idx])
        for i, v in zip(en_idx, ja_translations): ja_out[i] = v
    if ja_idx:
        en_translations = translate_list_to_english([items[i] for i in ja_idx])
        for i, v in zip(ja_idx, en_translations): en_out[i] = v
    return ja_out, en_out


def build_context(description: str, on_step=None,
                  audio_duration: float = 0.0) -> dict:
    """Run the full pipeline. on_step(msg) is called with progress strings.
    Bilingual schema for synopsis/description/tone/vocabulary/characters.
    Scenes / annotations remain plain English lists — translation is intentionally
    skipped for those (they're hand-edited and processed offline).
    audio_duration (seconds) seeds the initial root Scene's end."""
    def step(msg):
        log.info(msg)
        if on_step:
            on_step(msg)

    ensure_loaded(on_step=on_step)

    source_is_english = not _is_mostly_japanese(description)
    step(f"🌐 Source language: {'English' if source_is_english else 'Japanese'}")

    step("📖 Producing bilingual synopsis…")
    if source_is_english:
        synopsis_en = description
        synopsis_ja = translate_to_japanese(description)
    else:
        synopsis_ja = description
        synopsis_en = translate_to_english(description)

    step("🔍 Extracting entities…")
    entities = extract_entities(description)
    characters = entities["characters"]
    locations  = entities["locations"]
    groups     = entities["groups"]
    step(f"  👥 Characters ({len(characters)}): {characters}")
    step(f"  📍 Locations  ({len(locations)}): {locations}")
    step(f"  🛡 Groups     ({len(groups)}): {groups}")

    if source_is_english:
        step("🌐 Normalising entities to JA + EN…")
        characters, characters_en = _bilingualise(characters)
        locations,  locations_en  = _bilingualise(locations)
        groups,     groups_en     = _bilingualise(groups)
        vocabulary    = locations + groups
        vocabulary_en = locations_en + groups_en
    else:
        vocabulary = locations + groups
        step("🌐 Translating entities JA→EN for reference…")
        characters_en = translate_list_to_english(characters) if characters else []
        vocabulary_en = translate_list_to_english(vocabulary) if vocabulary else []

    step("📝 Generating Whisper-friendly description…")
    desc_ja, desc_en = generate_whisper_description(
        description, characters, source_is_english=source_is_english,
    )
    step(f"  🇯🇵 {desc_ja}")
    step(f"  🇬🇧 {desc_en}")

    chars_obj = []
    for ja_name, en_name in zip(characters, characters_en):
        chars_obj.append({
            "name":        {"ja": ja_name, "en": en_name},
            "aliases":     {"ja": [],      "en": []},
            "description": {"ja": "",      "en": ""},
        })

    return {
        "synopsis":    {"ja": synopsis_ja, "en": synopsis_en},
        "description": {"ja": desc_ja,     "en": desc_en},
        "tone":        {"ja": "会話調",    "en": "conversational"},
        "_notes": (
            "Edit this file before downstream processing. "
            "Add scenes (start/end + plain text), annotations (start + plain text), "
            "and fill per-character aliases / descriptions."
        ),
        "characters":  chars_obj,
        "vocabulary":  {"ja": vocabulary, "en": vocabulary_en},
        # Scenes tile the audio contiguously. The root scene covers the full
        # audio length until split. Schema: {start, end, text}. Annotations
        # are point-in-time events with just {start, text}.
        "scenes": [{
            "start": 0.0,
            "end":   round(float(audio_duration or 0.0), 3),
            "text":  "",
        }],
        "annotations": [],
    }
