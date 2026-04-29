// ── Transcribblr Player — WaveSurfer, regions, loop, audio source ─────────────

var ws = null;
var wsRegions = null;

// ── Region highlight helpers ──────────────────────────────────────────────────
var _curRegion=null, _addRegion=null, _split1Region=null, _split2Region=null;

// Move an existing region's bounds in-place via its DOM element (no flicker)
function moveRegion(region, s, e){
  if(!audioDur||audioDur<=0)return;
  var el=region&&region.element;
  if(!el)return;
  el.style.left=(s/audioDur*100)+'%';
  el.style.width=((e-s)/audioDur*100)+'%';
  // Keep internal props in sync
  region.start=s; region.end=e;
}

function updateAddRegion(){
  if(!wsRegions)return;
  var activeTab=document.querySelector('.tbtn.on');
  var onAdd=activeTab&&activeTab.getAttribute('data-tab')==='add';
  if(!onAdd){
    if(_addRegion){try{_addRegion.remove();}catch(x){} _addRegion=null;}
    return;
  }
  var s=parseFloat(($('as2')||{value:0}).value),e=parseFloat(($('ae2')||{value:0}).value);
  if(isNaN(s)||isNaN(e)||e<=s){
    if(_addRegion){try{_addRegion.remove();}catch(x){} _addRegion=null;}
    return;
  }
  if(_addRegion){moveRegion(_addRegion,s,e);}
  else{try{_addRegion=wsRegions.addRegion({start:s,end:e,color:'rgba(160,80,255,0.22)',drag:false,resize:false});}catch(x){}}
}

function updateSplitRegions(){
  if(!wsRegions)return;
  var activeTab=document.querySelector('.tbtn.on');
  var onSplit=activeTab&&activeTab.getAttribute('data-tab')==='split';
  if(!onSplit){
    if(_split1Region){try{_split1Region.remove();}catch(x){} _split1Region=null;}
    if(_split2Region){try{_split2Region.remove();}catch(x){} _split2Region=null;}
    return;
  }
  var e=entries[idx];if(!e)return;
  var t=parseFloat(($('st')||{value:e.start}).value);
  if(isNaN(t)||t<=e.start||t>=e.end){
    if(_split1Region){try{_split1Region.remove();}catch(x){} _split1Region=null;}
    if(_split2Region){try{_split2Region.remove();}catch(x){} _split2Region=null;}
    return;
  }
  // Part 1: cyan
  if(_split1Region){moveRegion(_split1Region,e.start,t);}
  else{try{_split1Region=wsRegions.addRegion({start:e.start,end:t,color:'rgba(0,217,255,0.18)',drag:false,resize:false});}catch(x){}}
  // Part 2: orange
  if(_split2Region){moveRegion(_split2Region,t,e.end);}
  else{try{_split2Region=wsRegions.addRegion({start:t,end:e.end,color:'rgba(255,140,0,0.18)',drag:false,resize:false});}catch(x){}}
}

function updateCurRegion(){
  if(!wsRegions||!audioDur)return;
  // Read directly from sliders — always the ground truth for current record
  var esEl=$('es'), eeEl=$('ee');
  var startT=esEl?parseFloat(esEl.value):NaN;
  var endT=eeEl?parseFloat(eeEl.value):NaN;
  // Fall back to saved entry if sliders not available
  if(isNaN(startT)||isNaN(endT)){
    var w=entries[idx]; if(!w)return;
    startT=w.start; endT=w.end;
  }
  if(isNaN(startT)||isNaN(endT)||endT<=startT){
    if(_curRegion){try{_curRegion.remove();}catch(x){} _curRegion=null;}
    return;
  }
  if(_curRegion){moveRegion(_curRegion,startT,endT);}
  else{try{_curRegion=wsRegions.addRegion({start:startT,end:endT,color:'rgba(255,210,0,0.18)',drag:false,resize:false});}catch(x){}}
}

// ── Audio source switcher ─────────────────────────────────────────────────────
var _audioSrc='vocals';
var _switchSeekTo=null;

// ── Loop state — declared here so filepicker.js can read looping ──────────────
var looping=false, loopTimer=null, _loopSeeking=false;

function getLoopBounds(){
  var e=entries[idx];
  if(!e||isNaN(e.start)||isNaN(e.end)||e.end<=e.start+0.1)return null;
  return {s:e.start,e:e.end};
}

function stopLoop(){
  looping=false;
  clearInterval(loopTimer);loopTimer=null;
  var lb=$('wloop');if(lb)lb.classList.remove('loop-on');
  clearTimeout(followPauseTimer);
  followPauseTimer=setTimeout(function(){audioFollow=true;},500);
}

function startLoopInterval(){
  if(loopTimer){clearInterval(loopTimer);loopTimer=null;}
  loopTimer=setInterval(function(){
    if(!looping||!ws)return;
    var b=getLoopBounds();if(!b)return;
    try{
      var t=ws.getCurrentTime();
      if(t>=b.e-0.05||t<b.s){
        _loopSeeking=true;
        ws.setTime(b.s);
        setTimeout(function(){_loopSeeking=false;},100);
        if(!ws.isPlaying()){
          setTimeout(function(){
            if(looping&&!ws.isPlaying()){
              var p=ws.play();if(p&&p.catch)p.catch(function(){});
            }
          },30);
        }
      }
    }catch(x){}
  },80);
}

function startLoop(){
  var b=getLoopBounds();if(!b)return;
  looping=true;
  var lb=$('wloop');if(lb)lb.classList.add('loop-on');
  _loopSeeking=true;
  ws.setTime(b.s);
  setTimeout(function(){
    _loopSeeking=false;
    if(!looping)return;
    try{var p=ws.play();if(p&&p.catch)p.catch(function(){});}catch(x){}
    startLoopInterval();
  },80);
}

// ── WaveSurfer init — guarded so CDN failure doesn't crash the app ────────────
try {
  wsRegions=(WaveSurfer.Regions||window.WaveSurferRegions).create();
  ws=WaveSurfer.create({
    container:'#wf',waveColor:'#1e4d3a',progressColor:'#00ff88',
    cursorColor:'#00ff88',cursorWidth:2,height:64,
    barWidth:2,barGap:1,barRadius:2,normalize:true,
    minPxPerSec:30,autoScroll:true,autoCenter:true,
    plugins:[wsRegions]
  });

  $('audio-src').addEventListener('change',function(){
    var newSrc=this.value;
    if(newSrc===_audioSrc)return;
    _audioSrc=newSrc;
    _switchSeekTo=ws.getCurrentTime();
    var wasPlaying=ws.isPlaying();
    if(looping)stopLoop();
    $('wsl').style.display='block';
    $('wf').style.display='none';
    $('wsl').innerHTML='<span class="spin"></span>SWITCHING AUDIO…';
    ws.load('/audio?src='+newSrc+'&file='+encodeURIComponent(window._activeFile||''));
    ws.once('ready',function(){
      if(wasPlaying)ws.play();
    });
  });

  ws.on('error',function(e){$('wsl').textContent='⚠ Audio error: '+e;});
  ws.on('ready',function(){
    audioDur=ws.getDuration();
    $('wsl').style.display='none';
    $('wf').style.display='block';
    $('wd').textContent=toSRT(audioDur);
    setTimeout(function(){
      var pxPerSec=Math.max(10,Math.round($('wf').clientWidth/90));
      ws.zoom(pxPerSec);
      // On source switch restore saved position, otherwise go to record start
      if(_switchSeekTo!==null){
        try{ws.setTime(_switchSeekTo);}catch(x){}
        _switchSeekTo=null;
      } else {
        if(entries.length)try{ws.setTime(entries[idx].start);}catch(x){}
      }
      updateCurRegion();
      setStatus('Loaded '+entries.length+' records');
    },50);
  });
  ws.on('timeupdate',function(t){
    $('wc').textContent=toSRT(t);

    // Find active record (within window) or upcoming (next after t)
    var active=-1, upcoming=-1;
    for(var i=0;i<entries.length;i++){
      if(t>=entries[i].start&&t<=entries[i].end){active=i;break;}
      if(entries[i].start>t&&(upcoming===-1||entries[i].start<entries[upcoming].start))upcoming=i;
    }

    // Drive record selection when audio is in control
    if(audioFollow){
      var target=active>=0?active:upcoming>=0?upcoming:-1;
      if(target>=0&&target!==idx){
        idx=target;
        $('sel').value=idx;
        render();
        updateCurRegion();
      }
    }

    // Highlight — re-check active against current idx (which may just have changed)
    var cur=$('cur');
    if(cur){
      var isActive=(active>=0&&active===idx);
      if(isActive) cur.classList.add('cur-active');
      else cur.classList.remove('cur-active');
    }
  });
  ws.on('play', function(){$('wpi').textContent='⏸';$('wpl').textContent='PAUSE';});
  ws.on('pause',function(){
    $('wpi').textContent='▶';$('wpl').textContent='PLAY';
    // Only stop loop if it wasn't us who caused the pause via setTime
    if(looping&&!_loopSeeking)stopLoop();
  });

  $('wrec').addEventListener('click',function(){if(entries[idx])ws.setTime(entries[idx].start);});
  $('wloop').addEventListener('click',function(){
    if(looping) stopLoop();
    else startLoop();
  });
  $('wplay').addEventListener('click',function(){ws.playPause();});
  $('wm30').addEventListener('click',function(){ws.setTime(Math.max(0,ws.getCurrentTime()-30));});
  $('wm10').addEventListener('click',function(){ws.setTime(Math.max(0,ws.getCurrentTime()-10));});
  $('wp10').addEventListener('click',function(){ws.setTime(Math.min(ws.getDuration(),ws.getCurrentTime()+10));});
  $('wp30').addEventListener('click',function(){ws.setTime(Math.min(ws.getDuration(),ws.getCurrentTime()+30));});
  $('wspd').addEventListener('input',function(){var v=parseFloat(this.value);$('wspv').textContent=v.toFixed(2)+'×';ws.setPlaybackRate(v);});
  $('wvol').addEventListener('input',function(){var v=parseFloat(this.value);$('wvolv').textContent=Math.round(v*100)+'%';ws.setVolume(v);});
} catch(e) {
  console.error('WaveSurfer init failed:', e);
}
