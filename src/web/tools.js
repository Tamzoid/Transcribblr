// ── Tools top-tab — Import + Clear sub-tabs ─────────────────────────────────
// Inner sub-tab switching follows the same pattern as Translations / Records.
// Clear actions hit /clear-records on the server and refetch /data on success
// so the editor's other panes reflect the change immediately.

document.querySelectorAll('.tool-tbtn').forEach(function(btn){
  btn.addEventListener('click', function(){
    var which = this.getAttribute('data-tooltab');
    document.querySelectorAll('.tool-tbtn').forEach(function(b){ b.classList.remove('on'); });
    this.classList.add('on');
    var pi=$('tools-pane-import'), pc=$('tools-pane-clear');
    if(pi) pi.style.display = which === 'import' ? '' : 'none';
    if(pc) pc.style.display = which === 'clear'  ? '' : 'none';
  });
});

function _toolsSetStatus(msg, warn){
  var el=$('tools-clear-status'); if(!el) return;
  el.textContent = msg || '';
  el.style.color = warn ? '#ffaa55' : '#888';
}

function _toolsClearRequest(action, label){
  if(!window._activeFile){ _toolsSetStatus('No project selected', true); return; }
  var prompt = action === 'all'
    ? 'Reset EVERY record back to ???? (destroys all transcriptions + translations)?'
    : 'Clear the English + literal lanes on EVERY record?';
  if(!confirm(prompt)) return;
  var btnT=$('tools-clear-translations'), btnA=$('tools-clear-all');
  if(btnT) btnT.disabled = true;
  if(btnA) btnA.disabled = true;
  _toolsSetStatus(label + '…');
  fetch('/clear-records', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({action: action})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(!d.ok){ throw new Error(d.error || 'failed'); }
      _toolsSetStatus('✓ Cleared '+d.cleared+' / '+d.total+' record(s)');
      // Refetch so dropdown labels, preview, badges all reflect the wipe.
      if(typeof apiFetchData === 'function'){
        apiFetchData().then(function(fresh){
          if(Array.isArray(fresh)) entries = fresh;
          if(typeof buildDD === 'function') buildDD();
          if(typeof render === 'function') render();
        });
      }
    })
    .catch(function(e){ _toolsSetStatus('⚠ '+e, true); })
    .finally(function(){
      if(btnT) btnT.disabled = false;
      if(btnA) btnA.disabled = false;
    });
}

(function _wireTools(){
  var ct=$('tools-clear-translations');
  if(ct) ct.addEventListener('click', function(){ _toolsClearRequest('translations', 'Clearing translations'); });
  var ca=$('tools-clear-all');
  if(ca) ca.addEventListener('click', function(){ _toolsClearRequest('all', 'Resetting all records to ????'); });
})();
