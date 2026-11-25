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
async function putSettings(s){ return tx('meta','readwrite', st=>{ st.meta.put({...s, key:'settings', updatedAt: Date.now()}); }); }
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
  await gcSources();
  return {replaced: !!existing};
}
async function deleteContest(id){ await tx(['contests','legacy'], 'readwrite', st=>{ st.contests.delete(id); st.legacy.delete(id); }); await gcSources(); }
function refsOf(c){ const h = []; if(c.sources){ for(const v of Object.values(c.sources)) if(v) h.push(v); } for(const s of c.sets||[]) if(s.sourceHash) h.push(s.sourceHash); return h; }
async function gcSources(){
  const used = new Set((await listContests()).flatMap(refsOf));
  const db = await open(); const keys = await reqP(db.transaction('sources').objectStore('sources').getAllKeys());
  const drop = keys.filter(k=>!used.has(k)); if(!drop.length) return;
  await tx('sources','readwrite', st=>{ for(const k of drop) st.sources.delete(k); });
}
async function updateContestFields(id, patch){
  const c = await getContest(id); if(!c) throw new Error('Contest not found');
  Object.assign(c, patch, {updatedAt: Date.now()}); await tx('contests','readwrite', st=>{ st.contests.put(c); }); return c;
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
  return {added, replaced, skipped, legacyAdded, settings: obj.settings, fromLegacy: !!obj.fromLegacy};
}

root.DupeDB = {DB_NAME, DB_VERSION, open, getSettings, putSettings, listContests, getContest, getSourceText, getLegacy, getAll,
  saveContest, deleteContest, updateContestFields, exportBackup, importBackup, migrateBackup, readBackupFile, estimate, persist, deflate, inflate};
})(typeof window!=='undefined' ? window : globalThis);
