// ── Translations → Review sub-tab ────────────────────────────────────────────
// Multi-select picker (translated records only) + chat with Qwen.
// Conversation history is kept here client-side and sent in full with every
// turn — the server is stateless. AI replies that contain record blocks can
// be applied with a per-message Apply button.

var _trRevSelected = {};   // {idx: true} — records queued for the NEXT send
var _trRevMessages = [];   // [{role:'system'|'user'|'assistant', content:'...'}]
var _trRevPolling = false;
// _trRevPendingUserIdx: index into _trRevMessages of the user message that
// the in-flight server call is augmenting. Cleared on response.
var _trRevPendingUserIdx = -1;

function _trRevEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _trRevSetStatus(msg, warn){
  var el=$('tr-rev-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _trRevLog(line){
  var el=$('tr-rev-log'); if(!el)return;
  var cur = el.textContent;
  // Same heartbeat-collapse as the other panels
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

// ── Picker ───────────────────────────────────────────────────────────────────
function _trRevSelectableState(i){
  var e = entries[i]; if(!e) return 'locked';
  var ja = (e.text && typeof e.text === 'object') ? (e.text.ja || '') : '';
  if(!ja.trim() || ja.indexOf('????') !== -1) return 'locked';
  var en = (e.text && typeof e.text === 'object') ? (e.text.en || '') : '';
  if(!en.trim()) return 'locked';   // not translated yet → can't review
  return 'selectable';
}

function _trRevBuildPickList(){
  var host=$('tr-rev-pick-list'); if(!host)return;
  host.innerHTML = '';
  if(!entries || !entries.length){
    host.innerHTML = '<div style="padding:10px;color:#666;font-size:11px">(no records loaded)</div>';
    _trRevUpdateSummary();
    return;
  }
  var frag = document.createDocumentFragment();
  entries.forEach(function(e, i){
    var state = _trRevSelectableState(i);
    var inSel = !!_trRevSelected[i];
    var classes = ['tr-adv-row', 'tr-rev-row'];
    var stat = '';
    var lane = (e && e.text && typeof e.text === 'object') ? e.text : {};
    var ja = (lane.ja || '').replace(/\n/g,' ');
    var en = (lane.en || '').replace(/\n/g,' ');
    if(state === 'locked'){
      classes.push('tr-adv-row--locked');
      stat = (!ja.trim() || ja.indexOf('????') !== -1) ? '?' : '·';
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
    // Two-line cell: EN on top (primary, what you're reviewing), JA below.
    // Locked rows that have no EN fall back to showing JA on the top line.
    var primary   = en || ja || '(empty)';
    var secondary = en ? ja : '';
    row.innerHTML =
      '<span class="num">'+(i+1)+'</span>'+
      '<span class="time">'+_trRevEsc(time)+'</span>'+
      '<span class="tr-rev-text">'+
        '<span class="tr-rev-en">'+_trRevEsc(primary)+'</span>'+
        (secondary ? '<span class="tr-rev-ja">'+_trRevEsc(secondary)+'</span>' : '')+
      '</span>'+
      '<span class="stat">'+stat+'</span>';
    if(state !== 'locked'){
      row.addEventListener('click', function(){ _trRevToggle(i); });
    }
    frag.appendChild(row);
  });
  host.appendChild(frag);
  _trRevUpdateSummary();
}

function _trRevToggle(i){
  if(_trRevSelected[i]) delete _trRevSelected[i];
  else _trRevSelected[i] = true;
  _trRevBuildPickList();
  _trRevUpdateButtons();
}

function _trRevClearSelection(){
  _trRevSelected = {};
  _trRevBuildPickList();
  _trRevUpdateButtons();
}

function _trRevSelectedIndices(){
  return Object.keys(_trRevSelected)
    .map(function(k){return parseInt(k, 10);})
    .filter(function(n){return !isNaN(n);})
    .sort(function(a,b){return a-b;});
}

function _trRevUpdateSummary(){
  var el=$('tr-rev-pick-summary'); if(!el)return;
  var indices = _trRevSelectedIndices();
  el.textContent = indices.length
    ? indices.length + ' selected'
    : 'No records selected.';
}

function _trRevUpdateButtons(){
  var indices = _trRevSelectedIndices();
  var send=$('tr-rev-send'), input=$('tr-rev-input'), hint=$('tr-rev-attach-hint');
  var hasText = !!(input && input.value.trim());
  // Send is enabled when there's typed text OR queued records (or both),
  // and we're not mid-flight.
  if(send) send.disabled = _trRevPolling || (!hasText && indices.length === 0);
  if(hint){
    if(indices.length){
      hint.textContent = 'will attach ' + indices.length + ' record'
        + (indices.length===1?'':'s') + ' to next send';
    } else {
      hint.textContent = '';
    }
  }
}

// ── Chat history rendering ───────────────────────────────────────────────────
function _trRevHasRecordBlocks(text){
  // A record block starts with a bare integer line. Look for at least one.
  return /^\s*\d+\s*$\n.*\n\s*\[.+\]/m.test(text || '');
}

function _trRevRenderChat(){
  var el=$('tr-rev-chat'); if(!el)return;
  el.innerHTML = '';
  if(!_trRevMessages.length){
    el.innerHTML = '<div style="color:#666;padding:6px">Pick records and click <em>Start review session</em>.</div>';
    return;
  }
  // Skip the system prompt; it's not user-facing
  _trRevMessages.forEach(function(m, mi){
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
    if(m.role === 'assistant' && _trRevHasRecordBlocks(m.content)){
      var apply = document.createElement('button');
      apply.className = 'btn'; apply.textContent = 'Apply changes';
      apply.style.cssText = 'padding:2px 8px;font-size:10px';
      apply.addEventListener('click', function(){ _trRevApply(m.content, apply); });
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

// ── Polling for one chat round ───────────────────────────────────────────────
function _trRevPoll(jobId){
  _trRevPolling = true;
  _trRevUpdateButtons();
  var since = 0;
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type === 'step') _trRevLog(ev.msg);
          else if(ev.type === 'augmented'){
            // Server augmented our placeholder user message with full
            // baseline / record blocks. Mirror that into local history so
            // the next turn sends the right thing.
            var i = (typeof ev.index === 'number') ? ev.index : _trRevPendingUserIdx;
            if(i >= 0 && i < _trRevMessages.length && _trRevMessages[i]){
              _trRevMessages[i].content = ev.content || '';
              _trRevRenderChat();
            }
          } else if(ev.type === 'result'){
            _trRevMessages.push({role:'assistant', content: ev.reply || ''});
            _trRevRenderChat();
            _trRevSetStatus('✓ Reply received');
          } else if(ev.type === 'error'){
            _trRevSetStatus('⚠ '+ev.error, true);
          }
        });
        since = s.next || since;
        if(s.done){
          _trRevPolling = false;
          _trRevPendingUserIdx = -1;
          _trRevUpdateButtons();
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        _trRevPolling = false;
        _trRevPendingUserIdx = -1;
        _trRevSetStatus('Poll failed: '+e, true);
        _trRevUpdateButtons();
      });
  }
  tick();
}

// ── Send: handles both first turn and subsequent turns ──────────────────────
function _trRevSend(){
  if(!window._activeFile){ _trRevSetStatus('No project selected', true); return; }
  if(_trRevPolling) return;
  var input=$('tr-rev-input'); if(!input)return;
  var typed = input.value.trim();
  var attach = _trRevSelectedIndices();
  if(!typed && !attach.length){ _trRevSetStatus('Type a message or select records', true); return; }

  // Push the user's typed text as a placeholder. The server may augment it
  // (with baseline context on first turn, or extra record blocks otherwise)
  // and echo back the final content via the 'augmented' event.
  _trRevMessages.push({role:'user', content: typed});
  _trRevPendingUserIdx = _trRevMessages.length - 1;
  input.value = '';
  _trRevRenderChat();

  var isFirst = !_trRevMessages.some(function(m){return m.role === 'assistant';});
  _trRevSetStatus(isFirst ? 'Building baseline…' : 'Sending…');

  fetch('/translate-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      messages: _trRevMessages,
      attach_records: attach.length ? attach : undefined,
    })
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id'); }
      _trRevPoll(d.job_id);
    })
    .catch(function(e){
      _trRevSetStatus('⚠ '+e, true);
      _trRevPolling = false;
      _trRevPendingUserIdx = -1;
      _trRevUpdateButtons();
    });

  // Clear the queue — those records are now attached to the in-flight send.
  // User can re-select any record (including ones just sent) for the next round.
  _trRevSelected = {};
  _trRevBuildPickList();
  _trRevUpdateButtons();
}

function _trRevApply(responseText, btn){
  var indices = _trRevSelectedIndices();
  if(!indices.length){ _trRevSetStatus('No records selected for apply', true); return; }
  if(btn) btn.disabled = true;
  _trRevSetStatus('Applying…');
  fetch('/apply-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({response_text: responseText, indices: indices})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'apply failed'); }
      _trRevSetStatus('✓ Applied to '+d.updated+' record(s)');
      // Refetch + re-render so dropdown labels, badges, preview all update.
      if(typeof apiFetchData === 'function'){
        apiFetchData().then(function(fresh){
          if(Array.isArray(fresh)) entries = fresh;
          if(typeof buildDD==='function')buildDD();
          if(typeof render==='function')render();
          _trRevBuildPickList();
        });
      }
      if(btn){ btn.textContent = '✓ Applied'; }
    })
    .catch(function(e){
      _trRevSetStatus('⚠ '+e, true);
      if(btn) btn.disabled = false;
    });
}

function _trRevReset(){
  if(_trRevMessages.length && !confirm('Discard the current review session?')) return;
  _trRevMessages = [];
  _trRevPendingUserIdx = -1;
  _trRevSelected = {};
  _trRevBuildPickList();
  _trRevRenderChat();
  _trRevSetStatus('');
  _trRevUpdateButtons();
}

// ── Public hook ──────────────────────────────────────────────────────────────
window._trRevOnShow = function(){
  _trRevBuildPickList();
  _trRevRenderChat();
  _trRevUpdateButtons();
};

// ── Wiring ───────────────────────────────────────────────────────────────────
(function _wireTrRev(){
  var clear=$('tr-rev-clear-sel'); if(clear) clear.addEventListener('click', _trRevClearSelection);
  var send =$('tr-rev-send');      if(send)  send.addEventListener('click', _trRevSend);
  var reset=$('tr-rev-reset');     if(reset) reset.addEventListener('click', _trRevReset);
  var inp  =$('tr-rev-input');     if(inp){
    inp.addEventListener('input', _trRevUpdateButtons);
    inp.addEventListener('keydown', function(ev){
      // Ctrl/Cmd+Enter sends
      if((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter'){
        ev.preventDefault();
        _trRevSend();
      }
    });
  }
})();
