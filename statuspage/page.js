// La pagina pubblica. Un guscio statico: i dati li prende da /api/status.json e si aggiorna da sola
// ogni minuto. Niente librerie, niente font o script da terzi (la CSP del Worker li vieterebbe).

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function pageHtml({ nonce, site }) {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(site)} · Status</title>
<meta name="description" content="${esc(site)}: stato dei servizi in tempo reale, incidenti e manutenzioni.">
<link rel="icon" href="data:,">
<link rel="alternate" type="application/rss+xml" title="${esc(site)} status" href="/feed.xml">
<style nonce="${nonce}">
:root{
  --page:hsl(90,11%,96%);--surface:#fff;--surface-2:hsl(60,13%,97%);
  --ink:hsl(216,60%,10%);--ink-2:hsl(216,8%,40%);--ink-3:hsl(216,6%,52%);
  --line:hsl(80,6%,86%);--line-soft:hsl(75,9%,91%);
  --brand:hsl(28,90%,50%);--brand-ink:hsl(28,94%,37%);
  --ok:hsl(160,84%,32%);--ok-soft:hsl(152,81%,94%);
  --warn:hsl(38,92%,40%);--warn-soft:hsl(55,92%,93%);
  --down:hsl(0,74%,48%);--down-soft:hsl(0,86%,96%);
  --maint:hsl(213,70%,45%);--maint-soft:hsl(213,80%,95%);
  --empty:hsl(80,6%,86%);
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --page:hsl(216,32%,7%);--surface:hsl(216,26%,11%);--surface-2:hsl(216,24%,14%);
  --ink:hsl(60,12%,94%);--ink-2:hsl(216,12%,72%);--ink-3:hsl(216,9%,60%);
  --line:hsl(216,16%,22%);--line-soft:hsl(216,18%,17%);
  --brand:hsl(30,92%,56%);--brand-ink:hsl(34,95%,64%);
  --ok:hsl(158,64%,46%);--ok-soft:hsl(160,40%,14%);
  --warn:hsl(44,90%,54%);--warn-soft:hsl(44,45%,15%);
  --down:hsl(0,80%,64%);--down-soft:hsl(0,40%,17%);
  --maint:hsl(213,80%,66%);--maint-soft:hsl(213,40%,17%);
  --empty:hsl(216,14%,26%);color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{background:var(--page);color:var(--ink);font:15px/1.6 var(--sans);
  padding:32px max(16px,env(safe-area-inset-right,0px)) 56px max(16px,env(safe-area-inset-left,0px))}
.wrap{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:22px;position:relative}
h1,h2,h3{margin:0;line-height:1.25;text-wrap:balance}
p{margin:0}
a{color:var(--brand-ink)}
button{font:inherit}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:19px;letter-spacing:-.01em}
.logo i{width:24px;height:24px;border-radius:7px;background:var(--brand);display:inline-block}
.logo span{font-weight:500;color:var(--ink-3)}
.lang{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.lang button{font:500 12px/1 var(--mono);padding:8px 10px;background:var(--surface);color:var(--ink-3);border:0;cursor:pointer}
.lang button[aria-pressed="true"]{background:var(--surface-2);color:var(--ink)}
.banner{display:flex;align-items:center;gap:14px;padding:16px 18px;border-radius:10px;border:1px solid var(--line)}
.banner .dot{width:12px;height:12px;border-radius:50%;flex:none;background:currentColor}
.banner b{font-size:16px;display:block}
.banner small{display:block;color:var(--ink-2);font-size:13px}
.banner.operational{background:var(--ok-soft);color:var(--ok)}
.banner.degraded{background:var(--warn-soft);color:var(--warn)}
.banner.outage{background:var(--down-soft);color:var(--down)}
.banner.unknown,.banner.stale{background:var(--surface-2);color:var(--ink-3)}
.banner b,.banner small{color:var(--ink)}
.banner small{color:var(--ink-2)}
.notice{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border-radius:10px;border:1px solid var(--line);background:var(--surface);cursor:pointer;text-align:left;color:inherit;width:100%}
.notice .k{font:500 11px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase}
.notice.maintenance{background:var(--maint-soft)}.notice.maintenance .k{color:var(--maint)}
.notice.degraded{background:var(--warn-soft)}.notice.degraded .k{color:var(--warn)}
.notice.outage{background:var(--down-soft)}.notice.outage .k{color:var(--down)}
.notice b{font-size:15px}
.notice p{font-size:14px;color:var(--ink-2)}
.comps{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)}
.comp{padding:14px 16px;display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line-soft)}
.comp:first-child{border-top:0}
.comp-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.comp-name{font-weight:600;font-size:14.5px}
.comp-sub{font-size:12.5px;color:var(--ink-3);font-weight:400;margin-left:6px}
.state{font-size:13px;font-weight:500;display:flex;align-items:center;gap:6px;white-space:nowrap}
.state::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.state.operational{color:var(--ok)}.state.degraded{color:var(--warn)}.state.outage{color:var(--down)}
.state.unknown{color:var(--ink-3)}.state.maintenance{color:var(--maint)}
.bars{display:grid;grid-template-columns:repeat(90,1fr);gap:2px;height:30px;cursor:pointer;border-radius:3px}
.bars i{border-radius:2px;background:var(--empty)}
.bars i.o{background:var(--ok)}.bars i.d{background:var(--warn)}.bars i.x{background:var(--down)}.bars i.m{background:var(--maint)}
.bars i.sel{outline:2px solid var(--ink);outline-offset:1px}
.axis{display:flex;justify-content:space-between;font:12px var(--mono);color:var(--ink-3);font-variant-numeric:tabular-nums}
.hist h2{font-size:16px;margin-bottom:6px}
.inc{display:grid;grid-template-columns:110px 1fr;gap:4px 16px;padding:12px 0;border:0;border-top:1px solid var(--line-soft);width:100%;text-align:left;background:none;color:inherit;cursor:pointer}
.inc time{font:12px var(--mono);color:var(--ink-3);padding-top:2px}
.inc b{font-size:14px}
.inc p{font-size:13.5px;color:var(--ink-2);grid-column:2}
.inc:hover b{text-decoration:underline;text-underline-offset:3px}
.empty{font-size:14px;color:var(--ink-3);padding:8px 0}
.pill{display:inline-block;font:500 11px/1 var(--mono);padding:3px 6px;border-radius:4px;margin-left:6px;vertical-align:2px}
.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.degraded{background:var(--warn-soft);color:var(--warn)}
.pill.outage{background:var(--down-soft);color:var(--down)}.pill.maintenance{background:var(--maint-soft);color:var(--maint)}
.foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--ink-3);border-top:1px solid var(--line-soft);padding-top:16px}
.tip{position:absolute;z-index:5;width:272px;max-width:calc(100% - 16px);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:13px;display:flex;flex-direction:column;gap:10px;box-shadow:0 2px 4px rgb(0 0 0/.08),0 16px 36px -12px rgb(0 0 0/.28)}
.tip-d{display:flex;justify-content:space-between;gap:8px;font:12px var(--mono);color:var(--ink-3)}
.tip-d b{color:var(--ink);font-weight:500}
.tip-row{display:grid;grid-template-columns:10px 1fr;gap:4px 10px;align-items:start}
.tip-row .sw{width:10px;height:10px;border-radius:3px;margin-top:4px;background:var(--ok)}
.tip-row .sw.d,.tip-row .sw.degraded{background:var(--warn)}.tip-row .sw.x,.tip-row .sw.outage{background:var(--down)}
.tip-row .sw.m,.tip-row .sw.maintenance{background:var(--maint)}.tip-row .sw.n{background:var(--empty)}
.tip-row b{font-weight:600;font-size:13.5px}
.tip-row small{grid-column:2;color:var(--ink-2);font-size:12.5px}
.linkbtn{grid-column:2;justify-self:start;font:500 12.5px/1.2 var(--sans);color:var(--brand-ink);background:none;border:0;padding:2px 0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
dialog{border:1px solid var(--line);border-radius:14px;padding:0;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 48px);background:var(--surface);color:var(--ink)}
dialog::backdrop{background:rgb(0 0 0/.45)}
.dl{padding:22px 24px 24px;display:flex;flex-direction:column;gap:18px}
.dl-h{display:flex;justify-content:space-between;align-items:start;gap:12px}
.dl-h h3{font-size:18px}
.close{font:500 18px/1 var(--sans);background:none;border:1px solid var(--line);color:var(--ink-2);border-radius:8px;width:32px;height:32px;cursor:pointer;flex:none}
.meta{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13.5px;margin:0}
.meta dt{font:11.5px var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);padding-top:2px}
.meta dd{margin:0}
.tl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.tl li{display:grid;grid-template-columns:14px 1fr;gap:2px 14px;position:relative;padding-bottom:16px}
.tl li::before{content:"";grid-row:1/span 2;width:10px;height:10px;border-radius:50%;margin:5px 2px 0;background:var(--ink-3)}
.tl li:first-child::before{background:var(--brand)}
.tl li:not(:last-child)::after{content:"";position:absolute;left:6px;top:20px;bottom:2px;width:2px;background:var(--line-soft)}
.tl .st{font-weight:600;font-size:14px}
.tl .st time{font:12px var(--mono);color:var(--ink-3);margin-left:8px}
.tl p{font-size:13.5px;color:var(--ink-2);grid-column:2;white-space:pre-line}
@media (max-width:560px){.inc{grid-template-columns:1fr}.inc p{grid-column:1}.bars{grid-template-columns:repeat(45,1fr)}.bars i:nth-child(-n+45){display:none}.axis .far{display:none}}
</style>
</head>
<body>
<div class="wrap" id="wrap">
  <header class="head">
    <div class="logo"><i aria-hidden="true"></i>${esc(site)} <span data-t="status">Stato dei servizi</span></div>
    <div class="lang" role="group" aria-label="Lingua"><button id="l-it" type="button">IT</button><button id="l-en" type="button">EN</button></div>
  </header>
  <div class="banner unknown" id="banner" role="status" aria-live="polite"><span class="dot"></span><div><b id="b-t">…</b><small id="b-s"></small></div></div>
  <div id="notices"></div>
  <div class="comps" id="comps"></div>
  <section class="hist"><h2 data-t="hist">Ultimi eventi</h2><div id="hist"></div></section>
  <footer class="foot"><span id="foot"></span><a href="/feed.xml" id="rss">RSS</a></footer>
  <div class="tip" id="tip" hidden></div>
  <dialog id="dlg" aria-labelledby="dlg-t"></dialog>
</div>
<script nonce="${nonce}">
(function(){
var T={
 it:{status:"Stato dei servizi",hist:"Ultimi eventi",allok:"Tutti i servizi funzionano",somedeg:"Alcuni servizi sono rallentati",someout:"Interruzione in corso",unk:"Stato in verifica",
  stale:"Dati non aggiornati",staleS:"Ultimo controllo alle {t}. Stiamo verificando.",both:"Controllato {a}, dall'esterno e dall'interno",ext:"Controllato {a}, dall'esterno",
  sec:"{n} secondi fa",min:"{n} minuti fa",now:"ora",operational:"Funziona",degraded:"Rallentato",outage:"Interruzione",unknown:"Non misurato",maintenance:"In manutenzione",
  ago:"90 giorni fa",today:"Oggi",avail:"disponibilità",na:"n/d",none:"Nessun disservizio",nodata:"Nessuna misura",dayAv:"disponibilità del giorno",
  det:"Dettagli",when:"Quando",dur:"Durata",impact:"Impatto",affected:"Componenti",upd:"Aggiornamenti",close:"Chiudi",noev:"Nessun evento negli ultimi 90 giorni.",
  maint:"Manutenzione programmata",inc:"Incidente in corso",resolved:"risolto",ongoing:"in corso",from:"dalle {a}",to:"alle {b}",
  s_investigating:"Indagine",s_identified:"Identificato",s_monitoring:"Monitoraggio",s_resolved:"Risolto",s_scheduled:"Programmata",s_in_progress:"In corso",s_completed:"Completata",
  foot:"Disponibilità misurata ogni minuto, dall'esterno e dall'interno. Orari in {tz}."},
 en:{status:"System status",hist:"Recent events",allok:"All systems operational",somedeg:"Some systems are degraded",someout:"Ongoing outage",unk:"Checking status",
  stale:"Data not up to date",staleS:"Last check at {t}. We are looking into it.",both:"Checked {a}, from outside and inside",ext:"Checked {a}, from outside",
  sec:"{n} seconds ago",min:"{n} minutes ago",now:"just now",operational:"Operational",degraded:"Degraded",outage:"Outage",unknown:"Not measured",maintenance:"Under maintenance",
  ago:"90 days ago",today:"Today",avail:"uptime",na:"n/a",none:"No incidents",nodata:"No measurements",dayAv:"uptime that day",
  det:"Details",when:"When",dur:"Duration",impact:"Impact",affected:"Components",upd:"Updates",close:"Close",noev:"No events in the last 90 days.",
  maint:"Planned maintenance",inc:"Ongoing incident",resolved:"resolved",ongoing:"ongoing",from:"from {a}",to:"to {b}",
  s_investigating:"Investigating",s_identified:"Identified",s_monitoring:"Monitoring",s_resolved:"Resolved",s_scheduled:"Scheduled",s_in_progress:"In progress",s_completed:"Completed",
  foot:"Availability measured every minute, from outside and inside. Times in {tz}."}
};
var lang="it";try{var sv=localStorage.getItem("lang");lang=sv==="en"||sv==="it"?sv:((navigator.language||"").slice(0,2)==="it"?"it":"en")}catch(e){lang=(navigator.language||"").slice(0,2)==="it"?"it":"en"}
var data=null,wrap=document.getElementById("wrap"),tip=document.getElementById("tip"),dlg=document.getElementById("dlg"),cur=null,hideT=null;
function t(k,v){var s=(T[lang][k]||k);if(v)for(var x in v)s=s.replace("{"+x+"}",v[x]);return s}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function loc(){return lang==="it"?"it-IT":"en-GB"}
function dayK(d){return new Intl.DateTimeFormat("en-CA",{timeZone:data.tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d)}
function fDay(k,y){var p=k.split("-");var d=new Date(Date.UTC(+p[0],+p[1]-1,+p[2],12));var o={day:"numeric",month:"short",timeZone:"UTC"};if(y)o.year="numeric";return d.toLocaleDateString(loc(),o)}
function fTime(iso){return new Date(iso).toLocaleTimeString(loc(),{hour:"2-digit",minute:"2-digit",timeZone:data.tz})}
function fDate(iso){return new Date(iso).toLocaleDateString(loc(),{day:"numeric",month:"short",year:"numeric",timeZone:data.tz})}
function pct(x){if(x==null)return t("na");var s=(Math.floor(x*10000)/100).toFixed(2).replace(/\\.?0+$/,"");return (lang==="it"?s.replace(".",","):s)+"%"}
function dur(ms){var m=Math.max(1,Math.round(ms/60000));if(m<60)return m+" min";var h=Math.floor(m/60),r=m%60;if(h<48)return h+" h"+(r?" "+r+" min":"");return Math.round(h/24)+(lang==="it"?" giorni":" days")}
function ago(iso){var s=Math.round((Date.now()-new Date(iso).getTime())/1000);if(s<10)return t("now");if(s<120)return t("sec",{n:s});return t("min",{n:Math.round(s/60)})}
function L(o){return o?(o[lang]||o.it||""):""}
function compName(id){var c=data.components.find(function(x){return x.id===id});return c?L(c.name):id}
function itemEnd(i){return i.end||new Date().toISOString()}
function itemsOn(day,cid){return data.items.filter(function(i){return i.components.indexOf(cid)>=0&&dayK(new Date(i.start))<=day&&day<=dayK(new Date(itemEnd(i)))})}
function cls(c,its){var k=c?(c.x>0?"x":c.d>0?"d":c.o>0?"o":""):"";its.forEach(function(i){if(i.impact==="outage")k="x";else if(i.impact==="degraded"&&k!=="x")k="d";else if(i.impact==="maintenance"&&(k===""||k==="o"))k="m"});return k}
function render(){
 document.documentElement.lang=lang;
 document.getElementById("l-it").setAttribute("aria-pressed",lang==="it");document.getElementById("l-en").setAttribute("aria-pressed",lang==="en");
 document.querySelectorAll("[data-t]").forEach(function(n){n.textContent=t(n.getAttribute("data-t"))});
 if(!data)return;
 var b=document.getElementById("banner"),st=data.components.map(function(c){return c.state});
 var k=st.indexOf("outage")>=0?"outage":st.indexOf("degraded")>=0?"degraded":st.indexOf("operational")>=0?"operational":"unknown";
 if(data.stale){b.className="banner stale";document.getElementById("b-t").textContent=t("stale");document.getElementById("b-s").textContent=data.checkedAt?t("staleS",{t:fTime(data.checkedAt)}):""}
 else{b.className="banner "+k;document.getElementById("b-t").textContent=t(k==="outage"?"someout":k==="degraded"?"somedeg":k==="operational"?"allok":"unk");document.getElementById("b-s").textContent=t(data.interno?"both":"ext",{a:ago(data.checkedAt)})}
 var nb=document.getElementById("notices");nb.innerHTML="";var now=new Date().toISOString(),soon=new Date(Date.now()+7*86400000).toISOString();
 data.items.filter(function(i){return !i.resolved&&(i.kind==="incident"||i.start<=soon)}).forEach(function(i){
  var btn=document.createElement("button");btn.type="button";btn.className="notice "+i.impact;
  var when=i.kind==="maintenance"?fDate(i.start)+", "+fTime(i.start)+" - "+fTime(i.end):"";
  btn.innerHTML='<span class="k">'+esc(i.kind==="maintenance"?t("maint"):t("inc"))+(when?" · "+esc(when):"")+'</span><b>'+esc(L(i.title))+'</b><p>'+esc(L(i.updates[0].text))+'</p>';
  btn.onclick=function(){openItem(i)};nb.appendChild(btn)});
 var box=document.getElementById("comps");box.innerHTML="";
 data.components.forEach(function(c,ci){
  var bars="";data.days.forEach(function(d,di){bars+='<i class="'+cls(c.history[di],itemsOn(d,c.id))+'" data-c="'+ci+'" data-i="'+di+'"></i>'});
  var s=c.maintenance?"maintenance":c.state,el=document.createElement("div");el.className="comp";
  el.innerHTML='<div class="comp-top"><span class="comp-name">'+esc(L(c.name))+(L(c.sub)?'<span class="comp-sub">'+esc(L(c.sub))+'</span>':'')+'</span><span class="state '+s+'">'+esc(t(s))+'</span></div>'+
   '<div class="bars" tabindex="0" role="group" data-c="'+ci+'" aria-label="'+esc(L(c.name))+'">'+bars+'</div>'+
   '<div class="axis"><span class="far">'+esc(t("ago"))+'</span><span>'+pct(c.uptime)+' '+esc(t("avail"))+'</span><span>'+esc(t("today"))+'</span></div>';
  box.appendChild(el)});
 var h=document.getElementById("hist");h.innerHTML="";
 var nowIso=new Date().toISOString();var past=data.items.filter(function(i){return i.start<=nowIso}).sort(function(a,b){return b.start.localeCompare(a.start)}).slice(0,8);
 if(!past.length){h.innerHTML='<p class="empty">'+esc(t("noev"))+'</p>'}
 past.forEach(function(i){var bt=document.createElement("button");bt.type="button";bt.className="inc";
  bt.innerHTML='<time>'+esc(fDate(i.start))+'</time><div><b>'+esc(L(i.title))+'</b><span class="pill '+(i.resolved?"ok":i.impact)+'">'+esc(i.resolved?t("resolved"):t("ongoing"))+'</span></div><p>'+esc(L(i.updates[0].text))+'</p>';
  bt.onclick=function(){openItem(i)};h.appendChild(bt)});
 document.getElementById("foot").textContent=t("foot",{tz:data.tz});
 document.getElementById("rss").href="/feed.xml"+(lang==="en"?"?lang=en":"");
 hideTip(true);
}
function showTip(bar){
 clearTimeout(hideT);if(cur)cur.classList.remove("sel");cur=bar;bar.classList.add("sel");
 var c=data.components[+bar.dataset.c],di=+bar.dataset.i,d=data.days[di],cnt=c.history[di],its=itemsOn(d,c.id);
 var html='<div class="tip-d"><b>'+esc(fDay(d,true))+'</b><span>'+esc(L(c.name))+'</span></div>';
 if(its.length)its.forEach(function(i){html+='<div class="tip-row"><span class="sw '+i.impact+'"></span><b>'+esc(L(i.title))+'</b><small>'+esc(t(i.impact==="maintenance"?"maintenance":i.impact))+' · '+esc(dur(new Date(itemEnd(i))-new Date(i.start)))+'</small><button class="linkbtn" type="button" data-id="'+esc(i.id)+'">'+esc(t("det"))+'</button></div>'});
 else if(cnt&&(cnt.d||cnt.x))html+='<div class="tip-row"><span class="sw '+(cnt.x?"x":"d")+'"></span><b>'+esc(t(cnt.x?"outage":"degraded"))+'</b><small>'+(cnt.x?cnt.x:cnt.d)+' min</small></div>';
 else html+='<div class="tip-row"><span class="sw '+(cnt&&cnt.o?"":"n")+'"></span><b>'+esc(t(cnt&&cnt.o?"none":"nodata"))+'</b></div>';
 var av=cnt?(cnt.o+cnt.d+cnt.x?(cnt.o+cnt.d)/(cnt.o+cnt.d+cnt.x):null):null;
 html+='<div class="tip-d"><span>'+esc(t("dayAv"))+'</span><b>'+pct(av)+'</b></div>';
 tip.innerHTML=html;tip.hidden=false;
 var r=bar.getBoundingClientRect(),s=wrap.getBoundingClientRect(),w=tip.offsetWidth,hh=tip.offsetHeight;
 var left=Math.max(0,Math.min(r.left-s.left+r.width/2-w/2,s.width-w)),top=r.top-s.top-hh-10;if(top<0)top=r.bottom-s.top+10;
 tip.style.left=left+"px";tip.style.top=top+"px";
}
function hideTip(now){clearTimeout(hideT);var f=function(){tip.hidden=true;if(cur){cur.classList.remove("sel");cur=null}};if(now===true)f();else hideT=setTimeout(f,180)}
wrap.addEventListener("mouseover",function(e){var b=e.target.closest(".bars i");if(b)showTip(b)});
wrap.addEventListener("mouseout",function(e){if(e.target.closest(".bars i")&&!(e.relatedTarget&&tip.contains(e.relatedTarget)))hideTip()});
wrap.addEventListener("click",function(e){var b=e.target.closest(".bars i");if(b){showTip(b);return}if(!tip.contains(e.target))hideTip(true)});
tip.addEventListener("mouseenter",function(){clearTimeout(hideT)});tip.addEventListener("mouseleave",function(){hideTip()});
tip.addEventListener("click",function(e){var b=e.target.closest(".linkbtn");if(b){var i=data.items.find(function(x){return x.id===b.dataset.id});if(i)openItem(i)}});
wrap.addEventListener("focusin",function(e){if(e.target.classList&&e.target.classList.contains("bars"))showTip(e.target.lastElementChild)});
wrap.addEventListener("focusout",function(e){if(e.target.classList&&e.target.classList.contains("bars")&&!(e.relatedTarget&&tip.contains(e.relatedTarget)))hideTip(true)});
wrap.addEventListener("keydown",function(e){
 if(!e.target.classList||!e.target.classList.contains("bars")||!cur)return;
 var n=data.days.length,i=+cur.dataset.i,j=e.key==="ArrowLeft"?i-1:e.key==="ArrowRight"?i+1:e.key==="Home"?0:e.key==="End"?n-1:null;
 if(e.key==="Enter"){var c=data.components[+cur.dataset.c],its=itemsOn(data.days[i],c.id);if(its.length){e.preventDefault();openItem(its[0])}return}
 if(e.key==="Escape"){hideTip(true);return}
 if(j===null)return;e.preventDefault();showTip(e.target.children[Math.max(0,Math.min(n-1,j))]);
});
function openItem(i){
 hideTip(true);
 var span=fDate(i.start)+", "+fTime(i.start)+(i.end||i.resolved?" - "+fTime(itemEnd(i)):"");
 dlg.innerHTML='<div class="dl"><div class="dl-h"><h3 id="dlg-t">'+esc(L(i.title))+'</h3><button class="close" type="button" aria-label="'+esc(t("close"))+'">×</button></div>'+
  '<dl class="meta"><dt>'+esc(t("when"))+'</dt><dd>'+esc(span)+'</dd>'+
  '<dt>'+esc(t("dur"))+'</dt><dd>'+esc(dur(new Date(itemEnd(i))-new Date(i.start)))+(i.resolved?"":" ("+esc(t("ongoing"))+")")+'</dd>'+
  '<dt>'+esc(t("impact"))+'</dt><dd><span class="pill '+i.impact+'">'+esc(t(i.impact==="maintenance"?"maintenance":i.impact))+'</span><span class="pill '+(i.resolved?"ok":i.impact)+'">'+esc(i.resolved?t("resolved"):t("ongoing"))+'</span></dd>'+
  '<dt>'+esc(t("affected"))+'</dt><dd>'+i.components.map(compName).map(esc).join(", ")+'</dd></dl>'+
  '<div><h3>'+esc(t("upd"))+'</h3><ol class="tl">'+i.updates.map(function(u){return '<li><span class="st">'+esc(t("s_"+u.status))+'<time>'+esc(fDate(u.at)+" "+fTime(u.at))+'</time></span><p>'+esc(L(u.text))+'</p></li>'}).join("")+'</ol></div></div>';
 dlg.querySelector(".close").onclick=function(){dlg.close()};
 if(dlg.showModal)dlg.showModal();else dlg.setAttribute("open","");
 try{history.replaceState(null,"","#"+i.id)}catch(e){}
}
dlg.addEventListener("click",function(e){if(e.target===dlg)dlg.close()});
dlg.addEventListener("close",function(){try{history.replaceState(null,"",location.pathname+location.search)}catch(e){}});
function setLang(l){lang=l;try{localStorage.setItem("lang",l)}catch(e){}render()}
document.getElementById("l-it").onclick=function(){setLang("it")};document.getElementById("l-en").onclick=function(){setLang("en")};
var first=true;
function load(){fetch("/api/status.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){data=d;render();
 if(first){first=false;var h=location.hash.slice(1);if(h){var i=data.items.find(function(x){return x.id===h});if(i)openItem(i)}}}).catch(function(){})}
render();load();setInterval(load,60000);setInterval(function(){if(data&&!data.stale)document.getElementById("b-s").textContent=t(data.interno?"both":"ext",{a:ago(data.checkedAt)})},15000);
})();
</script>
</body>
</html>`
}
