// ── Transcribblr Undo — stack, push/pop, keyboard shortcut ───────────────────

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

$('btn-undo').addEventListener('click',doUndo);
document.addEventListener('keydown',function(ev){
  if((ev.ctrlKey||ev.metaKey)&&ev.key==='z'){ev.preventDefault();doUndo();}
});
