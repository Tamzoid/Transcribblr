// ── Transcribblr Sliders — noUiSlider init, callbacks, nudge buttons ──────────

function getNeighbourBounds(){
  var prevEnd = idx > 0 ? entries[idx-1].end : 0;
  var nextStart = idx < entries.length-1 ? entries[idx+1].start : audioDur||9999;
  return {min: prevEnd, max: nextStart};
}

function timeSliderCb(vals){
  var nb=getNeighbourBounds();
  var s=Math.max(nb.min, parseFloat(vals[0]));
  var e=Math.min(nb.max, Math.max(s+0.01, parseFloat(vals[1])));
  $('es').value=s;
  $('ee').value=e;
  _userEditing=true;editPrev();
}

function addSliderCb(vals){
  $('as2').value=parseFloat(vals[0]);
  $('ae2').value=parseFloat(vals[1]);
  addPrev();
}

// Guard slider init — CDN failure must not break the rest of the app
try {
  if(typeof noUiSlider==='undefined') throw new Error('noUiSlider library not loaded');
  var tsEl=$('time-slider'), asEl=$('add-slider');
  if(!tsEl||!asEl) throw new Error('slider container missing');

  window.timeSlider=noUiSlider.create(tsEl,{
    start:[0,1],connect:true,step:0.01,
    range:{min:0,max:1},
    tooltips:[
      {to:function(v){return toSRT(v);}},
      {to:function(v){return toSRT(v);}}
    ]
  });
  window.timeSlider.on('slide',timeSliderCb);
  window.timeSlider.on('set',timeSliderCb);

  window.addSlider=noUiSlider.create(asEl,{
    start:[0,1],connect:true,step:0.01,
    range:{min:0,max:1},
    tooltips:[
      {to:function(v){return toSRT(v);}},
      {to:function(v){return toSRT(v);}}
    ]
  });
  window.addSlider.on('slide',addSliderCb);
  window.addSlider.on('set',addSliderCb);
} catch(e) {
  console.error('Slider init failed:', e);
}

// ── Nudge functions ───────────────────────────────────────────────────────────
function nudgeTimeSlider(handle, delta){
  _userEditing=true;
  var nb=getNeighbourBounds();
  var vals=window.timeSlider.get();
  var s=parseFloat(vals[0]), e=parseFloat(vals[1]);
  if(handle===0) s=Math.min(e-0.01, Math.max(nb.min, Math.round((s+delta)*100)/100));
  else            e=Math.max(s+0.01, Math.min(nb.max, Math.round((e+delta)*100)/100));
  window.timeSlider.set([s,e],false);
  $('es').value=s; $('ee').value=e;
  editPrev();
}

function nudgeAddSlider(handle, delta){
  var vals=window.addSlider.get();
  var s=parseFloat(vals[0]), e=parseFloat(vals[1]);
  if(handle===0) s=Math.max(0,Math.round((s+delta)*100)/100);
  else            e=Math.max(s+0.1,Math.round((e+delta)*100)/100);
  var mn=window.addSlider.options.range.min, mx=window.addSlider.options.range.max;
  if(s<mn||e>mx){
    window.addSlider.updateOptions({range:{min:Math.min(mn,s-1),max:Math.max(mx,e+1)}},false);
  }
  window.addSlider.set([s,e],false);
  $('as2').value=s; $('ae2').value=e;
  addPrev();
}

// ── Nudge button listeners ────────────────────────────────────────────────────
// All wrapped null-safe — the time/add tabs may have been removed, in which
// case these IDs don't exist and a bare addEventListener would throw and
// kill every later <script> in the IIFE.
function _on(id, fn){var el=document.getElementById(id); if(el) el.addEventListener('click', fn);}
_on('ts-s-dn', function(){nudgeTimeSlider(0,-0.5);});
_on('ts-s-up', function(){nudgeTimeSlider(0,+0.5);});
_on('ts-e-dn', function(){nudgeTimeSlider(1,-0.5);});
_on('ts-e-up', function(){nudgeTimeSlider(1,+0.5);});
_on('ts-s-now', function(){
  var t=Math.max(0,ws.getCurrentTime()-0.5);
  var es=$('es'); if(!es) return;
  nudgeTimeSlider(0, t - parseFloat(es.value));
});
_on('ts-e-now', function(){
  var t=ws.getCurrentTime();
  var ee=$('ee'); if(!ee) return;
  nudgeTimeSlider(1, t - parseFloat(ee.value));
});

_on('as-s-dn', function(){nudgeAddSlider(0,-0.5);});
_on('as-s-up', function(){nudgeAddSlider(0,+0.5);});
_on('as-e-dn', function(){nudgeAddSlider(1,-0.5);});
_on('as-e-up', function(){nudgeAddSlider(1,+0.5);});
_on('as-s-now', function(){
  var t=Math.max(0,ws.getCurrentTime()-0.5);
  var as2=$('as2'); if(!as2) return;
  nudgeAddSlider(0, t - parseFloat(as2.value));
});
_on('as-e-now', function(){
  var t=ws.getCurrentTime();
  var ae2=$('ae2'); if(!ae2) return;
  nudgeAddSlider(1, t - parseFloat(ae2.value));
});
