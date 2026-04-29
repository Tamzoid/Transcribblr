// ── Top tab switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.toptbtn').forEach(function(btn){
  btn.addEventListener('click', function(){
    var panel = this.getAttribute('data-panel');
    document.querySelectorAll('.toptbtn').forEach(function(b){ b.classList.remove('on'); });
    this.classList.add('on');
    $('panel-edit').style.display   = panel === 'edit'   ? '' : 'none';
    $('panel-export').style.display = panel === 'export' ? '' : 'none';
    if(panel === 'export'){ try{ ws.pause(); }catch(e){} refreshExportPreview(); }
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

function doExport(format){
  if(!entries.length){ $('export-status').textContent='⚠ No records loaded'; return; }
  var vtt=buildVtt(entries,format);
  var name=(window._activeFile||'export').replace(/\.srt$/i,'')+'.'+format+'.vtt';
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([vtt],{type:'text/vtt'}));
  a.download=name; a.click();
  $('export-status').textContent='✅ Downloaded '+name;
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
  fetch('/export-project?file='+encodeURIComponent(file))
    .then(function(r){
      if(!r.ok) throw new Error('Server error '+r.status);
      return r.blob();
    })
    .then(function(blob){
      var stem = file.replace(/\.srt$/i,'');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = stem+'.zip';
      a.click();
      if(st)st.textContent='✅ Downloaded '+stem+'.zip';
    })
    .catch(function(e){
      if(st)st.textContent='⚠ Export failed: '+e;
    });
});
