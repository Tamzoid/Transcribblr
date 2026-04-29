// ── Transcribblr App — boot, keyboard shortcuts, mobile handling ───────────────

// ── In-app log viewer (mobile-friendly: no devtools needed) ───────────────────
var _jsLogs=[]; // {t, level, msg}
var _logsOpen=false, _logsTimer=null, _logsHasErr=false;

function _pushJsLog(level,args){
  var msg=Array.prototype.map.call(args,function(a){
    if(a instanceof Error)return a.stack||a.message;
    if(typeof a==='object')try{return JSON.stringify(a);}catch(e){return String(a);}
    return String(a);
  }).join(' ');
  _jsLogs.push({t:new Date().toTimeString().slice(0,8),level:level,msg:msg});
  if(_jsLogs.length>500)_jsLogs.shift();
  if(level==='error'||level==='warn'){
    _logsHasErr=true;
    var b=document.getElementById('s-logs');if(b)b.classList.add('has-error');
  }
  if(_logsOpen)_renderLogs();
}
['log','info','warn','error'].forEach(function(lvl){
  var orig=console[lvl].bind(console);
  console[lvl]=function(){_pushJsLog(lvl==='log'?'info':lvl,arguments);orig.apply(console,arguments);};
});
window.addEventListener('error',function(ev){
  _pushJsLog('error',[ev.message+' @ '+(ev.filename||'?')+':'+ev.lineno]);
});
window.addEventListener('unhandledrejection',function(ev){
  _pushJsLog('error',['unhandled promise rejection:',ev.reason]);
});

function _renderLogs(){
  var body=document.getElementById('logs-body');if(!body)return;
  apiFetchLogs().then(function(srv){
    // srv is array of {time, level, module, message}
    var lines=[];
    (srv||[]).slice(-200).forEach(function(r){
      var lv=(r.level||'').toUpperCase();
      var cls=lv==='ERROR'?'lg-err':lv==='WARNING'?'lg-warn':lv==='DEBUG'?'lg-debug':'lg-info';
      lines.push('<span class="'+cls+'">'+r.time+' ['+lv+'] '+r.module+': '+_esc(r.message)+'</span>');
    });
    if(_jsLogs.length){
      lines.push('<span class="lg-info">─── browser ───</span>');
      _jsLogs.slice(-100).forEach(function(l){
        var cls=l.level==='error'?'lg-err':l.level==='warn'?'lg-warn':'lg-js';
        lines.push('<span class="'+cls+'">'+l.t+' ['+l.level.toUpperCase()+'] '+_esc(l.msg)+'</span>');
      });
    }
    body.innerHTML=lines.join('\n')||'(no logs)';
    body.scrollTop=body.scrollHeight;
  }).catch(function(e){
    body.textContent='Error fetching server logs: '+e;
  });
}
function _esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function toggleLogs(){
  _logsOpen=!_logsOpen;
  var ov=document.getElementById('logs-overlay');
  if(ov)ov.style.display=_logsOpen?'flex':'none';
  if(_logsOpen){
    _renderLogs();
    _logsTimer=setInterval(_renderLogs,2000);
    _logsHasErr=false;
    var b=document.getElementById('s-logs');if(b)b.classList.remove('has-error');
  } else {
    clearInterval(_logsTimer);_logsTimer=null;
  }
}

var _slBtn=document.getElementById('s-logs');
if(_slBtn)_slBtn.addEventListener('click',toggleLogs);
var _lcBtn=document.getElementById('logs-close');
if(_lcBtn)_lcBtn.addEventListener('click',toggleLogs);
var _lclrBtn=document.getElementById('logs-clear');
if(_lclrBtn)_lclrBtn.addEventListener('click',function(){_jsLogs=[];_renderLogs();});

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
    entries=Array.isArray(results[0])?results[0]:[];
    var cfg=results[1];
    var sources=results[2];
    console.log('[boot] /data →',Array.isArray(results[0])?results[0].length+' records':typeof results[0],'| selected:',cfg.selected);
    var hf=$('hdr-f');if(hf)hf.textContent=(cfg.selected||'No file selected')+' ▾';
    window._activeFile=cfg.selected||null;
    if(!cfg.selected){
      setStatus('No file selected — click filename to pick one', true);
      $('wsl').style.display='none';
      return;
    }
    if(!entries.length)setStatus('Loaded 0 records — project JSON may be empty or missing subtitles',true);
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
      if(ws){
        ws.load('/audio?src='+src+'&file='+encodeURIComponent(cfg.selected));
      } else {
        $('wsl').textContent='⚠ Audio player unavailable (CDN failed)';
      }
    } else {
      $('wsl').textContent='⚠ No audio found';
    }
  }).catch(function(e){
    setStatus('Boot failed — see error', true);
    var wsl=$('wsl');if(wsl)wsl.style.display='none';
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
    if(page==='create'){
      loadInputFiles();
      setStatus('');
    } else if(page==='projects'){
      if(!window._activeFile)setStatus('No file selected — click filename to pick one',true);
    }
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
