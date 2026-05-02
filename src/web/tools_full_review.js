// ── Tools → Full Review sub-tab — bulk audit of TRANSCRIPTIONS ──────────────
// Walks every transcribed record (or just the unreviewed ones) in chunks via
// Qwen2.5-14B asking it to flag transcription errors. Each suggestion lands
// as a card with current/proposed JA diff and per-card Apply / Skip buttons.

var _txFrPolling = false;
var _txFrSuggestions = [];   // [{idx, time, current_ja, proposed_ja, note,
                              //   block_text, status: 'pending'|'applied'|'skipped'}]

function _txFrEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _txFrSetStatus(msg, warn){
  var el=$('tx-fr-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _txFrLog(line){
  var el=$('tx-fr-log'); if(!el)return;
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

function _txFrCountScopes(){
  var unreviewed = 0, all = 0;
  (entries || []).forEach(function(e){
    if(!e || !e.text || typeof e.text !== 'object') return;
    var ja = e.text.ja || '';
    if(!ja.trim() || ja.indexOf('????') !== -1) return;
    all++;
    if(!e.new && !e.translator_note) unreviewed++;
  });
  var u=$('tx-fr-count-unreviewed'); if(u) u.textContent = unreviewed;
  var a=$('tx-fr-count-all');         if(a) a.textContent = all;
}

function _txFrCurScope(){
  var sel = document.querySelector('input[name="tx-fr-scope"]:checked');
  return sel ? sel.value : 'all';
}

function _txFrUpdateSummary(){
  var el=$('tx-fr-summary'); if(!el) return;
  var pending = _txFrSuggestions.filter(function(s){return s.status==='pending';}).length;
  var applied = _txFrSuggestions.filter(function(s){return s.status==='applied';}).length;
  var skipped = _txFrSuggestions.filter(function(s){return s.status==='skipped';}).length;
  if(!_txFrSuggestions.length){
    el.textContent = '';
  } else {
    el.textContent = pending + ' pending · ' + applied + ' applied · ' + skipped + ' skipped';
  }
  var btn = $('tx-fr-apply-all');
  if(btn) btn.disabled = pending === 0;
}

// ── Suggestion card rendering ────────────────────────────────────────────────
function _txFrRender(){
  var host=$('tx-fr-suggestions'); if(!host) return;
  if(!_txFrSuggestions.length){
    host.innerHTML = '<div style="padding:6px;color:#666">No suggestions yet — click <em>Run full audit</em>.</div>';
    _txFrUpdateSummary();
    return;
  }
  host.innerHTML = '';
  _txFrSuggestions.forEach(function(s, si){
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
      'margin-bottom:6px;font-size:11px;font-weight:700;color:#888;flex-wrap:wrap;gap:4px';
    var label = '#' + (s.idx + 1) + '  ' + (s.time||'');
    var statusTag = '';
    if(s.status === 'applied') statusTag = ' <span style="color:#00ff88">✓ applied</span>';
    else if(s.status === 'skipped') statusTag = ' <span style="color:#666">✗ skipped</span>';
    header.innerHTML = '<span>'+_txFrEsc(label)+statusTag+'</span>';

    if(s.status === 'pending'){
      var actions = document.createElement('span');
      var btnApply = document.createElement('button');
      btnApply.className = 'btn'; btnApply.textContent = 'Apply';
      btnApply.style.cssText = 'padding:2px 10px;font-size:10px;background:#0a1f12;color:#00ff88';
      btnApply.addEventListener('click', function(){ _txFrApply(si, btnApply); });
      var btnSkip = document.createElement('button');
      btnSkip.className = 'btn'; btnSkip.textContent = 'Skip';
      btnSkip.style.cssText = 'padding:2px 10px;font-size:10px;margin-left:4px';
      btnSkip.addEventListener('click', function(){ _txFrSkip(si); });
      actions.appendChild(btnApply); actions.appendChild(btnSkip);
      header.appendChild(actions);
    }
    card.appendChild(header);

    // Diff body — current vs proposed
    var diff = document.createElement('div');
    diff.style.cssText = 'font-size:11px;line-height:1.5';
    diff.innerHTML =
      '<div style="color:#a55"><span style="color:#666">— current:</span> '+_txFrEsc(s.current_ja || '(empty)')+'</div>'+
      '<div style="color:#9c9"><span style="color:#666">+ propose:</span> '+_txFrEsc(s.proposed_ja || '(empty)')+'</div>';
    if(s.note){
      diff.innerHTML += '<div style="color:#888;margin-top:4px;font-style:italic">📝 '+_txFrEsc(s.note)+'</div>';
    }
    card.appendChild(diff);

    host.appendChild(card);
  });
  _txFrUpdateSummary();
}

// ── Polling ──────────────────────────────────────────────────────────────────
function _txFrPoll(jobId){
  _txFrPolling = true;
  var runBtn=$('tx-fr-run'); if(runBtn) runBtn.disabled = true;
  var since = 0;
  var consecFail = 0;
  var MAX_CONSEC = 8;
  function tick(){
    var poll = (typeof _safePollJson === 'function')
      ? _safePollJson('/process-status?job='+jobId+'&since='+since)
      : fetch('/process-status?job='+jobId+'&since='+since).then(function(r){return r.json();});
    poll.then(function(s){
        consecFail = 0;
        (s.events||[]).forEach(function(ev){
          if(ev.type === 'step') _txFrLog(ev.msg);
          else if(ev.type === 'progress' && ev.idx !== undefined){
            _txFrSuggestions.push({
              idx: ev.idx, time: ev.time || '',
              current_ja:  ev.current_ja  || '',
              proposed_ja: ev.proposed_ja || '',
              note: ev.note || '', block_text: ev.block_text || '',
              status: 'pending',
            });
            _txFrRender();
          } else if(ev.type === 'result'){
            _txFrSetStatus('✓ Reviewed '+ev.reviewed+' record(s) in '+ev.chunks
              +' chunk(s) — '+ev.suggested+' suggestion(s)');
          } else if(ev.type === 'error'){
            _txFrSetStatus('⚠ '+ev.error, true);
          }
        });
        since = s.next || since;
        if(s.done){
          _txFrPolling = false;
          if(runBtn) runBtn.disabled = false;
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        consecFail++;
        if(consecFail >= MAX_CONSEC){
          _txFrPolling = false;
          if(runBtn) runBtn.disabled = false;
          _txFrSetStatus('Poll failed (gave up after '+MAX_CONSEC+' tries): '+e, true);
        } else {
          _txFrSetStatus('⏱ Upstream blip ('+consecFail+'/'+MAX_CONSEC+'), retrying…');
          setTimeout(tick, 2000);
        }
      });
  }
  tick();
}

// ── Run / Apply / Skip ───────────────────────────────────────────────────────
function _txFrRun(){
  if(!window._activeFile){ _txFrSetStatus('No project selected', true); return; }
  if(_txFrPolling) return;
  var scope = _txFrCurScope();
  var chunkSize = parseInt(($('tx-fr-chunk')||{value:10}).value, 10) || 10;
  _txFrSuggestions = [];
  _txFrRender();
  _txFrSetStatus('Starting full audit ('+scope+', chunk '+chunkSize+')…');
  fetch('/transcribe-full-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({scope: scope, chunk_size: chunkSize})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id'); }
      _txFrPoll(d.job_id);
    })
    .catch(function(e){ _txFrSetStatus('⚠ '+e, true); });
}

function _txFrApply(si, btn){
  var s = _txFrSuggestions[si]; if(!s || s.status !== 'pending') return;
  if(btn) btn.disabled = true;
  fetch('/transcribe-full-review-apply',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({idx: s.idx, new_ja: s.proposed_ja})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'apply failed'); }
      s.status = 'applied';
      // Optimistic local mirror
      if(entries[s.idx]){
        if(typeof entries[s.idx].text !== 'object')
          entries[s.idx].text = {ja:'',ro:'',en:''};
        // Mirror server-side _apply_ja_correction: wipe EN + literal +
        // translator_note, clear romaji (server regenerated it via cutlet
        // — frontend will show stale '' until next /data fetch, which
        // refresh-on-completion handles).
        entries[s.idx].text.ja  = s.proposed_ja;
        entries[s.idx].text.ro  = '';
        entries[s.idx].text.en  = '';
        entries[s.idx].text.lit = '';
        delete entries[s.idx].translator_note;
        entries[s.idx].new = true;
      }
      if(typeof buildDD === 'function') buildDD();
      if(typeof render === 'function') render();
      _txFrRender();
    })
    .catch(function(e){
      _txFrSetStatus('⚠ '+e, true);
      if(btn) btn.disabled = false;
    });
}

function _txFrSkip(si){
  var s = _txFrSuggestions[si]; if(!s || s.status !== 'pending') return;
  s.status = 'skipped';
  _txFrRender();
}

function _txFrApplyAll(){
  var pending = _txFrSuggestions.filter(function(s){return s.status==='pending';});
  if(!pending.length) return;
  if(!confirm('Apply all '+pending.length+' pending suggestion(s)?')) return;
  // Sequential — keep it simple, errors stop the cascade.
  var i = 0;
  function next(){
    if(i >= _txFrSuggestions.length){
      _txFrSetStatus('✓ Applied all pending');
      return;
    }
    var s = _txFrSuggestions[i++];
    if(s.status !== 'pending'){ next(); return; }
    fetch('/transcribe-full-review-apply',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({idx: s.idx, new_ja: s.proposed_ja})
    })
      .then(function(r){return r.json();})
      .then(function(d){
        if(!d.ok){ throw new Error(d.error || 'apply failed'); }
        s.status = 'applied';
        if(entries[s.idx]){
          if(typeof entries[s.idx].text !== 'object')
            entries[s.idx].text = {ja:'',ro:'',en:''};
          entries[s.idx].text.ja = s.proposed_ja;
          entries[s.idx].text.ro = '';
          entries[s.idx].new = true;
        }
        _txFrRender();
        next();
      })
      .catch(function(e){
        _txFrSetStatus('⚠ Stopped at #'+(s.idx+1)+': '+e, true);
      });
  }
  next();
}

// ── Public hooks ────────────────────────────────────────────────────────────
window._txFrOnShow = function(){
  _txFrCountScopes();
  _txFrRender();
};

(function _wireTxFr(){
  var run=$('tx-fr-run');           if(run) run.addEventListener('click', _txFrRun);
  var apply=$('tx-fr-apply-all');   if(apply) apply.addEventListener('click', _txFrApplyAll);
  document.querySelectorAll('input[name="tx-fr-scope"]').forEach(function(r){
    r.addEventListener('change', _txFrCountScopes);
  });
})();
