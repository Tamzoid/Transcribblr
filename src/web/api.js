// ── Transcribblr API client ───────────────────────────────────────────────────
// All fetch() calls go through here. Each function returns a Promise.

function apiGet(path) {
  return fetch(path, {
    headers: {'Cache-Control': 'no-cache', 'Pragma': 'no-cache'}
  }).then(function(r) {
    if (!r.ok) throw new Error(r.status + ' ' + path);
    return r.json();
  });
}

function apiPost(path, data) {
  return fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data),
  }).then(function(r) { return r.json(); });
}

// Load SRT entries for current file
function apiFetchData()       { return apiGet('/data'); }
function apiFetchConfig()     { return apiGet('/config'); }
function apiFetchFiles()      { return apiGet('/files'); }
function apiFetchSources()    { return apiGet('/audiosources'); }
function apiFetchLogs()       { return apiGet('/logs'); }

function apiSelectFile(name)  { return apiPost('/selectfile', {file: name}); }
function apiSave(entries)     { return apiPost('/save', entries); }
function apiRomaji(text)      { return apiPost('/romaji', {text: text}); }

function apiListInput() { return apiGet('/input-files'); }
function apiProcess(files, options, onEvent){
  return fetch('/process',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({files:files,options:options})
  }).then(function(r){return r.json();}).then(function(d){
    if(!d.job_id)throw new Error('No job_id returned');
    return new Promise(function(resolve,reject){
      var since=0;
      function poll(){
        fetch('/process-status?job='+d.job_id+'&since='+since)
          .then(function(r){return r.json();})
          .then(function(s){
            (s.events||[]).forEach(onEvent);
            since=s.next||since;
            if(s.done){resolve();}
            else{setTimeout(poll,1000);}
          })
          .catch(reject);
      }
      poll();
    });
  });
}
function apiImportSubtitles(file, onProgress){
  return new Promise(function(resolve, reject){
    var xhr=new XMLHttpRequest();
    var form=new FormData();
    form.append('file', file);
    if(onProgress){
      xhr.upload.addEventListener('progress', function(e){
        if(e.lengthComputable) onProgress(e.loaded, e.total);
      });
    }
    xhr.onload=function(){
      try{resolve(JSON.parse(xhr.responseText));}catch(e){reject(e);}
    };
    xhr.onerror=function(){reject(new Error('Network error'));};
    xhr.open('POST','/import-subtitles');
    xhr.send(form);
  });
}

function apiImportProject(file, onProgress){
  return new Promise(function(resolve, reject){
    var xhr=new XMLHttpRequest();
    var form=new FormData();
    form.append('file', file);
    if(onProgress){
      xhr.upload.addEventListener('progress', function(e){
        if(e.lengthComputable) onProgress(e.loaded, e.total);
      });
    }
    xhr.onload=function(){
      try{resolve(JSON.parse(xhr.responseText));}catch(e){reject(e);}
    };
    xhr.onerror=function(){reject(new Error('Network error'));};
    xhr.open('POST','/import-project');
    xhr.send(form);
  });
}

function apiUpload(file, onProgress){
  return new Promise(function(resolve, reject){
    var xhr=new XMLHttpRequest();
    var form=new FormData();
    form.append('file', file);
    if(onProgress){
      xhr.upload.addEventListener('progress', function(e){
        if(e.lengthComputable) onProgress(e.loaded, e.total);
      });
    }
    xhr.onload=function(){
      try{resolve(JSON.parse(xhr.responseText));}catch(e){reject(e);}
    };
    xhr.onerror=function(){reject(new Error('Network error'));};
    xhr.open('POST','/upload');
    xhr.send(form);
  });
}
