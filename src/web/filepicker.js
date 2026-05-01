// ── Transcribblr File Picker ────────────────────────────────────────────────────

// ── File picker ───────────────────────────────────────────────────────────────
var _allFiles=[];
var _STATUS_COLOR={
  ready:'#00ff88', vad_done:'#00d9ff', vocals_extracted:'#00d9ff',
  converted:'#ffcc00', pending:'#555', unknown:'#333'
};
function openFilePicker(){
  var m=$('fp-modal');if(!m)return;
  m.style.display='flex';
  $('fp-search').value='';
  $('fp-status').textContent='Loading…';
  apiFetchFiles().then(function(d){
    _allFiles=d.files||[];
    renderFileList(_allFiles, d.selected);
    $('fp-status').textContent=_allFiles.length+' project'+(_allFiles.length===1?'':'s');
  }).catch(function(){$('fp-status').textContent='Error loading projects';});
}
function closeFilePicker(){
  var m=$('fp-modal');if(m)m.style.display='none';
}
function filterFiles(q){
  var filtered=q?_allFiles.filter(function(f){return f.name.toLowerCase().includes(q.toLowerCase());}):_allFiles;
  renderFileList(filtered, null);
}
function renderFileList(files, current){
  var list=$('fp-list');if(!list)return;
  list.innerHTML='';
  files.forEach(function(f){
    var btn=document.createElement('button');
    btn.className='fp-item'+(f.srt===current?' fp-item-active':'');
    btn.style.display='flex';btn.style.alignItems='center';btn.style.gap='8px';
    var dot=document.createElement('span');
    dot.style.cssText='width:7px;height:7px;border-radius:50%;flex-shrink:0;background:'+(_STATUS_COLOR[f.status]||'#333');
    var label=document.createElement('span');label.textContent=f.name;
    btn.appendChild(dot);btn.appendChild(label);
    btn.onclick=function(){selectFile(f.srt);};
    list.appendChild(btn);
  });
}
function selectFile(name){
  // Stop any playback and loop first
  if(looping)stopLoop();
  try{ws.pause();}catch(e){}

  closeFilePicker();
  setStatus('Switching to '+name+'…', true);
  $('wsl').style.display='block';
  $('wf').style.display='none';
  $('wsl').innerHTML='<span class="spin"></span>LOADING…';

  // Sequential: switch file → fetch records → fetch audio sources → load audio
  apiSelectFile(name)
    .then(function(d){
      if(!d.ok){setStatus('Error: '+d.error, true);return;}
      var hf=$('hdr-f');if(hf)hf.textContent=d.selected+' ▾';
      window._activeFile=d.selected;
      setStatus('Loading records…');
      return apiFetchData()
        .then(function(fresh){
          console.log('[selectFile] /data →',Array.isArray(fresh)?fresh.length+' records':typeof fresh,'for',name);
          entries=Array.isArray(fresh)?fresh:[];idx=0;
          if(!entries.length){
            setStatus('No records loaded for '+name+' — check /logs',true);
          }
          buildDD();render();updateCurRegion();
          setStatus('Loading audio…');
          return apiFetchSources();
        })
        .then(function(sources){
          var sel=$('audio-src');
          if(sel){
            Array.from(sel.options).forEach(function(o){
              o.disabled=!sources[o.value];
              o.text=o.text.replace(' (unavailable)','');
              if(!sources[o.value])o.text+=' (unavailable)';
            });
          }
          if(typeof refreshVideoForActiveFile==='function')refreshVideoForActiveFile(!!sources['video']);
          // Pre-load the project's context + annotations so the Context tab
          // and the Records → Scenes/Speakers sub-tabs are populated before
          // the user navigates to them.
          if(typeof loadContextIntoPanel==='function')loadContextIntoPanel();
          if(typeof loadAnnotationsIntoPanel==='function')loadAnnotationsIntoPanel();
          var newSrc=sources['vocals']?'vocals':sources['full']?'full':null;
          if(!newSrc){
            setStatus('No audio found for '+name, true);
            $('wsl').textContent='⚠ No audio found';
            return;
          }
          _audioSrc=newSrc;
          if(sel)sel.value=newSrc;
          _switchSeekTo=0;
          ws.load('/audio?src='+newSrc+'&file='+encodeURIComponent(name));
          // Status updated by ws.on('ready')
        });
    })
    .catch(function(e){setStatus('Switch failed: '+e, true);});
}
// Close on backdrop click
document.getElementById('fp-modal').addEventListener('click',function(ev){
  if(ev.target===this)closeFilePicker();
});


window.openFilePicker  = openFilePicker;
window.closeFilePicker = closeFilePicker;
window.filterFiles     = filterFiles;

