// ── Tools → Speakers sub-tab — auto-guess unassigned speakers ───────────────
// Runs the speaker-guesser backend over every record that has a transcription
// but no speaker assignment. Each guess lands as a card with Accept / Dismiss
// controls. Accepting copies the suggestion into entries[i].speaker; the
// Records → Speakers sub-tab also surfaces the same suggestions inline.

var _txSpPolling = false;
// Suggestion cache keyed by record idx (the canonical store is the project
// JSON; this is a UI-side mirror so we can rebuild the list cheaply).
var _txSpSuggestions = {};   // {idx: {name_en, name_ja, confidence, note, status}}

function _txSpEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _txSpSetStatus(msg, warn){
  var el=$('tx-sp-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _txSpLog(line){
  var el=$('tx-sp-log'); if(!el)return;
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

// ── Suggestion list (built from entries[i].speaker_suggestion) ──────────────
function _txSpRebuildFromEntries(){
  _txSpSuggestions = {};
  (entries || []).forEach(function(e, i){
    if(e && e.speaker_suggestion){
      var s = e.speaker_suggestion;
      _txSpSuggestions[i] = {
        name_en: s.en || '', name_ja: s.ja || '',
        confidence: s.confidence || '', note: s.note || '',
        status: 'pending',
      };
    }
  });
}

function _txSpUpdateApplyAllBtn(){
  var btn=$('tx-sp-apply-all'); if(!btn) return;
  var pending = Object.keys(_txSpSuggestions).filter(function(k){
    var s = _txSpSuggestions[k];
    return s && s.status === 'pending' && (s.name_en || s.name_ja)
      && (s.confidence === 'high' || s.confidence === 'medium');
  });
  btn.disabled = pending.length === 0;
}

function _txSpRender(){
  var host=$('tx-sp-suggestions'); if(!host) return;
  var keys = Object.keys(_txSpSuggestions)
    .map(function(k){return parseInt(k,10);})
    .filter(function(n){return !isNaN(n);})
    .sort(function(a,b){return a-b;});
  if(!keys.length){
    host.innerHTML = '<div style="padding:6px;color:#666">No suggestions yet — click <em>Guess speakers</em>.</div>';
    _txSpUpdateApplyAllBtn();
    return;
  }
  // Filter: hide "no confident guess" suggestions from the list. They're
  // still recorded on entries so the model isn't asked about them again,
  // but they're not actionable so they only add noise here. We also count
  // how many got hidden so the user knows the audit was thorough.
  var visible = keys.filter(function(idx){
    var s = _txSpSuggestions[idx];
    return !!(s && (s.name_en || s.name_ja));
  });
  var hiddenCount = keys.length - visible.length;

  host.innerHTML = '';
  if(hiddenCount){
    var hint = document.createElement('div');
    hint.style.cssText = 'padding:4px 8px;color:#666;font-size:10px;font-style:italic;margin-bottom:4px';
    hint.textContent = '(' + hiddenCount + ' record' + (hiddenCount===1?'':'s') +
      ' had no confident guess — hidden from list)';
    host.appendChild(hint);
  }
  if(!visible.length){
    var none = document.createElement('div');
    none.style.cssText = 'padding:6px;color:#666';
    none.innerHTML = 'No actionable suggestions yet — click <em>Guess speakers</em>.';
    host.appendChild(none);
    _txSpUpdateApplyAllBtn();
    return;
  }

  visible.forEach(function(idx){
    var s = _txSpSuggestions[idx];
    var card = document.createElement('div');
    var hasName = !!(s.name_en || s.name_ja);  // always true here
    var color, border;
    if(s.status === 'applied')        { color='#0a1f12'; border='#1a3a28'; }
    else if(s.status === 'dismissed') { color='#1a1a1a'; border='#2a2a2a'; }
    else                              { color='#0d1822'; border='#1a2f3d'; }
    card.style.cssText = 'background:'+color+';border-left:3px solid '+border+
      ';border-radius:4px;padding:8px;margin-bottom:8px';

    var e = entries[idx] || {start:0};
    var time = (typeof toSRT === 'function') ? toSRT(e.start || 0).split(',')[0] : '';
    var lane = (e.text && typeof e.text === 'object') ? e.text : {};
    var ja = (lane.ja || '').replace(/\n/g,' ');
    var en = (lane.en || '').replace(/\n/g,' ');

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;'+
      'margin-bottom:4px;font-size:11px;font-weight:700;color:#888;flex-wrap:wrap;gap:4px';
    var label = '#'+(idx+1)+'  '+time;
    var statusTag = '';
    if(s.status === 'applied')        statusTag = ' <span style="color:#00ff88">✓ accepted</span>';
    else if(s.status === 'dismissed') statusTag = ' <span style="color:#666">✗ dismissed</span>';
    header.innerHTML = '<span>'+_txSpEsc(label)+statusTag+'</span>';

    if(s.status === 'pending'){
      var actions = document.createElement('span');
      var btnAcc = document.createElement('button');
      btnAcc.className = 'btn'; btnAcc.textContent = 'Accept';
      btnAcc.style.cssText = 'padding:2px 10px;font-size:10px;background:#0a1f12;color:#00ff88';
      btnAcc.addEventListener('click', function(){ _txSpAccept(idx, btnAcc); });
      var btnDis = document.createElement('button');
      btnDis.className = 'btn'; btnDis.textContent = 'Dismiss';
      btnDis.style.cssText = 'padding:2px 10px;font-size:10px;margin-left:4px';
      btnDis.addEventListener('click', function(){ _txSpDismiss(idx); });
      actions.appendChild(btnAcc); actions.appendChild(btnDis);
      header.appendChild(actions);
    }
    card.appendChild(header);

    var body = document.createElement('div');
    body.style.cssText = 'font-size:11px;line-height:1.5';
    var nameLine =
      '<span style="color:#9c9">→ '+_txSpEsc(s.name_en || s.name_ja)+'</span>'
      + (s.name_ja && s.name_en && s.name_en !== s.name_ja
         ? ' <span style="color:#666">('+_txSpEsc(s.name_ja)+')</span>' : '')
      + (s.confidence ? ' <span style="color:#666;font-size:10px">— '+_txSpEsc(s.confidence)+'</span>' : '');
    // Show JA primary + EN dimmed underneath so the user can review both
    // without bouncing back to the editor.
    body.innerHTML =
      '<div style="color:#cdd;margin-bottom:2px">'+_txSpEsc(ja || '(empty)')+'</div>'+
      (en ? '<div style="color:#888;font-size:10px;margin-bottom:4px">'+_txSpEsc(en)+'</div>'
          : '<div style="color:#555;font-size:10px;margin-bottom:4px;font-style:italic">(no English translation yet)</div>')+
      '<div>'+nameLine+'</div>';
    if(s.note){
      body.innerHTML += '<div style="color:#888;margin-top:4px;font-style:italic">📝 '+_txSpEsc(s.note)+'</div>';
    }
    card.appendChild(body);
    host.appendChild(card);
  });
  _txSpUpdateApplyAllBtn();
}

// ── Polling ──────────────────────────────────────────────────────────────────
function _txSpPoll(jobId){
  _txSpPolling = true;
  var runBtn=$('tx-sp-run'); if(runBtn) runBtn.disabled = true;
  var since = 0;
  var consecFail = 0, MAX_CONSEC = 8;
  function tick(){
    var poll = (typeof _safePollJson === 'function')
      ? _safePollJson('/process-status?job='+jobId+'&since='+since)
      : fetch('/process-status?job='+jobId+'&since='+since).then(function(r){return r.json();});
    poll.then(function(s){
      consecFail = 0;
      (s.events||[]).forEach(function(ev){
        if(ev.type === 'step') _txSpLog(ev.msg);
        else if(ev.type === 'progress' && ev.idx !== undefined){
          _txSpSuggestions[ev.idx] = {
            name_en: ev.name_en || '', name_ja: ev.name_ja || '',
            confidence: ev.confidence || '', note: ev.note || '',
            status: 'pending',
          };
          // Mirror onto entries so the Records → Speakers tab + dropdown
          // markers reflect the suggestion immediately.
          if(entries[ev.idx]){
            entries[ev.idx].speaker_suggestion = {
              en: ev.name_en || '', ja: ev.name_ja || '',
              confidence: ev.confidence || '', note: ev.note || '',
            };
          }
          _txSpRender();
        } else if(ev.type === 'result'){
          _txSpSetStatus('✓ Reviewed '+ev.reviewed+' record(s) — '
            +ev.suggested+' guesses, '+ev.skipped+' unsure');
        } else if(ev.type === 'error'){
          _txSpSetStatus('⚠ '+ev.error, true);
        }
      });
      since = s.next || since;
      if(s.done){
        _txSpPolling = false;
        if(runBtn) runBtn.disabled = false;
        // Refresh dropdown / preview so the speakers-tab badge updates
        if(typeof buildDD === 'function') buildDD();
        if(typeof render === 'function') render();
        if(typeof _recRender === 'function') _recRender();
      } else {
        setTimeout(tick, 1000);
      }
    }).catch(function(e){
      consecFail++;
      if(consecFail >= MAX_CONSEC){
        _txSpPolling = false;
        if(runBtn) runBtn.disabled = false;
        _txSpSetStatus('Poll failed (gave up): '+e, true);
      } else {
        _txSpSetStatus('⏱ Upstream blip ('+consecFail+'/'+MAX_CONSEC+'), retrying…');
        setTimeout(tick, 2000);
      }
    });
  }
  tick();
}

// ── Actions ──────────────────────────────────────────────────────────────────
function _txSpRun(){
  if(!window._activeFile){ _txSpSetStatus('No project selected', true); return; }
  if(_txSpPolling) return;
  var chunkSize = parseInt(($('tx-sp-chunk')||{value:15}).value, 10) || 15;
  var redo = !!($('tx-sp-redo') && $('tx-sp-redo').checked);
  // Reset pending suggestions if the user explicitly opts to redo
  if(redo){
    Object.keys(_txSpSuggestions).forEach(function(k){
      if(_txSpSuggestions[k].status === 'pending') delete _txSpSuggestions[k];
    });
  }
  _txSpRender();
  _txSpSetStatus('Starting speaker guess (chunk '+chunkSize+(redo?', redo':'')+')…');
  fetch('/guess-speakers', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chunk_size: chunkSize, redo: redo})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id'); }
      _txSpPoll(d.job_id);
    })
    .catch(function(e){ _txSpSetStatus('⚠ '+e, true); });
}

function _txSpAccept(idx, btn){
  var s = _txSpSuggestions[idx]; if(!s || s.status !== 'pending') return;
  if(btn) btn.disabled = true;
  fetch('/apply-speaker-suggestion', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({idx: idx})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'apply failed'); }
      s.status = 'applied';
      // Mirror onto the in-memory entry so other tabs update without a /data refetch.
      if(entries[idx]){
        if(s.name_en || s.name_ja){
          entries[idx].speaker = {en: s.name_en || '', ja: s.name_ja || ''};
        }
        delete entries[idx].speaker_suggestion;
      }
      if(typeof buildDD === 'function') buildDD();
      if(typeof render === 'function') render();
      if(typeof _recRender === 'function') _recRender();
      _txSpRender();
    })
    .catch(function(e){
      _txSpSetStatus('⚠ '+e, true);
      if(btn) btn.disabled = false;
    });
}

function _txSpDismiss(idx){
  var s = _txSpSuggestions[idx]; if(!s || s.status !== 'pending') return;
  fetch('/dismiss-speaker-suggestion', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({idx: idx})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'dismiss failed'); }
      s.status = 'dismissed';
      if(entries[idx]) delete entries[idx].speaker_suggestion;
      if(typeof buildDD === 'function') buildDD();
      if(typeof render === 'function') render();
      if(typeof _recRender === 'function') _recRender();
      _txSpRender();
    })
    .catch(function(e){ _txSpSetStatus('⚠ '+e, true); });
}

function _txSpApplyAllConfident(){
  var indices = Object.keys(_txSpSuggestions)
    .map(function(k){return parseInt(k,10);})
    .filter(function(idx){
      var s = _txSpSuggestions[idx];
      return s && s.status === 'pending' && (s.name_en || s.name_ja)
        && (s.confidence === 'high' || s.confidence === 'medium');
    });
  if(!indices.length){ _txSpSetStatus('No high/medium confidence suggestions to accept', true); return; }
  if(!confirm('Accept '+indices.length+' suggestion(s) (high or medium confidence)?')) return;
  // Sequential — keeps the UX simple, errors stop the cascade.
  var i = 0;
  function next(){
    if(i >= indices.length){
      _txSpSetStatus('✓ Accepted '+indices.length+' suggestion(s)');
      return;
    }
    _txSpAccept(indices[i++]);
    setTimeout(next, 30);
  }
  next();
}

function _txSpClearAll(){
  if(!confirm('Clear ALL pending speaker suggestions in this project?')) return;
  fetch('/dismiss-speaker-suggestion', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({all: true})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'clear failed'); }
      _txSpSetStatus('✓ Cleared '+d.cleared+' suggestion(s)');
      // Drop them locally too
      _txSpSuggestions = {};
      (entries || []).forEach(function(e){ if(e) delete e.speaker_suggestion; });
      if(typeof buildDD === 'function') buildDD();
      if(typeof render === 'function') render();
      if(typeof _recRender === 'function') _recRender();
      _txSpRender();
    })
    .catch(function(e){ _txSpSetStatus('⚠ '+e, true); });
}

// ── Public hooks ────────────────────────────────────────────────────────────
window._txSpOnShow = function(){
  _txSpRebuildFromEntries();
  _txSpRender();
};

(function _wireTxSp(){
  var run=$('tx-sp-run');             if(run) run.addEventListener('click', _txSpRun);
  var apply=$('tx-sp-apply-all');     if(apply) apply.addEventListener('click', _txSpApplyAllConfident);
  var clear=$('tx-sp-clear-all');     if(clear) clear.addEventListener('click', _txSpClearAll);
})();
