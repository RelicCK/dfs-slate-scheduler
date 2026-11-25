/* Dupe Checker page. Calculations live in dupe-core.js, storage in dupe-db.js. */
(function(){
'use strict';
const C = window.DupeCore, DB = window.DupeDB;
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const LS = {get(k,d){ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } }, set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }};
const esc = x => String(x ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const ok = v => v!==null && v!==undefined && Number.isFinite(v);
const f = (v,d=2) => ok(v) ? v.toFixed(d) : '—';
const pc = (v,d=1) => ok(v) ? v.toFixed(d)+'%' : '—';
const sgn = (v,d=2,s='') => ok(v) ? (v>0?'+':'')+v.toFixed(d)+s : '—';
const money = v => ok(v) ? '$'+v.toLocaleString('en-US',{minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
const int = v => ok(v) ? Math.round(v).toLocaleString() : '—';
const cls = v => ok(v) ? (v>0?'pos':v<0?'neg':'') : '';
const LETTERS = 'ABCDEFGHIJ';
const DEFAULT_RAKE = 13; // % estimate when no prize pool or rake is entered for a contest
const rakeOf = m => ok(m.rakePct) ? m.rakePct : DEFAULT_RAKE;
const STRATS = ['', 'P90 Spread', 'ROI dupe mitigation', 'Top 1% (no mitigation)', 'Projection', 'Other'];

// ---------- state ----------
function slotDefault(i){ const d = LS.get('aSlot'+i, {}); return {name: d.name || 'Set '+LETTERS[i], strategy: d.strategy || '', mitigation: d.mitigation ?? null, version: d.version || '', text:null, fileName:'', parsed:null, error:''}; }
const S = {stdText:null, stdFile:'', std:null, projText:null, projFile:'', proj:null, sets: Array.from({length:10}, (_,i)=>slotDefault(i)),
  overrides:{}, winnings:{}, meta:{site:'DK', sport:'', date:'', name:'', contestId:'', fee:null, prizePool:null, rakePct:null},
  A:null, setRes:[], historyId:null, legacy:false};
let view = LS.get('aView','overview');
const sortState = {};
let tracked = LS.get('aTracked', null) || ['relicck','','','','',''];
const trackedList = () => tracked.map(x=>x.trim()).filter(Boolean);
const me = () => trackedList()[0] || '';

// ---------- status ----------
function status(t, bad){ const el=$('#status'); el.textContent=t; el.classList.toggle('warn', !!bad); }
function msg(html){ $('#msg').innerHTML = html||''; }

// ---------- inputs ----------
function renderTracked(){
  $('#tracked').innerHTML = tracked.map((u,i)=>`<input type="text" data-tu="${i}" value="${esc(u)}" placeholder="${i? 'Player '+i : 'You'}" autocapitalize="off" spellcheck="false" aria-label="${i?'Tracked player '+i:'Your username'}">`).join('');
}
$('#tracked').addEventListener('change', e=>{ const i = e.target.dataset.tu; if(i===undefined) return;
  tracked[+i] = e.target.value.trim(); LS.set('aTracked', tracked);
  DB.getSettings().then(s=>DB.putSettings({...s, trackedUsers: tracked})).catch(()=>{});
  render(); });
function metaToInputs(){ const m=S.meta; $('#mSite').value=m.site||'DK'; $('#mSport').value=m.sport||''; $('#mDate').value=m.date||''; $('#mName').value=m.name||''; $('#mId').value=m.contestId||'';
  $('#mFee').value = ok(m.fee)?m.fee:''; $('#mPool').value = ok(m.prizePool)?m.prizePool:''; $('#mRake').value = ok(m.rakePct)?m.rakePct:''; }
function inputsToMeta(){ const n = v => { const x = C.num(v); return x===null ? null : x; };
  Object.assign(S.meta, {site:$('#mSite').value, sport:$('#mSport').value.trim().toUpperCase(), date:$('#mDate').value.trim(), name:$('#mName').value.trim(), contestId:$('#mId').value.trim(),
    fee:n($('#mFee').value), prizePool:n($('#mPool').value), rakePct:n($('#mRake').value)}); }
for(const id of ['mSite','mSport','mDate','mName','mId']) $('#'+id).addEventListener('change', ()=>{ inputsToMeta(); renderFiles(); });
for(const id of ['mFee','mPool','mRake']) $('#'+id).addEventListener('change', ()=>{ inputsToMeta(); recompute(); render(); });
function payNote(){
  const A = S.A, el = $('#payNote');
  if(!A){ el.textContent=''; return; }
  if(!A.table){ el.innerHTML = 'Enter the entry fee to estimate payouts and ROI. Without it ROI shows "—", never 0.'; return; }
  const t = A.table;
  el.innerHTML = `Estimated payouts: pool ${money(t.pool)} ${S.meta.prizePool ? '(entered)' : `= ${int(A.fieldSize)} entries × ${money(A.fee)} − ${rakeOf(S.meta)}% rake${ok(S.meta.rakePct) ? '' : ' (default estimate)'}`}. ${int(t.paid)} paid (20%), 1st ${money(t.first)} (30%), min cash ${money(t.minCash)}. ${t.notes.map(esc).join(' ')}`;
}
function renderFiles(){
  const set = (id, name, sub) => { const el=$(id); el.classList.toggle('ok', !!name); const fn=el.querySelector('.fn'); fn.textContent = name || sub; fn.title = name || ''; fn.classList.toggle('muted', !name); };
  set('#uStd', S.stdFile, 'CSV or ZIP from DraftKings');
  set('#uProj', S.projFile, 'Name, DFS ID, FLEX/CPT Proj, Own');
  $('#saveBtn').disabled = !S.std || S.legacy;
  $('#saveBtn').textContent = S.historyId ? 'Update in history' : 'Save to history';
  payNote();
}

// ---------- reading files ----------
async function unzipFirstCsv(file){
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let eocd = -1; for(let i=buf.length-22; i>=Math.max(0, buf.length-65557); i--) if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; }
  if(eocd<0) throw new Error('Not a ZIP file.');
  let p = dv.getUint32(eocd+16,true); const n = dv.getUint16(eocd+10,true);
  for(let k=0;k<n;k++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    const method = dv.getUint16(p+10,true), csize = dv.getUint32(p+20,true), nl = dv.getUint16(p+28,true), xl = dv.getUint16(p+30,true), cl = dv.getUint16(p+32,true), lho = dv.getUint32(p+42,true);
    const name = new TextDecoder().decode(buf.subarray(p+46, p+46+nl));
    p += 46+nl+xl+cl;
    if(!/\.csv$/i.test(name)) continue;
    const start = lho + 30 + dv.getUint16(lho+26,true) + dv.getUint16(lho+28,true), data = buf.subarray(start, start+csize);
    if(method===0) return {name, text: new TextDecoder().decode(data)};
    if(method===8) return {name, text: await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text()};
    throw new Error('Unsupported ZIP compression in '+name);
  }
  throw new Error('No CSV inside the ZIP.');
}
async function readAny(file){ if(/\.zip$/i.test(file.name)){ const z = await unzipFirstCsv(file); return {name: z.name.split('/').pop(), text: z.text}; } return {name:file.name, text: await file.text()}; }
function kindOf(text){
  const h = (C.parseCSV(text.slice(0, 4000))[0]||[]).map(x=>x.trim().toUpperCase());
  if(h.includes('LINEUP') && (h.includes('ENTRYID') || h.includes('ENTRYNAME'))) return 'std';
  if(h.includes('CPT') && h.includes('FLEX')) return 'set';
  if(h.includes('FLEX PROJ') || h.includes('DFS ID') || (h.includes('NAME') && h.some(x=>/PROJ/.test(x)))) return 'proj';
  return null;
}
async function handleFiles(files, forced){
  for(const file of files){
    try{
      status('Reading '+file.name+'…');
      const {name, text} = await readAny(file);
      const kind = forced || kindOf(text);
      if(kind==='std') await loadStandings(text, name);
      else if(kind==='proj') loadProjections(text, name);
      else if(kind==='set'){ const i = S.sets.findIndex(s=>!s.parsed); if(i<0){ msg('<span class="warn">All 10 lineup-set slots are full. Clear one first.</span>'); continue; } loadSet(i, text, name); }
      else msg(`<span class="warn">${esc(name)}: not a standings, projections or lineup-set CSV.</span>`);
    }catch(e){ console.error(e); msg(`<span class="warn">${esc(file.name)}: ${esc(e.message)}</span>`); }
  }
  recompute(); render();
}
async function loadStandings(text, name){
  const std = C.parseStandings(text, name);
  Object.assign(S, {stdText:text, stdFile:name, std, historyId:null, legacy:false, overrides:{}, winnings:{}});
  S.meta.contestId = std.contestId || S.meta.contestId;
  const sm = std.contestId ? schedulerMeta(std.contestId) : null;
  if(sm){ if(sm.name) S.meta.name = sm.name; const fee = C.num(sm.fee); if(fee!==null) S.meta.fee = fee; if(sm.sport && sm.sport!=='?') S.meta.sport = sm.sport; if(sm.site) S.meta.site = sm.site; if(sm.date && !S.meta.date) S.meta.date = sm.date; }
  // an already-saved contest: say so, and keep its saved details
  const id = contestKey();
  const saved = await DB.getContest(id).catch(()=>null);
  if(saved){ S.historyId = id; for(const k of ['sport','date','name','fee','prizePool','rakePct']) if(saved[k]!==undefined && saved[k]!==null && saved[k]!=='') S.meta[k]=saved[k]; S.overrides = saved.overrides||{}; S.winnings = saved.winnings||{}; }
  metaToInputs();
  msg(`${esc(name)}: ${int(std.entries.length)} entries, ${int(std.entries.length-std.skipped.length)} valid lineups${std.skipped.length?`, ${int(std.skipped.length)} skipped (no or invalid lineup)`:''}${std.dupIds?`, ${std.dupIds} repeated entry IDs ignored`:''}.` +
    (sm ? ` Contest details filled from your Slate Locks upload.` : '') + (saved ? ` <b>Already in history</b>: saving again updates that record.` : ''));
}
function loadProjections(text, name){
  const proj = C.parseProjections(text, name);
  Object.assign(S, {projText:text, projFile:name, proj});
  if(proj.date && !S.meta.date) S.meta.date = proj.date;
  if(proj.site) S.meta.site = proj.site;
  metaToInputs();
}
function loadSet(i, text, name){
  const s = S.sets[i];
  try{ s.parsed = C.parseLineupSet(text, name); s.error=''; if(s.parsed.sport && !S.meta.sport){ S.meta.sport = s.parsed.sport; metaToInputs(); } }
  catch(e){ s.parsed = null; s.error = e.message; }
  s.text = s.parsed ? text : null; s.fileName = name;
}
function schedulerMeta(cid){
  try{ const cm = LS.get('contestMeta', {}); if(cm[cid]) return cm[cid]; }catch(e){}
  try{ for(const s of Object.values(LS.get('slates', {}))) for(const c of s.contests||[]) if(String(c.id)===String(cid)) return {name:c.name, fee:c.fee, sport:s.sport, site:s.site, date:s.date}; }catch(e){}
  return null;
}
const contestKey = () => (S.meta.site||'DK')+'|'+(S.meta.contestId || (S.std ? 'h'+C.hashStr(S.std.entries.map(e=>e.id).join(',')) : ''));

// file pickers and drop
document.addEventListener('click', e=>{ const b = e.target.closest('[data-pick]'); if(!b) return; ({std:$('#fStd'), proj:$('#fProj')})[b.dataset.pick].click(); });
$('#fStd').onchange = e=>{ handleFiles([...e.target.files], 'std'); e.target.value=''; };
$('#fProj').onchange = e=>{ handleFiles([...e.target.files], 'proj'); e.target.value=''; };
document.body.addEventListener('dragover', e=>{ e.preventDefault(); document.body.classList.add('over'); });
document.body.addEventListener('dragleave', e=>{ if(!e.relatedTarget) document.body.classList.remove('over'); });
document.body.addEventListener('drop', e=>{ e.preventDefault(); document.body.classList.remove('over'); const fs=[...e.dataTransfer.files];
  const slot = e.target.closest('[data-slot]'); if(slot && fs.length===1){ readAny(fs[0]).then(({name,text})=>{ loadSet(+slot.dataset.slot, text, name); recompute(); render(); }); return; }
  handleFiles(fs); });
$('#clearAll').onclick = ()=>{ Object.assign(S, {stdText:null, stdFile:'', std:null, projText:null, projFile:'', proj:null, overrides:{}, winnings:{}, historyId:null, legacy:false, A:null, setRes:[]});
  S.sets = S.sets.map((s,i)=>slotDefault(i)); S.meta = {site:'DK', sport:'', date:'', name:'', contestId:'', fee:null, prizePool:null, rakePct:null}; LS.set('aOpen', null);
  metaToInputs(); msg(''); recompute(); render(); };

// ---------- compute ----------
function recompute(){
  if(!S.std){ S.A=null; S.setRes=[]; return; }
  const t0 = performance.now();
  S.A = C.analyzeContest(S.std, S.proj, {fee:S.meta.fee, prizePool:S.meta.prizePool, rakePct:rakeOf(S.meta), overrides:S.overrides});
  S.setRes = S.sets.map(s=>s.parsed ? C.setMetrics(S.A, s.parsed) : null);
  S.userCache = new Map();
  const ms = Math.round(performance.now()-t0);
  status(`${S.meta.site} ${S.meta.sport||''} ${S.std.format} · ${S.meta.name || (S.meta.contestId ? 'contest '+S.meta.contestId : S.stdFile)} · ${int(S.A.fieldSize)} entries${S.historyId?' · in history':''}${S.legacy?' · legacy record (read-only)':''}`.replace(/\s+/g,' '));
  void ms;
}
function userMetrics(u){
  if(!S.userCache) S.userCache = new Map();
  if(!S.userCache.has(u)){ const es = C.userEntries(S.A, u); S.userCache.set(u, es.length || C.userAllEntries(S.A,u).length ? C.portfolioMetrics(S.A, es, C.userAllEntries(S.A, u)) : null); }
  return S.userCache.get(u);
}
// portfolios: tracked users who entered, plus loaded lineup sets
function portfolios(){
  const out = [];
  for(const u of trackedList()){ const m = userMetrics(u); if(m && m.n) out.push({id:'u:'+u, label:u+(u===me()?' (you)':''), kind:'user', u}); }
  S.sets.forEach((s,i)=>{ if(S.setRes[i]) out.push({id:'s:'+i, label:s.name, kind:'set', i}); });
  return out;
}
const nid = n => C.normName(n);
function portfolioBuilds(pid){
  const A = S.A; if(!A || !pid) return {builds:[], slots:[], n:0};
  if(pid.startsWith('u:')){
    const m = userMetrics(pid.slice(2)); if(!m) return {builds:[], slots:[], n:0};
    const by = new Map();
    for(const r of m.rows){ let b = by.get(r.e.key); if(!b){ b = {key:r.e.key, cap:r.g.cap.join(', '), flex:r.g.flex, capId:nid(r.g.cap[0]||''), flexIds:r.g.flex.map(nid).sort(), proj:r.proj, times:r.times, dupes:r.dupes, entries:0, points:r.points}; by.set(r.e.key,b); } b.entries++; }
    return {builds:[...by.values()], slots: m.rows.map(r=>r.e.slots), n:m.n, hypothetical:false};
  }
  const i = +pid.slice(2), res = S.setRes[i]; if(!res) return {builds:[], slots:[], n:0};
  const by = new Map(), slots = [];
  for(const r of res.rows){ if(r.invalid || !r.key) continue;
    const names = r.res.names; slots.push([{role:'CPT', name:names[0]}, ...names.slice(1).map(n=>({role:'FLEX', name:n}))]);
    let b = by.get(r.key); if(!b){ const k = JSON.parse(r.key); b = {key:r.key, cap:names[0], flex:names.slice(1).sort((a,c)=>a.localeCompare(c)), capId:k[0][1][0], flexIds:k[1][1], proj:r.projCalc, times:r.timesIfEntered, dupes:r.dupes, entries:0, points:r.points}; by.set(r.key,b); }
    b.entries++; }
  return {builds:[...by.values()], slots, n:slots.length, hypothetical:true, unresolved: res.valid-res.resolved};
}
function portfolioSelect(id, cur){
  const ps = portfolios(); if(!ps.length) return '<span class="muted small">No tracked player entries or lineup sets loaded.</span>';
  return `<select id="${id}">${ps.map(p=>`<option value="${esc(p.id)}" ${p.id===cur?'selected':''}>${p.kind==='set'?'Set: ':''}${esc(p.label)}</option>`).join('')}</select>`;
}
function curPortfolio(key){ const ps = portfolios(); const v = LS.get(key, null); return ps.some(p=>p.id===v) ? v : (ps[0]?.id || null); }

// ---------- generic sortable table ----------
function table(id, cols, rows, opts={}){
  const st = sortState[id] || (opts.sort ? {k:opts.sort, dir: opts.dir || -1} : null);
  if(st){ const c = cols.find(c=>c.k===st.k); if(c){ const val = c.v || (r=>r[c.k]); rows = [...rows].sort((a,b)=>{ const x=val(a), y=val(b);
    if(x===y) return 0; if(x===null||x===undefined||(typeof x==='number'&&!Number.isFinite(x))) return 1; if(y===null||y===undefined||(typeof y==='number'&&!Number.isFinite(y))) return -1;
    return (typeof x==='string' ? x.localeCompare(y) : x-y) * st.dir; }); } }
  const lim = opts.limit ? (sortState[id+':lim'] || opts.limit) : Infinity, shown = rows.slice(0, lim);
  const head = '<tr>'+cols.map(c=>`<th class="${c.n?'n':''}" ${c.nosort?'':`data-sort="${c.k}"`} data-tbl="${id}" ${c.title?`title="${esc(c.title)}"`:''}>${c.label}${st&&st.k===c.k?(st.dir>0?' ▲':' ▼'):''}</th>`).join('')+'</tr>';
  const body = shown.map(r=>(opts.rowAttr? `<tr ${opts.rowAttr(r)}>` : '<tr>')+cols.map(c=>`<td class="${c.n?'n':''} ${c.cls||''}">${c.f ? c.f(r) : (c.n ? f(r[c.k]) : esc(r[c.k]))}</td>`).join('')+'</tr>'+(opts.after?opts.after(r):'')).join('');
  const more = rows.length>shown.length ? `<div class="row" style="padding:8px"><button class="sm" data-more="${id}">Show more (${int(rows.length-shown.length)} left)</button></div>` : '';
  return `<div class="tw ${opts.free?'free':''}"><table id="${id}"><thead>${head}</thead><tbody>${body || `<tr><td colspan="${cols.length}" class="empty">${opts.empty||'Nothing to show.'}</td></tr>`}</tbody></table>${more}</div>`;
}
document.addEventListener('click', e=>{
  const th = e.target.closest('th[data-sort]');
  if(th){ const id = th.dataset.tbl, k = th.dataset.sort, cur = sortState[id]; sortState[id] = {k, dir: cur && cur.k===k ? -cur.dir : (th.classList.contains('n') ? -1 : 1)}; renderView(); return; }
  const m = e.target.closest('[data-more]'); if(m){ sortState[m.dataset.more+':lim'] = (sortState[m.dataset.more+':lim'] || 300) + 500; renderView(); }
});
function download(name, rows){ const b = new Blob([C.toCSV(rows)], {type:'text/csv'}); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 1000); }
const tiles = list => `<div class="tiles">${list.filter(Boolean).map(([v,l,t])=>`<div class="tile" ${t?`title="${esc(t)}"`:''}><b>${v}</b><span>${l}</span></div>`).join('')}</div>`;
const needStd = () => `<div class="card empty">Add a contest standings file above (CSV or the ZIP from DraftKings), or open a saved contest from <button class="sm" data-tab="history">History</button>.</div>`;
const needProj = () => `<div class="card empty">Add the player projections CSV to see projections, contest loss and efficiency gaps.</div>`;
const timesPill = t => `<span class="pill ${t===1?'uniq':'dup'}">${t===1?'Unique':t+'×'}</span>`;
const lineupCell = (cap, flex) => `<b>${esc(cap)}</b> <span class="muted">·</span> ${flex.map(esc).join(' · ')}`;

// ---------- tabs ----------
document.addEventListener('click', e=>{ const t = e.target.closest('[data-tab]'); if(!t) return; view = t.dataset.tab; LS.set('aView', view); render(); if(t.closest('#inputs')) $('#tabs').scrollIntoView({behavior:'smooth'}); });
function render(){ renderFiles(); $$('#tabs [data-tab]').forEach(b=>b.classList.toggle('on', b.dataset.tab===view)); renderView(); }
function renderView(){
  const el = $('#view');
  try{
    const fn = VIEWS[view] || VIEWS.overview;
    const out = fn(el); if(typeof out==='string'){ el.innerHTML = out; BIND[view] && BIND[view](el); }
  }catch(e){ console.error(e); el.innerHTML = `<div class="card warn">Something went wrong drawing this tab: ${esc(e.message)}</div>`; }
}

// ---------- views ----------
const BUCKETS = [['1×',1,1],['2–5×',2,5],['6–10×',6,10],['11–25×',11,25],['26–50×',26,50],['51–100×',51,100],['101×+',101,Infinity]];
function distBars(times){ const n = times.length, c = BUCKETS.map(([,lo,hi])=>times.filter(t=>t>=lo&&t<=hi).length), mx = Math.max(1,...c);
  return BUCKETS.map((b,i)=>`<div class="bar"><span>${b[0]}</span><div class="t"><i style="width:${c[i]/mx*100}%"></i></div><span class="v">${int(c[i])} <span class="muted">(${n?(c[i]/n*100).toFixed(1):'0.0'}%)</span></span></div>`).join(''); }
const dsCells = d => [int(d.n), f(d.avg), f(d.median,0), f(d.p75,0), f(d.p90,0), f(d.max,0), pc(d.unique), pc(d.le1), pc(d.le4)];
const DS_HEAD = '<th class="n">Entries</th><th class="n">Avg dupes</th><th class="n">Median</th><th class="n">P75</th><th class="n">P90</th><th class="n">Max</th><th class="n">Unique</th><th class="n">≤1 dupe</th><th class="n">≤4 dupes</th>';
const VIEWS = {}, BIND = {};
const bindWinnings = el => el.querySelectorAll('[data-win]').forEach(i=>i.onchange=()=>{ const v = C.num(i.value); if(v===null) delete S.winnings[i.dataset.win]; else S.winnings[i.dataset.win] = v; renderView(); });

VIEWS.overview = () => {
  if(!S.A) return needStd();
  const A = S.A, std = S.std, times = A.valid.map(e=>A.groups.get(e.key).count), dupG = A.glist.filter(g=>g.count>1);
  const unique = times.filter(t=>t===1).length, mine = me() ? userMetrics(me()) : null;
  const reasons = {}; for(const e of std.skipped) reasons[e.invalid] = (reasons[e.invalid]||0)+1;
  const cov = A.glist.filter(g=>g.proj!==null).length;
  let h = tiles([[int(A.fieldSize),'Field size (all entries)','Every entry ID in the file; used for ranks and payouts'],[int(A.valid.length),'Valid lineups'],[int(std.skipped.length),'Skipped rows', Object.entries(reasons).map(([k,v])=>v+' '+k).join(', ')],
    [int(A.glist.length),'Distinct builds'],[int(dupG.length),'Duplicated builds'],[int(dupG.reduce((s,g)=>s+g.count,0)),'Entries in duplicated builds'],
    A.pm && [f(A.ceiling),'Contest ceiling','Highest complete projection among lineups actually played'],
    A.pm && [pc(cov/A.glist.length*100),'Builds with full projection', `${int(cov)} of ${int(A.glist.length)}; the rest are left out of projection metrics`]]);
  // you, your tracked players and the field, side by side. Field figures are per entry (every valid field entry counts once).
  const fd = C.dupeStats(times.map(t=>t-1));
  const gp = A.valid.map(e=>A.groups.get(e.key).proj);
  const fRank = A.valid.map(e=>C.rankFor(e.points, A.desc)).filter(ok);
  const fBestU = A.glist.filter(g=>g.count===1 && g.proj!==null).reduce((m,g)=>Math.max(m,g.proj), -Infinity);
  const fGap = A.pm ? C.mean(A.valid.map(e=>{ const g=A.groups.get(e.key); if(g.proj===null) return null; const b=A.bestAtOrBelow(g.count); return b ? b.proj-g.proj : null; })) : null;
  const field = {n:A.valid.length, distinct:A.glist.length, dupes:fd, avgProj:C.mean(gp), myMax:A.ceiling, bestU: ok(fBestU)?fBestU:null,
    avgContestLoss: ok(A.ceiling) && ok(C.mean(gp)) ? A.ceiling-C.mean(gp) : null, avgGap:fGap, avgPoints:C.mean(A.valid.map(e=>e.points)),
    top1: fRank.length ? fRank.filter(r=>r<=A.top1Cut).length/fRank.length*100 : null, top01: fRank.length ? fRank.filter(r=>r<=A.top01Cut).length/fRank.length*100 : null,
    roi: A.table && A.fee ? (A.table.pool/(A.fieldSize*A.fee)-1)*100 : null, exact:null};
  const players = trackedList().map(u=>{ const m = userMetrics(u), all = C.userAllEntries(A,u); if(!m || !m.n) return {u, m:null};
    const bu = portfolioBuilds('u:'+u).builds.filter(b=>b.times===1 && b.proj!==null).reduce((x,b)=>Math.max(x,b.proj), -Infinity);
    const w = C.num(S.winnings[C.baseUser(u)]);
    return {u, m:{...m, bestU: ok(bu)?bu:null, exact: w!==null && A.fee && all.length ? (w/(all.length*A.fee)-1)*100 : null}}; });
  const you = players[0]?.m;
  const g = (k, sub) => m => m ? (sub ? m[k]?.[sub] : m[k]) : null;
  const cmpRows = [ // [label, getter, decimals, suffix, better: 1 higher / -1 lower / 0 neutral, tip]
    ['Entries', g('n'), 0, '', 0, 'Valid lineups'],
    ['Distinct builds', g('distinct'), 0, '', 0],
    ['Distinct builds per entry', m=>m&&m.n ? m.distinct/m.n*100 : null, 1, '%', 0, 'Distinct lineups ÷ entries'],
    ['Unique entries', g('dupes','unique'), 1, '%', 1, 'Share of entries whose exact lineup nobody else played'],
    ['≤1 dupe', g('dupes','le1'), 1, '%', 1], ['≤4 dupes', g('dupes','le4'), 1, '%', 1],
    ['Avg dupes', g('dupes','avg'), 2, '', -1, 'Other entries with the same lineup, averaged over entries'],
    ['Median dupes', g('dupes','median'), 0, '', -1], ['P75 dupes', g('dupes','p75'), 0, '', -1], ['P90 dupes', g('dupes','p90'), 0, '', -1],
    ['Max times played', m=>m && ok(m.dupes.max) ? m.dupes.max+1 : null, 0, '×', -1],
    ...(A.pm ? [
    ['Avg projection', g('avgProj'), 2, '', 1, 'Per entry, fully projected lineups only'],
    ['Max projection', g('myMax'), 2, '', 1, 'Field: the contest ceiling'],
    ['Best unique projection', g('bestU'), 2, '', 1, 'Highest projection among lineups played only once'],
    ['Avg contest loss', g('avgContestLoss'), 2, '', -1, 'Contest ceiling − lineup projection'],
    ['Avg efficiency gap', g('avgGap'), 2, '', -1, 'Best field projection played no more often − lineup projection']] : []),
    ['Avg points', g('avgPoints'), 2, '', 1],
    ['Top 1%', g('top1'), 2, '%', 1, 'Share of entries ranked in the top 1% of the field'],
    ['Top 0.1%', g('top01'), 2, '%', 1],
    ['Est. realized ROI', g('roi'), 1, '%', 1, 'Modeled payouts (not real winnings). Field: the whole field, i.e. minus the rake'],
    ['Winnings $', 'win', 2, '', 0, 'Actual winnings from DraftKings, if you have them'],
    ['Exact ROI', g('exact'), 1, '%', 1, 'From the actual winnings entered above']];
  const v = (x,d,sx) => ok(x) ? (d===0 ? int(x) : x.toFixed(d))+sx : '—';
  const others = players.slice(1);
  const shown = cmpRows;
  h += `<div class="card"><h3>${esc(me()||'You')} vs tracked players and the field</h3>${you ? `<div class="tw free"><table><thead><tr><th>Stat</th><th class="n">${esc(me())}</th><th class="n">Field</th><th class="n" title="${esc(me())} − field">Diff</th>${others.map(p=>`<th class="n">${esc(p.u)}</th>`).join('')}</tr></thead><tbody>${shown.map(([l,get,d,sx,dir,tip])=>{
      if(get==='win'){ const inp = p => p.m ? `<input type="number" class="sm" data-win="${esc(C.baseUser(p.u))}" value="${S.winnings[C.baseUser(p.u)]??''}" step="any" min="0" style="width:88px" placeholder="optional">` : '';
        return `<tr><td title="${esc(tip)}">${l}</td><td class="n">${inp(players[0])}</td><td class="n muted">—</td><td></td>${others.map(p=>`<td class="n">${inp(p)}</td>`).join('')}</tr>`; }
      const y = get(you), fl = get(field), df = ok(y)&&ok(fl) ? y-fl : null;
      const c = !dir || !ok(df) || Math.abs(df)<1e-9 ? '' : (df*dir>0 ? 'pos' : 'neg');
      return `<tr><td ${tip?`title="${esc(tip)}"`:''}>${l}</td><td class="n"><b>${v(y,d,sx)}</b></td><td class="n">${v(fl,d,sx)}</td><td class="n ${c}">${l==='Entries'||l==='Distinct builds' ? '' : ok(df) ? (df>0?'+':'')+(d===0?Math.round(df):df.toFixed(d))+(sx==='%'?' pp':sx) : '—'}</td>${others.map(p=>`<td class="n">${p.m ? v(get(p.m),d,sx) : (l==='Entries' ? 'not entered' : '')}</td>`).join('')}</tr>`; }).join('')}</tbody></table></div>
    <div class="note">Field figures count every valid field entry once, the same way players' do. Diff is ${esc(me())} − field: green is better for you (more unique, higher projection, less given up), red is worse. pp = percentage points. Est. ROI needs the entry fee; type real winnings to get exact ROI.</div>` : `<div class="muted small">${esc(me()||'Your username')} has no entries in this contest.</div>`}</div>`;
  const rows = [['Field, per entry', C.dupeStats(times.map(t=>t-1))], ['Field, per distinct build', C.dupeStats(A.glist.map(g=>g.count-1))]];
  for(const u of trackedList()){ const m = userMetrics(u); rows.push([u+(u===me()?' (you)':''), m && m.n ? m.dupes : null]); }
  h += `<div class="grid2"><div class="card"><h3>Field: times played</h3>${distBars(times)}<div class="note">Share of valid field entries whose exact lineup was played that many times (including themselves).</div></div>
    <div class="card"><h3>${esc(me()||'You')}: times played</h3>${mine && mine.n ? distBars(mine.rows.map(r=>r.times)) : '<div class="muted small">No entries for this username in this contest.</div>'}</div></div>
    <div class="card"><h3>Duplication</h3><div class="tw free"><table><thead><tr><th>Portfolio</th>${DS_HEAD}</tr></thead><tbody>${rows.map(([l,d])=>`<tr><td class="nw">${esc(l)}</td>${d?dsCells(d).map(x=>`<td class="n">${x}</td>`).join(''):`<td colspan="9" class="muted">Not entered</td>`}</tr>`).join('')}</tbody></table></div>
    <div class="note">Dupes = other entries with the exact same lineup (times played − 1), so 0 = unique. Percentiles use nearest rank. "Per distinct build" counts each lineup once.</div></div>`;
  if(std.skipped.length) h += `<details class="exp card"><summary>${int(std.skipped.length)} skipped rows</summary><div class="small" style="margin-top:6px">${Object.entries(reasons).map(([k,v])=>`${int(v)} × ${esc(k)}`).join('<br>')}<div class="note">Skipped rows are excluded from duplication counts but still count toward the field size, ranks and prize pool.</div></div></details>`;
  return h;
};

VIEWS.mine = () => {
  if(!S.A) return needStd();
  const u = me(); if(!u) return '<div class="card empty">Enter your username in the first tracked-player box.</div>';
  const m = userMetrics(u); const all = C.userAllEntries(S.A, u);
  if(!m || !all.length) return `<div class="card empty">${esc(u)} has no entries in this contest.</div>`;
  const q = (LS.get('aMineQ','')||'').toLowerCase();
  const rows = m.rows.filter(r=>!q || r.e.lineup.toLowerCase().includes(q)).map(r=>({...r, cap:r.g.cap.join(', '), flex:r.g.flex, delta: r.proj!==null && r.points!==null ? r.points-r.proj : null, id:r.e.id}));
  const win = C.num(S.winnings[C.baseUser(u)]);
  const exact = win!==null && S.A.fee ? (win/(all.length*S.A.fee)-1)*100 : null;
  let h = tiles([[int(m.n)+(m.invalidCount?` <span class="small muted">+${m.invalidCount} invalid</span>`:''),'Entries'],[int(m.distinct),'Distinct builds'],[int(Math.round((m.dupes.unique||0)*m.n/100)),'Unique entries'],
    [f(m.dupes.avg),'Avg dupes'],[f(m.dupes.median,0),'Median dupes'],[f(m.dupes.p90,0),'P90 dupes'],[f(m.avgProj),'Avg projection'],[f(m.avgPoints),'Avg points'],
    [pc(m.top1),'Top 1%', `${m.top1n} of ${m.rankedN}`],
    exact!==null ? [pc(exact),'Exact ROI','From the winnings you entered'] : [pc(m.roi),'Est. realized ROI', S.A.table ? 'Modeled payouts, not your real winnings' : 'Enter the entry fee']]);
  h += `<div class="card"><div class="row" style="justify-content:space-between"><input type="text" id="mineQ" placeholder="Search players" value="${esc(q)}" style="max-width:260px"><span class="muted small">${int(rows.length)} entries</span><button class="sm" id="mineCsv">Download CSV</button></div></div>`;
  h += table('tMine', [
    {k:'times', label:'Played', n:1, f:r=>timesPill(r.times)}, {k:'dupes', label:'Dupes', n:1, f:r=>r.dupes},
    {k:'cap', label:'Lineup (CPT · FLEX)', cls:'fx', f:r=>lineupCell(r.cap, r.flex)},
    {k:'points', label:'Points', n:1}, {k:'rank', label:'Rank', n:1, f:r=>int(r.rank)}, {k:'proj', label:'Proj', n:1}, {k:'delta', label:'Pts − Proj', n:1, f:r=>`<span class="${cls(r.delta)}">${sgn(r.delta)}</span>`},
    {k:'payout', label:'Est. payout', n:1, f:r=>money(r.payout)}, {k:'id', label:'Entry ID', cls:'nw tiny'}], rows, {sort:'times', limit:300});
  if(m.invalidCount) h += `<div class="note">${m.invalidCount} of your entries had no valid lineup; they count toward ROI cost.</div>`;
  return h;
};
BIND.mine = el => { const q = el.querySelector('#mineQ'); if(q) q.oninput = ()=>{ LS.set('aMineQ', q.value); const pos=q.selectionStart; renderView(); const n=$('#mineQ'); n.focus(); n.setSelectionRange(pos,pos); };
  const b = el.querySelector('#mineCsv'); if(b) b.onclick = ()=>{ const m = userMetrics(me());
    download(`${me()}-lineups-${S.meta.contestId||'contest'}.csv`, [['Times Played','Dupes (other entries)','CPT','FLEX','Points','Rank','Projection','Points minus Projection','Est. Payout','Entry Name','Entry ID'],
      ...m.rows.map(r=>[r.times, r.dupes, r.g.cap.join(' | '), r.g.flex.join(' | '), r.points, r.rank, r.proj, r.proj!==null&&r.points!==null? +(r.points-r.proj).toFixed(2):'', r.payout!==null? +r.payout.toFixed(2):'', r.e.name, r.e.id])]); }; };

VIEWS.players = () => {
  if(!S.A) return needStd();
  const A = S.A, pid = curPortfolio('aPlPort'), P = portfolioBuilds(pid);
  const pe = new Map(); for(const sl of P.slots) for(const s of sl){ const n = nid(s.name); const z = pe.get(n) || {cpt:0, flex:0}; C.roleClass(s.role)==='FLEX' ? z.flex++ : z.cpt++; pe.set(n,z); }
  const vn = Math.max(1, A.valid.length), pn = Math.max(1, P.slots.length), q = (LS.get('aPlQ','')||'').toLowerCase();
  const res = (n, role) => A.results.get(n+'|'+role);
  const names = new Set([...A.fieldExp.keys(), ...pe.keys()]);
  const rows = [...names].map(n=>{ const fx = A.fieldExp.get(n) || {name: (P.slots.flat().find(s=>nid(s.name)===n)||{}).name || n, cpt:0, flex:0}, p = pe.get(n) || {cpt:0, flex:0}, pr = A.projOf(fx.name);
    const r = {name: fx.name, fCpt: fx.cpt/vn*100, pCpt: p.cpt/pn*100, fFlex: fx.flex/vn*100, pFlex: p.flex/pn*100,
      dCpt: res(n,'CPT')?.drafted ?? null, dFlex: res(n,'FLEX')?.drafted ?? null, cptProj: pr?.cptProj ?? null, flexProj: pr?.flexProj ?? null, cptOwn: pr?.cptOwn ?? null, flexOwn: pr?.flexOwn ?? null,
      cptPts: res(n,'CPT')?.fpts ?? null, flexPts: res(n,'FLEX')?.fpts ?? null};
    r.cDiff = r.pCpt - r.fCpt; r.fDiff = r.pFlex - r.fFlex; return r; }).filter(r=>!q || r.name.toLowerCase().includes(q));
  const pcol = (k,l,t) => ({k, label:l, n:1, title:t, f:r=>pc(r[k])});
  const dcol = (k,l,t) => ({k, label:l, n:1, title:t, f:r=>`<span class="${cls(r[k])}">${sgn(r[k],1,'%')}</span>`});
  return `<div class="card"><div class="row"><label class="row small">Portfolio ${portfolioSelect('plPort', pid)}</label><input type="text" id="plQ" placeholder="Search player" value="${esc(q)}" style="max-width:220px"></div>
    <div class="note">CPT and FLEX are separate everywhere: field % = share of ${int(A.valid.length)} valid field entries with that player in that role; portfolio % = share of ${int(P.slots.length)} portfolio entries${P.unresolved?` (${P.unresolved} unresolved set lineups left out)`:''}. DK %Drafted is DraftKings' own figure from the standings file.</div></div>` +
    table('tPl', [{k:'name', label:'Player', cls:'nw'}, pcol('fCpt','Field CPT'), pcol('pCpt','Port. CPT'), dcol('cDiff','CPT Δ'), pcol('fFlex','Field FLEX'), pcol('pFlex','Port. FLEX'), dcol('fDiff','FLEX Δ'),
      pcol('dCpt','DK CPT %Drafted'), pcol('dFlex','DK FLEX %Drafted'), {k:'cptProj', label:'CPT Proj', n:1}, {k:'flexProj', label:'FLEX Proj', n:1}, pcol('cptOwn','Proj CPT Own'), pcol('flexOwn','Proj FLEX Own'),
      {k:'cptPts', label:'CPT pts', n:1}, {k:'flexPts', label:'FLEX pts', n:1}], rows, {sort:'fFlex'});
};
BIND.players = el => { const s = el.querySelector('#plPort'); if(s) s.onchange = ()=>{ LS.set('aPlPort', s.value); renderView(); };
  const q = el.querySelector('#plQ'); q.oninput = ()=>{ LS.set('aPlQ', q.value); const p=q.selectionStart; renderView(); const n=$('#plQ'); n.focus(); n.setSelectionRange(p,p); }; };

let openBuild = null;
VIEWS.explorer = () => {
  if(!S.A) return needStd();
  const A = S.A, q = (LS.get('aExQ','')||'').toLowerCase(), only = LS.get('aExTracked', false);
  const tset = new Set(trackedList().map(C.baseUser));
  let rows = A.glist.map(g=>({g, key:g.key, times:g.count, dupes:g.count-1, cap:g.cap.join(', '), flex:g.flex, proj:g.proj, points:g.points, tr: g.entries.filter(e=>tset.has(e.user)).length, txt:(g.cap.join(' ')+' '+g.flex.join(' ')).toLowerCase()}));
  if(q) rows = rows.filter(r=>q.split(/\s*,\s*|\s+\+\s+/).every(t=>r.txt.includes(t)));
  if(only) rows = rows.filter(r=>r.tr>0);
  S.exRows = rows;
  return `<div class="card"><div class="row"><input type="text" id="exQ" placeholder="Search players (use + for several)" value="${esc(q)}" style="max-width:300px"><label class="row small"><input type="checkbox" id="exTr" ${only?'checked':''}> Only builds a tracked player entered</label><span class="muted small">${int(rows.length)} builds</span><button class="sm" id="exCsv">Export CSV</button></div></div>` +
    table('tEx', [{k:'times', label:'Played', n:1, f:r=>timesPill(r.times)}, {k:'dupes', label:'Dupes', n:1, f:r=>r.dupes}, {k:'cap', label:'Lineup (CPT · FLEX)', cls:'fx', f:r=>lineupCell(r.cap, r.flex)},
      {k:'proj', label:'Proj', n:1}, {k:'points', label:'Points', n:1}, {k:'tr', label:'Tracked', n:1, f:r=>r.tr||''}, {k:'x', label:'', nosort:1, f:r=>`<button class="sm" data-open="${esc(r.key)}">${openBuild===r.key?'Hide':'Entries'}</button>`}],
      rows, {sort:'times', limit:300, after: r=> openBuild===r.key ? `<tr class="sub"><td colspan="7"><div class="small" style="max-height:220px;overflow:auto;columns:240px">${r.g.entries.map(e=>`<div ${tset.has(e.user)?'class="good" style="font-weight:600"':''}>${esc(e.name)} <span class="muted tiny">${esc(e.id)} · rank ${int(e.rank)}</span></div>`).join('')}</div></td></tr>` : ''});
};
BIND.explorer = el => { const q = el.querySelector('#exQ'); q.oninput = ()=>{ LS.set('aExQ', q.value); clearTimeout(q._t); q._t = setTimeout(()=>{ const p=q.selectionStart; renderView(); const n=$('#exQ'); n.focus(); n.setSelectionRange(p,p); }, 200); };
  el.querySelector('#exTr').onchange = e=>{ LS.set('aExTracked', e.target.checked); renderView(); };
  el.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{ openBuild = openBuild===b.dataset.open ? null : b.dataset.open; renderView(); });
  el.querySelector('#exCsv').onclick = ()=>{ const tset = new Set(trackedList().map(C.baseUser));
    download(`lineups-${S.meta.contestId||'contest'}.csv`, [['Times Played','Dupes (other entries)','CPT','FLEX','Projection','Points','Tracked Entries','Tracked Usernames'],
      ...S.exRows.map(r=>[r.times, r.dupes, r.cap, r.flex.join(' | '), r.proj, r.points, r.tr, [...new Set(r.g.entries.filter(e=>tset.has(e.user)).map(e=>e.user))].join(' | ')])]); }; };

// ----- projection vs uniqueness -----
const LIMITS = [1,2,5,10,25,50,Infinity];
function scatter(field, front, mine, ceiling){
  const W=760, H=360, L=50, R=14, T=14, B=40;
  const all = field.concat(mine.filter(b=>b.proj!==null && b.times));
  const maxX = Math.max(2, ...all.map(r=>r.times)), ys = all.map(r=>r.proj);
  // y range from the 1st percentile up, so a few near-empty lineups don't squash the plot; lower points sit on the axis
  const minY = Math.min(C.percentile(ys,.01), ...mine.filter(b=>b.proj!==null).map(b=>b.proj))-0.5, maxY = Math.max(ceiling, ...ys)+0.5, lm = Math.log10(maxX);
  const x = v => L + Math.log10(Math.max(1,v))/lm*(W-L-R), y = v => T + (maxY-Math.max(v,minY))/(maxY-minY)*(H-T-B);
  const xt = [1,2,5,10,25,50,100,250,500,1000].filter(v=>v<=maxX);
  const yt = Array.from({length:5}, (_,i)=>minY+(maxY-minY)*i/4);
  const path = front.map((r,i)=>(i?'L':'M')+x(r.count).toFixed(1)+','+y(r.proj).toFixed(1)).join(' ');
  return `<svg class="scat" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projection versus times played">
    ${yt.map(v=>`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L-6}" y="${y(v)+4}" font-size="11" fill="var(--muted)" text-anchor="end">${v.toFixed(1)}</text>`).join('')}
    ${xt.map(v=>`<text x="${x(v)}" y="${H-B+16}" font-size="11" fill="var(--muted)" text-anchor="middle">${v}×</text>`).join('')}
    <line x1="${L}" x2="${W-R}" y1="${H-B}" y2="${H-B}" stroke="var(--muted)"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H-B}" stroke="var(--muted)"/>
    <g fill="var(--accent)" fill-opacity=".16">${field.map(r=>`<circle cx="${x(r.times).toFixed(1)}" cy="${y(r.proj).toFixed(1)}" r="2.4"/>`).join('')}</g>
    <path d="${path}" fill="none" stroke="var(--dk)" stroke-width="2" stroke-dasharray="5 4"/>
    <g>${mine.filter(b=>b.proj!==null && b.times).map(b=>`<circle cx="${x(b.times).toFixed(1)}" cy="${y(b.proj).toFixed(1)}" r="5" fill="var(--card)" stroke="var(--warn)" stroke-width="2"><title>${esc(b.cap)} · ${b.flex.map(esc).join(', ')}\nProj ${f(b.proj)} · played ${b.times}×</title></circle>`).join('')}</g>
    <text x="${(L+W-R)/2}" y="${H-4}" font-size="11.5" fill="var(--muted)" text-anchor="middle">Times played (log scale; hypothetical builds plotted as if entered)</text>
    <text x="13" y="${(T+H-B)/2}" font-size="11.5" fill="var(--muted)" text-anchor="middle" transform="rotate(-90 13 ${(T+H-B)/2})">Projected points</text></svg>
    <div class="legend"><span><i style="background:color-mix(in srgb,var(--accent) 35%,transparent)"></i>Field build</span><span><i style="background:var(--card);border:2px solid var(--warn)"></i>Selected portfolio</span><span><i style="background:var(--dk);border-radius:0;height:3px"></i>Field frontier</span></div>`;
}
let altFor = null;
VIEWS.tradeoff = () => {
  if(!S.A) return needStd(); if(!S.A.pm) return needProj();
  const A = S.A, pid = curPortfolio('aTrPort'), P = portfolioBuilds(pid);
  const maxLoss = C.num(LS.get('aTrLoss','')), maxT = C.num(LS.get('aTrMax',''));
  const field = A.glist.filter(g=>g.proj!==null).map(g=>({times:g.count, proj:g.proj}));
  const builds = P.builds.filter(b=>b.proj!==null);
  const shown = builds.filter(b=>(maxLoss===null || A.ceiling-b.proj<=maxLoss+1e-9) && (maxT===null || b.times<=maxT));
  const myMax = builds.length ? Math.max(...builds.map(b=>b.proj)) : null;
  for(const b of builds){ b.loss = A.ceiling-b.proj; b.myLoss = myMax-b.proj; b.fb = A.bestAtOrBelow(b.times); b.gap = b.fb ? b.fb.proj-b.proj : null; }
  const gaps = builds.map(b=>b.gap).filter(ok);
  const curve = LIMITS.map(l=>{ const fb = A.bestAtOrBelow(l===Infinity?1e9:l), pb = builds.filter(b=>b.times<=l).reduce((a,b)=>!a||b.proj>a.proj?b:a, null);
    return `<tr><td class="nw">${l===Infinity?'Any':'≤ '+l+'×'} <span class="muted tiny">${l===Infinity?'':l===1?'(0 dupes)':'(≤'+(l-1)+' dupes)'}</span></td><td class="n">${fb?f(fb.proj)+` <span class="muted tiny">${fb.count}×</span>`:'—'}</td><td class="n">${fb?f(A.ceiling-fb.proj):'—'}</td><td class="n">${pb?f(pb.proj)+` <span class="muted tiny">${pb.times}×</span>`:'—'}</td><td class="n">${pb&&fb?(fb.proj-pb.proj<0.005&&fb.proj-pb.proj>-0.005?'<span class="pos">matches</span>':sgn(fb.proj-pb.proj)):'—'}</td></tr>`; }).join('');
  let h = `<div class="card"><div class="row"><label class="row small">Portfolio ${portfolioSelect('trPort', pid)}</label>
    <label class="row small">Max projection loss <input type="number" id="trLoss" step="any" min="0" value="${maxLoss??''}" placeholder="any" style="width:80px"></label>
    <label class="row small">Max times played <input type="number" id="trMax" step="1" min="1" value="${maxT??''}" placeholder="any" style="width:80px"></label>
    <span class="muted small">Showing ${int(shown.length)} of ${int(builds.length)} builds with full projections${P.builds.length>builds.length?` (${P.builds.length-builds.length} missing a projection)`:''}${P.unresolved?`, ${P.unresolved} set lineups unresolved`:''}. Field benchmark: ${int(field.length)} projected field builds; filters never change it.</span></div></div>`;
  h += tiles([[f(A.ceiling),'Contest ceiling','Best complete projection actually played'],[f(myMax),'Portfolio max'],[gaps.length?f(Math.min(...gaps)):'—','Best efficiency gap'],[f(C.percentile(gaps,.5)),'Median efficiency gap'],
    [int(gaps.filter(g=>g<=0.5+1e-9).length),'Builds ≤0.5 pt from field best'],[int(gaps.filter(g=>g<=1+1e-9).length),'Builds ≤1.0 pt from field best']]);
  h += `<div class="grid2"><div class="card"><h3>Projection vs times played</h3>${scatter(field, A.frontier, shown, A.ceiling)}<div class="note">Frontier: field builds that no other field build beats on both projection and duplication.</div></div>
    <div class="card"><h3>Best build at each duplication limit</h3><div class="tw free"><table><thead><tr><th>Limit (times played)</th><th class="n">Field best</th><th class="n">Loss vs ceiling</th><th class="n">Portfolio best</th><th class="n">Field best − portfolio</th></tr></thead><tbody>${curve}</tbody></table></div>
    <div class="note">Times played includes the entry itself. For hypothetical sets it is the field count + 1 (as if you had entered it), so the limits line up with real entries.</div></div></div>`;
  h += `<div class="card"><h3>Build tradeoffs</h3><div class="note" style="margin:0 0 8px">Efficiency gap = best field projection played no more often − this build's projection. Real field builds can't go below 0; hypothetical builds can (they beat what the field actually played).</div>` +
    table('tTr', [{k:'proj', label:'Proj', n:1}, {k:'loss', label:'Contest loss', n:1}, {k:'myLoss', label:'Portfolio loss', n:1}, {k:'times', label:'Played', n:1, f:b=>timesPill(b.times)}, {k:'dupes', label:'Dupes', n:1, f:b=>b.dupes},
      {k:'fbp', label:'Field best ≤ played', n:1, v:b=>b.fb?.proj, f:b=>b.fb?`${f(b.fb.proj)} <span class="muted tiny">${b.fb.count}×</span>`:'—'}, {k:'gap', label:'Eff. gap', n:1, f:b=>`<span class="${b.gap!==null&&b.gap<=0.05?'pos':b.gap>1?'amber':''}">${f(b.gap)}</span>`},
      {k:'entries', label:'Entries', n:1, f:b=>b.entries}, {k:'cap', label:'Lineup (CPT · FLEX)', cls:'fx', f:b=>lineupCell(b.cap, b.flex)}, {k:'x', label:'', nosort:1, f:b=>`<button class="sm" data-alt="${esc(b.key)}">Alternatives</button>`}],
      shown, {sort:'proj', limit:200}) + `</div><div id="altBox"></div>`;
  S.trBuilds = builds;
  return h;
};
function renderAlts(key){
  const A = S.A, b = S.trBuilds.find(x=>x.key===key); if(!b) return;
  const uni = LS.get('aAltUni','field');
  const fieldBuilds = S.fieldAlt || (S.fieldAlt = A.glist.map(g=>({key:g.key, capId:nid(g.cap[0]||''), flexIds:g.flex.map(nid).sort(), cap:g.cap.join(', '), flex:g.flex, proj:g.proj, times:g.count, dupes:g.count-1})));
  const pool = uni==='field' ? fieldBuilds : S.trBuilds;
  const idx = uni==='field' ? (S.fieldAltIdx || (S.fieldAltIdx = C.altIndex(fieldBuilds))) : C.altIndex(S.trBuilds);
  const name = id => { const n = A.names.get(id); return n || id.replace(/^~/,''); };
  const alts = C.alternativesFor(b, idx).map(a=>({...a, dp: a.b.proj!==null ? a.b.proj-b.proj : null, dd: a.b.times-b.times})).sort((x,y)=>(y.dp??-99)-(x.dp??-99) || x.dd-y.dd).slice(0,40);
  $('#altBox').innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Alternatives to ${esc(b.cap)} · ${b.flex.map(esc).join(', ')}</h3>
    <div class="seg"><button data-uni="field" class="${uni==='field'?'on':''}">Search field builds</button><button data-uni="port" class="${uni!=='field'?'on':''}">Search this portfolio</button></div></div>
    <div class="note">Current: ${f(b.proj)} proj · played ${b.times}× · gap ${f(b.gap)}. One FLEX replaced, or the same six players with a different CPT. ${uni==='field' ? 'Only builds the field actually played are searched, so their duplication is known; an unplayed alternative would have 0 dupes but isn\'t listed.' : 'Searches only builds in the selected portfolio.'}</div>
    ${alts.length ? alts.map(a=>`<div class="altc"><b>${a.type}</b>: ${esc(name(a.out))} → ${esc(name(a.in))} · <span class="${cls(a.dp)}">${sgn(a.dp)} proj</span> · <span class="${a.dd<0?'pos':a.dd>0?'neg':''}">${a.dd>0?'+':''}${a.dd} times played</span> (${a.b.times}×) <div class="muted tiny">${esc(a.b.cap)} · ${a.b.flex.map(esc).join(', ')}</div></div>`).join('') : '<div class="muted small">No alternatives found in this search universe.</div>'}</div>`;
  $('#altBox').querySelectorAll('[data-uni]').forEach(x=>x.onclick=()=>{ LS.set('aAltUni', x.dataset.uni); renderAlts(key); });
  $('#altBox').scrollIntoView({behavior:'smooth', block:'start'});
}
BIND.tradeoff = el => { const s = el.querySelector('#trPort'); if(s) s.onchange = ()=>{ LS.set('aTrPort', s.value); renderView(); };
  const l = el.querySelector('#trLoss'), m = el.querySelector('#trMax'); if(l){ l.onchange = ()=>{ LS.set('aTrLoss', l.value); renderView(); }; m.onchange = ()=>{ LS.set('aTrMax', m.value); renderView(); }; }
  el.querySelectorAll('[data-alt]').forEach(b=>b.onclick=()=>{ altFor=b.dataset.alt; renderAlts(altFor); }); };

VIEWS.projections = () => {
  if(!S.proj) return needProj() + (S.A ? '' : '');
  const P = S.proj, A = S.A, pm = A ? A.pm : null;
  let h = '';
  if(pm){
    const total = A.names.size, cov = A.glist.filter(g=>g.proj!==null).length;
    h += tiles([[int(total),'Contest players'],[int(pm.match.size),'Matched', pm.viaOverride? pm.viaOverride+' by your overrides' : ''],[int(pm.unmatched.length),'Unmatched'],[int(pm.ambiguous.length),'Ambiguous'],[int(pm.unused.length),'Unused projection rows'],
      [pc(cov/Math.max(1,A.glist.length)*100),'Field builds fully projected'], [P.hasCpt ? 'Yes':'No','CPT Proj column', P.hasCpt ? 'CPT projections are used as given, never multiplied again' : 'No CPT column: captain lineups get no projection']]);
    const opts = sel => `<option value="">— no match —</option>`+P.rows.map(p=>`<option value="${esc(p.id||p.name)}" ${sel===(p.id||p.name)?'selected':''}>${esc(p.name)}${p.id?' #'+esc(p.id):''}</option>`).join('');
    const prob = [...pm.unmatched.map(u=>({...u, why:u.override?'set to no match':'no projection with this name'})), ...pm.ambiguous.map(a=>({...a, why:'several: '+a.candidates.join(' / ')}))];
    const ovr = Object.entries(S.overrides);
    h += `<div class="grid2"><div class="card"><h3>Contest names needing a match</h3>${prob.length ? prob.map(u=>`<div class="row small" style="margin:4px 0"><span style="flex:1;min-width:140px"><b>${esc(u.name)}</b> <span class="muted">${esc(u.why)}</span></span><select class="sm" data-ovr="${esc(u.norm)}">${opts(S.overrides[u.norm])}</select></div>`).join('') : '<div class="good small">Every contest player matched a projection.</div>'}
      ${ovr.length ? `<div class="note">Your overrides: ${ovr.map(([k,v])=>`${esc(A.names.get(k)||k)} → ${esc(v||'no match')} <button class="sm" data-unovr="${esc(k)}">undo</button>`).join(' · ')}</div>` : ''}
      <div class="note">Names are matched after normalising case, accents, punctuation and spacing, then again without Jr/Sr/II/III. Anything uncertain is left unmatched rather than guessed.</div></div>
      <div class="card"><h3>Projection rows not in the contest</h3>${pm.unused.length ? `<div class="small">${pm.unused.map(p=>esc(p.name)+(p.id?` <span class="muted tiny">#${esc(p.id)}</span>`:'')).join(', ')}</div><div class="note">Usually players nobody rostered.</div>` : '<div class="good small">None.</div>'}
      ${P.issues.length ? `<div class="note warn">${P.issues.map(esc).join('<br>')}</div>` : ''}</div></div>`;
  } else h += `<div class="card muted small">Projections loaded (${P.rows.length} players). Add the contest standings to match them.</div>`;
  const rows = P.rows.map(p=>{ const n = A ? [...A.pm.match].find(([,x])=>x===p)?.[0] : null; const rc = n && A.results.get(n+'|CPT'), rf = n && A.results.get(n+'|FLEX');
    return {...p, dC: rc?.drafted ?? null, dF: rf?.drafted ?? null, aC: rc?.fpts ?? null, aF: rf?.fpts ?? null}; });
  h += `<div class="card"><h3>Loaded projections <span class="muted tiny" style="font-weight:400">${esc(S.projFile)}</span></h3>` + table('tPj', [{k:'name', label:'Player', cls:'nw'}, {k:'id', label:'DFS ID', cls:'tiny'},
    {k:'flexProj', label:'FLEX Proj', n:1}, {k:'cptProj', label:'CPT Proj', n:1}, {k:'flexOwn', label:'Proj FLEX Own', n:1, f:r=>pc(r.flexOwn)}, {k:'cptOwn', label:'Proj CPT Own', n:1, f:r=>pc(r.cptOwn)},
    {k:'dF', label:'DK FLEX %Drafted', n:1, f:r=>pc(r.dF)}, {k:'dC', label:'DK CPT %Drafted', n:1, f:r=>pc(r.dC)}, {k:'aF', label:'FLEX pts', n:1}, {k:'aC', label:'CPT pts', n:1}], rows, {sort:'flexProj', free:true}) +
    `<div class="note">Ownership in this file is in percentage points. Projected and actual ownership stay split by role.</div></div>`;
  return h;
};
BIND.projections = el => {
  el.querySelectorAll('[data-ovr]').forEach(s=>s.onchange=()=>{ S.overrides[s.dataset.ovr] = s.value; recompute(); render(); });
  el.querySelectorAll('[data-unovr]').forEach(b=>b.onclick=()=>{ delete S.overrides[b.dataset.unovr]; recompute(); render(); });
};

// ----- lineup sets -----
const setLabel = s => s.strategy ? s.strategy + (ok(s.mitigation) ? ` ${s.mitigation}%` : '') : s.name;
VIEWS.sets = () => {
  const slots = S.sets.map((s,i)=>`<div class="slot ${s.parsed?'ok':''}" data-slot="${i}">
    <input type="text" class="sm" data-sf="name" data-i="${i}" value="${esc(s.name)}" aria-label="Set name">
    <div class="two"><select class="sm" data-sf="strategy" data-i="${i}" aria-label="Strategy">${STRATS.map(o=>`<option value="${esc(o)}" ${o===s.strategy?'selected':''}>${o||'Strategy…'}</option>`).join('')}</select>
    <input type="number" class="sm" data-sf="mitigation" data-i="${i}" value="${s.mitigation??''}" placeholder="Mitig. %" step="any" min="0" max="100" aria-label="Mitigation percent"></div>
    <input type="text" class="sm" data-sf="version" data-i="${i}" value="${esc(s.version)}" placeholder="Source / ROI version" aria-label="Source version">
    <div class="row"><button class="sm" data-setup="${i}">${s.parsed?'Replace':'Upload'}</button>${s.parsed||s.error?`<button class="sm" data-setclr="${i}">Clear</button>`:''}</div>
    <span class="fn" title="${esc(s.fileName)}">${esc(s.fileName || 'No file')}</span>
    ${s.parsed?`<span class="tiny">${s.parsed.rows.length} lineups${s.parsed.issues.length?` · <span class="warn">${s.parsed.issues.length} invalid</span>`:''}</span>`:''}${s.error?`<span class="tiny warn">${esc(s.error)}</span>`:''}</div>`).join('');
  let h = `<div class="card"><h3>Lineup sets</h3><div class="note" style="margin:0 0 8px">Up to ten hypothetical portfolios (CPT, FLEX ×5, Proj, Actual, P90, ROI, Top 1%, Uniqueness…). Player IDs are matched through the projections file. Stack and the summed Own column are ignored. P90 Spread is its own strategy, not 0% mitigation. Names, strategies and mitigation % are remembered per slot.</div><div class="slots">${slots}</div><input type="file" id="fSet" accept=".csv,text/csv" hidden></div>`;
  if(!S.A) return h + needStd();
  const L = S.sets.map((s,i)=>({s,i,m:S.setRes[i]})).filter(x=>x.m);
  if(!L.length) return h;
  if(!S.A.pm) h += `<div class="card warn small">Add the projections file: set lineups use DFS IDs, which are matched to contest names through it. Until then their duplication is unknown.</div>`;
  const users = trackedList().map(u=>({u, m:userMetrics(u)})).filter(x=>x.m && x.m.n);
  const col = (lab, fn, tip) => `<tr><td class="nw" ${tip?`title="${esc(tip)}"`:''}>${lab}</td>${L.map(x=>`<td class="n">${fn(x.m, x.s)}</td>`).join('')}${users.map(x=>`<td class="n muted">${fn.u ? fn.u(x.m) : ''}</td>`).join('')}</tr>`;
  const U = (fn, ufn) => { fn.u = ufn; return fn; };
  const roiCell = m => m.roi!==null ? pc(m.roi) : (S.A.fee ? '—' : '<span class="muted">enter fee</span>');
  h += `<div class="card"><h3>Set comparison</h3><div class="tw free"><table><thead><tr><th>Metric</th>${L.map(x=>`<th class="n">${esc(x.s.name)}<div class="tiny muted" style="font-weight:400">${esc(x.s.strategy||'')}${ok(x.s.mitigation)?' '+x.s.mitigation+'%':''}</div></th>`).join('')}${users.map(x=>`<th class="n">${esc(x.u)}<div class="tiny muted" style="font-weight:400">actual</div></th>`).join('')}</tr></thead><tbody>
    <tr><td colspan="${1+L.length+users.length}" class="tiny muted"><b>Pre-lock (from the set files)</b></td></tr>
    ${col('Lineups', U(m=>`${m.valid}${m.invalid?` <span class="warn tiny">+${m.invalid} invalid</span>`:''}`, m=>m.n))}
    ${col('Distinct builds', U(m=>m.distinct, m=>m.distinct))}
    ${col('Avg projection', U(m=>f(m.avgProj), m=>f(m.avgProj)), 'Set: the file\'s Proj. Players: from the projections file')}
    ${col('Avg P90', m=>f(m.avgP90))}${col('Avg P50', m=>f(m.avgP50))}${col('Avg P10', m=>f(m.avgP10))}
    ${col('Predicted ROI (avg)', m=>pc(m.predRoi), 'Simulated ROI from the set file. Not realized.')}${col('Predicted NormROI', m=>f(m.predNormRoi,1))}
    ${col('Predicted Top 1%', m=>pc(m.predTop1,2))}${col('Predicted Top 0.1%', m=>pc(m.predTop01,2))}${col('Avg Uniqueness', m=>f(m.avgUniq,1))}
    <tr><td colspan="${1+L.length+users.length}" class="tiny muted"><b>Duplication in the real field</b> (dupes = field entries already holding that lineup; actual players: other entries)</td></tr>
    ${col('ID coverage', U(m=>`${pc(m.resolved/Math.max(1,m.valid)*100)} <span class="tiny muted">${m.resolved}/${m.valid}</span>`, ()=>'—'), 'Lineups whose every player ID resolved to the contest. Unresolved ones have unknown dupes, never 0.')}
    ${col('Avg dupes', U(m=>f(m.dupes.avg), m=>f(m.dupes.avg)))}${col('Median dupes', U(m=>f(m.dupes.median,0), m=>f(m.dupes.median,0)))}${col('P90 dupes', U(m=>f(m.dupes.p90,0), m=>f(m.dupes.p90,0)))}${col('Max dupes', U(m=>f(m.dupes.max,0), m=>f(m.dupes.max,0)))}
    ${col('Unique', U(m=>pc(m.dupes.unique), m=>pc(m.dupes.unique)))}${col('≤1 dupe', U(m=>pc(m.dupes.le1), m=>pc(m.dupes.le1)))}${col('≤4 dupes', U(m=>pc(m.dupes.le4), m=>pc(m.dupes.le4)))}
    ${col('Avg contest loss', U(m=>f(m.avgContestLoss), m=>f(m.avgContestLoss)), 'Contest ceiling − lineup projection (same projections file for everyone)')}
    ${col('Avg efficiency gap', U(m=>f(m.avgGap), m=>f(m.avgGap)))}
    <tr><td colspan="${1+L.length+users.length}" class="tiny muted"><b>Results</b></td></tr>
    ${col('Avg actual points', U(m=>`${f(m.avgPoints)} <span class="tiny muted">${m.scoredN}/${m.valid}</span>`, m=>f(m.avgPoints)))}
    ${col('Actual Top 1%', U(m=>`${pc(m.top1)} <span class="tiny muted">${m.top1n}</span>`, m=>`${pc(m.top1)} <span class="tiny muted">${m.top1n}</span>`))}
    ${col('Actual Top 0.1%', U(m=>`${pc(m.top01,2)} <span class="tiny muted">${m.top01n}</span>`, m=>`${pc(m.top01,2)} <span class="tiny muted">${m.top01n}</span>`))}
    ${col('Est. realized ROI', U(roiCell, roiCell), 'Modeled DK payout curve, each lineup inserted into the real field. Not exact.')}
    ${col('Score checks', m=>m.scoreMismatch ? `<span class="warn">${m.scoreMismatch} differ</span>` : '<span class="good">ok</span>', 'File Actual vs scores from the standings (tolerance 0.05 for the file\'s rounding)')}
    </tbody></table></div><div class="note">Top 1% / 0.1%: rank (ties share the best rank) within the top 1% / 0.1% of the field size; a hypothetical lineup is ranked as an extra entry (field + 1). Est. realized ROI = total modeled payout ÷ total entry fees − 1. Predicted ROI is the set file's simulated figure and is never mixed with realized ROI.</div></div>`;
  // experiment: incremental cost of mitigation vs a baseline set
  let base = LS.get('aBase', null); if(!L.some(x=>x.i===base)) base = (L.find(x=>x.s.mitigation===0) || L[0]).i;
  const B = L.find(x=>x.i===base).m;
  h += `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Mitigation tradeoff vs baseline</h3><label class="row small">Baseline <select id="baseSel">${L.map(x=>`<option value="${x.i}" ${x.i===base?'selected':''}>${esc(x.s.name)}</option>`).join('')}</select></label></div>
    <div class="tw free" style="margin-top:8px"><table><thead><tr><th>Set</th><th class="n">Mitigation</th><th class="n">Proj sacrificed</th><th class="n">P90 sacrificed</th><th class="n">Dupes removed</th><th class="n">Unique gain</th><th class="n">Dupes removed per proj pt</th><th class="n">Δ Est. ROI</th><th class="n">Δ Top 1%</th></tr></thead><tbody>
    ${L.filter(x=>x.i!==base).map(x=>{ const m=x.m, ps = ok(B.avgProj)&&ok(m.avgProj) ? B.avgProj-m.avgProj : null, p9 = ok(B.avgP90)&&ok(m.avgP90) ? B.avgP90-m.avgP90 : null, dr = ok(B.dupes.avg)&&ok(m.dupes.avg) ? B.dupes.avg-m.dupes.avg : null;
      return `<tr><td class="nw">${esc(x.s.name)}</td><td class="n">${ok(x.s.mitigation)?x.s.mitigation+'%':esc(x.s.strategy||'—')}</td><td class="n">${f(ps)}</td><td class="n">${f(p9)}</td><td class="n ${cls(dr)}">${f(dr)}</td><td class="n ${cls(m.dupes.unique-B.dupes.unique)}">${sgn(ok(m.dupes.unique)&&ok(B.dupes.unique)?m.dupes.unique-B.dupes.unique:null,1,' pp')}</td>
        <td class="n">${ps!==null && dr!==null ? (ps>0 ? f(dr/ps) : `<span class="muted" title="No projection was given up, so the ratio is undefined">n/a${dr>0?' (free gain)':''}</span>`) : '—'}</td>
        <td class="n ${cls(ok(m.roi)&&ok(B.roi)?m.roi-B.roi:null)}">${sgn(ok(m.roi)&&ok(B.roi)?m.roi-B.roi:null,1,' pp')}</td><td class="n">${sgn(ok(m.top1)&&ok(B.top1)?m.top1-B.top1:null,2,' pp')}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">Load a second set to compare.</td></tr>'}</tbody></table></div>
    <div class="note">One contest is one sample, and lineups within a slate are correlated: treat these as observations, not a verdict. History pairs strategies across contests.</div></div>`;
  // overlap
  if(L.length>1){
    const mode = LS.get('aOvMode','jaccard');
    h += `<div class="grid2"><div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Overlap</h3><div class="seg"><button data-ov="jaccard" class="${mode==='jaccard'?'on':''}">Jaccard</button><button data-ov="row" class="${mode!=='jaccard'?'on':''}">Share of row set</button></div></div>
      <div class="tw free" style="margin-top:8px"><table class="ovl"><thead><tr><th></th>${L.map(x=>`<th>${esc(x.s.name)}</th>`).join('')}</tr></thead><tbody>${L.map(a=>`<tr><th>${esc(a.s.name)}</th>${L.map(b=>{ if(a.i===b.i) return `<td class="muted">${a.m.distinct}</td>`; const o = C.overlap(a.s.parsed, b.s.parsed);
        return `<td title="${o.shared} shared · ${o.sizeA} vs ${o.sizeB} distinct">${mode==='jaccard'?pc(o.jaccard*100):pc(o.shareOfA*100)}<div class="tiny muted">${o.shared} shared</div></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="note">Exact lineup matches (CPT + the same five FLEX). Jaccard = shared ÷ distinct lineups in either set. Share of row set = shared ÷ distinct lineups in the row's set. Diagonal = distinct lineups.</div></div>`;
  } else h += '<div class="grid2"><div class="card muted small">Load two or more sets to see overlap.</div>';
  h += `<div class="card"><h3>Prediction calibration</h3>${L.map(x=>{ const c = C.calibration(x.m.rows);
    return `<div class="altc"><b>${esc(x.s.name)}</b><div class="small">Predicted uniqueness, lowest 20%: <b>${f(c.lowUniq?.dupes)}</b> avg dupes (${pc(c.lowUniq?.unique)} unique) · highest 20%: <b>${f(c.highUniq?.dupes)}</b> (${pc(c.highUniq?.unique)} unique) <span class="muted tiny">${c.quintileSize} per group, ${c.uniqExcluded} excluded</span></div>
      <div class="small">Top 1%: predicted ${pc(c.top1.predicted,2)}, actual ${pc(c.top1.actual,2)} · Top 0.1%: predicted ${pc(c.top01.predicted,2)}, actual ${pc(c.top01.actual,2)} <span class="muted tiny">n=${c.top1.n}${c.top1.excluded?`, ${c.top1.excluded} excluded`:''}</span></div></div>`; }).join('')}
    <div class="note">Lineups missing a metric or an outcome are left out and counted.</div></div></div>`;
  // lineup-level
  let di = LS.get('aSetDetail', L[0].i); if(!L.some(x=>x.i===di)) di = L[0].i;
  const D = S.setRes[di];
  h += `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Lineup results</h3><div class="row"><select id="setDet">${L.map(x=>`<option value="${x.i}" ${x.i===di?'selected':''}>${esc(x.s.name)}</option>`).join('')}</select><button class="sm" id="setCsv">Download CSV</button></div></div><div style="margin-top:8px">` +
    table('tSetD', [{k:'status', label:'Field', cls:'nw', f:r=>r.invalid?`<span class="warn">${esc(r.invalid)}</span>`:r.key?esc(r.status):`<span class="warn" title="${esc(r.res.why)}">unresolved</span>`},
      {k:'dupes', label:'Dupes', n:1, f:r=>r.dupes===null?'?':r.dupes===0?'<span class="pill uniq">0</span>':r.dupes}, {k:'proj', label:'Proj', n:1}, {k:'p90', label:'P90', n:1}, {k:'roi', label:'Pred ROI', n:1, f:r=>pc(r.roi)},
      {k:'top1', label:'Pred Top 1%', n:1, f:r=>pc(r.top1,2)}, {k:'uniq', label:'Pred Uniq', n:1, f:r=>f(r.uniq,1)}, {k:'points', label:'Points', n:1, f:r=>`${f(r.points)}${r.scoreSrc!=='contest standings'&&r.points!==null?` <span class="tiny muted" title="${esc(r.scoreSrc)}">*</span>`:''}`},
      {k:'rank', label:'Rank', n:1, f:r=>int(r.rank)}, {k:'payout', label:'Est. payout', n:1, f:r=>money(r.payout)}, {k:'gap', label:'Eff. gap', n:1},
      {k:'names', label:'Lineup', cls:'fx', v:r=>r.res.names?.[0]||r.cptId, f:r=>r.res.names ? lineupCell(r.res.names[0], r.res.names.slice(1)) : `<span class="kbd">${esc(r.cptId)} · ${r.flexIds.map(esc).join(' · ')}</span>`}],
      D.rows, {sort:'proj', limit:200}) + `<div class="note">* score not from a matching field entry: from the standings' player results (role-adjusted) or the file's Actual.</div></div></div>`;
  return h;
};
BIND.sets = el => {
  let pending = null;
  el.querySelectorAll('[data-sf]').forEach(inp=>inp.onchange=()=>{ const s = S.sets[+inp.dataset.i], k = inp.dataset.sf;
    s[k] = k==='mitigation' ? C.num(inp.value) : inp.value.trim(); if(k==='name' && !s.name) s.name = 'Set '+LETTERS[+inp.dataset.i];
    LS.set('aSlot'+inp.dataset.i, {name:s.name, strategy:s.strategy, mitigation:s.mitigation, version:s.version}); renderView(); });
  const fi = el.querySelector('#fSet');
  el.querySelectorAll('[data-setup]').forEach(b=>b.onclick=()=>{ pending = +b.dataset.setup; fi.click(); });
  fi.onchange = async ()=>{ const file = fi.files[0]; fi.value=''; if(!file || pending===null) return; const {name, text} = await readAny(file); loadSet(pending, text, name); recompute(); render(); };
  el.querySelectorAll('[data-setclr]').forEach(b=>b.onclick=()=>{ const i=+b.dataset.setclr; Object.assign(S.sets[i], {text:null, fileName:'', parsed:null, error:''}); recompute(); render(); });
  const bs = el.querySelector('#baseSel'); if(bs) bs.onchange = ()=>{ LS.set('aBase', +bs.value); renderView(); };
  el.querySelectorAll('[data-ov]').forEach(b=>b.onclick=()=>{ LS.set('aOvMode', b.dataset.ov); renderView(); });
  const sd = el.querySelector('#setDet'); if(sd) sd.onchange = ()=>{ LS.set('aSetDetail', +sd.value); renderView(); };
  const csv = el.querySelector('#setCsv'); if(csv) csv.onclick = ()=>{ const i = LS.get('aSetDetail', null) ?? S.setRes.findIndex(Boolean); const s = S.sets[i], m = S.setRes[i]; if(!m) return;
    download(`${s.name.replace(/[^a-z0-9]+/gi,'-').toLowerCase()}-results.csv`, [['Set','Strategy','Mitigation %','Source Version','CPT ID','FLEX IDs','CPT','FLEX','Field Status','Dupes (field entries holding this lineup)','Times Played If Entered','Proj (file)','Proj (projections file)','P90','P50','P10','Pred ROI %','Pred NormROI','Pred Top 1 %','Pred Top 0.1 %','Pred Uniqueness','Actual Points','Score Source','Rank (field+1)','Actual Top 1%','Actual Top 0.1%','Est. Payout (modeled)','Contest Loss','Efficiency Gap'],
      ...m.rows.map(r=>[s.name, s.strategy, s.mitigation, s.version, r.cptId, r.flexIds.join(' | '), r.res.names?.[0]||'', (r.res.names||[]).slice(1).join(' | '), r.invalid||r.status, r.dupes, r.timesIfEntered, r.proj, r.projCalc!==null?+r.projCalc.toFixed(2):'', r.p90, r.p50, r.p10, r.roi, r.normRoi, r.top1, r.top01, r.uniq, r.points, r.scoreSrc, r.rank, r.actTop1, r.actTop01, r.payout!==null?+r.payout.toFixed(2):'', r.contestLoss!==null?+r.contestLoss.toFixed(2):'', r.gap!==null?+r.gap.toFixed(2):''])]); };
};

// ----- player comparison -----
VIEWS.compare = () => {
  if(!S.A) return needStd();
  const A = S.A, rows = trackedList().map(u=>{ const m = userMetrics(u), all = C.userAllEntries(A,u), w = C.num(S.winnings[C.baseUser(u)]);
    return {u, m, all: all.length, exact: w!==null && A.fee && all.length ? (w/(all.length*A.fee)-1)*100 : null, w}; });
  if(!rows.length) return '<div class="card empty">Enter usernames in the tracked-player boxes.</div>';
  const td = (v, c='') => `<td class="n ${c}">${v}</td>`;
  return `<div class="card"><h3>Tracked players</h3><div class="tw free"><table><thead><tr><th>Player</th><th class="n">Entries</th><th class="n">Distinct</th><th class="n">Avg proj</th><th class="n">Avg score</th><th class="n">Avg dupes</th><th class="n">Median</th><th class="n">P75</th><th class="n">P90</th><th class="n">Max</th><th class="n">Unique</th><th class="n">≤1</th><th class="n">≤4</th><th class="n">Avg contest loss</th><th class="n">Avg eff. gap</th><th class="n">Top 1%</th><th class="n">Top 0.1%</th><th class="n" title="Modeled payouts">Est. realized ROI</th><th class="n">Winnings $</th><th class="n">Exact ROI</th></tr></thead><tbody>
    ${rows.map(({u,m,all,exact,w})=>`<tr class="${u===me()?'mine':''}"><td class="nw"><b>${esc(u)}</b>${u===me()?' <span class="pill me">you</span>':''}</td>${!all ? `<td colspan="17" class="muted">Not entered</td>` :
      [td(int(m.n)+(m.invalidCount?` <span class="tiny warn">+${m.invalidCount}</span>`:'')), td(int(m.distinct)), td(f(m.avgProj)), td(f(m.avgPoints)), td(f(m.dupes.avg)), td(f(m.dupes.median,0)), td(f(m.dupes.p75,0)), td(f(m.dupes.p90,0)), td(f(m.dupes.max,0)),
        td(pc(m.dupes.unique)), td(pc(m.dupes.le1)), td(pc(m.dupes.le4)), td(f(m.avgContestLoss)), td(f(m.avgGap)), td(`${pc(m.top1)} <span class="tiny muted">${m.top1n}</span>`), td(`${pc(m.top01,2)} <span class="tiny muted">${m.top01n}</span>`),
        td(m.roi!==null?pc(m.roi):(A.fee?'—':'<span class="muted">enter fee</span>'), cls(m.roi))].join('')}
      ${all ? `<td class="n"><input type="number" class="sm" data-win="${esc(C.baseUser(u))}" value="${w??''}" step="any" min="0" style="width:90px" placeholder="optional"></td>${td(pc(exact), cls(exact))}` : ''}</tr>`).join('')}
    </tbody></table></div>
    <div class="note">Usernames match exactly (case-insensitive, after removing the "(8/45)" entry suffix). Dupes = other entries with the same lineup. Avg projection uses the projections file and only fully projected lineups; P90 isn't shown for real players because the projections file doesn't have it.
    Est. realized ROI uses the modeled payout curve; enter actual winnings (from DraftKings) to get exact ROI. Entries without a valid lineup still count as cost.</div></div>`;
};
BIND.compare = bindWinnings;
BIND.overview = bindWinnings;

// ---------- history ----------
function contestSummary(){
  const A = S.A, trackedSum = {};
  for(const u of trackedList()){ const m = userMetrics(u), all = C.userAllEntries(A,u); if(!all.length) continue;
    trackedSum[C.baseUser(u)] = {n:m.n, all:all.length, distinct:m.distinct, dupes:m.dupes, avgProj:m.avgProj, projCoverage:m.projCoverage, avgPoints:m.avgPoints, avgContestLoss:m.avgContestLoss, avgGap:m.avgGap,
      top1n:m.top1n, top01n:m.top01n, rankedN:m.rankedN, payoutTotal:m.payoutTotal, cost:m.cost, roi:m.roi}; }
  const sets = S.sets.map((s,i)=>({s,i,m:S.setRes[i]})).filter(x=>x.m).map(({s,i,m})=>({slot:i, name:s.name, strategy:s.strategy, mitigation:s.mitigation, version:s.version, label:setLabel(s),
    n:m.n, valid:m.valid, resolved:m.resolved, distinct:m.distinct, dupes:m.dupes, avgProj:m.avgProj, avgProjCalc:m.avgProjCalc, avgP90:m.avgP90, predRoi:m.predRoi, predTop1:m.predTop1, predTop01:m.predTop01, avgUniq:m.avgUniq,
    avgPoints:m.avgPoints, scoredN:m.scoredN, top1n:m.top1n, top01n:m.top01n, avgContestLoss:m.avgContestLoss, avgGap:m.avgGap, payoutTotal:m.payoutTotal, cost:m.cost, roi:m.roi}));
  const times = A.valid.map(e=>A.groups.get(e.key).count);
  return {calcVersion: C.CALC_VERSION, computedAt: Date.now(), trackedUsers: trackedList(), ceiling: A.ceiling, fieldDupes: C.dupeStats(times.map(t=>t-1)), distinct: A.glist.length, tracked: trackedSum, sets};
}
function contestRecord(){
  inputsToMeta(); const A = S.A, m = S.meta;
  const sources = [{hash:'std-'+C.hashStr(S.stdText), kind:'standings', fileName:S.stdFile, text:S.stdText}];
  if(S.projText) sources.push({hash:'proj-'+C.hashStr(S.projText), kind:'projections', fileName:S.projFile, text:S.projText});
  const sets = S.sets.map((s,i)=>{ if(!s.parsed) return null; const h = 'set-'+C.hashStr(s.text); sources.push({hash:h, kind:'lineup set', fileName:s.fileName, text:s.text});
    return {slot:i, name:s.name, strategy:s.strategy, mitigation:s.mitigation, version:s.version, fileName:s.fileName, sourceHash:h}; }).filter(Boolean);
  const record = {id: contestKey(), schema:1, site:m.site, sport:m.sport, format:S.std.format, date:m.date, name:m.name, contestId:m.contestId,
    fieldSize:A.fieldSize, validEntries:A.valid.length, skipped:S.std.skipped.length, fee:m.fee, prizePool:m.prizePool, rakePct:m.rakePct,
    payoutModel: A.table ? {kind:'estimated DK curve v1', pool:A.table.pool, paid:A.table.paid, firstShare:.3, paidShare:.2, minCashX:1.5, alpha:A.table.alpha, rakePct:m.prizePool ? null : rakeOf(m), prizePoolEntered:!!m.prizePool} : null,
    winnings:S.winnings, overrides:S.overrides,
    sources:{standings:sources[0].hash, projections: S.projText ? sources[1].hash : null}, files:{standings:S.stdFile, projections:S.projFile},
    sets, summary: contestSummary()};
  return {record, sources};
}
$('#saveBtn').onclick = async ()=>{
  if(!S.A) return;
  const b = $('#saveBtn'); b.disabled = true;
  try{
    const {record, sources} = contestRecord();
    const r = await DB.saveContest(record, sources);
    S.historyId = record.id; LS.set('aOpen', record.id);
    DB.persist();
    msg(`<span class="good">${r.replaced ? 'Updated' : 'Saved'} ${esc(record.name || record.id)} in history.</span>${r.replaced ? ' It replaced the earlier copy of the same contest, so nothing is counted twice.' : ''}`);
    recompute(); render();
  }catch(e){ console.error(e); msg(`<span class="warn">Save failed: ${esc(e.message)}. Nothing was written.</span>`); }
  b.disabled = false;
};
async function openContest(id, quiet){
  if(id.startsWith('LEGACY|')) return openLegacy(id);
  const c = await DB.getContest(id); if(!c) throw new Error('Not found in history.');
  status('Opening '+(c.name||c.id)+'…');
  const stdText = await DB.getSourceText(c.sources.standings);
  if(!stdText) throw new Error('The standings file for this contest is missing from storage.');
  const projText = c.sources.projections ? await DB.getSourceText(c.sources.projections) : null;
  Object.assign(S, {stdText, stdFile:c.files.standings, std:C.parseStandings(stdText, c.files.standings), projText, projFile: projText ? c.files.projections : '', proj: projText ? C.parseProjections(projText, c.files.projections) : null,
    overrides: c.overrides||{}, winnings: c.winnings||{}, historyId: c.id, legacy:false});
  S.meta = {site:c.site, sport:c.sport, date:c.date, name:c.name, contestId:c.contestId, fee:c.fee, prizePool:c.prizePool, rakePct:c.rakePct};
  S.sets = Array.from({length:10}, (_,i)=>slotDefault(i));
  for(const s of c.sets||[]){ const t = await DB.getSourceText(s.sourceHash); const slot = S.sets[s.slot]; Object.assign(slot, {name:s.name, strategy:s.strategy||'', mitigation:s.mitigation??null, version:s.version||''}); if(t) loadSet(s.slot, t, s.fileName); else slot.error = 'source file missing'; }
  LS.set('aOpen', c.id); metaToInputs(); recompute();
  if(!quiet) msg(`Opened ${esc(c.name || c.id)} from history.`);
}
// original Dupe Checker records: rebuilt from what they kept (lineup groups, your entries, projections, sets)
async function openLegacy(id){
  const L = (await DB.getLegacy(id)).record;
  const entries = [], mine = new Set((L.myEntries||[]).map(e=>e.key));
  const toSlots = g => [{role:'CPT', name:g.captain}, ...(g.flex||[]).map(n=>({role:'FLEX', name:n}))];
  for(const e of L.myEntries||[]) entries.push({id:e.id||'', name:e.name, user:C.baseUser(e.name), rank:null, points:C.num(e.points), lineup:'', slots:toSlots(e)});
  const myCount = {}; for(const e of L.myEntries||[]) myCount[e.key] = (myCount[e.key]||0)+1;
  let k=0; for(const g of L.fieldGroups||[]){ const n = g.count - (myCount[g.key]||0); for(let i=0;i<n;i++) entries.push({id:'L'+(k++), name:'(field)', user:'', rank:null, points:C.num(g.points), lineup:'', slots:toSlots(g)}); }
  for(let i=0;i<(L.missingRows||0);i++) entries.push({id:'M'+i, name:'(no lineup)', user:'', rank:null, points:0, lineup:'', invalid:'no lineup'});
  const std = {kind:'standings', fileName:'legacy', contestId:'', header:[], entries, players:[], skipped:entries.filter(e=>e.invalid), dupIds:0, signature:'CPTx1 FLEXx5', format:'Showdown'};
  const proj = L.projectionRows && L.projectionRows.length ? {kind:'projections', fileName:'legacy', header:[], rows:L.projectionRows.map(p=>({...p, id:String(p.id||'')})), issues:[], hasCpt:true} : null;
  Object.assign(S, {stdText:null, stdFile:'Legacy: '+L.fingerprint, std, projText:null, projFile: proj?'legacy projections':'', proj, overrides:{}, winnings:{}, historyId:id, legacy:true});
  S.meta = {site:'DK', sport:'', date:String(L.savedAt||'').slice(0,10), name:L.fingerprint, contestId:'', fee:C.num(L.entryFee), prizePool:null, rakePct:null};
  S.sets = Array.from({length:10}, (_,i)=>slotDefault(i));
  (L.lineupSets||[]).slice(0,10).forEach((s,i)=>{ const rows = (s.rows||[]).map(r=>({...r, cptId:String(r.cptId), flexIds:(r.flexIds||[]).map(String), idKey: JSON.stringify([['CPT',[String(r.cptId)]],['FLEX',(r.flexIds||[]).map(String).sort()]]), uniq: r.uniq ?? null, normRoi: r.normroi ?? null}));
    Object.assign(S.sets[i], {name:s.name, parsed:{kind:'set', rows, issues:[]}, fileName:'legacy'}); });
  metaToInputs(); recompute();
  msg('Opened a record imported from the original Dupe Checker. Usernames of other players and ranks weren\'t kept in that format, so tracked-player comparisons cover only your entries. It can\'t be re-saved.');
}
async function recalcAll(){
  const list = (await DB.listContests()); let n=0;
  const keep = {...S, sets: S.sets};
  for(const c of list){ try{ await openContest(c.id, true); const sum = contestSummary(); await DB.updateContestFields(c.id, {summary: sum}); n++; status(`Recalculated ${n} of ${list.length}…`); }catch(e){ console.error(e); } }
  Object.assign(S, keep); recompute();
  return n;
}
let histCache = null;
VIEWS.history = el => {
  el.innerHTML = '<div class="card muted">Loading history…</div>';
  loadHistory().then(h=>{ if(view==='history'){ el.innerHTML = h; BIND.history(el); } }).catch(e=>{ el.innerHTML = `<div class="card warn">History storage error: ${esc(e.message)}</div>`; });
};
async function loadHistory(){
  const [list, legacy, est] = await Promise.all([DB.listContests(), DB.getAll('legacy'), DB.estimate()]);
  histCache = list;
  list.sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')) || b.savedAt-a.savedAt);
  const stale = list.filter(c=>!c.summary || c.summary.calcVersion!==C.CALC_VERSION || String(c.summary.trackedUsers)!==String(trackedList())).length;
  let h = `<div class="card"><div class="row" style="justify-content:space-between"><div><h3 style="margin:0">History</h3><div class="note" style="margin:0">Stored in this browser (IndexedDB) for ${esc(location.host||'this page')}. Raw files are kept compressed so every metric can be recalculated later. Export a backup now and then; browser storage doesn't move between devices or sites.</div></div>
    <div class="row"><button id="hExp">Export backup</button><button id="hImp">Import / merge</button><button id="hRecalc" ${list.length?'':'disabled'}>Recalculate all</button><input type="file" id="hFile" accept=".json,.gz,application/json,application/gzip" hidden></div></div>
    <div class="msg" id="hMsg">${stale?`<span class="amber">${stale} saved contest${stale==1?'':'s'} were summarised with other tracked players or an older calculation. Recalculate all to refresh them.</span>`:''}</div>
    ${tiles([[int(list.length),'Saved contests'],[int(list.reduce((s,c)=>s+(c.fieldSize||0),0)),'Field entries'],[int(list.reduce((s,c)=>s+(c.sets||[]).length,0)),'Lineup sets'],[int(list.reduce((s,c)=>s+(c.summary?.sets||[]).reduce((z,x)=>z+x.n,0),0)),'Hypothetical lineups'],
      legacy.length && [int(legacy.length),'Imported from old Dupe Checker'], est && [`${(est.usage/1048576).toFixed(1)} MB`,'Storage used']])}</div>`;
  // strategy history
  const groupBy = LS.get('aHGroup','strategy');
  const strat = new Map();
  for(const c of list) for(const s of c.summary?.sets||[]){ const lab = groupBy==='name' ? s.name : s.label; const a = strat.get(lab) || {lab, rows:[]}; a.rows.push({c, s}); strat.set(lab, a); }
  const agg = a => { const r = a.rows, N = r.reduce((z,x)=>z+x.s.valid,0), dn = r.reduce((z,x)=>z+(x.s.dupes?.n||0),0), sc = r.reduce((z,x)=>z+x.s.scoredN,0);
    const ew = k => { let w=0,t=0; for(const x of r){ const v = k==='dupes'?x.s.dupes?.avg:k==='unique'?x.s.dupes?.unique:x.s[k]; const n = k==='dupes'||k==='unique' ? x.s.dupes?.n||0 : x.s.valid; if(ok(v) && n){ t+=v*n; w+=n; } } return w ? t/w : null; };
    const cw = k => C.mean(r.map(x=>k==='dupes'?x.s.dupes?.avg:k==='unique'?x.s.dupes?.unique:x.s[k]));
    const roiR = r.filter(x=>ok(x.s.payoutTotal) && x.s.cost); const pay = roiR.reduce((z,x)=>z+x.s.payoutTotal,0), cost = roiR.reduce((z,x)=>z+x.s.cost,0);
    return {lab:a.lab, contests:new Set(r.map(x=>x.c.id)).size, n:N, dn, projE:ew('avgProj'), projC:cw('avgProj'), p90E:ew('avgP90'), dupE:ew('dupes'), dupC:cw('dupes'), uniqE:ew('unique'), uniqC:cw('unique'),
      top1: sc ? r.reduce((z,x)=>z+x.s.top1n,0)/sc*100 : null, top01: sc ? r.reduce((z,x)=>z+x.s.top01n,0)/sc*100 : null, roi: cost ? (pay/cost-1)*100 : null, roiC: C.mean(roiR.map(x=>x.s.roi)), roiN: roiR.length, pred: ew('predRoi')}; };
  const SA = [...strat.values()].map(agg);
  let base = LS.get('aHBase', null); if(!SA.some(x=>x.lab===base)) base = SA[0]?.lab;
  const per = (lab, k) => { const m = new Map(); for(const x of strat.get(lab)?.rows||[]){ const v = k==='dupes'?x.s.dupes?.avg:k==='unique'?x.s.dupes?.unique:x.s[k]; m.set(x.c.id, ok(v)?v:null); } return m; };
  const pr = (lab, k, flip) => { const p = C.paired(per(lab,k), per(base,k)); if(!p.n) return '—'; const v = flip ? -p.mean : p.mean; return `${sgn(v)} <span class="tiny muted">±${f(p.se)} · ${p.n}</span>`; };
  h += `<div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Strategies across contests</h3><div class="row"><div class="seg"><button data-hg="strategy" class="${groupBy!=='name'?'on':''}">By strategy + mitigation</button><button data-hg="name" class="${groupBy==='name'?'on':''}">By set name</button></div></div></div>
    <div class="tw free" style="margin-top:8px"><table><thead><tr><th>Strategy</th><th class="n">Contests</th><th class="n">Lineups</th><th class="n">Avg proj</th><th class="n">Avg P90</th><th class="n">Avg dupes</th><th class="n">per contest</th><th class="n">Unique</th><th class="n">per contest</th><th class="n">Top 1%</th><th class="n">Top 0.1%</th><th class="n">Est. realized ROI</th><th class="n">per contest</th><th class="n">Pred ROI</th></tr></thead><tbody>
    ${SA.map(a=>`<tr><td class="nw"><b>${esc(a.lab)}</b></td><td class="n">${a.contests}</td><td class="n">${int(a.n)}</td><td class="n">${f(a.projE)}</td><td class="n">${f(a.p90E)}</td><td class="n">${f(a.dupE)}</td><td class="n muted">${f(a.dupC)}</td><td class="n">${pc(a.uniqE)}</td><td class="n muted">${pc(a.uniqC)}</td><td class="n">${pc(a.top1,2)}</td><td class="n">${pc(a.top01,2)}</td><td class="n ${cls(a.roi)}">${pc(a.roi)}${a.roiN<a.contests?` <span class="tiny muted">${a.roiN}/${a.contests}</span>`:''}</td><td class="n muted">${pc(a.roiC)}</td><td class="n muted">${pc(a.pred)}</td></tr>`).join('') || `<tr><td colspan="14" class="empty">Save contests with lineup sets to build strategy history.</td></tr>`}</tbody></table></div>
    <div class="note">First figure weights every lineup equally; "per contest" averages contest results so a big contest doesn't dominate. ROI = total modeled payout ÷ total fees − 1 over contests with a fee. Predicted ROI definitions can change with mitigation settings and source versions, so compare it only within a strategy.</div>
    ${SA.length>1 ? `<h3 style="margin-top:14px">Paired against <select id="hBase" class="sm">${SA.map(a=>`<option ${a.lab===base?'selected':''}>${esc(a.lab)}</option>`).join('')}</select> on the same contests</h3>
    <div class="tw free"><table><thead><tr><th>Strategy</th><th class="n">Proj sacrificed</th><th class="n">P90 sacrificed</th><th class="n">Dupes removed</th><th class="n">Unique gain (pp)</th><th class="n">Δ Est. ROI (pp)</th></tr></thead><tbody>
    ${SA.filter(a=>a.lab!==base).map(a=>`<tr><td class="nw">${esc(a.lab)}</td><td class="n">${pr(a.lab,'avgProj',true)}</td><td class="n">${pr(a.lab,'avgP90',true)}</td><td class="n">${pr(a.lab,'dupes',true)}</td><td class="n">${pr(a.lab,'unique')}</td><td class="n">${pr(a.lab,'roi')}</td></tr>`).join('')}</tbody></table></div>
    <div class="note">Mean difference per contest ± standard error · number of paired contests. Contests are the unit, because lineups within one slate move together. A handful of contests is not enough to pick a winner.</div>` : ''}</div>`;
  // tracked players across contests
  const users = new Map();
  for(const c of list) for(const [u,t] of Object.entries(c.summary?.tracked||{})){ const a = users.get(u) || {u, rows:[]}; a.rows.push({c,t}); users.set(u,a); }
  const UA = [...users.values()].map(a=>{ const r = a.rows, n = r.reduce((z,x)=>z+x.t.n,0), dn = r.reduce((z,x)=>z+(x.t.dupes?.n||0),0);
    const ew = (get, w) => { let s=0, W=0; for(const x of r){ const v=get(x.t), ww=w(x.t); if(ok(v)&&ww){ s+=v*ww; W+=ww; } } return W ? s/W : null; };
    const roiR = r.filter(x=>ok(x.t.payoutTotal) && x.t.cost), pay = roiR.reduce((z,x)=>z+x.t.payoutTotal,0), cost = roiR.reduce((z,x)=>z+x.t.cost,0);
    const exR = r.filter(x=>ok(C.num(x.c.winnings?.[a.u])) && x.c.fee), win = exR.reduce((z,x)=>z+C.num(x.c.winnings[a.u]),0), exCost = exR.reduce((z,x)=>z+x.t.all*x.c.fee,0);
    const rk = r.reduce((z,x)=>z+x.t.rankedN,0);
    return {u:a.u, contests:r.length, n, dupE: ew(t=>t.dupes?.avg, t=>t.dupes?.n), dupC: C.mean(r.map(x=>x.t.dupes?.avg)), uniqE: ew(t=>t.dupes?.unique, t=>t.dupes?.n), uniqC: C.mean(r.map(x=>x.t.dupes?.unique)),
      le1: ew(t=>t.dupes?.le1, t=>t.dupes?.n), loss: ew(t=>t.avgContestLoss, t=>t.projCoverage), gap: ew(t=>t.avgGap, t=>t.projCoverage), proj: ew(t=>t.avgProj, t=>t.projCoverage),
      top1: rk ? r.reduce((z,x)=>z+x.t.top1n,0)/rk*100 : null, roi: cost ? (pay/cost-1)*100 : null, roiN: roiR.length, exact: exCost ? (win/exCost-1)*100 : null, exN: exR.length}; });
  h += `<div class="card"><h3>Tracked players across contests</h3><div class="tw free"><table><thead><tr><th>Player</th><th class="n">Contests</th><th class="n">Entries</th><th class="n">Avg proj</th><th class="n">Avg dupes</th><th class="n">per contest</th><th class="n">Unique</th><th class="n">per contest</th><th class="n">≤1 dupe</th><th class="n">Contest loss</th><th class="n">Eff. gap</th><th class="n">Top 1%</th><th class="n">Est. realized ROI</th><th class="n">Exact ROI</th></tr></thead><tbody>
    ${UA.map(a=>`<tr class="${a.u===C.baseUser(me())?'mine':''}"><td class="nw"><b>${esc(a.u)}</b></td><td class="n">${a.contests}</td><td class="n">${int(a.n)}</td><td class="n">${f(a.proj)}</td><td class="n">${f(a.dupE)}</td><td class="n muted">${f(a.dupC)}</td><td class="n">${pc(a.uniqE)}</td><td class="n muted">${pc(a.uniqC)}</td><td class="n">${pc(a.le1)}</td><td class="n">${f(a.loss)}</td><td class="n">${f(a.gap)}</td><td class="n">${pc(a.top1,2)}</td>
      <td class="n ${cls(a.roi)}">${pc(a.roi)}${a.roiN<a.contests?` <span class="tiny muted">${a.roiN}/${a.contests}</span>`:''}</td><td class="n ${cls(a.exact)}">${a.exN?pc(a.exact)+` <span class="tiny muted">${a.exN}</span>`:'—'}</td></tr>`).join('') || `<tr><td colspan="14" class="empty">Saved contests will show your and your tracked players' history here.</td></tr>`}</tbody></table></div>
    <div class="note">Contests a player didn't enter are left out, not counted as zero. Exact ROI only uses contests where you entered real winnings.</div></div>`;
  // contest list
  h += `<div class="card"><h3>Saved contests</h3>${list.map(c=>{ const me_ = c.summary?.tracked?.[C.baseUser(me())];
    return `<div class="hist-item"><div style="min-width:0"><div><span class="pill ${esc(c.site)}">${esc(c.site)}</span> <b>${esc(c.sport||'')}</b> <span class="pill type">${esc(c.format||'')}</span> <b>${esc(c.name || 'Contest '+c.contestId)}</b> <span class="muted small">${esc(c.date||'')}</span></div>
      <div class="chips"><span>${int(c.fieldSize)} entries</span><span>${c.fee?money(c.fee)+' fee':'no fee'}</span><span>${(c.sets||[]).length} sets</span>${me_?`<span>you: ${me_.all} entries, ${pc(me_.dupes?.unique)} unique${ok(me_.roi)?', est. ROI '+pc(me_.roi):''}</span>`:''}<span>ID ${esc(c.contestId||'—')}</span><span>saved ${new Date(c.updatedAt||c.savedAt).toLocaleDateString()}</span>${c.summary?.calcVersion!==C.CALC_VERSION?'<span class="amber">needs recalculation</span>':''}</div></div>
      <div class="row"><button class="sm primary" data-hopen="${esc(c.id)}">Open</button><button class="sm" data-hdel="${esc(c.id)}">Delete</button></div></div>`; }).join('') || '<div class="muted small">No saved contests yet. Load a contest and press Save to history.</div>'}
    ${legacy.map(l=>`<div class="hist-item"><div><span class="pill type">old Dupe Checker</span> <b>${esc(l.record.fingerprint)}</b> <span class="muted small">${esc(String(l.record.savedAt||'').slice(0,10))} · ${int(l.record.validEntries)} entries</span></div><div class="row"><button class="sm" data-hopen="${esc(l.id)}">Open</button><button class="sm" data-hdel="${esc(l.id)}">Delete</button></div></div>`).join('')}</div>`;
  return h;
}
BIND.history = el => {
  const hm = el.querySelector('#hMsg'), say = (t, bad) => { hm.innerHTML = bad ? `<span class="warn">${t}</span>` : t; };
  el.querySelector('#hExp').onclick = async ()=>{ try{ say('Preparing backup…'); const {blob, counts} = await DB.exportBackup(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `contest-analytics-backup-${new Date().toISOString().slice(0,10)}.json.gz`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
    say(`<span class="good">Backup downloaded: ${counts.contests} contests, ${counts.sources} files${counts.legacy?`, ${counts.legacy} old Dupe Checker records`:''}.</span> Keep it somewhere safe (it holds your entry data).`); }catch(e){ say('Export failed: '+esc(e.message), true); } };
  const fi = el.querySelector('#hFile');
  el.querySelector('#hImp').onclick = ()=>fi.click();
  fi.onchange = async ()=>{ const file = fi.files[0]; fi.value=''; if(!file) return;
    try{ say('Importing…'); const r = await DB.importBackup(file);
      if(r.settings?.trackedUsers?.length){ tracked = [...r.settings.trackedUsers, '', '', '', '', '', ''].slice(0,6); if(!tracked[0]) tracked[0]='relicck'; LS.set('aTracked', tracked); renderTracked(); }
      await renderViewAsync(); $('#hMsg').innerHTML = `<span class="good">Imported: ${r.added} new contest${r.added==1?'':'s'}, ${r.replaced} updated, ${r.skipped} already up to date${r.legacyAdded?`, ${r.legacyAdded} from the old Dupe Checker`:''}.</span>${r.settings?.trackedUsers?' Tracked players restored from the backup.':''}`; }
    catch(e){ say('Import failed, nothing changed: '+esc(e.message), true); } };
  el.querySelector('#hRecalc').onclick = async ()=>{ say('Recalculating…'); const n = await recalcAll(); await renderViewAsync(); $('#hMsg').innerHTML = `<span class="good">Recalculated ${n} contest${n==1?'':'s'} with the current tracked players.</span>`; };
  el.querySelectorAll('[data-hopen]').forEach(b=>b.onclick = async ()=>{ try{ await openContest(b.dataset.hopen); view='overview'; LS.set('aView',view); render(); window.scrollTo({top:0}); }catch(e){ say(esc(e.message), true); } });
  el.querySelectorAll('[data-hdel]').forEach(b=>b.onclick = async ()=>{ if(b.dataset.confirm!=='1'){ b.dataset.confirm='1'; b.textContent='Delete for good?'; b.classList.add('primary'); return; }
    await DB.deleteContest(b.dataset.hdel); if(S.historyId===b.dataset.hdel){ S.historyId=null; renderFiles(); } renderViewAsync(); });
  el.querySelectorAll('[data-hg]').forEach(b=>b.onclick=()=>{ LS.set('aHGroup', b.dataset.hg); renderViewAsync(); });
  const hb = el.querySelector('#hBase'); if(hb) hb.onchange = ()=>{ LS.set('aHBase', hb.value); renderViewAsync(); };
};
async function renderViewAsync(){ if(view!=='history') return renderView(); const el=$('#view'); const h = await loadHistory(); el.innerHTML = h; BIND.history(el); }

// ---------- start ----------
renderTracked(); metaToInputs();
DB.getSettings().then(s=>{ if(s && Array.isArray(s.trackedUsers) && !LS.get('aTracked', null)){ tracked = [...s.trackedUsers,'','','','','',''].slice(0,6); renderTracked(); render(); } }).catch(()=>{});
render();
const last = LS.get('aOpen', null);
if(last) openContest(last, true).then(()=>render()).catch(()=>{ LS.set('aOpen', null); });
})();
