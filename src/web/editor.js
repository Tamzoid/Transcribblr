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
  entries.splice(at,0,{start:parseFloat($('as2').value),end:parseFloat($('ae2').value),text:"????"});
  idx=at;buildDD();render();triggerSave();setStatus("Added record #"+(idx+1));
}
function doSplit(){
  pushUndo();
  var e=entries[idx],c=parseInt($('sc').value),t=parseFloat($('st').value),jp=extractJP(e.text);
  var t1=jp.substring(0,c).trim()||'????',t2=jp.substring(c).trim()||'????';
  entries.splice(idx,1,{start:e.start,end:t,text:t1},{start:t,end:e.end,text:t2});
  buildDD();render();triggerSave();setStatus("Split record");
}
function doMerge(){
  if(idx+1>=entries.length){setStatus("No next record",true);return;}
  pushUndo();
  var a=entries[idx],b=entries[idx+1];
  entries.splice(idx,2,{start:a.start,end:b.end,text:mergeTexts(a.text,b.text)});
  buildDD();render();triggerSave();setStatus("Merged records");
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
    if(name==='time'||name==='text')render();
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
    clearTimeout(followPauseTimer);
    // Don't re-enable audioFollow while looping — stopLoop() will re-enable it
    if(!looping){
      followPauseTimer=setTimeout(function(){audioFollow=true;},2000);
    }
  }
}
$('btn-prev').addEventListener('click',function(){go(idx-1);});
$('btn-next').addEventListener('click',function(){go(idx+1);});
$('sel').addEventListener('change',function(){go(parseInt($('sel').value));});

// et textarea listener
var etEl=$('et');if(etEl)etEl.addEventListener('input',function(){_userEditing=true;editPrev();});
['sc','st'].forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('input',splitPrev);});
document.querySelectorAll('input[name="apos"]').forEach(function(r){r.addEventListener('change',addInfo);});
$('btn-save-time').addEventListener('click',doEdit);
$('btn-save-text').addEventListener('click',doEdit);
$('btn-add').addEventListener('click',doAdd);
$('btn-split').addEventListener('click',doSplit);
$('btn-split-now').addEventListener('click',function(){
  // Set time split to current playback position then split
  var t=ws.getCurrentTime();
  var e=entries[idx];if(!e)return;
  t=Math.max(e.start+0.01,Math.min(t,e.end-0.01));
  var st=$('st');if(st){st.value=t;}
  splitPrev();
  doSplit();
});
$('btn-merge').addEventListener('click',doMerge);
$('btn-delete').addEventListener('click',doDelete);


