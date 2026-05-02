// ── Translations → Full Review sub-tab ───────────────────────────────────────
// Walks every translated record (or just the 🆕 unreviewed ones) in chunks
// via Qwen2.5-14B and asks for revision suggestions. Each suggestion lands
// as a card with current/proposed diff and per-card Apply / Skip buttons.

var _trFrPolling = false;
var _trFrSuggestions = [];   // [{idx, time, ja, current_en, current_lit,
                              //   proposed_en, proposed_lit, note,
                              //   block_text, status: 'pending'|'applied'|'skipped'}]

function _trFrEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _trFrSetStatus(msg, warn){
  var el=$('tr-fr-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _trFrLog(line){
  var el=$('tr-fr-log'); if(!el)return;
  var cur = el.textContent;
  var key = null;
  var hb = line.match(/⏳\s+(.+?)\s+— still working/);
  if(hb) key = '⏳:' + hb[1];
  if(key){
    var lastNl = cur.lastIndexOf('\n');
    var lastLine = (lastNl >= 0) ? cur.substring(lastNl + 1) : cur;
    var prevHb = lastLine.match(/⏳\s+(.+?)\s+— still working/);
    if(prevHb && '⏳:' + prevHb[1] === key){
      el.textContent = (lastNl >= 0 ? cur.substring(0, lastNl + 1) : '') + line;
      el.scrollTop = el.scrollHeight;
      return;
    }
  }
  el.textContent += (cur ? '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function _trFrCountScopes(){
  var unreviewed = 0, all = 0;
  (entries || []).forEach(function(e){
    if(!e || !e.text || typeof e.text !== 'object') return;
    var ja = e.text.ja || '', en = e.text.en || '';
    if(!ja.trim() || ja.indexOf('????') !== -1) return;
    if(!en.trim()) return;
    all++;
    if(e.new) unreviewed++;
  });
  var u=$('tr-fr-count-unreviewed'); if(u) u.textContent = unreviewed;
  var a=$('tr-fr-count-all');         if(a) a.textContent = all;
}

function _trFrCurScope(){
  var sel = document.querySelector('input[name="tr-fr-scope"]:checked');
  return sel ? sel.value : 'unreviewed';
}

function _trFrUpdateSummary(){
  var el=$('tr-fr-summary'); if(!el) return;
  var pending = _trFrSuggestions.filter(function(s){return s.status==='pending';}).length;
  var applied = _trFrSuggestions.filter(function(s){return s.status==='applied';}).length;
  var skipped = _trFrSuggestions.filter(function(s){return s.status==='skipped';}).length;
  if(!_trFrSuggestions.length){
    el.textContent = '';
  } else {
    el.textContent = pending + ' pending · ' + applied + ' applied · ' + skipped + ' skipped';
  }
  var btn = $('tr-fr-apply-all');
  if(btn) btn.disabled = pending === 0;
}

// ── Suggestion card rendering ────────────────────────────────────────────────
function _trFrRender(){
  var host=$('tr-fr-suggestions'); if(!host) return;
  if(!_trFrSuggestions.length){
    host.innerHTML = '<div style="padding:6px;color:#666">No suggestions yet — click <em>Run full review</em>.</div>';
    _trFrUpdateSummary();
    return;
  }
  host.innerHTML = '';
  _trFrSuggestions.forEach(function(s, si){
    var card = document.createElement('div');
    var color = s.status === 'applied' ? '#0a1f12'
              : s.status === 'skipped' ? '#1a1a1a'
              : '#0d1822';
    var border = s.status === 'applied' ? '#1a3a28'
               : s.status === 'skipped' ? '#2a2a2a'
               : '#1a2f3d';
    card.style.cssText = 'background:'+color+';border-left:3px solid '+border+
      ';border-radius:4px;padding:8px;margin-bottom:8px';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;'+
      'margin-bottom:6px;font-size:11px;font-weight:700;color:#888';
    var label = '#' + (s.idx + 1) + '  ' + (s.time||'');
    var statusTag = '';
    if(s.status === 'applied') statusTag = ' <span style="color:#00ff88">✓ applied</span>';
    else if(s.status === 'skipped') statusTag = ' <span style="color:#666">✗ skipped</span>';
    header.innerHTML = '<span>'+_trFrEsc(label)+statusTag+'</span>';

    if(s.status === 'pending'){
      var btnApply = document.createElement('button');
      btnApply.className = 'btn'; btnApply.textContent = 'Apply';
      btnApply.style.cssText = 'padding:2px 10px;font-size:10px;background:#0a1f12;color:#00ff88';
      btnApply.addEventListener('click', function(){ _trFrApply(si, btnApply); });
      var btnSkip = document.createElement('button');
      btnSkip.className = 'btn'; btnSkip.textContent = 'Skip';
      btnSkip.style.cssText = 'padding:2px 10px;font-size:10px;margin-left:4px';
      btnSkip.addEventListener('click', function(){ _trFrSkip(si); });
      var actions = document.createElement('span');
      actions.appendChild(btnApply); actions.appendChild(btnSkip);
      header.appendChild(actions);
    }

    card.appendChild(header);

    // JA reference
    var ja = document.createElement('div');
    ja.style.cssText = 'color:#888;font-size:11px;margin-bottom:4px';
    ja.textContent = '[' + (s.ja || '') + ']';
    card.appendChild(ja);

    // Diff: current EN strikethrough, proposed EN bold green
    var diff = document.createElement('div');
    diff.style.cssText = 'font-size:11px;line-height:1.5';
    diff.innerHTML =
      '<div style="color:#888;text-decoration:line-through">' + _trFrEsc(s.current_en || '') + '</div>'+
      '<div style="color:#00ff88;font-weight:600">' + _trFrEsc(s.proposed_en || '') + '</div>';
    card.appendChild(diff);

    // Literal diff (if proposed_lit differs from current_lit)
    if(s.proposed_lit && s.proposed_lit !== s.current_lit){
      var litDiff = document.createElement('div');
      litDiff.style.cssText = 'font-size:10px;line-height:1.4;margin-top:4px;color:#9cc';
      var oldLit = s.current_lit
        ? '<div style="color:#557; text-decoration:line-through">&lt;'+_trFrEsc(s.current_lit)+'&gt;</div>'
        : '';
      litDiff.innerHTML = oldLit + '<div>&lt;'+_trFrEsc(s.proposed_lit)+'&gt;</div>';
      card.appendChild(litDiff);
    }

    // Translator note
    if(s.note){
      var note = document.createElement('div');
      note.style.cssText = 'font-size:10px;color:#7dd3e0;margin-top:6px;padding:4px 6px;'+
        'background:#0a1820;border:1px solid #1a3540;border-radius:3px';
      note.innerHTML = '💬 ' + _trFrEsc(s.note);
      card.appendChild(note);
    }

    host.appendChild(card);
  });
  _trFrUpdateSummary();
}

// ── Polling ──────────────────────────────────────────────────────────────────
function _trFrPoll(jobId){
  _trFrPolling = true;
  var runBtn=$('tr-fr-run'); if(runBtn) runBtn.disabled = true;
  var since = 0;
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type === 'step') _trFrLog(ev.msg);
          else if(ev.type === 'progress' && ev.idx !== undefined){
            _trFrSuggestions.push({
              idx: ev.idx, time: ev.time || '', ja: ev.ja || '',
              current_en:  ev.current_en  || '', current_lit:  ev.current_lit  || '',
              proposed_en: ev.proposed_en || '', proposed_lit: ev.proposed_lit || '',
              note: ev.note || '', block_text: ev.block_text || '',
              status: 'pending',
            });
            _trFrRender();
          } else if(ev.type === 'result'){
            _trFrSetStatus('✓ Reviewed '+ev.reviewed+' record(s) in '+ev.chunks
              +' chunk(s) — '+ev.suggested+' suggestion(s)');
          } else if(ev.type === 'error'){
            _trFrSetStatus('⚠ '+ev.error, true);
          }
        });
        since = s.next || since;
        if(s.done){
          _trFrPolling = false;
          if(runBtn) runBtn.disabled = false;
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        _trFrPolling = false;
        if(runBtn) runBtn.disabled = false;
        _trFrSetStatus('Poll failed: '+e, true);
      });
  }
  tick();
}

// ── Actions ──────────────────────────────────────────────────────────────────
function _trFrRun(){
  if(!window._activeFile){ _trFrSetStatus('No project selected', true); return; }
  if(_trFrPolling) return;
  var scope = _trFrCurScope();
  var chunkSize = parseInt(($('tr-fr-chunk')||{value:10}).value, 10) || 10;
  // Reset suggestions for a new run
  _trFrSuggestions = [];
  _trFrRender();
  _trFrSetStatus('Starting full review ('+scope+', chunk '+chunkSize+')…');
  fetch('/full-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({scope: scope, chunk_size: chunkSize})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id'); }
      _trFrPoll(d.job_id);
    })
    .catch(function(e){ _trFrSetStatus('⚠ '+e, true); });
}

function _trFrApply(si, btn){
  var s = _trFrSuggestions[si]; if(!s || s.status !== 'pending') return;
  if(btn) btn.disabled = true;
  fetch('/apply-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({response_text: s.block_text, indices: [s.idx]})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok || !d.updated){ throw new Error(d.error || 'no records updated'); }
      s.status = 'applied';
      _trFrRender();
      // Refresh entries so the dropdown badge / preview / Text-tab banner
      // all reflect the new translation.
      if(typeof apiFetchData === 'function'){
        apiFetchData().then(function(fresh){
          if(Array.isArray(fresh)) entries = fresh;
          if(typeof buildDD==='function')buildDD();
          if(typeof render==='function')render();
          _trFrCountScopes();
        });
      }
    })
    .catch(function(e){
      _trFrSetStatus('⚠ apply: '+e, true);
      if(btn) btn.disabled = false;
    });
}

function _trFrSkip(si){
  var s = _trFrSuggestions[si]; if(!s || s.status !== 'pending') return;
  s.status = 'skipped';
  _trFrRender();
}

function _trFrApplyAll(){
  // Sequentially apply every pending suggestion. Stops on first error.
  var pending = _trFrSuggestions
    .map(function(s, i){ return {s:s, i:i}; })
    .filter(function(p){ return p.s.status === 'pending'; });
  if(!pending.length) return;
  if(!confirm('Apply all '+pending.length+' pending suggestion(s)?')) return;
  _trFrSetStatus('Applying '+pending.length+'…');

  function step(k){
    if(k >= pending.length){
      _trFrSetStatus('✓ Applied all pending suggestions');
      if(typeof apiFetchData === 'function'){
        apiFetchData().then(function(fresh){
          if(Array.isArray(fresh)) entries = fresh;
          if(typeof buildDD==='function')buildDD();
          if(typeof render==='function')render();
          _trFrCountScopes();
        });
      }
      return;
    }
    var p = pending[k];
    fetch('/apply-review',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({response_text: p.s.block_text, indices: [p.s.idx]})
    })
      .then(function(r){return r.json();})
      .then(function(d){
        if(d && d.ok && d.updated){ p.s.status = 'applied'; }
        else { p.s.status = 'skipped'; }
        _trFrRender();
        step(k + 1);
      })
      .catch(function(e){
        _trFrSetStatus('⚠ apply-all halted: '+e, true);
      });
  }
  step(0);
}

// ── Public hook ──────────────────────────────────────────────────────────────
window._trFrOnShow = function(){
  _trFrCountScopes();
  _trFrRender();
};

// ── Wiring ───────────────────────────────────────────────────────────────────
(function _wireTrFr(){
  var run=$('tr-fr-run');           if(run) run.addEventListener('click', _trFrRun);
  var apply=$('tr-fr-apply-all');   if(apply) apply.addEventListener('click', _trFrApplyAll);
  document.querySelectorAll('input[name="tr-fr-scope"]').forEach(function(r){
    r.addEventListener('change', function(){});
  });
})();
