// ── Transcribblr File Picker ────────────────────────────────────────────────────

// ── File picker ───────────────────────────────────────────────────────────────
var _allFiles=[];
function openFilePicker(){
  var m=$('fp-modal');if(!m)return;
  m.style.display='flex';
  $('fp-search').value='';
  $('fp-status').textContent='Loading…';
  apiFetchFiles().then(function(d){
    _allFiles=d.files||[];
    renderFileList(_allFiles, d.selected);
    $('fp-status').textContent=_allFiles.length+' files';
  }).catch(function(){$('fp-status').textContent='Error loading files';});
}
function closeFilePicker(){
  var m=$('fp-modal');if(m)m.style.display='none';
}
function filterFiles(q){
  var filtered=q?_allFiles.filter(f=>f.toLowerCase().includes(q.toLowerCase())):_allFiles;
  renderFileList(filtered, null);
}
function renderFileList(files, current){
  var list=$('fp-list');if(!list)return;
  list.innerHTML='';
  files.forEach(function(f){
    var btn=document.createElement('button');
    btn.textContent=f;
    btn.className='fp-item'+(f===current?' fp-item-active':'');
    btn.onclick=function(){selectFile(f);};
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
          entries=fresh;idx=0;
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

