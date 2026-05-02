#!/usr/bin/env python3
"""
Transcribblr build script
Inlines web/style.css and web/*.js into web/index.html.

Usage:
    python build.py          # build only
    python build.py --zip    # build + create Transcribblr_v2.zip
"""

import os
import re
import sys
import shutil
import zipfile
from datetime import datetime

ROOT    = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, 'src', 'web')

# Source template
TEMPLATE = os.path.join(WEB_DIR, 'templates', 'base.html')
OUTPUT   = os.path.join(WEB_DIR, 'index.html')

# JS files in load order
JS_FILES = [
    'api.js',
    'ui.js',
    'player.js',
    'components/slider/slider.js',
    'components/undo/undo.js',
    'editor.js',
    'tab_record.js',
    'filepicker.js',
    'export.js',
    'create.js',
    'context.js',
    'annotations.js',
    'transcribe.js',
    'translations.js',
    'translate_advanced.js',
    'translate_review.js',
    'translate_full_review.js',
    'tools.js',
    'app.js',
]


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def build():
    print("Building Transcribblr...")

    if not os.path.exists(TEMPLATE):
        # First run — create the template from current index.html
        _create_template()

    html = read(TEMPLATE)

    # ── Resolve HTML partials ────────────────────────────────────────────────
    import re as _re
    def resolve_partials(h, base_dir, depth=0):
        if depth > 5: return h  # guard against circular includes
        def replacer(m):
            inner = m.group(1).strip()
            # Optional parameters: <!-- {{PARTIAL: path.html | key=val, key2=val2}} -->
            if '|' in inner:
                path_str, params_str = inner.split('|', 1)
                params = {}
                for kv in params_str.split(','):
                    kv = kv.strip()
                    if '=' in kv:
                        k, v = kv.split('=', 1)
                        params[k.strip()] = v.strip()
            else:
                path_str, params = inner, {}
            path = os.path.join(base_dir, path_str.strip())
            if not os.path.exists(path):
                print(f"  WARNING: Missing partial: {path_str.strip()}")
                return f"<!-- MISSING: {path_str.strip()} -->"
            content = read(path)
            for k, v in params.items():
                content = content.replace('{{' + k + '}}', v)
            print(f"  OK {path_str.strip()} ({len(content.splitlines())} lines)")
            return resolve_partials(content, base_dir, depth+1)
        return _re.sub(r'<!-- \{\{PARTIAL: ([^}]+)\}\} -->', replacer, h)

    html = resolve_partials(html, WEB_DIR)

    # ── Inline CSS ──────────────────────────────────────────────────────────
    css_parts = [read(os.path.join(WEB_DIR, 'style.css'))]
    components_dir = os.path.join(WEB_DIR, 'components')
    if os.path.isdir(components_dir):
        for cname in sorted(os.listdir(components_dir)):
            css_file = os.path.join(components_dir, cname, cname + '.css')
            if os.path.isfile(css_file):
                css_parts.append(read(css_file))
                print(f"  OK {cname}/{cname}.css")
    css = '\n'.join(css_parts)
    html = html.replace('/* {{STYLE_CSS}} */', css)

    # ── Inline JS ───────────────────────────────────────────────────────────
    parts = []
    for fname in JS_FILES:
        path = os.path.join(WEB_DIR, fname)
        if not os.path.exists(path):
            print(f"  WARNING: Missing: {fname} — skipping")
            continue
        src = read(path)
        parts.append(f"// ── {fname} {'─' * (50 - len(fname))}\n{src}")
        print(f"  OK {fname} ({len(src.splitlines())} lines)")

    js = '\n\n'.join(parts)
    html = html.replace('/* {{APP_JS}} */', js)

    # ── Write output ────────────────────────────────────────────────────────
    # Validate JS brace balance
    import re
    scripts = re.findall(r'<script>(.*?)</script>', html, re.DOTALL)
    for i, s in enumerate(scripts):
        o, c = s.count('{'), s.count('}')
        if o != c:
            print(f"\nERROR: JS brace mismatch in script {i+1}: {o} open, {c} close")
            return False

    with open(OUTPUT, 'w', encoding='utf-8') as f:
        f.write(html)

    print(f"\nSUCCESS: Built -> web/index.html ({len(html.splitlines())} lines)")
    return True


def _create_template():
    """
    One-time: turn the current index.html into index.template.html
    by replacing the inline CSS and JS with placeholder comments.
    """
    print("  Creating index.template.html from current index.html...")
    html = read(OUTPUT)

    # Replace inline <style> block with placeholder
    html = re.sub(
        r'<style>\n.*?\n</style>',
        '<style>\n/* {{STYLE_CSS}} */\n</style>',
        html, count=1, flags=re.DOTALL
    )

    # Replace inline <script> block with placeholder
    html = re.sub(
        r'<script>\n\(function\(\)\{.*?\}\)\(\);\n</script>',
        '<script>\n(function(){\n/* {{APP_JS}} */\n})();\n</script>',
        html, count=1, flags=re.DOTALL
    )

    with open(TEMPLATE, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"  OK Template saved -> web/index.template.html")


def make_zip():
    ts       = datetime.now().strftime('%Y%m%d_%H%M%S')
    zip_name = f'Transcribblr_v2_{ts}.zip'
    zip_path = os.path.join(os.path.dirname(ROOT), zip_name)

    folder_name = os.path.basename(ROOT)
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            # Skip __pycache__, .git, logs
            dirnames[:] = [d for d in dirnames
                           if d not in ('__pycache__', '.git', 'logs', '.ipynb_checkpoints')]
            for fname in filenames:
                if fname.endswith('.pyc'):
                    continue
                fpath    = os.path.join(dirpath, fname)
                arc_path = os.path.join(folder_name,
                                        os.path.relpath(fpath, ROOT))
                zf.write(fpath, arc_path)

    size = os.path.getsize(zip_path) // 1024
    print(f"\nZIPPED: {zip_name} ({size}KB)")
    return zip_path


if __name__ == '__main__':
    ok = build()
    if ok and '--zip' in sys.argv:
        make_zip()
