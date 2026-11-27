/* Dupe Checker: sync History between your devices through a private GitHub repo of yours.

   Why GitHub: history keeps the raw contest files (several MB), far beyond what ntfy can hold, and a private
   repo is free, reliable and only readable with your token. The token is a fine-grained personal access token
   limited to that one repo with Contents read/write. It's stored only in this browser (localStorage "dupeSync").

   Layout in the repo (branch = the repo's default):
     history/index.json.gz        gzip JSON {format, version, updatedAt, device, settings, contests, legacy, deleted, sources}
                                  (the same records the History stores locally, plus deletions so they spread too)
     history/src/<hash>.bin       one raw file, deflate-compressed exactly as stored locally. Named by content hash,
                                  so a file is uploaded once and never changes.

   One sync: read index (remember its sha) -> merge into this device (download only files it lacks) ->
   if this device has anything the index lacks, upload missing files then write the index with that sha.
   If another device wrote in between, GitHub refuses the write (409) and we start over from its copy.
   Runs on page load, a few seconds after any change, and when the page comes back to the foreground.
*/
(function(root){
'use strict';
const DB = root.DupeDB;
const KEY = 'dupeSync', API = 'https://api.github.com', INDEX = 'history/index.json.gz', FORMAT = 'dfs-contest-history-sync', VERSION = 1;
const LS = {get(k,d){ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } }, set(k,v){ try{ v==null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }};
const cfg = () => LS.get(KEY, null);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const timeStr = t => new Date(t).toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
const dayStr = t => { const d = new Date(t), n = new Date(); return d.toDateString()===n.toDateString() ? timeStr(t) : d.toLocaleDateString('en-US',{month:'short', day:'numeric'})+' '+timeStr(t); };

let state = {busy:false, text:'', bad:false};
function setState(text, bad, busy=false){ state = {text, bad, busy}; paint(); }

// ---------- GitHub ----------
class GHError extends Error { constructor(status, msg){ super(msg); this.status = status; } }
async function gh(path, {method='GET', body, raw, token}={}){
  const c = cfg(); token = token || (c && c.token);
  let r;
  try{
    r = await fetch(API+path, {method, cache:'no-store', body: body ? JSON.stringify(body) : undefined,
      headers: {Authorization: 'Bearer '+token, Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? {'Content-Type':'application/json'} : {})}});
  }catch(e){ throw new GHError(0, 'No connection to GitHub.'); }
  if(r.ok) return r;
  let m = ''; try{ m = (await r.json()).message || ''; }catch(e){}
  if(r.status===401) throw new GHError(401, 'GitHub rejected the token (it may have expired). Set up sync again with a new token.');
  if(r.status===403 && /rate limit/i.test(m)) throw new GHError(403, 'GitHub rate limit reached; will try again later.');
  if(r.status===403) throw new GHError(403, 'The token can\'t write to that repo. It needs Contents: Read and write on it.');
  throw new GHError(r.status, `GitHub ${r.status}${m ? ': '+m : ''}`);
}
const contentsPath = (repo, p) => `/repos/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
async function gzip(obj){ return new Uint8Array(await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
async function gunzip(bytes){ return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()); }

async function readIndex(repo){
  let r;
  try{ r = await gh(contentsPath(repo, INDEX)); }
  catch(e){ if(e.status===404) return {sha:null, data:null}; throw e; }
  const j = await r.json();
  let bytes;
  if(j.encoding==='base64' && j.content) bytes = DB.unb64(j.content.replace(/\s/g,''));
  else bytes = new Uint8Array(await (await gh(`/repos/${repo}/git/blobs/${j.sha}`, {raw:true})).arrayBuffer()); // over 1 MB: fetch the exact blob
  const data = await gunzip(bytes);
  if(data.format!==FORMAT) throw new Error('The sync repo holds something else at '+INDEX+'.');
  if(data.version > VERSION) throw new Error('Another device synced with a newer version of this page. Reload to update.');
  return {sha: j.sha, data};
}
async function fetchSource(repo, hash){
  const r = await gh(contentsPath(repo, `history/src/${hash}.bin`), {raw:true});
  return new Uint8Array(await r.arrayBuffer());
}
async function putFile(repo, p, bytes, message, sha){
  return gh(contentsPath(repo, p), {method:'PUT', body: {message, content: DB.b64(bytes), ...(sha ? {sha} : {})}});
}

// ---------- sync ----------
const device = () => { let d = LS.get('dupeSyncDevice', null); if(!d){ d = (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'computer')+'-'+Math.random().toString(36).slice(2,6); LS.set('dupeSyncDevice', d); } return d; };
// what the index needs to match: ids + update times, legacy ids, deletions, settings time, file hashes
const fingerprint = s => JSON.stringify([(s.contests||[]).map(c=>[c.id, c.updatedAt||0]).sort((a,b)=>a[0]<b[0]?-1:1), (s.legacy||[]).map(l=>l.id).sort(),
  Object.entries(s.deleted||{}).sort(), (s.settings && s.settings.updatedAt)||0, Object.keys(s.sources||{}).sort()]);

async function once(repo){
  const {sha, data: remote} = await readIndex(repo);
  let applied = null;
  if(remote){
    applied = await DB.applyRemote(remote, h=>fetchSource(repo, h));
    if(applied.any) root.dispatchEvent(new CustomEvent('dupesync-applied', {detail: applied}));
  }
  const local = await DB.snapshot();
  if(remote && fingerprint(local)===fingerprint(remote)) return {applied, wrote:false};
  const have = new Set(Object.keys((remote && remote.sources) || {}));
  const missing = Object.keys(local.sources).filter(h=>!have.has(h));
  let n = 0;
  for(const h of missing){
    setState(`Uploading files to your sync repo (${++n} of ${missing.length})…`, false, true);
    const bytes = await DB.getSourceBytes(h); if(!bytes) continue;
    try{ await putFile(repo, `history/src/${h}.bin`, bytes, `Add file ${h}`); }
    catch(e){ if(e.status!==422) throw e; } // 422 = already there (an earlier sync uploaded it); content-addressed, so fine
  }
  const out = {format: FORMAT, version: VERSION, updatedAt: Date.now(), device: device(), ...local};
  try{ await putFile(repo, INDEX, await gzip(out), `History from ${device()}: ${local.contests.length} contests`, sha); }
  catch(e){ if(e.status===409 || (e.status===422 && !sha)) return 'conflict'; throw e; } // someone else wrote first: merge again
  return {applied, wrote:true};
}

let running = null, again = false, timer = null;
function syncNow(){
  const c = cfg(); if(!c) return Promise.resolve(null);
  if(running){ again = true; return running; }
  running = (async()=>{
    setState('Syncing…', false, true);
    try{
      let r;
      for(let i=0; i<4; i++){ r = await once(c.repo); if(r!=='conflict') break; }
      if(r==='conflict') throw new Error('Other devices kept writing at the same time; will try again shortly.');
      const a = r.applied, bits = [];
      if(a && a.added) bits.push(`${a.added} new from your other devices`);
      if(a && a.updated) bits.push(`${a.updated} updated`);
      if(a && a.removed) bits.push(`${a.removed} removed`);
      LS.set(KEY, {...cfg(), lastSync: Date.now(), lastError: null});
      setState(`Synced at ${timeStr(Date.now())}${bits.length ? ' ('+bits.join(', ')+')' : ''}.`, false);
      return r;
    }catch(e){
      console.error(e);
      LS.set(KEY, {...(cfg()||c), lastError: e.message});
      setState('Sync failed: '+e.message+(e.status===401||e.status===403 ? '' : ' Your history is safe on this device.'), true);
      if(e.status!==401) schedule(60e3);
      return null;
    }finally{
      running = null;
      if(again){ again = false; schedule(1500); }
    }
  })();
  return running;
}
function schedule(ms){ clearTimeout(timer); timer = setTimeout(syncNow, ms); }

// ---------- setup ----------
async function connect(token, repoIn){
  token = (token||'').trim(); repoIn = (repoIn||'').trim().replace(/^https?:\/\/github\.com\//,'').replace(/\.git$/,'').replace(/\/+$/,'');
  if(!token) throw new Error('Paste the token first.');
  if(!repoIn) repoIn = 'dfs-history';
  let repo = repoIn;
  if(!repo.includes('/')){ const u = await (await gh('/user', {token})).json(); repo = u.login+'/'+repo; }
  let info;
  try{ info = await (await gh('/repos/'+repo, {token})).json(); }
  catch(e){ if(e.status===404) throw new Error(`Can't see ${repo}. Check the name, and that the token was given access to it.`); throw e; }
  if(!info.private) throw new Error(`${repo} is public, so anyone could read your history. Make it private (repo Settings → Danger Zone → Change visibility), then try again.`);
  if(info.permissions && info.permissions.push===false) throw new Error('The token can only read that repo. Give it Contents: Read and write.');
  LS.set(KEY, {token, repo: info.full_name, since: Date.now()});
  return syncNow();
}
function disconnect(){ LS.set(KEY, null); setState('', false); paint(); }
// a link that sets up sync on another device (holds the token, so it's meant for your own devices only)
function setupLink(){ const c = cfg(); if(!c) return ''; const p = btoa(JSON.stringify({t:c.token, r:c.repo})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return location.origin + location.pathname + '#sync=' + p; }
function readSetupLink(){
  const m = /[#&]sync=([A-Za-z0-9_-]+)/.exec(location.hash); if(!m) return false;
  try{ history.replaceState(null, '', location.pathname + location.search); }catch(e){}
  try{ const o = JSON.parse(atob(m[1].replace(/-/g,'+').replace(/_/g,'/'))); if(o.t && o.r){ LS.set(KEY, {token:o.t, repo:o.r, since:Date.now()}); LS.set('aView','history'); return true; } }catch(e){}
  return false;
}

// ---------- UI (History tab, #syncBox) ----------
let box = null, showSetup = false, linkShown = false;
function mount(el){ box = el; paint(); }
function paint(){
  if(!box || !box.isConnected) return;
  const c = cfg();
  if(!c){
    box.innerHTML = `<div class="sync"><div class="row" style="justify-content:space-between"><div><b>Sync between devices: off.</b> <span class="muted small">History saved here stays in this browser.</span></div>
      ${showSetup ? '' : '<button class="sm primary" id="syBegin">Set up sync</button>'}</div>
      ${showSetup ? `<div class="note">Keeps your history in a private GitHub repo of yours, so your phone and computer see the same contests. Create a private repo (for example dfs-history) and a fine-grained token limited to it with Contents: Read and write, then paste them here. Do this once; the page then gives you a link that sets up your other devices.</div>
      <div class="row"><input type="password" id="syTok" placeholder="Token (github_pat_…)" autocomplete="off" autocapitalize="off" spellcheck="false" style="flex:2;min-width:220px">
      <input type="text" id="syRepo" placeholder="dfs-history" value="dfs-history" autocapitalize="off" spellcheck="false" style="flex:1;min-width:140px">
      <button class="sm primary" id="syGo">Connect</button><button class="sm" id="syCancel">Cancel</button></div>` : ''}
      ${state.text ? `<div class="small ${state.bad?'warn':'muted'}">${esc(state.text)}</div>` : ''}</div>`;
  } else {
    const txt = state.text || (c.lastError ? 'Last sync failed: '+c.lastError : c.lastSync ? `Last synced ${dayStr(c.lastSync)}.` : 'Not synced yet.');
    box.innerHTML = `<div class="sync"><div class="row" style="justify-content:space-between"><div><b>Syncing with your other devices</b> <span class="muted small">via ${esc(c.repo)}</span><div class="small ${state.bad||(!state.text&&c.lastError)?'warn':'muted'}">${esc(txt)}</div></div>
      <div class="row"><button class="sm" id="sySync" ${state.busy?'disabled':''}>Sync now</button><button class="sm" id="syLink">Set up another device</button><button class="sm" id="syOff">Turn off here</button></div></div>
      ${linkShown ? `<div class="note">Open this link on your other device (for example AirDrop it, or send it to yourself in Notes or a text). It contains your token, so keep it to your own devices.</div>
      <div class="row"><input type="text" id="syLinkTxt" readonly value="${esc(setupLink())}" style="flex:1;min-width:200px;font-size:12px"><button class="sm primary" id="syCopy">${navigator.share ? 'Share' : 'Copy'}</button></div>` : ''}</div>`;
  }
  const on = (id, f) => { const b = box.querySelector('#'+id); if(b) b.onclick = f; };
  on('syBegin', ()=>{ showSetup = true; paint(); });
  on('syCancel', ()=>{ showSetup = false; setState('', false); });
  on('syGo', async ()=>{ const t = box.querySelector('#syTok').value, r = box.querySelector('#syRepo').value; setState('Checking the token…', false, true);
    try{ await connect(t, r); showSetup = false; paint(); }catch(e){ setState(e.message, true); } });
  on('sySync', ()=>syncNow());
  on('syLink', ()=>{ linkShown = !linkShown; paint(); });
  on('syOff', ()=>{ const b = box.querySelector('#syOff'); if(b.dataset.confirm!=='1'){ b.dataset.confirm='1'; b.textContent='Stop syncing on this device?'; b.classList.add('primary'); return; } linkShown = false; disconnect(); });
  on('syCopy', async ()=>{ const url = setupLink();
    if(navigator.share){ try{ await navigator.share({title:'Dupe Checker sync', url}); return; }catch(e){ if(e.name==='AbortError') return; } }
    try{ await navigator.clipboard.writeText(url); box.querySelector('#syCopy').textContent = 'Copied'; }catch(e){ const i = box.querySelector('#syLinkTxt'); i.select(); } });
}

// ---------- start ----------
const fromLink = readSetupLink();
root.addEventListener('dupedb-change', ()=>{ if(cfg()) schedule(3000); });
document.addEventListener('visibilitychange', ()=>{ const c = cfg(); if(!document.hidden && c && !running && Date.now()-(c.lastSync||0) > 60e3) syncNow(); });
if(cfg()) setTimeout(syncNow, fromLink ? 0 : 500);

root.DupeSync = {syncNow, connect, disconnect, mount, setupLink, fingerprint, configured: ()=>!!cfg()};
})(window);
