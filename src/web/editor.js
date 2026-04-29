// ── Transcribblr Editor — save, dirty tracking, record actions ─────────────────

// ── Save & dirty tracking ────────────────────────────────────────────────────

var _pendingEdits=new Set();
var _userEditing=false;
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
function setUnsaved(d){
  // just used for the "Saving…" state transition — dirty count is separate
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

// ── Sliders + buttons ─────────────────────────────────────────────────────────
// noUiSlider — time tab
window.timeSlider=noUiSlider.create($('time-slider'),{
  start:[0,1],connect:true,step:0.01,
  range:{min:0,max:1},
  tooltips:[
    {to:function(v){return toSRT(v);}},
    {to:function(v){return toSRT(v);}}
  ]
});
function getNeighbourBounds(){
  var prevEnd = idx > 0 ? entries[idx-1].end : 0;
  var nextStart = idx < entries.length-1 ? entries[idx+1].start : audioDur||9999;
  return {min: prevEnd, max: nextStart};
}

function timeSliderCb(vals){
  var nb=getNeighbourBounds();
  var s=Math.max(nb.min, parseFloat(vals[0]));
  var e=Math.min(nb.max, Math.max(s+0.01, parseFloat(vals[1])));
  $('es').value=s;
  $('ee').value=e;
  _userEditing=true;editPrev();
}
window.timeSlider.on('slide',timeSliderCb);
window.timeSlider.on('set',timeSliderCb);

// noUiSlider — add tab
window.addSlider=noUiSlider.create($('add-slider'),{
  start:[0,1],connect:true,step:0.01,
  range:{min:0,max:1},
  tooltips:[
    {to:function(v){return toSRT(v);}},
    {to:function(v){return toSRT(v);}}
  ]
});
function addSliderCb(vals){
  $('as2').value=parseFloat(vals[0]);
  $('ae2').value=parseFloat(vals[1]);
  addPrev();
}
window.addSlider.on('slide',addSliderCb);
window.addSlider.on('set',addSliderCb);


// ── Time nudge buttons ────────────────────────────────────────────────────────
function nudgeTimeSlider(handle, delta){_userEditing=true;
  var nb=getNeighbourBounds();
  var vals=window.timeSlider.get();
  var s=parseFloat(vals[0]), e=parseFloat(vals[1]);
  if(handle===0) s=Math.min(e-0.01, Math.max(nb.min, Math.round((s+delta)*100)/100));
  else            e=Math.max(s+0.01, Math.min(nb.max, Math.round((e+delta)*100)/100));
  window.timeSlider.set([s,e],false);
  $('es').value=s; $('ee').value=e;
  editPrev();
}
function nudgeAddSlider(handle, delta){
  var vals=window.addSlider.get();
  var s=parseFloat(vals[0]), e=parseFloat(vals[1]);
  if(handle===0) s=Math.max(0,Math.round((s+delta)*100)/100);
  else            e=Math.max(s+0.1,Math.round((e+delta)*100)/100);
  var mn=window.addSlider.options.range.min, mx=window.addSlider.options.range.max;
  if(s<mn||e>mx){
    window.addSlider.updateOptions({range:{min:Math.min(mn,s-1),max:Math.max(mx,e+1)}},false);
  }
  window.addSlider.set([s,e],false);
  $('as2').value=s; $('ae2').value=e;
  addPrev();
}
$('ts-s-dn').addEventListener('click',function(){nudgeTimeSlider(0,-0.5);});
$('ts-s-up').addEventListener('click',function(){nudgeTimeSlider(0,+0.5);});
$('ts-e-dn').addEventListener('click',function(){nudgeTimeSlider(1,-0.5);});
$('ts-e-up').addEventListener('click',function(){nudgeTimeSlider(1,+0.5);});
$('ts-s-now').addEventListener('click',function(){
  var t=Math.max(0,ws.getCurrentTime()-0.5);
  nudgeTimeSlider(0, t - parseFloat($('es').value));
});
$('ts-e-now').addEventListener('click',function(){
  var t=ws.getCurrentTime();
  nudgeTimeSlider(1, t - parseFloat($('ee').value));
});
$('as-s-dn').addEventListener('click',function(){nudgeAddSlider(0,-0.5);});
$('as-s-up').addEventListener('click',function(){nudgeAddSlider(0,+0.5);});
$('as-e-dn').addEventListener('click',function(){nudgeAddSlider(1,-0.5);});
$('as-e-up').addEventListener('click',function(){nudgeAddSlider(1,+0.5);});
$('as-s-now').addEventListener('click',function(){
  var t=Math.max(0,ws.getCurrentTime()-0.5);
  nudgeAddSlider(0, t - parseFloat($('as2').value));
});
$('as-e-now').addEventListener('click',function(){
  var t=ws.getCurrentTime();
  nudgeAddSlider(1, t - parseFloat($('ae2').value));
});

// et textarea listener still needed
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


// ── Undo stack ────────────────────────────────────────────────────────────────
var _undoStack=[];
var _UNDO_LIMIT=50;
function pushUndo(){
  _undoStack.push({entries:JSON.parse(JSON.stringify(entries)),idx:idx});
  if(_undoStack.length>_UNDO_LIMIT)_undoStack.shift();
  var btn=$('btn-undo');
  if(btn){btn.disabled=false;btn.style.opacity='1';btn.style.color='#00ff88';}
}
function doUndo(){
  if(!_undoStack.length)return;
  var snap=_undoStack.pop();
  entries=snap.entries;idx=snap.idx;
  buildDD();render();updateCurRegion();
  setStatus('Undone');
  if(!_undoStack.length){
    var btn=$('btn-undo');
    if(btn){btn.disabled=true;btn.style.opacity='0.35';btn.style.color='#555';}
  }
}
