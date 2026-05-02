// ── Top tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.toptbtn').forEach(function(btn){
  btn.addEventListener('click', function(){
    var panel = this.getAttribute('data-panel');
    document.querySelectorAll('.toptbtn').forEach(function(b){ b.classList.remove('on'); });
    this.classList.add('on');
    $('panel-edit').style.display   = panel === 'edit'         ? '' : 'none';
    var pei=$('panel-exportimport'); if(pei) pei.style.display = panel === 'exportimport' ? '' : 'none';
    var pc=$('panel-context'); if(pc) pc.style.display = panel === 'context' ? '' : 'none';
    var ptr=$('panel-translations'); if(ptr) ptr.style.display = panel === 'translations' ? '' : 'none';
    var pw=$('player-wrap'); if(pw) pw.style.display = panel==='edit' ? '' : 'none';
    if(panel === 'exportimport'){
      try{ ws.pause(); }catch(e){}
      // Refresh whichever inner sub-tab is currently active.
      var active = document.querySelector('.ei-tbtn.on');
      if(active && active.getAttribute('data-eitab') === 'export') refreshExportPreview();
    }
    if(panel === 'translations'){
      try{ ws.pause(); }catch(e){}
      if(typeof window._trAdvOnShow === 'function') window._trAdvOnShow();
    }
    if(panel === 'context'){ try{ ws.pause(); }catch(e){} if(typeof loadContextIntoPanel==='function')loadContextIntoPanel(); }
    if(panel === 'edit' && typeof loadAnnotationsIntoPanel==='function') loadAnnotationsIntoPanel();
    if(typeof _annUpdateRegions === 'function') _annUpdateRegions();
  });
});

// ── Export/Import inner sub-tab switching ────────────────────────────────────
document.querySelectorAll('.ei-tbtn').forEach(function(btn){
  btn.addEventListener('click', function(){
    var which = this.getAttribute('data-eitab');
    document.querySelectorAll('.ei-tbtn').forEach(function(b){ b.classList.remove('on'); });
    this.classList.add('on');
    var pe=$('ei-pane-export'), pi=$('ei-pane-import');
    if(pe) pe.style.display = which === 'export' ? '' : 'none';
    if(pi) pi.style.display = which === 'import' ? '' : 'none';
    if(which === 'export') refreshExportPreview();
  });
});

// ── VTT export ────────────────────────────────────────────────────────────────
function toVttTime(sec){
  sec = Math.max(0, sec);
  var h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60),
      s=Math.floor(sec%60),   ms=Math.round((sec%1)*1000);
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+
         String(s).padStart(2,'0')+'.'+String(ms).padStart(3,'0');
}

function extractExportLane(text, format){
  // text is now {ja, ro, en} (legacy strings handled via _laneObj).
  var l = (typeof _laneObj === 'function') ? _laneObj(text) : (text||{});
  var ja=l.ja||'', ro=l.ro||'', en=l.en||'';
  switch(format){
    case 'japanese': return ja||en||ro;
    case 'romaji':   return ro||ja||en;
    case 'english':  return en||ja||ro;
    case 'all':
      var parts=[];
      if(ja)parts.push('['+ja+']');
      if(ro)parts.push('('+ro+')');
      if(en)parts.push(en);
      return parts.join('\n');
    default:         return en||ja||ro;
  }
}

function buildVtt(ents, format){
  var out=['WEBVTT',''];
  ents.forEach(function(e,i){
    var cue=extractExportLane(e.text||'',format);
    if(!cue) return;
    out.push(String(i+1), toVttTime(e.start)+' --> '+toVttTime(e.end), cue, '');
  });
  return out.join('\n');
}

// Trigger a file download from a Blob. Works on desktop, mobile, and inside
// the Colab iframe — falls back to a visible "Tap to download" link if the
// programmatic click is silently blocked.
function _downloadBlob(blob, filename, statusEl){
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');
  a.href=url; a.download=filename;
  a.style.display='none';
  document.body.appendChild(a);
  try{ a.click(); }catch(e){ console.warn('download a.click() threw',e); }
  setTimeout(function(){ try{document.body.removeChild(a);}catch(e){} },2000);
  // Always also show a visible link so the user can tap it if the auto-click
  // didn't trigger a download (mobile Safari / iframe sandbox quirks).
  if(statusEl){
    var sizeKb=Math.max(1,Math.round(blob.size/1024));
    statusEl.innerHTML='';
    var hint=document.createElement('span');
    hint.textContent='Ready ('+sizeKb+' KB) — ';
    var link=document.createElement('a');
    link.href=url; link.download=filename;
    link.target='_blank'; link.rel='noopener';
    link.textContent='tap to download '+filename;
    link.style.color='#00ff88'; link.style.textDecoration='underline';
    statusEl.appendChild(hint); statusEl.appendChild(link);
  }
  console.log('[download]',filename,blob.size,'bytes');
}

function doExport(format){
  if(!entries.length){ $('export-status').textContent='⚠ No records loaded'; return; }
  var vtt=buildVtt(entries,format);
  var name=(window._activeFile||'export').replace(/\.srt$/i,'')+'.'+format+'.vtt';
  _downloadBlob(new Blob([vtt],{type:'text/vtt'}), name, $('export-status'));
}

function refreshExportPreview(){
  var s=$('export-status'), p=$('export-preview'), pt=$('export-preview-text');
  if(!entries.length){ if(p)p.style.display='none'; if(s)s.textContent='No file loaded'; return; }
  if(pt)pt.textContent=buildVtt(entries.slice(0,5),'english');
  if(p)p.style.display='';
  if(s)s.textContent=entries.length+' records — click a format to download';
}

$('exp-english').addEventListener('click', function(){ doExport('english'); });
$('exp-japanese').addEventListener('click', function(){ doExport('japanese'); });
$('exp-romaji').addEventListener('click',   function(){ doExport('romaji'); });
$('exp-all').addEventListener('click',      function(){ doExport('all'); });

function _fmtKb(n){
  if(n>1024*1024)return(n/1024/1024).toFixed(1)+' MB';
  if(n>1024)return Math.round(n/1024)+' KB';
  return n+' B';
}

$('exp-project').addEventListener('click', function(){
  var file = window._activeFile;
  var st = $('exp-project-status');
  if(!file){ if(st)st.textContent='⚠ No project loaded'; return; }

  var stem = file.replace(/\.srt$/i,'');
  var t0 = Date.now();
  console.log('[export-project] requesting zip for',file);

  // XHR gives us a real download-progress event; fetch().then(r.blob()) doesn't.
  var xhr = new XMLHttpRequest();
  xhr.responseType = 'blob';
  xhr.open('GET', '/export-project?file='+encodeURIComponent(file));

  // Animated dots while we wait for the server to start streaming
  var dots = 0, tickTimer = null;
  function startTicker(label){
    stopTicker();
    tickTimer = setInterval(function(){
      dots = (dots + 1) % 4;
      if(st)st.textContent = label + ' ' + '.'.repeat(dots) + ' '.repeat(3-dots);
    }, 350);
  }
  function stopTicker(){ if(tickTimer){clearInterval(tickTimer);tickTimer=null;} }

  startTicker('Preparing ZIP on server');

  xhr.onreadystatechange = function(){
    // First byte from server arrived — switch from "preparing" to "downloading"
    if(xhr.readyState === xhr.HEADERS_RECEIVED){
      stopTicker();
      var total = parseInt(xhr.getResponseHeader('Content-Length')||'0',10);
      console.log('[export-project] response headers, content-length=',total);
      if(!total) startTicker('Downloading');
    }
  };
  xhr.onprogress = function(ev){
    if(!st)return;
    if(ev.lengthComputable){
      var pct = Math.round(ev.loaded/ev.total*100);
      st.textContent = 'Downloading ZIP… '+pct+'%  ('+_fmtKb(ev.loaded)+' / '+_fmtKb(ev.total)+')';
    } else {
      st.textContent = 'Downloading ZIP… '+_fmtKb(ev.loaded);
    }
  };
  xhr.onload = function(){
    stopTicker();
    if(xhr.status !== 200){
      console.error('[export-project] server returned',xhr.status);
      if(st)st.textContent='⚠ Export failed: server returned '+xhr.status;
      return;
    }
    var elapsed = ((Date.now()-t0)/1000).toFixed(1);
    console.log('[export-project] done in',elapsed,'s, size=',xhr.response.size);
    _downloadBlob(xhr.response, stem+'.zip', st);
  };
  xhr.onerror = function(){
    stopTicker();
    console.error('[export-project] network error');
    if(st)st.textContent='⚠ Network error';
  };
  xhr.onabort = function(){
    stopTicker();
    if(st)st.textContent='⚠ Aborted';
  };
  xhr.send();
});
