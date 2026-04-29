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
