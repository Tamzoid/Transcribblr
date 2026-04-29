// ── Transcribblr Create Page — file upload, input list, processing ────────────

function loadInputFiles(){
  apiListInput()
    .then(function(d){renderInputFiles(d.files||[]);})
    .catch(function(){renderInputFiles([]);});
}

function renderInputFiles(files){
  var el=$('input-file-list');if(!el)return;
  if(!files.length){
    el.innerHTML='<div class="ib">No files in input folder</div>';
    _updateProcessBtn();return;
  }
  el.innerHTML='';
  files.forEach(function(f){
    var row=document.createElement('label');
    row.className='inp-file';
    var check=document.createElement('span');check.className='inp-file-check';
    var cb=document.createElement('input');cb.type='checkbox';cb.className='file-cb';cb.value=f.name;
    cb.addEventListener('change',function(){
      row.classList.toggle('selected',cb.checked);
      _updateProcessBtn();
    });
    var name=document.createElement('span');name.className='inp-file-name';name.textContent=f.name;
    check.appendChild(cb);check.appendChild(name);
    var size=document.createElement('span');size.className='inp-file-size';size.textContent=_fmtSize(f.size);
    row.appendChild(check);row.appendChild(size);
    el.appendChild(row);
  });
  _updateProcessBtn();
}

function _updateProcessBtn(){
  var btn=$('btn-process');if(!btn)return;
  var any=document.querySelectorAll('.file-cb:checked').length>0;
  btn.disabled=!any;
}

function _fmtSize(b){
  if(b>1e9)return(b/1e9).toFixed(1)+'GB';
  if(b>1e6)return(b/1e6).toFixed(1)+'MB';
  if(b>1e3)return(b/1e3).toFixed(1)+'KB';
  return b+'B';
}

// ── Upload ────────────────────────────────────────────────────────────────────

function _doUpload(file){
  var prog=$('upload-prog'),bar=$('upload-bar'),status=$('upload-status');
  if(prog)prog.style.display='';
  if(bar)bar.style.width='0%';
  if(status)status.textContent='Uploading '+file.name+'…';
  apiUpload(file,function(loaded,total){
    var pct=Math.round(loaded/total*100);
    if(bar)bar.style.width=pct+'%';
    if(status)status.textContent=pct+'%  '+_fmtSize(loaded)+' / '+_fmtSize(total);
  })
    .then(function(d){
      if(bar)bar.style.width='100%';
      if(status)status.textContent=d.ok?'✓ '+d.filename:'⚠ '+(d.error||'Upload failed');
      if(d.ok)loadInputFiles();
    })
    .catch(function(e){if(status)status.textContent='⚠ Upload failed: '+e;});
}

var _dz=$('drop-zone');
if(_dz){
  _dz.addEventListener('dragover',function(e){e.preventDefault();_dz.classList.add('drag-over');});
  _dz.addEventListener('dragleave',function(){_dz.classList.remove('drag-over');});
  _dz.addEventListener('drop',function(e){
    e.preventDefault();_dz.classList.remove('drag-over');
    var f=e.dataTransfer&&e.dataTransfer.files[0];if(f)_doUpload(f);
  });
}
var _vi=$('video-input');
if(_vi)_vi.addEventListener('change',function(){if(_vi.files[0])_doUpload(_vi.files[0]);});

// ── Process ───────────────────────────────────────────────────────────────────

function _logLine(text, cls, id){
  var lines=$('process-log-lines');if(!lines)return null;
  var d=document.createElement('div');
  d.className='proc-line'+(cls?' '+cls:'');
  d.textContent=text;
  if(id)d.id=id;
  lines.appendChild(d);
  lines.scrollTop=lines.scrollHeight;
  return d;
}

function processSelected(){
  var checked=Array.from(document.querySelectorAll('.file-cb:checked')).map(function(cb){return cb.value;});
  if(!checked.length)return;

  var log=$('process-log'),lines=$('process-log-lines'),btn=$('btn-process');
  if(log)log.style.display='';
  if(lines)lines.innerHTML='';
  if(btn)btn.disabled=true;

  _logLine('Processing '+checked.length+' file'+(checked.length>1?'s':'')+'…','proc-start');

  var _lastStep={};

  apiProcess(checked,{demucs:true,vad:true},function(ev){
    if(ev.type==='complete'){
      _logLine('Done.','proc-ok');
      if(btn)btn.disabled=false;
      return;
    }
    var safe=ev.file.replace(/\W/g,'_');
    if(ev.type==='start'){
      _logLine('⏳ '+ev.file,'proc-start');
      _lastStep[safe]=null;
    } else if(ev.type==='step'){
      var el=_logLine('  '+ev.msg);
      el._baseMsg=ev.msg;
      _lastStep[safe]=el;
    } else if(ev.type==='progress'){
      var el=_lastStep[safe];
      if(el)el.textContent='  '+(el._baseMsg||'Working')+'… '+ev.pct+'%';
    } else if(ev.type==='done'){
      var msg=ev.ok?'✓ '+ev.file:'⚠ '+ev.file+': '+(ev.error||'failed');
      _logLine(msg,ev.ok?'proc-ok':'proc-err');
    }
  }).catch(function(e){
    _logLine('⚠ '+e,'proc-err');
    if(btn)btn.disabled=false;
  });
}

var _pb=$('btn-process');
if(_pb)_pb.addEventListener('click',processSelected);

// ── Import Project ────────────────────────────────────────────────────────────

function _doImport(file){
  var prog=$('import-prog'),bar=$('import-bar'),status=$('import-status');
  if(prog)prog.style.display='';
  if(bar)bar.style.width='0%';
  if(status)status.textContent='Uploading '+file.name+'…';
  apiImportProject(file,function(loaded,total){
    var pct=Math.round(loaded/total*100);
    if(bar)bar.style.width=pct+'%';
    if(status)status.textContent=pct+'%  '+_fmtSize(loaded)+' / '+_fmtSize(total);
  }).then(function(d){
    if(bar)bar.style.width='100%';
    if(d.ok){
      if(status)status.textContent='✓ Imported '+d.stem+' ('+d.files.length+' file'+(d.files.length===1?'':'s')+')';
    } else {
      if(status)status.textContent='⚠ '+(d.error||'Import failed');
    }
  }).catch(function(e){if(status)status.textContent='⚠ Import failed: '+e;});
}

var _idz=$('import-drop-zone');
if(_idz){
  _idz.addEventListener('dragover',function(e){e.preventDefault();_idz.classList.add('drag-over');});
  _idz.addEventListener('dragleave',function(){_idz.classList.remove('drag-over');});
  _idz.addEventListener('drop',function(e){
    e.preventDefault();_idz.classList.remove('drag-over');
    var f=e.dataTransfer&&e.dataTransfer.files[0];if(f)_doImport(f);
  });
}
var _ii=$('import-input');
if(_ii)_ii.addEventListener('change',function(){if(_ii.files[0])_doImport(_ii.files[0]);});
