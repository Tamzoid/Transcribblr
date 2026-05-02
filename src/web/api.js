// ── Transcribblr API client ───────────────────────────────────────────────────
// All fetch() calls go through here. Each function returns a Promise.

// Resilient JSON fetcher for polling endpoints. The Colab proxy in front of
// the server occasionally returns plain-text "upstream connection error…"
// when the backend is busy — that breaks r.json() and would stop the poll
// loop entirely. This helper:
//   • throws a clean Error on non-2xx responses
//   • throws a tagged Error when the body isn't JSON (so callers can soft-retry)
function _safePollJson(path) {
  return fetch(path, {
    headers: {'Cache-Control': 'no-cache', 'Pragma': 'no-cache'}
  }).then(function(r) {
    return r.text().then(function(t) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (t||'').substring(0,100));
      try { return JSON.parse(t); }
      catch(e) {
        // Non-JSON body — proxy/upstream error page. Caller should retry.
        var snippet = (t||'').replace(/\s+/g,' ').substring(0,80);
        var err = new Error('non-JSON response: ' + snippet);
        err.transient = true;
        throw err;
      }
    });
  });
}
window._safePollJson = _safePollJson;

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
      var since=0, consecFail=0, MAX_CONSEC=8;
      function poll(){
        _safePollJson('/process-status?job='+d.job_id+'&since='+since)
          .then(function(s){
            consecFail = 0;
            (s.events||[]).forEach(onEvent);
            since=s.next||since;
            if(s.done){resolve();}
            else{setTimeout(poll,1000);}
          })
          .catch(function(e){
            consecFail++;
            if(consecFail >= MAX_CONSEC) reject(e);
            else setTimeout(poll, 2000);
          });
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
