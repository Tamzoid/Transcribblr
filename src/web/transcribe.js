// ── Transcribe sub-tab — WhisperX driver + status table ──────────────────────
// Uses the same /process-status polling pattern as context generation.

var _txPolling = false;
var _txReady   = false;  // true once /prep-prompts has succeeded for this project

function _txEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _txSetStatus(msg, warn){
  var el=$('tx-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _txLog(line){
  var el=$('tx-log'); if(!el)return;
  var cur = el.textContent;
  // Collapse consecutive heartbeat ticks ("  ⏳ <label> — still working (Ns)")
  // so the tick count visually updates in place rather than piling up.
  var hb = line.match(/⏳\s+(.+?)\s+— still working/);
  if(hb){
    var lastNl = cur.lastIndexOf('\n');
    var lastLine = (lastNl >= 0) ? cur.substring(lastNl + 1) : cur;
    var prevHb = lastLine.match(/⏳\s+(.+?)\s+— still working/);
    if(prevHb && prevHb[1] === hb[1]){
      el.textContent = (lastNl >= 0 ? cur.substring(0, lastNl + 1) : '') + line;
      el.scrollTop = el.scrollHeight;
      return;
    }
  }
  el.textContent += (cur ? '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function _txClearLog(){
  var el=$('tx-log'); if(el) el.textContent='';
}

function _txStatusFor(e){
  var t = e && e.text;
  var ja = (t && typeof t === 'object') ? (t.ja || '') : (typeof t==='string' ? t : '');
  if(ja.indexOf('????') !== -1) return 'pending';
  if(e && e.new) return 'new';
  return 'done';
}

function _txRenderTable(){
  var tb=$('tx-tbody'); if(!tb)return;
  tb.innerHTML='';
  if(!entries || !entries.length){
    tb.innerHTML='<tr><td colspan="4" style="padding:8px;color:#666">(no records loaded)</td></tr>';
    return;
  }
  entries.forEach(function(e,i){
    var l = (typeof _laneObj === 'function') ? _laneObj(e.text) : (e.text||{});
    var ja = l.ja || '';
    var stat = _txStatusFor(e);
    var col  = stat==='pending' ? '#ffaa55' : (stat==='new' ? '#00d9ff' : '#666');
    var icon = stat==='pending' ? '?' : (stat==='new' ? '🆕' : '✓');
    var tr=document.createElement('tr');
    tr.style.borderBottom='1px solid #1a1a1a';
    tr.innerHTML =
      '<td style="padding:3px 6px;color:#666">'+(i+1)+'</td>'+
      '<td style="padding:3px 6px;color:#666;font-family:monospace">'+toSRT(e.start||0).split(',')[0]+'</td>'+
      '<td style="padding:3px 6px;color:'+col+'">'+icon+' '+stat+'</td>'+
      '<td style="padding:3px 6px;color:#aaa">'+_txEsc(ja.substring(0,80))+(ja.length>80?'…':'')+'</td>';
    tr.style.cursor='pointer';
    tr.addEventListener('click', function(){
      if(typeof go==='function') go(i);
    });
    tb.appendChild(tr);
  });
}

function _txRenderSummary(){
  var el=$('tx-summary'); if(!el)return;
  if(!entries || !entries.length){ el.textContent=''; return; }
  var pending=0, neu=0, done=0;
  entries.forEach(function(e){
    var s=_txStatusFor(e);
    if(s==='pending')pending++; else if(s==='new')neu++; else done++;
  });
  el.textContent = entries.length+' records — '+pending+' pending, '+neu+' new (unreviewed), '+done+' reviewed';
  var run=$('tx-run'); var here=$('tx-run-here');
  var lock = !_txReady || pending===0 || _txPolling;
  if(run)  run.disabled  = lock;
  if(here) here.disabled = lock;
}

// ── Polling ──────────────────────────────────────────────────────────────────

function _txPoll(jobId, label, onComplete){
  _txPolling = true;
  var since = 0;
  var prepBtn=$('tx-prep'), runBtn=$('tx-run'), hereBtn=$('tx-run-here');
  if(prepBtn) prepBtn.disabled = true;
  if(runBtn)  runBtn.disabled  = true;
  if(hereBtn) hereBtn.disabled = true;
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type==='step'){
            _txLog(ev.msg);
          } else if(ev.type==='progress' && ev.idx !== undefined){
            // optimistic update — refresh single row
            if(entries[ev.idx]){
              if(typeof entries[ev.idx].text !== 'object')
                entries[ev.idx].text = {ja:'',ro:'',en:''};
              entries[ev.idx].text.ja = ev.text || '';
              entries[ev.idx].text.ro = ev.romaji || '';
              entries[ev.idx].new = true;
            }
            _txRenderTable();
            _txRenderSummary();
          } else if(ev.type==='result'){
            if(label==='prep'){
              _txReady = true;
              _txSetStatus('✓ Prompts ready — '+(ev.pending_count||0)+' record(s) need transcribing');
              (ev.warnings||[]).forEach(function(w){
                _txLog('⚠ '+w.level+': '+w.key+' — '+w.char_count+' chars (limit '+w.error_limit+')');
              });
            } else if(label==='run'){
              _txSetStatus('✓ Transcribed '+ev.transcribed+'/'+ev.total+' records'
                          +(ev.failed?' ('+ev.failed+' failed)':''));
            }
          } else if(ev.type==='error'){
            _txSetStatus('⚠ '+ev.error, true);
          }
        });
        since = s.next || since;
        if(s.done){
          _txPolling = false;
          if(prepBtn) prepBtn.disabled = false;
          // Refresh records from server so the table reflects the latest saved state
          if(typeof apiFetchData === 'function'){
            apiFetchData().then(function(fresh){
              if(Array.isArray(fresh)){ entries = fresh; }
              if(typeof buildDD==='function')buildDD();
              if(typeof render==='function')render();
              _txRenderTable();
              _txRenderSummary();
              if(typeof onComplete==='function')onComplete();
            }).catch(function(){
              _txRenderSummary();
              if(typeof onComplete==='function')onComplete();
            });
          } else {
            _txRenderSummary();
            if(typeof onComplete==='function')onComplete();
          }
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        _txPolling = false;
        _txSetStatus('Poll failed: '+e, true);
        if(prepBtn) prepBtn.disabled = false;
        _txRenderSummary();
      });
  }
  tick();
}

// ── Actions ──────────────────────────────────────────────────────────────────

function _txStartPrep(){
  if(!window._activeFile){ _txSetStatus('No project selected', true); return; }
  _txClearLog();
  _txSetStatus('Building prompts…');
  fetch('/prep-prompts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error||'no job_id returned'); }
      _txPoll(d.job_id, 'prep');
    })
    .catch(function(e){ _txSetStatus('⚠ '+e, true); });
}

function _txStartRun(indices){
  if(!window._activeFile){ _txSetStatus('No project selected', true); return; }
  if(!_txReady){ _txSetStatus('Prepare prompts first', true); return; }
  _txClearLog();
  var subsetMsg = (indices && indices.length) ? indices.length+' record(s) up to ▶' : 'all pending';
  _txSetStatus('Transcribing '+subsetMsg+' — this may take several minutes…');
  var src=($('tx-src')||{value:'vocals'}).value;
  var sens=($('tx-sens')||{value:'High'}).value;
  var body={src:src, sensitivity:sens};
  if(indices && indices.length) body.indices = indices;
  fetch('/transcribe',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body)
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error||'no job_id returned'); }
      _txPoll(d.job_id, 'run');
    })
    .catch(function(e){ _txSetStatus('⚠ '+e, true); });
}

function _txStartRunUpToHere(){
  // Pending records whose start time is at or before the current playback
  // cursor. Lets the user transcribe the section they've just scoped out
  // without committing to the whole project.
  var t = (typeof ws !== 'undefined' && ws) ? ws.getCurrentTime() : 0;
  var indices = [];
  entries.forEach(function(e, i){
    if(_txStatusFor(e) !== 'pending') return;
    if((e.start || 0) <= t) indices.push(i);
  });
  if(!indices.length){
    _txSetStatus('No pending records at or before '+toSRT(t).split(',')[0], true);
    return;
  }
  _txStartRun(indices);
}

function _txMarkOneReviewed(idx){
  if(!window._activeFile || !entries[idx])return;
  fetch('/mark-reviewed',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({indices:[idx]})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.ok){
        if(entries[idx]) delete entries[idx].new;
        if(typeof buildDD==='function')buildDD();
        if(typeof render==='function')render();
        _txRenderTable();
        _txRenderSummary();
      }
    });
}

// Public hook called from editor.js when the Transcribe sub-tab is shown.
window._txOnShow = function(){
  _txRenderTable();
  _txRenderSummary();
};

// ── Wiring ───────────────────────────────────────────────────────────────────
(function _wireTranscribe(){
  var p=$('tx-prep');       if(p) p.addEventListener('click', _txStartPrep);
  var r=$('tx-run');        if(r) r.addEventListener('click', function(){_txStartRun();});
  var h=$('tx-run-here');   if(h) h.addEventListener('click', _txStartRunUpToHere);
})();
