// ── Translations top-tab — Basic + Advanced ──────────────────────────────────
// Streams /process-status events the same way Transcribe does, optimistically
// patches each entry's text.en as the server emits progress.

var _trPolling = false;

function _trEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function _trSetStatus(which, msg, warn){
  var el=$('tr-'+which+'-status'); if(!el)return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _trLog(which, line){
  var el=$('tr-'+which+'-log'); if(!el)return;
  el.textContent += (el.textContent ? '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function _trClearLog(which){
  var el=$('tr-'+which+'-log'); if(el) el.textContent='';
}

function _trDisableButtons(disabled){
  var b1=$('tr-basic-run'); if(b1) b1.disabled = disabled;
  var b2=$('tr-adv-run');   if(b2) b2.disabled = disabled;
}

function _trPoll(jobId, which){
  _trPolling = true;
  _trDisableButtons(true);
  var since = 0;
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type==='step'){
            _trLog(which, ev.msg);
          } else if(ev.type==='progress' && ev.idx !== undefined){
            // Optimistic update — patch entries[idx].text.en immediately so
            // the editor's other panes see the new translation right away.
            if(entries[ev.idx]){
              if(typeof entries[ev.idx].text !== 'object')
                entries[ev.idx].text = {ja:'',ro:'',en:''};
              entries[ev.idx].text.en = ev.en || '';
            }
          } else if(ev.type==='result'){
            _trSetStatus(which,
              '✓ Translated '+ev.translated+'/'+ev.total+' record(s)'
              +(ev.failed?' ('+ev.failed+' failed)':''));
          } else if(ev.type==='error'){
            _trSetStatus(which, '⚠ '+ev.error, true);
          }
        });
        since = s.next || since;
        if(s.done){
          _trPolling = false;
          _trDisableButtons(false);
          // Refetch + re-render so the dropdown labels and editor reflect
          // every translation that just landed.
          if(typeof apiFetchData === 'function'){
            apiFetchData().then(function(fresh){
              if(Array.isArray(fresh)){ entries = fresh; }
              if(typeof buildDD==='function')buildDD();
              if(typeof render==='function')render();
            }).catch(function(){});
          }
        } else {
          setTimeout(tick, 1000);
        }
      })
      .catch(function(e){
        _trPolling = false;
        _trDisableButtons(false);
        _trSetStatus(which, 'Poll failed: '+e, true);
      });
  }
  tick();
}

// ── Actions ──────────────────────────────────────────────────────────────────

function _trStart(which, body){
  if(!window._activeFile){ _trSetStatus(which, 'No project selected', true); return; }
  _trClearLog(which);
  _trSetStatus(which, 'Starting — first run loads C3TR (~30–60s)…');
  fetch('/translate-records',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body||{})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.job_id){ throw new Error(d.error||'no job_id returned'); }
      _trPoll(d.job_id, which);
    })
    .catch(function(e){ _trSetStatus(which, '⚠ '+e, true); });
}

function _trStartBasic(){
  // Default tags — matches the upstream Step 6 script.
  _trStart('basic', {});
}

function _trStartAdvanced(){
  var raw = (($('tr-adv-style')||{}).value || '').trim();
  var tags = raw ? raw.split(',').map(function(t){return t.trim();}).filter(Boolean) : [];
  var force = !!($('tr-adv-force') && $('tr-adv-force').checked);
  _trStart('advanced', {style_tags:tags, force:force});
}

// ── Sub-tab switching ──────────────────────────────────────────────────────
document.querySelectorAll('.tr-tbtn').forEach(function(btn){
  btn.addEventListener('click', function(){
    var which = this.getAttribute('data-trtab');
    document.querySelectorAll('.tr-tbtn').forEach(function(b){ b.classList.remove('on'); });
    this.classList.add('on');
    var pb=$('tr-pane-basic'), pa=$('tr-pane-advanced');
    if(pb) pb.style.display = which === 'basic'    ? '' : 'none';
    if(pa) pa.style.display = which === 'advanced' ? '' : 'none';
  });
});

// ── Wiring ──────────────────────────────────────────────────────────────────
(function _wireTranslations(){
  var b=$('tr-basic-run'); if(b) b.addEventListener('click', _trStartBasic);
  var a=$('tr-adv-run');   if(a) a.addEventListener('click', _trStartAdvanced);
})();
