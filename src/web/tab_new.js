// ── Edit → "New" tab — playback-driven add/split/delete + big play button ────
//
// Two modes:
//   normal:  preview, action buttons (Add/Split/Delete), nudge controls, big play
//   split:   bisect-current-record preview, char-position nudges, confirm/cancel

var _newSplitChar = 0;   // chars from start of JA where the split lands
var _newSplitTime = 0;   // playback time of the split (frozen on entry)
var _newSplitMode = false;

// Index of the record that contains the current playback time, or -1 if none.
function _newHostIdx(){
  if(!ws || !entries.length) return -1;
  var t = ws.getCurrentTime();
  for(var i=0; i<entries.length; i++){
    if(t >= entries[i].start && t <= entries[i].end) return i;
  }
  return -1;
}

function _newActiveOnTab(){
  var b = document.querySelector('.tbtn.on');
  return b && b.getAttribute('data-tab') === 'new';
}

function _newPlayBtnSync(){
  var b = $('new-play'); if(!b || !ws) return;
  b.textContent = ws.isPlaying() ? '⏸' : '▶';
}

function _newRender(){
  if(!_newActiveOnTab() || _newSplitMode) return;
  if(!ws) return;
  var host = _newHostIdx();
  var inRecord = host >= 0;

  // Swap Add ↔ {Split + Delete} so the action area's height stays constant.
  var addBtn = $('new-add');
  if(addBtn) addBtn.style.display = inRecord ? 'none' : '';
  var actionsRow = $('new-actions-row');
  if(actionsRow) actionsRow.style.display = inRecord ? '' : 'none';

  // Nudge section is always visible; buttons disable when out of a record so
  // the layout (and the big-play position) doesn't shift.
  document.querySelectorAll('.new-nudges .nudge').forEach(function(b){
    b.disabled = !inRecord;
  });

  _newPlayBtnSync();
}

// ── Add ─────────────────────────────────────────────────────────────────────
function _newAdd(){
  if(!ws) return;
  var t = ws.getCurrentTime();
  if(_newHostIdx() >= 0){
    setStatus('Already inside a record', true);
    return;
  }
  // Cap end at next record's start (or audioDur).
  var nextStart = audioDur || (t + 2);
  for(var i=0;i<entries.length;i++){
    if(entries[i].start > t){nextStart = entries[i].start; break;}
  }
  var newEnd = Math.min(t + 2, nextStart);
  if(newEnd <= t + 0.05){
    setStatus('Not enough room to insert a record here', true);
    return;
  }
  // Find insertion index (first entry whose start > t)
  var insertAt = entries.length;
  for(var k=0;k<entries.length;k++){if(entries[k].start > t){insertAt=k; break;}}
  pushUndo();
  entries.splice(insertAt, 0, {
    start: t, end: newEnd,
    text: {ja:'????', ro:'', en:''},
  });
  idx = insertAt;
  buildDD(); render(); updateCurRegion();
  triggerSave();
  setStatus('Added record #'+(idx+1));
  _newRender();
}

// ── Delete ─────────────────────────────────────────────────────────────────
function _newDelete(){
  var host = _newHostIdx();
  if(host < 0) return;
  pushUndo();
  entries.splice(host, 1);
  idx = Math.min(idx, entries.length - 1);
  buildDD(); render(); updateCurRegion();
  triggerSave();
  setStatus('Deleted record');
  _newRender();
}

// ── Nudges (current record only) ────────────────────────────────────────────
function _newNudge(side, what){
  var host = _newHostIdx();
  if(host < 0) return;
  var e = entries[host];
  var t = ws ? ws.getCurrentTime() : 0;
  if(side === 's'){
    var newStart = (what === 'now') ? t : (e.start + parseFloat(what));
    // Clamp: must be ≥ prev end and ≤ own end - 0.05
    if(host > 0) newStart = Math.max(newStart, entries[host-1].end);
    newStart = Math.max(0, Math.min(newStart, e.end - 0.05));
    e.start = newStart;
  } else {
    var newEnd = (what === 'now') ? t : (e.end + parseFloat(what));
    if(host + 1 < entries.length) newEnd = Math.min(newEnd, entries[host+1].start);
    newEnd = Math.max(e.start + 0.05, Math.min(newEnd, audioDur || newEnd));
    e.end = newEnd;
  }
  // Make sure idx points to the host so the rest of the editor follows.
  idx = host;
  buildDD(); render(); updateCurRegion();
  triggerSave();
  _newRender();
}

// ── Split ──────────────────────────────────────────────────────────────────
function _newSplitStart(){
  var host = _newHostIdx();
  if(host < 0){setStatus('Not inside a record', true); return;}
  if(ws && ws.isPlaying()) ws.pause();
  idx = host;
  _newSplitTime = ws.getCurrentTime();
  var e = entries[host];
  var jp = (typeof extractJP === 'function') ? extractJP(e.text) : '';
  var stripped = (jp || '').replace(/[?？]/g, '').trim();
  if(!stripped){
    // Empty (or just "????") — no character bisection needed; commit now.
    _newCommitSplit(_newSplitTime, '????', '????');
    return;
  }
  var frac = (e.end - e.start) > 0 ? (_newSplitTime - e.start) / (e.end - e.start) : 0.5;
  _newSplitChar = Math.round(jp.length * Math.max(0, Math.min(1, frac)));
  _newSplitMode = true;
  $('new-normal').style.display = 'none';
  $('new-split-mode').style.display = '';
  _newSplitRender();
}

function _newCommitSplit(t, jp1, jp2){
  var e = entries[idx]; if(!e) return;
  jp1 = (jp1 || '').trim() || '????';
  jp2 = (jp2 || '').trim() || '????';
  var carry = {};
  ['speaker','speaker_note','note'].forEach(function(k){
    if(e[k] !== undefined) carry[k] = e[k];
  });
  pushUndo();
  var first  = Object.assign({start: e.start, end: t,
                              text: {ja:jp1, ro:'', en:''}}, carry);
  var second = {start: t, end: e.end, text: {ja:jp2, ro:'', en:''}};
  entries.splice(idx, 1, first, second);
  buildDD(); render(); updateCurRegion();
  triggerSave();
  setStatus('Split record at '+toSRT(t));
  _newRender();
}

function _newSplitRender(){
  var e = entries[idx]; if(!e) return;
  var jp = (typeof extractJP === 'function') ? extractJP(e.text) : '';
  _newSplitChar = Math.max(0, Math.min(jp.length, _newSplitChar));
  var jp1 = jp.substring(0, _newSplitChar);
  var jp2 = jp.substring(_newSplitChar);
  var p1 = $('new-split-p1'), p2 = $('new-split-p2');
  if(p1) p1.textContent = (idx+1) + '\n' + toSRT(e.start) + ' → ' + toSRT(_newSplitTime)
                       + '\n' + (jp1 || '(empty)');
  if(p2) p2.textContent = (idx+2) + '\n' + toSRT(_newSplitTime) + ' → ' + toSRT(e.end)
                       + '\n' + (jp2 || '(empty)');
  var t = $('new-split-time'); if(t) t.textContent = toSRT(_newSplitTime);
}

function _newSplitNudge(delta){
  _newSplitChar += delta;
  _newSplitRender();
}

function _newSplitConfirm(){
  var e = entries[idx]; if(!e) return;
  var jp = (typeof extractJP === 'function') ? extractJP(e.text) : '';
  var c = Math.max(0, Math.min(jp.length, _newSplitChar));
  _newCommitSplit(_newSplitTime, jp.substring(0, c), jp.substring(c));
  _newSplitCancel();
}

function _newSplitCancel(){
  _newSplitMode = false;
  $('new-normal').style.display = '';
  $('new-split-mode').style.display = 'none';
  _newRender();
}

// ── Wire everything ────────────────────────────────────────────────────────
(function _wireNew(){
  var p = $('new-play');     if(p)  p.addEventListener('click', function(){if(ws) ws.playPause();});
  var a = $('new-add');      if(a)  a.addEventListener('click', _newAdd);
  var s = $('new-split');    if(s)  s.addEventListener('click', _newSplitStart);
  var d = $('new-delete');   if(d)  d.addEventListener('click', _newDelete);

  document.querySelectorAll('[data-newnudge]').forEach(function(b){
    b.addEventListener('click', function(){
      var spec = b.getAttribute('data-newnudge').split(',');
      _newNudge(spec[0], spec[1]);
    });
  });

  document.querySelectorAll('[data-charnudge]').forEach(function(b){
    b.addEventListener('click', function(){
      _newSplitNudge(parseInt(b.getAttribute('data-charnudge'), 10));
    });
  });

  var sc = $('new-split-confirm'); if(sc) sc.addEventListener('click', _newSplitConfirm);
  var sx = $('new-split-cancel');  if(sx) sx.addEventListener('click', _newSplitCancel);
})();

// Refresh whenever ws ticks while we're on the new tab.
window._newOnTimeUpdate = function(){ _newRender(); };
