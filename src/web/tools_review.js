// ── Tools → Review sub-tab — conversational TRANSCRIPTION review ────────────
// Mirrors translate_review.js shape but operates on text.ja, applies via
// /transcribe-review-apply, and uses the transcription system prompt
// (server-side default in transcribe_review.REVIEW_SYSTEM_PROMPT).

var _txRevSelected = {};
var _txRevMessages = [];
var _txRevPolling = false;
var _txRevPendingUserIdx = -1;
var _txRevSessionProject = '';

function _txRevEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _txRevSetStatus(msg, warn){
  var el=$('tx-rev-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _txRevLog(line){
  var el=$('tx-rev-log'); if(!el)return;
  var cur = el.textContent;
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

// ── Picker — selectable = transcribed (any text.ja that isn't ????) ─────────
function _txRevSelectableState(i){
  var e = entries[i]; if(!e) return 'locked';
  var ja = (e.text && typeof e.text === 'object') ? (e.text.ja || '') : '';
  if(!ja.trim() || ja.indexOf('????') !== -1) return 'locked';
  return 'selectable';
}

function _txRevBuildPickList(){
  var host=$('tx-rev-pick-list'); if(!host)return;
  host.innerHTML = '';
  if(!entries || !entries.length){
    host.innerHTML = '<div style="padding:10px;color:#666;font-size:11px">(no records loaded)</div>';
    _txRevUpdateSummary();
    return;
  }
  var frag = document.createDocumentFragment();
  entries.forEach(function(e, i){
    var state = _txRevSelectableState(i);
    var inSel = !!_txRevSelected[i];
    var classes = ['tr-adv-row'];
    var stat = '';
    var lane = (e && e.text && typeof e.text === 'object') ? e.text : {};
    var ja = (lane.ja || '').replace(/\n/g,' ');
    var en = (lane.en || '').replace(/\n/g,' ');
    if(state === 'locked'){
      classes.push('tr-adv-row--locked');
      stat = !ja.trim() ? '·' : '?';
    } else if(inSel){
      classes.push('tr-adv-row--selected');
      stat = '◆';
    } else {
      classes.push('tr-adv-row--selectable');
      stat = '+';
    }
    var time = (typeof toSRT === 'function') ? toSRT(e.start || 0).split(',')[0] : '';
    var row = document.createElement('div');
    row.className = classes.join(' ');
    // JA primary (this is what we're auditing); EN underneath if present.
    row.innerHTML =
      '<span class="num">'+(i+1)+'</span>'+
      '<span class="time">'+_txRevEsc(time)+'</span>'+
      '<span class="tr-rev-text">'+
        '<span class="tr-rev-en">'+_txRevEsc(ja || '(empty)')+'</span>'+
        (en ? '<span class="tr-rev-ja">'+_txRevEsc(en)+'</span>' : '')+
      '</span>'+
      '<span class="stat">'+stat+'</span>';
    if(state !== 'locked'){
      row.addEventListener('click', function(){ _txRevToggle(i); });
    }
    frag.appendChild(row);
  });
  host.appendChild(frag);
  _txRevUpdateSummary();
}

function _txRevToggle(i){
  if(_txRevSelected[i]) delete _txRevSelected[i];
  else _txRevSelected[i] = true;
  _txRevBuildPickList();
  _txRevUpdateButtons();
}

function _txRevClearSelection(){
  _txRevSelected = {};
  _txRevBuildPickList();
  _txRevUpdateButtons();
}

function _txRevSelectedIndices(){
  return Object.keys(_txRevSelected)
    .map(function(k){return parseInt(k, 10);})
    .filter(function(n){return !isNaN(n);})
    .sort(function(a,b){return a-b;});
}

function _txRevUpdateSummary(){
  var el=$('tx-rev-pick-summary'); if(!el)return;
  var indices = _txRevSelectedIndices();
  el.textContent = indices.length ? indices.length + ' selected' : 'No records selected.';
}

function _txRevCurMode(){
  var sel=document.querySelector('input[name="tx-rev-mode"]:checked');
  return sel ? sel.value : 'tldr';
}

function _txRevUpdateButtons(){
  var indices = _txRevSelectedIndices();
  var send=$('tx-rev-send'), input=$('tx-rev-input'), hint=$('tx-rev-attach-hint');
  var hasText = !!(input && input.value.trim());
  if(send) send.disabled = _txRevPolling || (!hasText && indices.length === 0);
  if(hint){
    hint.textContent = indices.length
      ? 'will attach ' + indices.length + ' record' + (indices.length===1?'':'s') + ' to next send'
      : '';
  }
}

// ── Chat history rendering ───────────────────────────────────────────────────
function _txRevHasRecordBlocks(text){
  return /^\s*\d+\s*$\n.*\n\s*\[.+\]/m.test(text || '');
}

function _txRevRenderChat(){
  var el=$('tx-rev-chat'); if(!el)return;
  el.innerHTML = '';
  if(!_txRevMessages.length){
    el.innerHTML = '<div style="color:#666;padding:6px">Pick records, type a message, and click <em>Send</em>.</div>';
    return;
  }
  _txRevMessages.forEach(function(m){
    if(m.role === 'system') return;
    var row = document.createElement('div');
    row.style.cssText = 'margin-bottom:8px;padding:6px 8px;border-radius:4px';
    var who = m.role === 'user' ? '🙋 You' : '🤖 AI';
    var color = m.role === 'user' ? '#0d1822' : '#0a1f12';
    var border = m.role === 'user' ? '#1a2f3d' : '#1a3a28';
    row.style.background = color;
    row.style.borderLeft = '3px solid ' + border;
    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:10px;color:#888;font-weight:700;margin-bottom:3px;display:flex;justify-content:space-between;align-items:center';
    hdr.innerHTML = '<span>'+who+'</span>';
    if(m.role === 'assistant' && _txRevHasRecordBlocks(m.content)){
      var apply = document.createElement('button');
      apply.className = 'btn'; apply.textContent = 'Apply changes';
      apply.style.cssText = 'padding:2px 8px;font-size:10px';
      apply.addEventListener('click', function(){ _txRevApply(m.content, apply); });
      hdr.appendChild(apply);
    }
    row.appendChild(hdr);
    var body = document.createElement('div');
    body.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-family:inherit;color:#cdd';
    body.textContent = m.content;
    row.appendChild(body);
    el.appendChild(row);
  });
  el.scrollTop = el.scrollHeight;
}

// ── Persistence ─────────────────────────────────────────────────────────────
var _txRevSavePending = null;

function _txRevPersistSave(){
  if(!window._activeFile) return Promise.resolve();
  if(_txRevSavePending){
    _txRevSavePending = _txRevSavePending.then(_txRevPersistSaveImpl, _txRevPersistSaveImpl);
    return _txRevSavePending;
  }
  _txRevSavePending = _txRevPersistSaveImpl().finally(function(){ _txRevSavePending = null; });
  return _txRevSavePending;
}

function _txRevPersistSaveImpl(){
  // Reuses /review-session schema but stores to a different field via the
  // session_kind discriminator.
  return fetch('/review-session', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      action: 'save',
      kind: 'transcribe',
      messages: _txRevMessages,
      selected_indices: _txRevSelectedIndices(),
      context_mode: _txRevCurMode(),
    })
  }).catch(function(){});
}

function _txRevPersistLoad(){
  if(!window._activeFile) return Promise.resolve(null);
  return fetch('/review-session', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({action:'load', kind:'transcribe'})
  }).then(function(r){return r.json();}).then(function(d){
    return (d && d.ok) ? (d.session || null) : null;
  }).catch(function(){ return null; });
}

function _txRevPersistClear(){
  if(!window._activeFile) return Promise.resolve();
  return fetch('/review-session', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({action:'clear', kind:'transcribe'})
  }).catch(function(){});
}

// ── Polling ──────────────────────────────────────────────────────────────────
function _txRevPoll(jobId){
  _txRevPolling = true;
  _txRevUpdateButtons();
  var since = 0;
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type === 'step') _txRevLog(ev.msg);
          else if(ev.type === 'augmented'){
            var i = (typeof ev.index === 'number') ? ev.index : _txRevPendingUserIdx;
            if(i >= 0 && i < _txRevMessages.length && _txRevMessages[i]){
              _txRevMessages[i].content = ev.content || '';
              _txRevRenderChat();
            }
          } else if(ev.type === 'result'){
            if(typeof ev.reply === 'string'){
              _txRevMessages.push({role:'assistant', content: ev.reply || ''});
              _txRevRenderChat();
              _txRevSetStatus('✓ Reply received');
              _txRevPersistSave();
            }
          } else if(ev.type === 'error'){
            _txRevSetStatus('⚠ '+ev.error, true);
          }
        });
        since = s.next || since;
        if(s.done){
          _txRevPolling = false;
          _txRevPendingUserIdx = -1;
          _txRevUpdateButtons();
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        _txRevPolling = false;
        _txRevPendingUserIdx = -1;
        _txRevSetStatus('Poll failed: '+e, true);
        _txRevUpdateButtons();
      });
  }
  tick();
}

// ── Send / Apply / Reset ─────────────────────────────────────────────────────
function _txRevSend(){
  if(!window._activeFile){ _txRevSetStatus('No project selected', true); return; }
  if(_txRevPolling) return;
  var input=$('tx-rev-input'); if(!input)return;
  var typed = input.value.trim();
  var attach = _txRevSelectedIndices();
  if(!typed && !attach.length){ _txRevSetStatus('Type a message or select records', true); return; }

  _txRevMessages.push({role:'user', content: typed});
  _txRevPendingUserIdx = _txRevMessages.length - 1;
  input.value = '';
  _txRevRenderChat();

  var isFirst = !_txRevMessages.some(function(m){return m.role === 'assistant';});
  _txRevSetStatus(isFirst ? 'Building baseline…' : 'Sending…');

  fetch('/transcribe-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      messages: _txRevMessages,
      attach_records: attach.length ? attach : undefined,
      context_mode: _txRevCurMode(),
    })
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id'); }
      _txRevPoll(d.job_id);
    })
    .catch(function(e){
      _txRevSetStatus('⚠ '+e, true);
      _txRevPolling = false;
      _txRevPendingUserIdx = -1;
      _txRevUpdateButtons();
    });

  _txRevSelected = {};
  _txRevBuildPickList();
  _txRevUpdateButtons();
}

function _txRevApply(responseText, btn){
  // Apply considers EVERY index ever selected in this session — we look at
  // the messages history for record indices that appeared in user blocks.
  // But since the picker clears after each send, we need to reconstruct.
  // Simpler: parse the response for record blocks ourselves — every <idx>
  // mentioned IS a candidate. Then send all those indices.
  var indices = _txRevExtractRespondedIndices(responseText);
  if(!indices.length){ _txRevSetStatus('No record blocks found in this reply', true); return; }
  if(btn) btn.disabled = true;
  _txRevSetStatus('Applying…');
  fetch('/transcribe-review-apply',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({response_text: responseText, indices: indices})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'apply failed'); }
      _txRevSetStatus('✓ Applied to '+d.updated+' record(s)');
      if(typeof apiFetchData === 'function'){
        apiFetchData().then(function(fresh){
          if(Array.isArray(fresh)) entries = fresh;
          if(typeof buildDD==='function')buildDD();
          if(typeof render==='function')render();
          _txRevBuildPickList();
        });
      }
      if(btn){ btn.textContent = '✓ Applied'; }
      _txRevPersistSave();
    })
    .catch(function(e){
      _txRevSetStatus('⚠ '+e, true);
      if(btn) btn.disabled = false;
    });
}

function _txRevExtractRespondedIndices(text){
  // Very loose — match lines that are just an integer at the start of a block.
  var out = [];
  var blocks = (text || '').split(/\n\s*\n/);
  blocks.forEach(function(b){
    var m = b.match(/^\s*(\d+)\s*$/m);
    if(m){
      var n = parseInt(m[1], 10);
      if(!isNaN(n) && n > 0) out.push(n - 1);
    }
  });
  return out;
}

function _txRevReset(){
  if(_txRevMessages.length && !confirm('Discard the current transcription review session?')) return;
  _txRevMessages = [];
  _txRevPendingUserIdx = -1;
  _txRevSelected = {};
  _txRevBuildPickList();
  _txRevRenderChat();
  _txRevSetStatus('');
  _txRevUpdateButtons();
  _txRevPersistClear();
}

function _txRevApplyLoadedSession(s){
  if(!s){ _txRevMessages = []; _txRevSelected = {}; return; }
  _txRevMessages = Array.isArray(s.messages) ? s.messages.slice() : [];
  var sel = {};
  (s.selected_indices || []).forEach(function(i){ sel[i] = true; });
  _txRevSelected = sel;
  if(s.context_mode){
    var radio = document.querySelector('input[name="tx-rev-mode"][value="'+s.context_mode+'"]');
    if(radio) radio.checked = true;
  }
}

// ── Public hooks ────────────────────────────────────────────────────────────
window._txRevOnShow = function(){
  var needLoad = _txRevSessionProject !== (window._activeFile || '');
  _txRevSessionProject = window._activeFile || '';
  var paint = function(){
    _txRevBuildPickList();
    _txRevRenderChat();
    _txRevUpdateButtons();
  };
  if(needLoad){
    _txRevPersistLoad().then(function(s){
      _txRevApplyLoadedSession(s);
      if(s && (s.messages || []).length){
        _txRevSetStatus('Restored saved session ('
          + (s.messages || []).filter(function(m){return m.role==='user';}).length
          + ' user turns, last updated ' + (s.updated || '?') + ')');
      }
      paint();
    });
  } else {
    paint();
  }
};

window._txRevOnProjectSwitch = function(){
  _txRevSessionProject = '';
  _txRevMessages = [];
  _txRevSelected = {};
  _txRevPendingUserIdx = -1;
  _txRevSetStatus('');
  var activeBtn = document.querySelector('.tool-tbtn.on');
  if(activeBtn && activeBtn.getAttribute('data-tooltab') === 'review'){
    if(typeof window._txRevOnShow === 'function') window._txRevOnShow();
  }
};

// ── Wiring ──────────────────────────────────────────────────────────────────
(function _wireTxRev(){
  var clear=$('tx-rev-clear-sel'); if(clear) clear.addEventListener('click', _txRevClearSelection);
  var send =$('tx-rev-send');      if(send)  send.addEventListener('click', _txRevSend);
  var reset=$('tx-rev-reset');     if(reset) reset.addEventListener('click', _txRevReset);
  var inp  =$('tx-rev-input');     if(inp){
    inp.addEventListener('input', _txRevUpdateButtons);
    inp.addEventListener('keydown', function(ev){
      if((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter'){
        ev.preventDefault();
        _txRevSend();
      }
    });
  }
})();
