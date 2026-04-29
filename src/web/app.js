// ── Transcribblr App — boot, keyboard shortcuts, mobile handling ───────────────

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown',function(ev){
  if(ev.target.tagName==='TEXTAREA'||ev.target.tagName==='INPUT')return;
  if(ev.key==='ArrowLeft') go(idx-1);
  if(ev.key==='ArrowRight')go(idx+1);
  if(ev.key===' '){ev.preventDefault();if(ws)ws.playPause();}
});




// ── Mobile keyboard handling ──────────────────────────────────────────────────
var _etEl=$('et');
if(_etEl){
  _etEl.addEventListener('focus',function(){
    document.body.style.paddingBottom='50vh';
    setTimeout(function(){_etEl.scrollIntoView({behavior:'smooth',block:'center'});},300);
  });
  _etEl.addEventListener('blur',function(){
    document.body.style.paddingBottom='';
  });
}




// ── Boot ────────────────────────────────────────────────────────────────────
// Load entries + config from server then initialise
function showBootError(msg){
  var body=document.body;
  var div=document.createElement('div');
  div.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'
    +'background:#1a0a0a;border:1px solid #ff4444;border-radius:10px;padding:24px 32px;'
    +'color:#ff8888;font-family:monospace;font-size:13px;text-align:center;z-index:99999';
  div.innerHTML='<div style="font-size:20px;margin-bottom:12px">⚠ Boot Error</div>'
    +'<div>'+msg+'</div>'
    +'<div style="margin-top:16px;font-size:11px;color:#555">Check server logs at /logs</div>';
  body.appendChild(div);
}

function boot(){
  setStatus('Loading…');
  Promise.all([
    apiFetchData(),
    apiFetchConfig(),
    apiFetchSources()
  ]).then(function(results){
    entries=results[0];
    var cfg=results[1];
    var sources=results[2];
    var hf=$('hdr-f');if(hf)hf.textContent=(cfg.selected||'No file selected')+' ▾';
    window._activeFile=cfg.selected||null;
    if(!cfg.selected){
      setStatus('No file selected — click filename to pick one', true);
      $('wsl').style.display='none';
      return;
    }
    buildDD();render();
    // Load audio now that we know a file is selected
    var sel=$('audio-src');
    Array.from(sel?sel.options:[]).forEach(function(o){
      if(!sources[o.value]){o.disabled=true;o.text+=' (unavailable)';}
    });
    var src=sources['vocals']?'vocals':sources['full']?'full':null;
    if(src){
      _audioSrc=src;
      if(sel)sel.value=src;
      ws.load('/audio?src='+src+'&file='+encodeURIComponent(cfg.selected));
    } else {
      $('wsl').textContent='⚠ No audio found';
    }
  }).catch(function(e){
    setStatus('Boot failed — see error', true);
    showBootError(String(e));
  });
}

// ── App nav (Create | Projects) ───────────────────────────────────────────────
document.querySelectorAll('.appnav-btn').forEach(function(btn){
  btn.addEventListener('click',function(){
    var page=btn.getAttribute('data-page');
    document.querySelectorAll('.appnav-btn').forEach(function(b){b.classList.remove('on');});
    btn.classList.add('on');
    var pc=$('panel-create'),pp=$('panel-projects');
    if(pc)pc.style.display=page==='create'?'':'none';
    if(pp)pp.style.display=page==='projects'?'':'none';
    if(page==='create')loadInputFiles();
  });
});

// ── Edit / Export top-tabs ────────────────────────────────────────────────────
document.querySelectorAll('.toptbtn').forEach(function(btn){
  btn.addEventListener('click',function(){
    var panel=btn.getAttribute('data-panel');
    document.querySelectorAll('.toptbtn').forEach(function(b){b.classList.remove('on');});
    btn.classList.add('on');
    var pe=$('panel-edit'),px=$('panel-export');
    if(pe)pe.style.display=panel==='edit'?'':'none';
    if(px)px.style.display=panel==='export'?'':'none';
  });
});

var _fsBtn=$('btn-fs'),_fsMode=false;
if(_fsBtn)_fsBtn.addEventListener('click',function(){
  _fsMode=!_fsMode;
  window.parent.postMessage({type:'srtfs',action:_fsMode?'enter':'exit'},'*');
  _fsBtn.textContent=_fsMode?'⨯':'⛶';
  _fsBtn.title=_fsMode?'Exit fullscreen':'Fullscreen';
});

window.openFilePicker = openFilePicker;
boot();
