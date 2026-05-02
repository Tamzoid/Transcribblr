// ── Translations → Review sub-tab ────────────────────────────────────────────
// Multi-select picker (translated records only) + chat with Qwen.
// Conversation history is kept here client-side and sent in full with every
// turn — the server is stateless. AI replies that contain record blocks can
// be applied with a per-message Apply button.

var _trRevSelected = {};   // {idx: true} — toggle set, no contiguity rule
var _trRevMessages = [];   // [{role:'system'|'user'|'assistant', content:'...'}]
var _trRevSessionStarted = false;
var _trRevPolling = false;

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
    var classes = ['tr-adv-row'];
    var stat = '';
    if(state === 'locked'){
      classes.push('tr-adv-row--locked');
      var ja = (e.text && typeof e.text === 'object') ? (e.text.ja || '') : '';
      stat = (!ja.trim() || ja.indexOf('????') !== -1) ? '?' : '·';
    } else if(inSel){
      classes.push('tr-adv-row--selected');
      stat = '◆';
    } else {
      classes.push('tr-adv-row--selectable');
      stat = '+';
    }
    var ja = (e.text && typeof e.text === 'object') ? (e.text.ja || '') : '';
    var preview = ja.replace(/\n/g,' ');
    var time = (typeof toSRT === 'function') ? toSRT(e.start || 0).split(',')[0] : '';
    var row = document.createElement('div');
    row.className = classes.join(' ');
    row.innerHTML =
      '<span class="num">'+(i+1)+'</span>'+
      '<span class="time">'+_trRevEsc(time)+'</span>'+
      '<span class="text">'+_trRevEsc(preview || '(empty)')+'</span>'+
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
  var start=$('tr-rev-start'), send=$('tr-rev-send'), input=$('tr-rev-input');
  if(start) start.disabled = _trRevSessionStarted || indices.length === 0 || _trRevPolling;
  if(send)  send.disabled  = !_trRevSessionStarted || _trRevPolling
                             || !(input && input.value.trim());
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
          else if(ev.type === 'baseline'){
            // Server attached a baseline message — show it as a user turn.
            _trRevMessages.push({role:'user', content: ev.content});
            _trRevRenderChat();
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
          _trRevUpdateButtons();
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        _trRevPolling = false;
        _trRevSetStatus('Poll failed: '+e, true);
        _trRevUpdateButtons();
      });
  }
  tick();
}

// ── Actions ──────────────────────────────────────────────────────────────────
function _trRevStart(){
  if(!window._activeFile){ _trRevSetStatus('No project selected', true); return; }
  var indices = _trRevSelectedIndices();
  if(!indices.length){ _trRevSetStatus('Pick at least one record', true); return; }

  // Reset history. The server has the system prompt baked into translate_advanced.py
  // but we send it as the first message so it's visible in the UI when needed.
  _trRevMessages = [
    {role:'system', content:'__use_review_default__'},
  ];
  _trRevSessionStarted = true;

  _trRevSetStatus('Starting session — building baseline…');
  // The server will append the baseline user message and ask Qwen for an
  // initial review reply. We pass build_baseline_for so the server knows
  // to construct it from authoritative project state.
  fetch('/translate-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      messages: _trRevServerMessages(),
      build_baseline_for: indices,
    })
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id'); }
      _trRevPoll(d.job_id);
    })
    .catch(function(e){ _trRevSetStatus('⚠ '+e, true); });
  _trRevUpdateButtons();
}

function _trRevSend(){
  if(!_trRevSessionStarted) return;
  var input=$('tr-rev-input'); if(!input)return;
  var msg = input.value.trim();
  if(!msg) return;
  _trRevMessages.push({role:'user', content: msg});
  input.value = '';
  _trRevRenderChat();
  _trRevSetStatus('Sending…');
  fetch('/translate-review',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({messages: _trRevServerMessages()})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error || 'no job_id'); }
      _trRevPoll(d.job_id);
    })
    .catch(function(e){ _trRevSetStatus('⚠ '+e, true); });
  _trRevUpdateButtons();
}

function _trRevServerMessages(){
  // Materialise the system marker into the actual review system prompt
  // (the server replaces __use_review_default__ → REVIEW_SYSTEM_PROMPT).
  return _trRevMessages.map(function(m){
    if(m.role === 'system' && m.content === '__use_review_default__'){
      // Empty system content tells the server to use its default REVIEW_SYSTEM_PROMPT.
      return {role:'system', content:''};
    }
    return m;
  }).filter(function(m){
    // Drop empty system message; server's _adv.chat() sees the rest and the
    // first user turn (baseline + project context) carries the framing.
    if(m.role === 'system' && !m.content) return false;
    return true;
  });
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
  _trRevSessionStarted = false;
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
  var start=$('tr-rev-start');     if(start) start.addEventListener('click', _trRevStart);
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
