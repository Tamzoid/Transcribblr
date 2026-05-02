// ── Translations → Advanced sub-tab ──────────────────────────────────────────
// Qwen2.5-14B with full project context. Lets the user pick:
//   • Context mode: Full / TLDR / Close
//   • Scope: by scene OR by record range
//   • Optional style hint
//   • Force re-translate already-translated records
// Streams progress via /process-status (same pattern as transcribe + basic).

var _trAdvPolling = false;

function _trAdvEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _trAdvSetStatus(msg, warn){
  var el=$('tr-adv-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _trAdvLog(line){
  var el=$('tr-adv-log'); if(!el)return;
  var cur = el.textContent;
  // Collapse consecutive heartbeat ticks AND HF download progress lines
  // (same file → updating in place rather than piling up).
  var key = null;
  var hb = line.match(/⏳\s+(.+?)\s+— still working/);
  if(hb) key = '⏳:' + hb[1];
  var dl = line.match(/📥\s+(.+?)\s+\d+%/);
  if(dl) key = '📥:' + dl[1];
  if(key){
    var lastNl = cur.lastIndexOf('\n');
    var lastLine = (lastNl >= 0) ? cur.substring(lastNl + 1) : cur;
    var prevHb = lastLine.match(/⏳\s+(.+?)\s+— still working/);
    var prevDl = lastLine.match(/📥\s+(.+?)\s+\d+%/);
    var prevKey = prevHb ? '⏳:' + prevHb[1] : (prevDl ? '📥:' + prevDl[1] : null);
    if(prevKey === key){
      el.textContent = (lastNl >= 0 ? cur.substring(0, lastNl + 1) : '') + line;
      el.scrollTop = el.scrollHeight;
      return;
    }
  }
  el.textContent += (cur ? '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function _trAdvClearLog(){
  var el=$('tr-adv-log'); if(el) el.textContent='';
}

// ── Token-size estimate for Full mode ────────────────────────────────────────
// Walks `entries`, sums chars over translated records, divides by 2.5
// (mixed JA + EN ≈ 2.5 chars/token). Updates the indicator next to the
// Full radio with a green/amber/red colour.
function _trAdvUpdateFullSize(){
  var span=$('tr-adv-full-size'); if(!span)return;
  if(!entries || !entries.length){ span.textContent = ''; return; }
  var chars = 0;
  entries.forEach(function(e){
    if(!e || !e.text || typeof e.text !== 'object') return;
    var ja = e.text.ja || '';
    var en = e.text.en || '';
    if(!en.trim() || ja.indexOf('????') !== -1) return;
    chars += ja.length + en.length;
  });
  var tokens = Math.round(chars / 2.5);
  var label;
  if(tokens < 1000) label = tokens + ' tok';
  else label = (tokens / 1000).toFixed(1) + 'K tok';
  var color, dot;
  if(tokens < 16000)      { color = '#00ff88'; dot = '🟢'; }
  else if(tokens < 32000) { color = '#ffaa55'; dot = '🟠'; }
  else                    { color = '#ff5555'; dot = '🔴'; }
  span.textContent = '~' + label + ' ' + dot;
  span.style.color = color;
}
window._trAdvUpdateFullSize = _trAdvUpdateFullSize;

// ── Context-mode radio group ─────────────────────────────────────────────────
function _trAdvCurMode(){
  var sel=document.querySelector('input[name="tr-adv-mode"]:checked');
  return sel ? sel.value : 'tldr';
}
function _trAdvOnModeChange(){
  var mode = _trAdvCurMode();
  var box=$('tr-adv-story-box');
  if(box) box.style.display = mode === 'tldr' ? '' : 'none';
}

// ── Scope picker ─────────────────────────────────────────────────────────────
function _trAdvCurScope(){
  var sel=document.querySelector('input[name="tr-adv-scope"]:checked');
  return sel ? sel.value : 'scene';
}
function _trAdvOnScopeChange(){
  var s = _trAdvCurScope();
  var sceneRow=$('tr-adv-scene-row'), rangeRow=$('tr-adv-range-row');
  if(sceneRow) sceneRow.style.display = s === 'scene' ? '' : 'none';
  if(rangeRow) rangeRow.style.display = s === 'range' ? '' : 'none';
  _trAdvUpdateRunBtn();
}

function _trAdvBuildSceneDropdown(){
  var sel=$('tr-adv-scene'); if(!sel)return;
  var prev = sel.value;
  sel.innerHTML='';
  var scenes = (typeof _ann !== 'undefined' && _ann && _ann.scenes) || [];
  if(!scenes.length){
    var o=document.createElement('option');
    o.value=''; o.textContent='(no scenes — generate context first)';
    sel.appendChild(o); sel.disabled = true;
    return;
  }
  sel.disabled = false;
  scenes.forEach(function(s, i){
    var pendingCount = _trAdvSceneIndices(s).length;
    var label = (i+1) + '. ' + (s.text||'(no description)').substring(0,40)
              + (s.text && s.text.length>40?'…':'')
              + ' — ' + pendingCount + ' record' + (pendingCount===1?'':'s');
    var o=document.createElement('option');
    o.value = String(i); o.textContent = label;
    sel.appendChild(o);
  });
  if(prev) sel.value = prev;
}

function _trAdvSceneIndices(scene){
  if(!scene || !entries) return [];
  var st = scene.start || 0, en = scene.end != null ? scene.end : Infinity;
  var force = $('tr-adv-force') && $('tr-adv-force').checked;
  var out = [];
  entries.forEach(function(e, i){
    var t = e.start || 0;
    if(t < st || t >= en) return;
    var ja = (e.text && typeof e.text === 'object') ? (e.text.ja || '') : '';
    if(!ja.trim() || ja.indexOf('????') !== -1) return;
    var en2 = (e.text && typeof e.text === 'object') ? (e.text.en || '') : '';
    if(en2.trim() && !force) return;
    out.push(i);
  });
  return out;
}

function _trAdvRangeIndices(){
  var fromEl=$('tr-adv-range-from'), toEl=$('tr-adv-range-to');
  var force = $('tr-adv-force') && $('tr-adv-force').checked;
  if(!fromEl || !toEl) return [];
  var from = parseInt(fromEl.value, 10), to = parseInt(toEl.value, 10);
  if(isNaN(from) || isNaN(to)) return [];
  // 1-based inclusive in the UI
  var lo = Math.min(from, to) - 1, hi = Math.max(from, to) - 1;
  var out = [];
  for(var i = Math.max(0, lo); i <= Math.min(entries.length - 1, hi); i++){
    var e = entries[i]; if(!e) continue;
    var ja = (e.text && typeof e.text === 'object') ? (e.text.ja || '') : '';
    if(!ja.trim() || ja.indexOf('????') !== -1) continue;
    var en = (e.text && typeof e.text === 'object') ? (e.text.en || '') : '';
    if(en.trim() && !force) continue;
    out.push(i);
  }
  return out;
}

function _trAdvCurIndices(){
  if(_trAdvCurScope() === 'scene'){
    var sel=$('tr-adv-scene');
    var i = sel ? parseInt(sel.value, 10) : -1;
    var scenes = (typeof _ann !== 'undefined' && _ann && _ann.scenes) || [];
    if(isNaN(i) || i < 0 || i >= scenes.length) return [];
    return _trAdvSceneIndices(scenes[i]);
  }
  return _trAdvRangeIndices();
}

function _trAdvUpdateRunBtn(){
  var btn=$('tr-adv-run'); if(!btn) return;
  var indices = _trAdvCurIndices();
  btn.disabled = !indices.length || _trAdvPolling;
  btn.textContent = indices.length
    ? 'Translate ' + indices.length + ' record' + (indices.length===1?'':'s')
    : 'Translate (none selected)';
}

// ── Story-so-far box ─────────────────────────────────────────────────────────
function _trAdvRenderStoryBox(){
  var box=$('tr-adv-story-text'), idxEl=$('tr-adv-story-idx');
  if(!box) return;
  // Pull from the project's context — fetched on every poll completion via
  // the existing /context endpoint indirectly. Cache on window.
  var ctx = window._trAdvCachedCtx || {};
  var story = (ctx.story_so_far || '').trim();
  var through = (ctx.story_so_far_through_idx != null) ? ctx.story_so_far_through_idx : -1;
  box.textContent = story || '(no summary yet — translate in TLDR mode or click Refresh)';
  if(idxEl){
    var total = entries ? entries.length : 0;
    idxEl.textContent = through >= 0
      ? 'Covers records 1–' + (through + 1) + ' of ' + total
      : 'Not generated yet';
  }
}

function _trAdvFetchCtx(cb){
  fetch('/context').then(function(r){return r.json();}).then(function(d){
    window._trAdvCachedCtx = (d && d.context) || {};
    if(cb) cb();
  }).catch(function(){ if(cb) cb(); });
}

// ── Polling ──────────────────────────────────────────────────────────────────
function _trAdvPoll(jobId){
  _trAdvPolling = true;
  _trAdvUpdateRunBtn();
  var refreshBtn=$('tr-adv-refresh-summary');
  if(refreshBtn) refreshBtn.disabled = true;
  var since = 0;
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type==='step'){
            _trAdvLog(ev.msg);
          } else if(ev.type==='progress' && ev.idx !== undefined){
            if(entries[ev.idx]){
              if(typeof entries[ev.idx].text !== 'object')
                entries[ev.idx].text = {ja:'',ro:'',en:''};
              entries[ev.idx].text.en = ev.en || '';
              if(ev.translator_note){
                entries[ev.idx].translator_note = ev.translator_note;
              } else {
                delete entries[ev.idx].translator_note;
              }
              entries[ev.idx].new = true;
            }
          } else if(ev.type==='result'){
            if(ev.summary !== undefined){
              _trAdvSetStatus('✓ Story summary regenerated');
            } else {
              _trAdvSetStatus('✓ Translated '+ev.translated+'/'+ev.total
                + (ev.failed?' ('+ev.failed+' failed)':'')
                + (ev.notes_added?' · '+ev.notes_added+' note(s) added':''));
            }
          } else if(ev.type==='error'){
            _trAdvSetStatus('⚠ '+ev.error, true);
          }
        });
        since = s.next || since;
        if(s.done){
          _trAdvPolling = false;
          if(refreshBtn) refreshBtn.disabled = false;
          // Refetch /data + /context so the dropdown labels, badges, story
          // box and size indicator all reflect the latest persisted state.
          if(typeof apiFetchData === 'function'){
            apiFetchData().then(function(fresh){
              if(Array.isArray(fresh)) entries = fresh;
              if(typeof buildDD==='function')buildDD();
              if(typeof render==='function')render();
              _trAdvFetchCtx(function(){
                _trAdvRenderStoryBox();
                _trAdvUpdateFullSize();
                _trAdvBuildSceneDropdown();
                _trAdvUpdateRunBtn();
              });
            });
          } else {
            _trAdvFetchCtx(_trAdvRenderStoryBox);
            _trAdvUpdateFullSize();
            _trAdvUpdateRunBtn();
          }
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        _trAdvPolling = false;
        if(refreshBtn) refreshBtn.disabled = false;
        _trAdvSetStatus('Poll failed: '+e, true);
        _trAdvUpdateRunBtn();
      });
  }
  tick();
}

// ── Actions ──────────────────────────────────────────────────────────────────
function _trAdvStart(){
  if(!window._activeFile){ _trAdvSetStatus('No project selected', true); return; }
  var indices = _trAdvCurIndices();
  if(!indices.length){ _trAdvSetStatus('No records selected', true); return; }
  var force = !!($('tr-adv-force') && $('tr-adv-force').checked);
  var mode = _trAdvCurMode();
  var hint = (($('tr-adv-style-hint')||{}).value || '').trim();
  _trAdvClearLog();
  _trAdvSetStatus('Starting (' + mode + ' mode, ' + indices.length + ' record' + (indices.length===1?'':'s') + ')…');
  fetch('/translate-advanced',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      indices: indices, context_mode: mode, force: force, style_hint: hint,
    })
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id returned'); }
      _trAdvPoll(d.job_id);
    })
    .catch(function(e){ _trAdvSetStatus('⚠ '+e, true); });
}

function _trAdvRefreshSummary(){
  if(!window._activeFile){ _trAdvSetStatus('No project selected', true); return; }
  _trAdvClearLog();
  _trAdvSetStatus('Generating story summary — loads Qwen on first run…');
  fetch('/refresh-story-summary',{
    method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id returned'); }
      _trAdvPoll(d.job_id);
    })
    .catch(function(e){ _trAdvSetStatus('⚠ '+e, true); });
}

// ── Public hook called when the Translations panel is shown ──────────────────
window._trAdvOnShow = function(){
  _trAdvBuildSceneDropdown();
  _trAdvUpdateFullSize();
  _trAdvOnModeChange();
  _trAdvOnScopeChange();
  _trAdvFetchCtx(function(){
    _trAdvRenderStoryBox();
    _trAdvUpdateRunBtn();
  });
};

// ── Wiring ───────────────────────────────────────────────────────────────────
(function _wireTrAdv(){
  document.querySelectorAll('input[name="tr-adv-mode"]').forEach(function(r){
    r.addEventListener('change', _trAdvOnModeChange);
  });
  document.querySelectorAll('input[name="tr-adv-scope"]').forEach(function(r){
    r.addEventListener('change', _trAdvOnScopeChange);
  });
  var sel=$('tr-adv-scene'); if(sel) sel.addEventListener('change', _trAdvUpdateRunBtn);
  var fr=$('tr-adv-range-from'); if(fr) fr.addEventListener('input', _trAdvUpdateRunBtn);
  var to=$('tr-adv-range-to');   if(to) to.addEventListener('input', _trAdvUpdateRunBtn);
  var force=$('tr-adv-force');   if(force) force.addEventListener('change', function(){
    _trAdvBuildSceneDropdown(); _trAdvUpdateRunBtn();
  });
  var run=$('tr-adv-run');         if(run) run.addEventListener('click', _trAdvStart);
  var refresh=$('tr-adv-refresh-summary');
  if(refresh) refresh.addEventListener('click', _trAdvRefreshSummary);
})();
