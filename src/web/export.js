// ── Top tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.toptbtn').forEach(function(btn){
  btn.addEventListener('click', function(){
    var panel = this.getAttribute('data-panel');
    document.querySelectorAll('.toptbtn').forEach(function(b){ b.classList.remove('on'); });
    this.classList.add('on');
    $('panel-edit').style.display   = panel === 'edit'   ? '' : 'none';
    $('panel-export').style.display = panel === 'export' ? '' : 'none';
    var pi=$('panel-import'); if(pi) pi.style.display = panel === 'import' ? '' : 'none';
    if(panel === 'export'){ try{ ws.pause(); }catch(e){} refreshExportPreview(); }
    if(panel === 'import'){ try{ ws.pause(); }catch(e){} }
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
  var lines=text.trim().split('\n'), jp=null, ro=null, en=null;
  lines.forEach(function(l){
    l=l.trim();
    if(l[0]==='['&&l[l.length-1]===']') jp=l.slice(1,-1);
    else if(l[0]==='('&&l[l.length-1]===')') ro=l.slice(1,-1);
    else if(l) en=l;
  });
  switch(format){
    case 'japanese': return jp||en||text.trim();
    case 'romaji':   return ro||jp||text.trim();
    case 'english':  return en||text.trim();
    case 'all':      return text.trim();
    default:         return en||text.trim();
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

$('exp-project').addEventListener('click', function(){
  var file = window._activeFile;
  var st = $('exp-project-status');
  if(!file){ if(st)st.textContent='⚠ No project loaded'; return; }
  if(st)st.textContent='Preparing ZIP…';
  console.log('[export-project] requesting zip for',file);
  fetch('/export-project?file='+encodeURIComponent(file))
    .then(function(r){
      console.log('[export-project] response',r.status);
      if(!r.ok) throw new Error('Server error '+r.status);
      return r.blob();
    })
    .then(function(blob){
      var stem = file.replace(/\.srt$/i,'');
      _downloadBlob(blob, stem+'.zip', st);
    })
    .catch(function(e){
      console.error('[export-project] failed',e);
      if(st)st.textContent='⚠ Export failed: '+e;
    });
});
