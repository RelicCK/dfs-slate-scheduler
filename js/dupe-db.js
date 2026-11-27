/* Dupe Checker: history database (IndexedDB) with versioned schema, backup and restore.

   Database "dfsContestAnalytics" (separate from the scheduler's localStorage; never touches it).
   Stores (schema v1):
     meta     {key}            settings (tracked players), schema info
     contests {id}             one record per contest: identity, fee/prize model, source hashes,
                               set metadata, summary metrics (calcVersion-stamped, recomputable)
     sources  {hash}           raw input files, deflate-compressed. Lossless: every metric can be
                               recalculated from these with newer code.
     legacy   {id}             records imported from the original DFS Dupe Checker backup, kept verbatim
   Contest identity: "<site>|<contest ID>" (multiple contests on one slate stay separate).
   Saving the same contest again replaces that record in one transaction, so nothing is counted twice.
*/
(function(root){
'use strict';
const DB_NAME = 'dfsContestAnalytics', DB_VERSION = 1, BACKUP_FORMAT = 'dfs-contest-analytics-backup', BACKUP_VERSION = 1;
// schema migrations: index = version reached. Each runs inside the upgrade transaction.
const MIGRATIONS = {
  1(db){
    db.createObjectStore('meta', {keyPath:'key'});
    const c = db.createObjectStore('contests', {keyPath:'id'}); c.createIndex('date','date'); c.createIndex('savedAt','savedAt');
    db.createObjectStore('sources', {keyPath:'hash'});
    db.createObjectStore('legacy', {keyPath:'id'});
  },
  // 2(db, tx){ ... } add future migrations here; never edit an old one
};
let dbp = null;
function open(){
  if(dbp) return dbp;
  dbp = new Promise((resolve, reject)=>{
    if(!('indexedDB' in root)) return reject(new Error('This browser has no IndexedDB, so history can\'t be stored.'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ev => { const db = req.result, tx = req.transaction;
      for(let v = ev.oldVersion+1; v <= DB_VERSION; v++) MIGRATIONS[v](db, tx); };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; resolve(db); };
    req.onerror = () => { dbp = null; reject(req.error || new Error('Could not open the history database.')); };
    req.onblocked = () => reject(new Error('History database is open in an older tab. Close other tabs of this page and reload.'));
  });
  return dbp;
}
// run fn(stores) in one transaction; resolves after commit, rejects (and rolls back) on any error
async function tx(names, mode, fn){
  const db = await open();
  return new Promise((resolve, reject)=>{
    const t = db.transaction(names, mode); const st = {}; for(const n of [].concat(names)) st[n] = t.objectStore(n);
    let out; try{ out = fn(st, t); }catch(e){ try{ t.abort(); }catch(_){} reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined && out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error || new Error('History write failed.'));
    t.onabort = () => reject(t.error || new Error('History write was cancelled.'));
  });
}
const reqP = r => new Promise((res, rej)=>{ r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); });
async function getAll(store){ const db = await open(); return reqP(db.transaction(store).objectStore(store).getAll()); }
async function get(store, key){ const db = await open(); return reqP(db.transaction(store).objectStore(store).get(key)); }

// ---------- compression ----------
async function deflate(text){ const s = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw')); return new Uint8Array(await new Response(s).arrayBuffer()); }
async function inflate(bytes){ const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')); return new Response(s).text(); }
function b64(bytes){ let s=''; for(let i=0;i<bytes.length;i+=0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000)); return btoa(s); }
function unb64(str){ const bin = atob(str); const u = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; }

// ---------- API ----------
async function getSettings(){ return (await get('meta','settings')) || {key:'settings'}; }
async function putSettings(s){ await tx('meta','readwrite', st=>{ st.meta.put({...s, key:'settings', updatedAt: Date.now()}); }); changed(); }
// tell the sync module (dupe-sync.js) that history changed on this device
function changed(){ try{ root.dispatchEvent(new Event('dupedb-change')); }catch(e){} }
async function listContests(){ return getAll('contests'); }
async function getContest(id){ return get('contests', id); }
async function getSourceText(hash){ const s = await get('sources', hash); return s ? inflate(s.bytes) : null; }
async function getLegacy(id){ return get('legacy', id); }
// sources: [{hash, kind, fileName, text}] ; contest record built by the UI
async function saveContest(record, sources){
  const packed = [];
  for(const s of sources) packed.push({hash:s.hash, kind:s.kind, fileName:s.fileName, size:s.text.length, bytes: await deflate(s.text), savedAt: Date.now()});
  const existing = await getContest(record.id);
  record.savedAt = existing ? existing.savedAt : Date.now();
  record.updatedAt = Date.now();
  await tx(['contests','sources'], 'readwrite', st=>{
    for(const p of packed) st.sources.put(p);
    st.contests.put(record);
  });
  await gcSources(); changed();
  return {replaced: !!existing};
}
// a deletion is remembered (id -> time) so it reaches your other devices instead of the contest coming back from them
async function deleteContest(id){
  const del = await getDeleted();
  await tx(['contests','legacy','meta'], 'readwrite', st=>{ st.contests.delete(id); st.legacy.delete(id); st.meta.put({key:'deleted', map:{...del, [id]: Date.now()}}); });
  await gcSources(); changed();
}
async function getDeleted(){ return ((await get('meta','deleted')) || {}).map || {}; }
function refsOf(c){ const h = []; if(c.sources){ for(const v of Object.values(c.sources)) if(v) h.push(v); } for(const s of c.sets||[]) if(s.sourceHash) h.push(s.sourceHash); return h; }
async function gcSources(){
  const used = new Set((await listContests()).flatMap(refsOf));
  const db = await open(); const keys = await reqP(db.transaction('sources').objectStore('sources').getAllKeys());
  const drop = keys.filter(k=>!used.has(k)); if(!drop.length) return;
  await tx('sources','readwrite', st=>{ for(const k of drop) st.sources.delete(k); });
}
async function updateContestFields(id, patch){
  const c = await getContest(id); if(!c) throw new Error('Contest not found');
  Object.assign(c, patch, {updatedAt: Date.now()}); await tx('contests','readwrite', st=>{ st.contests.put(c); }); changed(); return c;
}
async function estimate(){ try{ return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; }catch(e){ return null; } }
async function persist(){ try{ return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }catch(e){ return false; } }

// ---------- backup ----------
async function exportBackup(){
  const contests = await listContests(), legacy = await getAll('legacy'), sources = await getAll('sources'), settings = await getSettings();
  const obj = {format: BACKUP_FORMAT, version: BACKUP_VERSION, dbVersion: DB_VERSION, app: 'Slate Locks · Dupe Checker', exportedAt: new Date().toISOString(),
    settings, contests, legacy, sources: sources.map(s=>({...s, bytes: b64(s.bytes)}))};
  const gz = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  return {blob: await new Response(gz).blob(), counts: {contests: contests.length, legacy: legacy.length, sources: sources.length}};
}
async function readBackupFile(file){
  const head = new Uint8Array(await file.slice(0,2).arrayBuffer());
  let text;
  if(head[0]===0x1f && head[1]===0x8b) text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  else text = await file.text();
  return JSON.parse(text);
}
// bring any known backup shape up to the current format
function migrateBackup(obj){
  if(!obj || typeof obj!=='object') throw new Error('Not a backup file.');
  if(obj.format === BACKUP_FORMAT){
    if(obj.version > BACKUP_VERSION) throw new Error(`This backup is from a newer version (${obj.version}). Reload the page to get the latest version first.`);
    // future: if(obj.version===1) obj = v1to2(obj);
    if(!Array.isArray(obj.contests) || !Array.isArray(obj.sources)) throw new Error('Backup is missing its contests or sources.');
    return obj;
  }
  // original DFS Dupe Checker export: {app:'DFS Dupe Checker', schemaVersion:1, trackedUsers, contests:[{fingerprint,...}]}, or a bare array
  const arr = Array.isArray(obj) ? obj : obj.contests;
  if(Array.isArray(arr) && (obj.app==='DFS Dupe Checker' || Array.isArray(obj) || arr.every(c=>c && c.fingerprint))){
    return {format: BACKUP_FORMAT, version: BACKUP_VERSION, fromLegacy: true,
      settings: Array.isArray(obj.trackedUsers) ? {trackedUsers: obj.trackedUsers} : null,
      contests: [], sources: [], legacy: arr.filter(c=>c && c.fingerprint).map(c=>({id: 'LEGACY|'+c.fingerprint, importedAt: Date.now(), record: c}))};
  }
  throw new Error('Unrecognised backup format.');
}
// merge: new contests added; an existing contest is replaced only if the backup copy is newer
async function importBackup(file, {applySettings=true}={}){
  const obj = migrateBackup(await readBackupFile(file));
  for(const c of obj.contests) if(!c || !c.id || !c.sources) throw new Error('A contest in the backup is malformed; nothing was imported.');
  const have = new Map((await listContests()).map(c=>[c.id, c]));
  const haveLegacy = new Set((await getAll('legacy')).map(x=>x.id));
  let added=0, replaced=0, skipped=0, legacyAdded=0;
  const srcByHash = new Map(obj.sources.map(s=>[s.hash, s]));
  await tx(['contests','sources','legacy','meta'], 'readwrite', st=>{
    for(const c of obj.contests){
      const cur = have.get(c.id);
      if(cur && (cur.updatedAt||0) >= (c.updatedAt||0)){ skipped++; continue; }
      for(const h of refsOf(c)){ const s = srcByHash.get(h); if(s) st.sources.put({...s, bytes: unb64(s.bytes)}); }
      st.contests.put(c); cur ? replaced++ : added++;
    }
    for(const l of obj.legacy||[]){ if(haveLegacy.has(l.id)){ skipped++; continue; } st.legacy.put(l); legacyAdded++; }
    if(applySettings && obj.settings && obj.settings.trackedUsers) st.meta.put({...(obj.settings||{}), key:'settings', updatedAt: Date.now()});
  });
  if(added || replaced || legacyAdded) changed();
  return {added, replaced, skipped, legacyAdded, settings: obj.settings, fromLegacy: !!obj.fromLegacy};
}

// ---------- sync support (used by dupe-sync.js) ----------
// Snapshot = everything another device needs, minus raw file bytes:
//   {settings, contests:[records], legacy:[records], deleted:{id: time}, sources:{hash: {kind, fileName, size, savedAt}}}
async function snapshot(){
  const [settings, contests, legacy, deleted, db] = await Promise.all([getSettings(), listContests(), getAll('legacy'), getDeleted(), open()]);
  const srcs = await reqP(db.transaction('sources').objectStore('sources').getAll());
  const sources = {}; for(const s of srcs) sources[s.hash] = {kind:s.kind, fileName:s.fileName, size:s.size, savedAt:s.savedAt};
  return {settings, contests, legacy, deleted, sources};
}
// Pure: what to take from a remote snapshot. A contest is taken when it's new here or the remote copy was updated later,
// unless it was deleted (on any device) after that update. Deletions win over older copies everywhere.
function planMerge(local, remote){
  const deleted = {...(local.deleted||{})};
  for(const [id, at] of Object.entries(remote.deleted||{})) if(!(deleted[id] >= at)) deleted[id] = at;
  const have = new Map((local.contests||[]).map(c=>[c.id, c]));
  const take = [], drop = [];
  for(const c of remote.contests||[]){
    if(!c || !c.id || !c.sources) continue;
    const cur = have.get(c.id), t = c.updatedAt || c.savedAt || 0;
    if(deleted[c.id] >= t) continue;
    if(!cur || (cur.updatedAt||0) < t) take.push(c);
  }
  for(const c of local.contests||[]) if(deleted[c.id] >= (c.updatedAt || c.savedAt || 0)) drop.push(c.id);
  const haveLegacy = new Set((local.legacy||[]).map(l=>l.id));
  const takeLegacy = (remote.legacy||[]).filter(l=>l && l.id && !haveLegacy.has(l.id) && !deleted[l.id]);
  for(const l of local.legacy||[]) if(deleted[l.id] && !drop.includes(l.id)) drop.push(l.id);
  const rs = remote.settings, ls = local.settings;
  const settings = rs && Array.isArray(rs.trackedUsers) && (rs.updatedAt||0) > ((ls && ls.updatedAt)||0) ? rs : null;
  const delChanged = JSON.stringify(deleted) !== JSON.stringify(local.deleted||{});
  return {take, takeLegacy, drop, deleted, settings, delChanged, any: !!(take.length || takeLegacy.length || drop.length || settings)};
}
// apply a remote snapshot; fetchSource(hash) -> Promise<Uint8Array> of the deflated file, called only for files this device lacks
async function applyRemote(remote, fetchSource){
  const local = await snapshot();
  const p = planMerge(local, remote);
  if(!p.any && !p.delChanged) return {...p, added:0, updated:0, removed:0};
  const need = new Set(); for(const c of p.take) for(const h of refsOf(c)) if(!local.sources[h]) need.add(h);
  const got = [];
  for(const h of need){ const meta = (remote.sources||{})[h] || {}; got.push({hash:h, kind:meta.kind, fileName:meta.fileName, size:meta.size, savedAt:meta.savedAt||Date.now(), bytes: await fetchSource(h)}); }
  const haveIds = new Set(local.contests.map(c=>c.id));
  await tx(['contests','sources','legacy','meta'], 'readwrite', st=>{
    for(const s of got) st.sources.put(s);
    for(const c of p.take) st.contests.put(c);
    for(const l of p.takeLegacy) st.legacy.put(l);
    for(const id of p.drop){ st.contests.delete(id); st.legacy.delete(id); }
    st.meta.put({key:'deleted', map:p.deleted});
    if(p.settings) st.meta.put({...p.settings, key:'settings'});
  });
  if(p.drop.length) await gcSources();
  return {...p, added: p.take.filter(c=>!haveIds.has(c.id)).length + p.takeLegacy.length, updated: p.take.filter(c=>haveIds.has(c.id)).length, removed: p.drop.length};
}
async function getSourceBytes(hash){ const s = await get('sources', hash); return s ? s.bytes : null; }

root.DupeDB = {DB_NAME, DB_VERSION, open, getSettings, putSettings, listContests, getContest, getSourceText, getLegacy, getAll,
  saveContest, deleteContest, updateContestFields, exportBackup, importBackup, migrateBackup, readBackupFile, estimate, persist, deflate, inflate,
  snapshot, planMerge, applyRemote, getSourceBytes, b64, unb64};
})(typeof window!=='undefined' ? window : globalThis);
