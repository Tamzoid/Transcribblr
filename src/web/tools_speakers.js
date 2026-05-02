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

// ── Inline audio playback ────────────────────────────────────────────────────
// One shared <audio> element across all suggestion cards so only one clip
// plays at a time. We seek to start, play, and pause at end via a
// timeupdate listener.
var _txSpAudio = null;
function _txSpAudioEl(){
  if(_txSpAudio) return _txSpAudio;
  _txSpAudio = document.createElement('audio');
  _txSpAudio.preload = 'metadata';
  return _txSpAudio;
}
function _txSpPlayRange(start, end, btn){
  if(!window._activeFile){ _txSpSetStatus('No audio loaded', true); return; }
  var src = (window._audioSrc || 'vocals');
  var url = '/audio?src='+src+'&file='+encodeURIComponent(window._activeFile);
  var a = _txSpAudioEl();
  // Reset prior stop-handler if a different card was playing
  if(a._stopHandler){
    a.removeEventListener('timeupdate', a._stopHandler);
    a._stopHandler = null;
  }
  if(a._activeBtn && a._activeBtn !== btn){
    a._activeBtn.textContent = '▶';
    a._activeBtn.classList.remove('on');
  }
  // Toggle pause if the same card is already playing
  if(a._activeBtn === btn && !a.paused){
    a.pause();
    btn.textContent = '▶';
    btn.classList.remove('on');
    a._activeBtn = null;
    return;
  }
  if(a._loadedSrc !== url){
    a.src = url; a._loadedSrc = url;
  }
  var stopAt = (end || start + 5) + 0.05;
  function onTime(){
    if(a.currentTime >= stopAt){
      a.pause();
      a.removeEventListener('timeupdate', onTime);
      a._stopHandler = null;
      if(btn){ btn.textContent = '▶'; btn.classList.remove('on'); }
      a._activeBtn = null;
    }
  }
  a._stopHandler = onTime;
  a._activeBtn = btn;
  a.addEventListener('timeupdate', onTime);
  // currentTime can only be set once metadata is loaded — handle both cases.
  function start_play(){
    try{ a.currentTime = start; }catch(e){}
    a.play().catch(function(err){ console.warn('audio play failed', err); });
    if(btn){ btn.textContent = '⏸'; btn.classList.add('on'); }
  }
  if(a.readyState >= 1){
    start_play();
  } else {
    a.addEventListener('loadedmetadata', start_play, {once: true});
  }
}

// ── Character roster (sourced from _ann.characters loaded by annotations.js) ─
function _txSpCharacters(){
  return (typeof _ann !== 'undefined' && _ann && Array.isArray(_ann.characters))
    ? _ann.characters : [];
}
function _txSpBuildCharSelect(currentEn, currentJa){
  // Build a <select> with one option per character. The option's value is
  // the character index in _ann.characters; data attrs carry en/ja for
  // easy retrieval at apply time. If the AI's name doesn't match anything
  // in the roster, prepend an extra "(AI: <name>)" option that's selected.
  var sel = document.createElement('select');
  sel.style.cssText = 'font-size:11px;padding:2px 6px;background:#111;color:#cdd;'+
    'border:1px solid #2a2a2a;border-radius:4px;font-family:inherit;max-width:220px';
  var chars = _txSpCharacters();
  var matched = false;
  chars.forEach(function(c, i){
    var name = c && c.name;
    var en = (name && typeof name === 'object') ? (name.en || '') : (name || '');
    var ja = (name && typeof name === 'object') ? (name.ja || '') : '';
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.setAttribute('data-en', en);
    opt.setAttribute('data-ja', ja);
    opt.textContent = en + (ja && ja !== en ? ' (' + ja + ')' : '');
    if(!matched && currentEn && en && en.toLowerCase() === currentEn.toLowerCase()){
      opt.selected = true; matched = true;
    } else if(!matched && currentJa && ja && ja === currentJa){
      opt.selected = true; matched = true;
    }
    sel.appendChild(opt);
  });
  if(!matched && (currentEn || currentJa)){
    // The AI's guess wasn't in the roster — keep it visible as a synthetic
    // first option so the user knows what it suggested.
    var ghost = document.createElement('option');
    ghost.value = '__ai__';
    ghost.setAttribute('data-en', currentEn || '');
    ghost.setAttribute('data-ja', currentJa || '');
    ghost.textContent = '(AI: ' + (currentEn || currentJa) + ')';
    ghost.selected = true;
    sel.insertBefore(ghost, sel.firstChild);
  }
  return sel;
}
function _txSpReadSelect(sel){
  var opt = sel.options[sel.selectedIndex];
  if(!opt) return null;
  return {en: opt.getAttribute('data-en') || '', ja: opt.getAttribute('data-ja') || ''};
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
    var color, border;
    if(s.status === 'applied')        { color='#0a1f12'; border='#1a3a28'; }
    else if(s.status === 'dismissed') { color='#1a1a1a'; border='#2a2a2a'; }
    else                              { color='#0d1822'; border='#1a2f3d'; }
    card.style.cssText = 'background:'+color+';border-left:3px solid '+border+
      ';border-radius:4px;padding:8px;margin-bottom:8px';

    var e = entries[idx] || {start:0, end:0};
    var time = (typeof toSRT === 'function') ? toSRT(e.start || 0).split(',')[0] : '';
    var lane = (e.text && typeof e.text === 'object') ? e.text : {};
    var ja = (lane.ja || '').replace(/\n/g,' ');
    var en = (lane.en || '').replace(/\n/g,' ');

    // ── Header: idx/time + (when pending) play / dismiss controls ─────────
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;'+
      'margin-bottom:4px;font-size:11px;font-weight:700;color:#888;flex-wrap:wrap;gap:4px';
    var statusTag = '';
    if(s.status === 'applied')        statusTag = ' <span style="color:#00ff88">✓ accepted</span>';
    else if(s.status === 'dismissed') statusTag = ' <span style="color:#666">✗ dismissed</span>';
    var leftLabel = document.createElement('span');
    leftLabel.innerHTML = _txSpEsc('#'+(idx+1)+'  '+time)+statusTag;

    var leftWrap = document.createElement('span');
    leftWrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
    // Play button (always available — even on applied/dismissed cards so the
    // user can still review the audio after deciding).
    var btnPlay = document.createElement('button');
    btnPlay.className = 'btn';
    btnPlay.textContent = '▶';
    btnPlay.title = 'Play this record (' + (e.start||0).toFixed(1) + 's–' + (e.end||0).toFixed(1) + 's)';
    btnPlay.style.cssText = 'padding:2px 8px;font-size:11px;min-width:28px';
    btnPlay.addEventListener('click', function(){ _txSpPlayRange(e.start || 0, e.end || (e.start||0)+5, btnPlay); });
    leftWrap.appendChild(btnPlay);
    leftWrap.appendChild(leftLabel);
    header.appendChild(leftWrap);

    if(s.status === 'pending'){
      var actions = document.createElement('span');
      actions.style.cssText = 'display:flex;gap:4px';
      var btnDis = document.createElement('button');
      btnDis.className = 'btn'; btnDis.textContent = 'Dismiss';
      btnDis.style.cssText = 'padding:2px 10px;font-size:10px';
      btnDis.addEventListener('click', function(){ _txSpDismiss(idx); });
      actions.appendChild(btnDis);
      header.appendChild(actions);
    }
    card.appendChild(header);

    // ── Body: JA + EN ─────────────────────────────────────────────────────
    var body = document.createElement('div');
    body.style.cssText = 'font-size:11px;line-height:1.5;margin-bottom:6px';
    body.innerHTML =
      '<div style="color:#cdd;margin-bottom:2px">'+_txSpEsc(ja || '(empty)')+'</div>'+
      (en ? '<div style="color:#888;font-size:10px">'+_txSpEsc(en)+'</div>'
          : '<div style="color:#555;font-size:10px;font-style:italic">(no English translation yet)</div>');
    card.appendChild(body);

    // ── Speaker pick row: dropdown + Accept button ────────────────────────
    var pickRow = document.createElement('div');
    pickRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px';
    var arrow = document.createElement('span');
    arrow.style.cssText = 'color:#9c9;flex-shrink:0';
    arrow.textContent = '→';
    pickRow.appendChild(arrow);
    var sel = _txSpBuildCharSelect(s.name_en, s.name_ja);
    sel.disabled = (s.status !== 'pending');
    pickRow.appendChild(sel);
    if(s.confidence){
      var confTag = document.createElement('span');
      confTag.style.cssText = 'color:#666;font-size:10px';
      confTag.textContent = '(AI: ' + s.confidence + ')';
      pickRow.appendChild(confTag);
    }
    if(s.status === 'pending'){
      var btnAcc = document.createElement('button');
      btnAcc.className = 'btn'; btnAcc.textContent = 'Accept';
      btnAcc.style.cssText = 'padding:2px 10px;font-size:10px;background:#0a1f12;color:#00ff88;margin-left:auto';
      btnAcc.addEventListener('click', function(){
        var picked = _txSpReadSelect(sel);
        if(!picked || (!picked.en && !picked.ja)){ _txSpSetStatus('Pick a character first', true); return; }
        _txSpAccept(idx, btnAcc, picked);
      });
      pickRow.appendChild(btnAcc);
    }
    card.appendChild(pickRow);

    if(s.note){
      var noteEl = document.createElement('div');
      noteEl.style.cssText = 'color:#888;margin-top:6px;font-style:italic;font-size:11px';
      noteEl.textContent = '📝 ' + s.note;
      card.appendChild(noteEl);
    }
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

function _txSpAccept(idx, btn, override){
  var s = _txSpSuggestions[idx]; if(!s || s.status !== 'pending') return;
  if(btn) btn.disabled = true;
  // Use the override (from the dropdown) if provided, otherwise the AI's
  // stored guess. Defensive: fall back to suggestion fields when missing.
  var finalEn = (override && override.en) || s.name_en || '';
  var finalJa = (override && override.ja) || s.name_ja || '';
  var body = {idx: idx};
  if(override){ body.en = finalEn; body.ja = finalJa; }
  fetch('/apply-speaker-suggestion', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'apply failed'); }
      s.status = 'applied';
      // Reflect what was actually saved so the rendered card matches.
      s.name_en = finalEn; s.name_ja = finalJa;
      // Mirror onto the in-memory entry so other tabs update without /data.
      if(entries[idx]){
        if(finalEn || finalJa){
          entries[idx].speaker = {en: finalEn, ja: finalJa};
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
