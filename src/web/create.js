// ── Transcribblr Create Page — file upload + input file list ─────────────────

function loadInputFiles(){
  apiListInput()
    .then(function(d){renderInputFiles(d.files||[]);})
    .catch(function(){renderInputFiles([]);});
}

function renderInputFiles(files){
  var el=$('input-file-list');if(!el)return;
  if(!files.length){
    el.innerHTML='<div class="ib">No files in input folder</div>';return;
  }
  el.innerHTML='';
  files.forEach(function(f){
    var row=document.createElement('div');row.className='inp-file';
    var name=document.createElement('span');name.className='inp-file-name';name.textContent=f.name;
    var size=document.createElement('span');size.className='inp-file-size';size.textContent=_fmtSize(f.size);
    row.appendChild(name);row.appendChild(size);el.appendChild(row);
  });
}

function _fmtSize(b){
  if(b>1e9)return(b/1e9).toFixed(1)+'GB';
  if(b>1e6)return(b/1e6).toFixed(1)+'MB';
  if(b>1e3)return(b/1e3).toFixed(1)+'KB';
  return b+'B';
}

function _doUpload(file){
  var prog=$('upload-prog'),bar=$('upload-bar'),status=$('upload-status');
  if(prog)prog.style.display='';
  if(bar)bar.style.width='0%';
  if(status)status.textContent='Uploading '+file.name+'…';
  apiUpload(file, function(loaded, total){
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

// Drop zone
var _dz=$('drop-zone');
if(_dz){
  _dz.addEventListener('dragover',function(e){e.preventDefault();_dz.classList.add('drag-over');});
  _dz.addEventListener('dragleave',function(){_dz.classList.remove('drag-over');});
  _dz.addEventListener('drop',function(e){
    e.preventDefault();_dz.classList.remove('drag-over');
    var f=e.dataTransfer&&e.dataTransfer.files[0];
    if(f)_doUpload(f);
  });
}

var _vi=$('video-input');
if(_vi)_vi.addEventListener('change',function(){if(_vi.files[0])_doUpload(_vi.files[0]);});
