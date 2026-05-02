// ── Transcribblr Editor — save, dirty tracking, record actions ─────────────────

// ── Save & dirty tracking ────────────────────────────────────────────────────

var _pendingEdits=new Set();
function markDirty(n){
  if(!_userEditing)return;
  _pendingEdits.add(n);
  var el=$('s-uns');if(!el)return;
  el.textContent='● Unsaved changes - ('+_pendingEdits.size+')';
}
function clearDirty(){
  _pendingEdits.clear();
  var el=$('s-uns');if(!el)return;
  el.textContent='';
}

// ── Record actions ──────────────────────────────────────────────────────────

function doEdit(){
  pushUndo();
  buildDD();render();updateCurRegion();triggerSave();setStatus("Saved");
}
function doAdd(){
  pushUndo();
  var p=document.querySelector('input[name="apos"]:checked').value,at=p==='Before'?idx:idx+1;
  entries.splice(at,0,{start:parseFloat($('as2').value),end:parseFloat($('ae2').value),
                       text:{ja:'????', ro:'', en:''}});
  idx=at;buildDD();render();triggerSave();setStatus("Added record #"+(idx+1));
}
function doSplit(){
  pushUndo();
  var e=entries[idx],c=parseInt($('sc').value),t=parseFloat($('st').value);
  var jp=extractJP(e.text);
  var jp1=jp.substring(0,c).trim()||'????', jp2=jp.substring(c).trim()||'????';
  var carry={};['speaker','speaker_note','note'].forEach(function(k){
    if(e[k]!==undefined)carry[k]=e[k];
  });
  var first  = Object.assign({start:e.start, end:t,
                              text:{ja:jp1, ro:'', en:''}}, carry);
  var second = {start:t, end:e.end, text:{ja:jp2, ro:'', en:''}};
  entries.splice(idx,1,first,second);
  buildDD();render();triggerSave();setStatus("Split record");
}
// Pick the adjacent pair {a, b} (a = b - 1) to merge, based on playback cursor:
//   inside a record       → that record + next  (or prev + this if it's the last)
//   between records       → previous + next
//   before the first      → first two
//   after the last        → last two
// Returns null if there are fewer than 2 records.
function _mergePair(){
  if(entries.length < 2) return null;
  var t = (typeof ws !== 'undefined' && ws) ? ws.getCurrentTime() : 0;
  // Inside a record?
  for(var i=0;i<entries.length;i++){
    if(t >= entries[i].start && t <= entries[i].end){
      if(i + 1 < entries.length) return {a: i, b: i+1};
      return {a: i-1, b: i};  // last record
    }
  }
  // Between records — pick last record before t and first after.
  var prev = -1, next = -1;
  for(var j=0;j<entries.length;j++){
    if(entries[j].end < t) prev = j;
    if(entries[j].start > t){ next = j; break; }
  }
  if(prev < 0){
    // Before the first record — merge the first two.
    return {a: 0, b: 1};
  }
  if(next < 0){
    // After the last record — merge the last two.
    return {a: entries.length-2, b: entries.length-1};
  }
  return {a: prev, b: next};
}

function doMerge(){
  var pair = _mergePair();
  if(!pair){setStatus("Need at least 2 records to merge", true); return;}
  pushUndo();
  var a=entries[pair.a], b=entries[pair.b];
  var carry={};['speaker','speaker_note','note'].forEach(function(k){
    if(a[k]!==undefined)carry[k]=a[k];
  });
  var merged=Object.assign({start:a.start,end:b.end,text:mergeTexts(a.text,b.text)},carry);
  entries.splice(pair.a,2,merged);
  idx = pair.a;
  buildDD();render();triggerSave();
  setStatus('Merged records '+(pair.a+1)+' + '+(pair.b+1));
}
function doDelete(){
  pushUndo();
  entries.splice(idx,1);idx=Math.min(idx,entries.length-1);
  buildDD();render();triggerSave();setStatus("Deleted record");
}

function triggerSave(){clearTimeout(saveTimer);saveTimer=setTimeout(doSave,900);}
function doSave(){
  if(!window._activeFile)return;
  setStatus("Saving…");
  apiSave(entries)
    .then(function(d){
      if(d.ok){
        setStatus("Saved ✓ ("+d.count+" records)");clearDirty();
      } else { setStatus("Save error: "+d.error,true); }
    })
    .catch(function(e){setStatus("Save failed: "+e,true);});
}


// ── Transcribblr Editor — tabs, nav, sliders, save, undo ─────────────────────

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tbtn').forEach(function(btn){
  btn.addEventListener('click',function(){
    var name=btn.getAttribute('data-tab');
    document.querySelectorAll('.tp').forEach(function(p){p.classList.remove('on');});
    document.querySelectorAll('.tbtn').forEach(function(b){b.classList.remove('on');});
    var panel=document.getElementById('tp-'+name);
    if(panel)panel.classList.add('on');
    btn.classList.add('on');
    if(name==='text')render();
    if(name==='edit' && typeof _newRender==='function')_newRender();
    if(name==='scenes' && typeof _aeRender==='function'){_annSyncSceneToTime && _annSyncSceneToTime();_aeRender();}
    if(name==='speakers' && typeof _recRender==='function')_recRender();
    if(name==='transcribe' && typeof window._txOnShow==='function')window._txOnShow();
    if(typeof _annUpdateRegions==='function')_annUpdateRegions();
    updateCur();
    updateAddRegion();
    updateSplitRegions();
    });
});

// ── Nav ───────────────────────────────────────────────────────────────────────
// audioFollow: true = audio drives record selection; briefly paused on manual nav
var audioFollow=true, followPauseTimer=null;

function go(i,fromAudio){
  idx=Math.max(0,Math.min(i,entries.length-1));
  $('sel').value=idx;
  render();
  updateCurRegion();
  if(typeof window._spOnIdxChanged==='function')window._spOnIdxChanged();
  // If navigated manually, seek audio to record start and pause auto-follow briefly
  if(!fromAudio){
    if(looping){
      // Restart loop interval on new record's bounds
      clearInterval(loopTimer);loopTimer=null;
      var b=getLoopBounds();
      if(b){ws.setTime(b.s);startLoopInterval();}
    } else {
      if(ws)try{ws.setTime(entries[idx].start);}catch(x){}
    }
    audioFollow=false;
    console.log('[follow] off (manual nav, looping='+looping+')');
    clearTimeout(followPauseTimer);
    // Don't re-enable audioFollow while looping — stopLoop() will re-enable it
    if(!looping){
      followPauseTimer=setTimeout(function(){
        audioFollow=true;
        console.log('[follow] on (timer)');
      },2000);
    }
  }
}
$('btn-prev').addEventListener('click',function(){go(idx-1);});
$('btn-next').addEventListener('click',function(){go(idx+1);});
$('sel').addEventListener('change',function(){go(parseInt($('sel').value));});

// ── Text-tab inputs — auto-save on input, with per-lane undo history ───────
// Undo stack keeps recent values per lane (debounced so single keystrokes
// don't bloat history). render() resets the stack when navigating to a new
// entry — undo only works within the current record.
var _etHist = {ja:[''], en:['']};
var _etHistTimer = {ja:null, en:null};
var _etSuppressHist = false;
var ET_HIST_MAX = 30;
var _romajiInputTimer = null;

function _etResetHist(){
  var t = (entries[idx] && entries[idx].text) || {};
  _etHist.ja = [t.ja || ''];
  _etHist.en = [t.en || ''];
  _etUpdateUndoBtns();
}
function _etUpdateUndoBtns(){
  var ja=$('et-ja-undo'); if(ja) ja.disabled = _etHist.ja.length <= 1;
  var en=$('et-en-undo'); if(en) en.disabled = _etHist.en.length <= 1;
}
function _etPushHistDebounced(lane){
  if(_etSuppressHist) return;
  var el = $('et-'+lane); if(!el) return;
  clearTimeout(_etHistTimer[lane]);
  _etHistTimer[lane] = setTimeout(function(){
    var h = _etHist[lane], v = el.value;
    if(h.length === 0 || h[h.length-1] !== v){
      h.push(v);
      if(h.length > ET_HIST_MAX) h.shift();
      _etUpdateUndoBtns();
    }
  }, 500);
}
function _etUndo(lane){
  var h = _etHist[lane];
  if(h.length <= 1) return;
  h.pop();
  var prev = h[h.length-1];
  var el = $('et-'+lane); if(!el) return;
  _etSuppressHist = true;
  el.value = prev;
  el.dispatchEvent(new Event('input'));
  _etSuppressHist = false;
  _etUpdateUndoBtns();
}
window._etResetHist = _etResetHist;  // called from render()

function _onJaInput(){
  _userEditing=true;
  editPrev();
  triggerSave();
  // Clear stored romaji until the regen lands so display doesn't show stale.
  if(entries[idx] && typeof entries[idx].text === 'object') entries[idx].text.ro = '';
  clearTimeout(_romajiInputTimer);
  _romajiInputTimer=setTimeout(function(){
    var ja=entries[idx] && entries[idx].text && entries[idx].text.ja;
    if(!ja)return;
    delete _romajiCache[ja];
    getRomaji(ja, function(r){
      if(!r||!entries[idx])return;
      if(typeof entries[idx].text==='object') entries[idx].text.ro=r;
      triggerSave();
      updateCur();
    });
  }, 500);
  _etPushHistDebounced('ja');
}
var _etJa=$('et-ja'); if(_etJa) _etJa.addEventListener('input', _onJaInput);
var _etEn=$('et-en'); if(_etEn) _etEn.addEventListener('input', function(){
  _userEditing=true; editPrev(); triggerSave(); _etPushHistDebounced('en');
});

var _etJaUndo=$('et-ja-undo'); if(_etJaUndo) _etJaUndo.addEventListener('click', function(){_etUndo('ja');});
var _etEnUndo=$('et-en-undo'); if(_etEnUndo) _etEnUndo.addEventListener('click', function(){_etUndo('en');});

var _etClear=$('et-clear');
if(_etClear) _etClear.addEventListener('click', function(){
  var ja=$('et-ja'), en=$('et-en');
  if(ja){ ja.value='????'; ja.dispatchEvent(new Event('input')); }
  if(en){ en.value='';     en.dispatchEvent(new Event('input')); }
});
var _etClearEn=$('et-clear-en');
if(_etClearEn) _etClearEn.addEventListener('click', function(){
  var en=$('et-en');
  if(en){ en.value=''; en.dispatchEvent(new Event('input')); }
});

// "Mark reviewed" — small ✓ icon overlaid on the current-record preview.
// Only visible when the current record carries the 🆕 flag set by /transcribe.
function _updateReviewedBtn(){
  var btn=$('cur-mark-reviewed'); if(!btn) return;
  var e=entries[idx];
  btn.style.display = (e && e.new) ? 'flex' : 'none';
}
window._updateReviewedBtn = _updateReviewedBtn;
var _curReviewed=$('cur-mark-reviewed');
if(_curReviewed) _curReviewed.addEventListener('click', function(ev){
  ev.stopPropagation();  // don't trigger #cur's mode-cycle click handler
  if(typeof _txMarkOneReviewed==='function') _txMarkOneReviewed(idx);
  _updateReviewedBtn();
});

// Translator note banner — populated by render(), dismissed via the small
// button which calls /clear-translator-note.
function _updateTranslatorNote(){
  var box=$('et-translator-note'), txt=$('et-translator-note-text');
  if(!box || !txt) return;
  var e = entries[idx];
  var note = (e && e.translator_note) || '';
  if(!note){ box.style.display='none'; return; }
  txt.textContent = note;
  box.style.display = '';
}
window._updateTranslatorNote = _updateTranslatorNote;
var _trNoteDismiss=$('et-translator-note-dismiss');
if(_trNoteDismiss) _trNoteDismiss.addEventListener('click', function(){
  if(!entries[idx])return;
  var keepIdx = idx;
  fetch('/clear-translator-note',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({indices:[keepIdx]})
  })
    .then(function(r){return r.json();})
    .then(function(d){
      if(d && d.ok && entries[keepIdx]){
        delete entries[keepIdx].translator_note;
        if(typeof buildDD==='function')buildDD();
        _updateTranslatorNote();
      }
    });
});

var _btnMerge=$('btn-merge'); if(_btnMerge) _btnMerge.addEventListener('click',doMerge);


// ── Subtitle import (replace current project's subtitles from VTT/SRT/TXT) ────
function _doSubtitleImport(file){
  var status=$('subimp-status');
  if(!window._activeFile){
    if(status)status.textContent='⚠ No project selected';
    return;
  }
  if(status)status.textContent='Uploading '+file.name+'…';
  apiImportSubtitles(file,function(loaded,total){
    if(status)status.textContent='Uploading '+file.name+'… '+Math.round(loaded/total*100)+'%';
  }).then(function(d){
    if(d.ok){
      if(status)status.textContent='✓ Replaced subtitles ('+d.count+' records)';
      pushUndo();
      entries=d.entries;idx=0;
      buildDD();render();updateCurRegion();
      setStatus('Imported '+d.count+' records from '+file.name);
    } else {
      if(status)status.textContent='⚠ '+(d.error||'Import failed');
    }
  }).catch(function(e){
    if(status)status.textContent='⚠ '+e;
  });
}

var _sidz=$('subimp-drop-zone');
if(_sidz){
  _sidz.addEventListener('dragover',function(e){e.preventDefault();_sidz.classList.add('drag-over');});
  _sidz.addEventListener('dragleave',function(){_sidz.classList.remove('drag-over');});
  _sidz.addEventListener('drop',function(e){
    e.preventDefault();_sidz.classList.remove('drag-over');
    var f=e.dataTransfer&&e.dataTransfer.files[0];if(f)_doSubtitleImport(f);
  });
}
var _siInput=$('subimp-input');
if(_siInput)_siInput.addEventListener('change',function(){if(_siInput.files[0])_doSubtitleImport(_siInput.files[0]);});


