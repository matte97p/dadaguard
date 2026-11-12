// La pagina /admin: pubblicare un incidente o una manutenzione, aggiornarli, chiuderli. Sta dietro
// Cloudflare Access e il Worker verifica anche il token (access.js). Il template precompilato è un
// punto di partenza: il testo lo scrive chi pubblica.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function adminHtml({ nonce, site, components, user }) {
  const comps = JSON.stringify(components.map((c) => ({ id: c.id, name: c.name.it }))).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(site)} · Status admin</title>
<style nonce="${nonce}">
:root{--bg:#f6f7f4;--surface:#fff;--ink:#0f1a2b;--ink-2:#5b6370;--line:#dcded8;--brand:#e8770d;--ok:#0f8a5f;--down:#c62828;--warn:#a96a00}
@media (prefers-color-scheme:dark){:root{--bg:#0d121a;--surface:#151c27;--ink:#eef0ea;--ink-2:#a3acba;--line:#2a3342;--brand:#f39a3a;--ok:#35c48e;--down:#ff7a7a;--warn:#f0b43c;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px 16px 64px}
.wrap{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:24px}
h1{font-size:22px;margin:0}h2{font-size:17px;margin:0 0 12px}
.who{color:var(--ink-2);font-size:13px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600}
input,select,textarea{font:inherit;font-weight:400;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink)}
textarea{min-height:90px;resize:vertical}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:600px){.row{grid-template-columns:1fr}}
fieldset{border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-wrap:wrap;gap:8px 16px;margin:0}
fieldset label{flex-direction:row;align-items:center;gap:6px;font-weight:400}
legend{font-size:13px;font-weight:600;padding:0 4px}
button{font:600 14px/1 ui-sans-serif,system-ui,sans-serif;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
button.primary{background:var(--ink);color:var(--surface);border-color:var(--ink)}
button.danger{color:var(--down)}
.msg{font-size:13.5px;min-height:1.2em}.msg.err{color:var(--down)}.msg.ok{color:var(--ok)}
.item{border-top:1px solid var(--line);padding-top:14px;display:flex;flex-direction:column;gap:8px}
.item:first-child{border-top:0;padding-top:0}
.item h3{margin:0;font-size:15px}.item .m{font-size:12.5px;color:var(--ink-2)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
[hidden]{display:none!important}
</style>
</head>
<body>
<div class="wrap">
  <div><h1>${esc(site)} · Status admin</h1><p class="who">Accesso come ${esc(user)}. Ogni pubblicazione resta nel log con il tuo nome; il nome non compare sulla pagina pubblica.</p></div>

  <form class="card" id="new">
    <h2>Pubblica</h2>
    <div class="row">
      <label for="kind">Tipo<select id="kind"><option value="incident">Incidente</option><option value="maintenance">Manutenzione programmata</option></select></label>
      <label for="impact" id="impact-l">Impatto<select id="impact"><option value="degraded">Rallentato</option><option value="outage">Interruzione</option></select></label>
    </div>
    <fieldset id="comps"><legend>Componenti coinvolti</legend></fieldset>
    <div class="row">
      <label for="start">Inizio<input id="start" type="datetime-local"></label>
      <label for="end" id="end-l">Fine prevista<input id="end" type="datetime-local"></label>
    </div>
    <div class="row">
      <label for="t-it">Titolo (IT)<input id="t-it" maxlength="140"></label>
      <label for="t-en">Title (EN)<input id="t-en" maxlength="140"></label>
    </div>
    <div class="row">
      <label for="x-it">Primo aggiornamento (IT)<textarea id="x-it" maxlength="2000"></textarea></label>
      <label for="x-en">First update (EN)<textarea id="x-en" maxlength="2000"></textarea></label>
    </div>
    <div class="actions"><button class="primary" type="submit">Pubblica</button><button type="button" id="tpl">Usa il template</button></div>
    <p class="msg" id="msg" role="status"></p>
  </form>

  <section class="card"><h2>Aperti e recenti</h2><div id="list"></div></section>
</div>
<script nonce="${nonce}">
(function(){
var COMPS=${comps};
var ST={incident:[["investigating","Indagine"],["identified","Identificato"],["monitoring","Monitoraggio"],["resolved","Risolto"]],maintenance:[["scheduled","Programmata"],["in_progress","In corso"],["completed","Completata"]]};
var TPL={incident:{it:["Rallentamento su {c}","Stiamo verificando un rallentamento su {c}. Le altre funzioni non sono coinvolte. Prossimo aggiornamento entro 30 minuti."],en:["Degraded performance on {c}","We are looking into degraded performance on {c}. Other features are not affected. Next update within 30 minutes."]},
 maintenance:{it:["Manutenzione programmata: {c}","Aggiornamento programmato di {c}. Durante la finestra il servizio potrebbe non essere disponibile per pochi minuti."],en:["Planned maintenance: {c}","Planned upgrade of {c}. During the window the service may be unavailable for a few minutes."]}};
function $(id){return document.getElementById(id)}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
var fs=$("comps");COMPS.forEach(function(c){var l=document.createElement("label");l.innerHTML='<input type="checkbox" value="'+esc(c.id)+'"> '+esc(c.name);fs.appendChild(l)});
function kindUI(){var m=$("kind").value==="maintenance";$("impact-l").hidden=m}
$("kind").onchange=kindUI;kindUI();
function chosen(){return Array.prototype.slice.call(fs.querySelectorAll("input:checked")).map(function(i){return i.value})}
function names(){var ids=chosen();return COMPS.filter(function(c){return ids.indexOf(c.id)>=0}).map(function(c){return c.name}).join(", ")||"…"}
$("tpl").onclick=function(){var k=$("kind").value,n=names();$("t-it").value=TPL[k].it[0].replace("{c}",n);$("x-it").value=TPL[k].it[1].replace("{c}",n);$("t-en").value=TPL[k].en[0].replace("{c}",n);$("x-en").value=TPL[k].en[1].replace("{c}",n)};
function iso(v){return v?new Date(v).toISOString():null}
function api(path,body){return fetch(path,{method:body?"POST":"GET",headers:body?{"content-type":"application/json"}:{},body:body?JSON.stringify(body):undefined,credentials:"same-origin"}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("errore "+r.status));return j})})}
function say(el,txt,ok){el.textContent=txt;el.className="msg "+(ok?"ok":"err")}
$("new").onsubmit=function(e){e.preventDefault();var k=$("kind").value;
 api("/admin/api/items",{kind:k,impact:$("impact").value,components:chosen(),start:iso($("start").value),end:iso($("end").value),status:ST[k][0][0],
  title:{it:$("t-it").value,en:$("t-en").value},text:{it:$("x-it").value,en:$("x-en").value}})
 .then(function(){say($("msg"),"Pubblicato.",true);$("new").reset();kindUI();load()}).catch(function(err){say($("msg"),err.message,false)})};
function fmt(iso){return iso?new Date(iso).toLocaleString("it-IT",{dateStyle:"short",timeStyle:"short"}):""}
function load(){api("/admin/api/items").then(function(items){var box=$("list");box.innerHTML="";if(!items.length){box.textContent="Niente da mostrare.";return}
 items.forEach(function(i){var d=document.createElement("div");d.className="item";var st=ST[i.kind];
  d.innerHTML='<h3>'+esc(i.title.it)+'</h3><p class="m">'+(i.kind==="maintenance"?"Manutenzione":"Incidente "+(i.impact==="outage"?"(interruzione)":"(rallentamento)"))+' · '+esc(i.components.join(", "))+' · '+esc(fmt(i.start))+(i.end?' / '+esc(fmt(i.end)):'')+' · '+(i.resolved?"chiuso":"aperto")+' · ultimo: '+esc(i.updates[0].status)+'</p>'+
   (i.resolved?'':'<div class="row"><label>Stato<select class="s">'+st.map(function(s){return '<option value="'+s[0]+'">'+s[1]+'</option>'}).join("")+'</select></label>'+(i.kind==="incident"?'<label>Impatto<select class="im"><option value="degraded"'+(i.impact==="degraded"?" selected":"")+'>Rallentato</option><option value="outage"'+(i.impact==="outage"?" selected":"")+'>Interruzione</option></select></label>':'<span></span>')+'</div>'+
   '<div class="row"><label>Aggiornamento (IT)<textarea class="ti"></textarea></label><label>Update (EN)<textarea class="te"></textarea></label></div>')+
   '<div class="actions">'+(i.resolved?'':'<button class="primary up" type="button">Pubblica aggiornamento</button>')+'<button class="danger del" type="button">Elimina</button></div><p class="msg"></p>';
  var msg=d.querySelector(".msg");
  var up=d.querySelector(".up");if(up)up.onclick=function(){var im=d.querySelector(".im");api("/admin/api/items/"+i.id,{status:d.querySelector(".s").value,impact:im?im.value:undefined,text:{it:d.querySelector(".ti").value,en:d.querySelector(".te").value}}).then(function(){load()}).catch(function(err){say(msg,err.message,false)})};
  var del=d.querySelector(".del"),armed=false;del.onclick=function(){if(!armed){armed=true;del.textContent="Conferma: elimina davvero";return}api("/admin/api/items/"+i.id+"/delete",{}).then(function(){load()}).catch(function(err){say(msg,err.message,false)})};
  box.appendChild(d)})}).catch(function(err){$("list").textContent=err.message})}
load();
})();
</script>
</body>
</html>`
}
