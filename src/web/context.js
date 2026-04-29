// ── Context tab — generate / view / edit project.context ─────────────────────

function _ctxStatus(msg, warn){
  var el=$('ctx-status');if(!el)return;
  el.textContent=msg||'';
  el.style.color=warn?'#ffcc00':'#888';
}
function _ctxLog(line){
  var box=$('ctx-progress');var pre=$('ctx-progress-log');
  if(!box||!pre)return;
  box.style.display='';
  pre.textContent+=(pre.textContent?'\n':'')+line;
  pre.scrollTop=pre.scrollHeight;
}
function _ctxClearLog(){
  var pre=$('ctx-progress-log');if(pre)pre.textContent='';
  var box=$('ctx-progress');if(box)box.style.display='none';
}

function _ctxRenderResult(ctx){
  var wrap=$('ctx-result-wrap'),ta=$('ctx-json');
  if(!wrap||!ta)return;
  if(ctx==null){
    wrap.style.display='none';ta.value='';
  } else {
    wrap.style.display='';
    ta.value=JSON.stringify(ctx,null,2);
  }
  var sb=$('ctx-save');if(sb)sb.disabled=(ctx==null);
}

function loadContextIntoPanel(){
  if(!window._activeFile){
    _ctxStatus('No project selected — pick one to start',true);
    _ctxRenderResult(null);
    return;
  }
  _ctxStatus('Loading existing context…');
  apiGet('/context').then(function(d){
    if(d&&d.context){
      _ctxStatus('Loaded existing context for '+window._activeFile);
      _ctxRenderResult(d.context);
    } else {
      _ctxStatus('No context yet for '+window._activeFile+' — paste a description and generate one');
      _ctxRenderResult(null);
    }
  }).catch(function(e){
    _ctxStatus('Failed to load: '+e,true);
  });
}

function _ctxStartGenerate(){
  if(!window._activeFile){_ctxStatus('No project selected',true);return;}
  var desc=($('ctx-desc')||{value:''}).value.trim();
  if(!desc){_ctxStatus('Paste a description first',true);return;}
  _ctxClearLog();
  var btn=$('ctx-generate');if(btn)btn.disabled=true;
  _ctxStatus('Submitting…');
  fetch('/generate-context',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({description:desc})
  }).then(function(r){return r.json();}).then(function(d){
    if(!d.job_id){throw new Error(d.error||'no job_id returned');}
    _ctxStatus('Generating context — first run loads the model (~30–60s)…');
    _pollContextJob(d.job_id);
  }).catch(function(e){
    _ctxStatus('⚠ '+e,true);
    if(btn)btn.disabled=false;
  });
}

function _pollContextJob(jobId){
  var since=0,btn=$('ctx-generate');
  function tick(){
    fetch('/process-status?job='+jobId+'&since='+since)
      .then(function(r){return r.json();})
      .then(function(s){
        (s.events||[]).forEach(function(ev){
          if(ev.type==='step'){_ctxLog(ev.msg);}
          else if(ev.type==='result'){
            _ctxRenderResult(ev.context);
            _ctxStatus('✓ Context generated and saved to '+ev.project);
          }
          else if(ev.type==='error'){_ctxStatus('⚠ '+ev.error,true);}
        });
        since=s.next||since;
        if(s.done){
          if(btn)btn.disabled=false;
        } else {
          setTimeout(tick,1000);
        }
      })
      .catch(function(e){
        _ctxStatus('Poll failed: '+e,true);
        if(btn)btn.disabled=false;
      });
  }
  tick();
}

function _ctxSaveEdits(){
  var ta=$('ctx-json');if(!ta)return;
  var raw=ta.value;
  var parsed;
  try{parsed=JSON.parse(raw);}
  catch(e){_ctxStatus('⚠ Invalid JSON: '+e.message,true);return;}
  _ctxStatus('Saving…');
  fetch('/save-context',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({context:parsed})
  }).then(function(r){return r.json();}).then(function(d){
    if(d.ok)_ctxStatus('✓ Saved');
    else _ctxStatus('⚠ '+(d.error||'save failed'),true);
  }).catch(function(e){_ctxStatus('⚠ '+e,true);});
}

(function _wireContext(){
  var ta=$('ctx-desc');
  if(ta)ta.addEventListener('input',function(){
    var btn=$('ctx-generate');if(btn)btn.disabled=!ta.value.trim();
  });
  var gen=$('ctx-generate');if(gen)gen.addEventListener('click',_ctxStartGenerate);
  var refr=$('ctx-refresh');if(refr)refr.addEventListener('click',loadContextIntoPanel);
  var save=$('ctx-save');if(save)save.addEventListener('click',_ctxSaveEdits);
})();
