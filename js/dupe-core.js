/* Dupe Checker: calculation core (no DOM, no storage).
   Loaded by analytics.html in the browser and by tests/run-tests.js in Node.

   Definitions kept from the original DFS Dupe Checker, tightened where the
   integration spec asked for it. Every convention is written down here:

   - Lineup key: role-specific. Multiplier slots (CPT, MVP, STAR, PRO) are keyed by
     role; every other slot (FLEX, UTIL, classic positions) is an unordered multiset.
     CPT A + FLEX {B,C} == CPT A + FLEX {C,B}; CPT B + FLEX {A,C} is different.
     Serialised as JSON so names with "|" or commas can't collide.
   - Times played = number of valid field entries with that key.
   - Dupes (normalised) = other entries sharing the lineup.
       actual field entry:          times played - 1
       hypothetical (inserted):     field entries with that key (0 if absent)
       hypothetical, unresolved ID: unknown (null), never 0
   - Percentiles: nearest-rank (sorted ascending, value at ceil(p*n)).
   - Lineup projection = CPT Proj (explicit column, never 1.5x again) + sum FLEX Proj.
     Any missing piece -> null, and the lineup is left out of projection metrics.
   - Ranks: competition ranking on points (ties share the best rank).
     Top X% = rank <= X% of field size. Hypothetical insertion uses field size + 1.
   - Payout model (estimated, never "exact"): see payoutTable().
   - CPT and FLEX ownership / exposure are always kept separate.
*/
(function(root){
'use strict';
const CALC_VERSION = 2; // 2: default 13% rake estimate in the UI

// ---------- CSV ----------
function parseCSV(text){
  text = String(text||'').replace(/^﻿/, '');
  const rows=[]; let row=[], f='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){ if(c=='"'){ if(text[i+1]=='"'){ f+='"'; i++; } else q=false; } else f+=c; }
    else if(c=='"') q=true;
    else if(c==','){ row.push(f); f=''; }
    else if(c=='\n'||c=='\r'){ if(c=='\r'&&text[i+1]=='\n') i++; row.push(f); rows.push(row); row=[]; f=''; }
    else f+=c;
  }
  if(f!==''||row.length){ row.push(f); rows.push(row); }
  return rows;
}
function toCSV(rows){ return rows.map(r=>r.map(v=>{ const s = v==null ? '' : String(v); return /[",\n\r]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }).join(',')).join('\r\n'); }

// numbers: "889.6%" -> 889.6, "$1,000" -> 1000, "" -> null
function num(v){
  if(v===undefined||v===null) return null;
  const s = String(v).replace(/[%,$\s]/g,'');
  if(s==='' || s==='-' || /^n\/?a$/i.test(s)) return null;
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
function normName(n, stripSuffix){
  let x = String(n||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()
    .replace(/&/g,' and ').replace(/[’'`.]/g,'').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
  if(stripSuffix) x = x.replace(/\s+(jr|sr|ii|iii|iv|v)$/,'').trim();
  return x;
}
// "relicck (8/45)" -> "relicck". Only the trailing entry-number suffix is removed.
function baseUser(n){ return String(n||'').replace(/\s*\(\d+\s*\/\s*\d+\)\s*$/,'').trim().toLowerCase(); }
function hashStr(str){ // 53-bit string hash (cyrb53), hex
  let h1=0xdeadbeef, h2=0x41c6ce57;
  for(let i=0;i<str.length;i++){ const c=str.charCodeAt(i); h1=Math.imul(h1^c,2654435761); h2=Math.imul(h2^c,1597334677); }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return (4294967296*(2097151&h2)+(h1>>>0)).toString(16).padStart(14,'0');
}

// ---------- stats ----------
function percentile(arr, p){ // nearest-rank
  const a = arr.filter(Number.isFinite); if(!a.length) return null;
  const x = [...a].sort((m,n)=>m-n); return x[Math.max(0, Math.ceil(p*x.length)-1)];
}
function mean(arr){ const a = arr.filter(v=>v!==null && Number.isFinite(v)); return a.length ? a.reduce((s,v)=>s+v,0)/a.length : null; }
function sd(arr){ const a = arr.filter(Number.isFinite); if(a.length<2) return null; const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1)); }
function dupeStats(d){ // d: array of normalised dupes (null = unknown, excluded and counted)
  const k = d.filter(v=>v!==null && Number.isFinite(v)), n = k.length;
  const share = f => n ? k.filter(f).length/n*100 : null;
  return {n, unknown: d.length-n, avg: mean(k), median: percentile(k,.5), p75: percentile(k,.75), p90: percentile(k,.9),
    max: n ? Math.max(...k) : null, unique: share(v=>v===0), le1: share(v=>v<=1), le4: share(v=>v<=4)};
}

// ---------- lineups ----------
const MULTI_ROLES = {CPT:'CPT', CAPTAIN:'CPT', MVP:'MVP', STAR:'STAR', PRO:'PRO'};
const ROLE_TOKENS = ['CPT','CAPTAIN','MVP','STAR','PRO','FLEX','UTIL','QB','RB','WR','TE','DST','DEF','K','PG','SG','SF','PF','G','F','C','LW','RW','D','W','P','SP','RP','1B','2B','3B','SS','OF','CF','M','GK','CPTN'];
const ROLE_RE = new RegExp('(?:^|\\s)('+ROLE_TOKENS.join('|')+')\\s+', 'g');
const roleClass = r => MULTI_ROLES[r] || 'FLEX';
const ROLE_ORDER = ['CPT','MVP','STAR','PRO','FLEX'];
// "CPT Josh Allen FLEX A FLEX B" -> [{role:'CPT',name:'Josh Allen'},{role:'FLEX',name:'A'},...]
function parseLineupString(s){
  s = String(s||'').trim(); if(!s) return null;
  const marks = []; let m; ROLE_RE.lastIndex = 0;
  while((m = ROLE_RE.exec(s))){ marks.push({role:m[1], at:m.index + (m[0].length - m[0].trimStart().length), end: ROLE_RE.lastIndex}); }
  if(!marks.length || marks[0].at!==0) return null;
  const slots = marks.map((k,i)=>({role:k.role=='CAPTAIN'||k.role=='CPTN'?'CPT':k.role, name: s.slice(k.end, i+1<marks.length ? marks[i+1].at : s.length).trim()}));
  if(slots.some(x=>!x.name)) return null;
  return slots;
}
// canonical key from slots + identity function (contest: normalised name; sets: resolved identity)
function lineupKey(slots, idOf){
  const by = {};
  for(const sl of slots){ const c = roleClass(sl.role); (by[c] ||= []).push(idOf(sl)); }
  return JSON.stringify(ROLE_ORDER.filter(r=>by[r]).map(r=>[r, by[r].sort()]));
}
const nameId = sl => normName(sl.name);
function signature(slots){ const c={}; for(const s of slots){ const k=roleClass(s.role); c[k]=(c[k]||0)+1; } return ROLE_ORDER.filter(r=>c[r]).map(r=>r+'x'+c[r]).join(' '); }
function formatFromSignature(sig){ return /^CPTx1 FLEXx\d+$/.test(sig) ? 'Showdown' : /MVP/.test(sig) ? 'Single game' : 'Classic'; }

// ---------- contest standings ----------
function findCol(h, names){ const n = h.map(x=>normName(x)); for(const c of names){ const i = n.indexOf(normName(c)); if(i>=0) return i; } return -1; }
function parseStandings(text, fileName){
  const rows = parseCSV(text);
  if(rows.length<2) throw new Error('No contest rows found.');
  const h = rows[0].map(x=>x.trim());
  const iRank=findCol(h,['Rank']), iId=findCol(h,['EntryId','Entry ID']), iName=findCol(h,['EntryName','Entry Name','Username']),
        iPts=findCol(h,['Points','FPTS Total','Score']), iLu=findCol(h,['Lineup']), iTR=findCol(h,['TimeRemaining']);
  if(iLu<0 || iName<0) throw new Error('Could not find the Lineup and EntryName columns. Use a DraftKings contest standings CSV.');
  // the player results table sits to the right on the same rows; parse it separately
  const iPl = h.indexOf('Player', iLu+1), iRole = h.indexOf('Roster Position'), iDr = h.indexOf('%Drafted'), iF = h.lastIndexOf('FPTS');
  const entries = [], skipped = [], seen = new Set(), players = [];
  let dupIds = 0;
  for(let r=1;r<rows.length;r++){
    const row = rows[r];
    if(iPl>=0 && row[iPl] && row[iPl].trim()) players.push({name: row[iPl].trim(), role: (row[iRole]||'').trim().toUpperCase(), drafted: num(row[iDr]), fpts: num(row[iF])});
    const id = iId>=0 ? (row[iId]||'').trim() : '';
    const nm = (row[iName]||'').trim();
    if(!id && !nm) continue; // player-only row
    if(id){ if(seen.has(id)){ dupIds++; continue; } seen.add(id); }
    const e = {id, name:nm, user: baseUser(nm), rank: iRank>=0 ? num(row[iRank]) : null, points: iPts>=0 ? num(row[iPts]) : null,
               tr: iTR>=0 ? (row[iTR]||'') : '', lineup: (row[iLu]||'').trim()};
    const slots = parseLineupString(e.lineup);
    if(!slots){ e.invalid = e.lineup ? 'unrecognised lineup' : 'no lineup'; skipped.push(e); }
    else e.slots = slots;
    entries.push(e);
  }
  // roster-slot validation against the contest's dominant slot signature
  const sigCount = {};
  for(const e of entries) if(e.slots) sigCount[signature(e.slots)] = (sigCount[signature(e.slots)]||0)+1;
  const sig = Object.entries(sigCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || '';
  for(const e of entries) if(e.slots && signature(e.slots)!==sig){ e.invalid = 'roster slots don\'t match '+sig; delete e.slots; skipped.push(e); }
  for(const e of entries) if(e.slots){ const ids = e.slots.map(nameId); if(new Set(ids).size!==ids.length && !/Classic/.test(formatFromSignature(sig))){ e.invalid='same player twice'; delete e.slots; skipped.push(e); } }
  const fm = String(fileName||'').match(/contest-standings-(\d+)/i);
  return {kind:'standings', fileName: fileName||'', contestId: fm ? fm[1] : '', header: h, entries, players, skipped, dupIds, signature: sig, format: formatFromSignature(sig)};
}

// ---------- projections ----------
function parseProjections(text, fileName){
  const rows = parseCSV(text); if(rows.length<2) throw new Error('No projection rows found.');
  const h = rows[0].map(x=>x.trim());
  const ni=findCol(h,['Name','Player','Player Name','Nickname']), idi=findCol(h,['DFS ID','Player ID','ID']),
    fi=findCol(h,['FLEX Proj','Flex Projection','UTIL Proj','Projection','Proj','FPTS']), ci=findCol(h,['CPT Proj','Captain Proj','MVP Proj']),
    foi=findCol(h,['FLEX Own','Flex Ownership','UTIL Own','Ownership','Own']), coi=findCol(h,['CPT Own','Captain Own','MVP Own']);
  if(ni<0 || fi<0) throw new Error('The projections CSV needs a name column and a FLEX projection column (e.g. Name + FLEX Proj).');
  const out = [], issues = [];
  rows.slice(1).forEach((r,i)=>{
    const name = (r[ni]||'').trim(); if(!name) return;
    const p = {name, id: idi>=0 ? String(r[idi]||'').trim() : '', flexProj: num(r[fi]), cptProj: ci>=0 ? num(r[ci]) : null,
      flexOwn: foi>=0 ? num(r[foi]) : null, cptOwn: coi>=0 ? num(r[coi]) : null, raw: r};
    if(p.flexProj===null) issues.push(`Row ${i+2} (${name}): no FLEX projection`);
    out.push(p);
  });
  if(!out.length) throw new Error('No usable projection rows.');
  const fm = String(fileName||'').match(/(\d{2})-(\d{2})-(\d{4})-(DraftKings|FanDuel)-?(.*)\.csv$/i);
  return {kind:'projections', fileName: fileName||'', header: h, rows: out, issues, hasCpt: ci>=0,
    date: fm ? `${fm[3]}-${fm[1]}-${fm[2]}` : '', site: fm ? (/^d/i.test(fm[4])?'DK':'FD') : '', slateLabel: fm ? fm[5].replace(/-/g,' ') : ''};
}

// match contest names to projection rows. overrides: {contestNormName: projectionId | '' (= no match)}
function matchProjections(contestNames, proj, overrides){
  overrides = overrides || {};
  const exact = new Map(), loose = new Map(), byId = new Map();
  proj.rows.forEach((p,i)=>{ p._i=i; const a=normName(p.name), b=normName(p.name,true);
    (exact.get(a) || exact.set(a,[]).get(a)).push(p); (loose.get(b) || loose.set(b,[]).get(b)).push(p); if(p.id) byId.set(p.id,p); });
  const match = new Map(), unmatched = [], ambiguous = [], used = new Set(); let viaOverride = 0;
  for(const disp of contestNames){
    const n = normName(disp);
    if(Object.prototype.hasOwnProperty.call(overrides, n)){
      const o = overrides[n]; const p = o ? (byId.get(o) || proj.rows.find(x=>x.name===o)) : null;
      if(p){ match.set(n,p); used.add(p); viaOverride++; } else unmatched.push({name:disp, norm:n, override:true});
      continue;
    }
    let c = exact.get(n)||[];
    if(c.length===1){ match.set(n,c[0]); used.add(c[0]); continue; }
    if(c.length>1){ ambiguous.push({name:disp, norm:n, candidates:c.map(x=>x.name+(x.id?' #'+x.id:''))}); continue; }
    c = loose.get(normName(disp,true))||[];
    if(c.length===1){ match.set(n,c[0]); used.add(c[0]); continue; }
    if(c.length>1){ ambiguous.push({name:disp, norm:n, candidates:c.map(x=>x.name+(x.id?' #'+x.id:''))}); continue; }
    unmatched.push({name:disp, norm:n});
  }
  const reverse = new Map(); for(const [n,p] of match) if(!reverse.has(p)) reverse.set(p, n);
  return {match, reverse, byId, unmatched, ambiguous, unused: proj.rows.filter(p=>!used.has(p)), viaOverride};
}

// ---------- hypothetical lineup sets ----------
const SET_COLS = {proj:['Proj','Projection'], actual:['Actual','Actual Points'], own:['Own'], iter:['IterScore'], p90:['P90'], p50:['P50'], p10:['P10'],
  salary:['Salary'], roi:['ROI'], normRoi:['NormROI'], top1:['Top 1%'], top01:['Top 0.1%'], uniq:['Uniqueness'], stack:['Stack']};
function parseLineupSet(text, fileName){
  const a = parseCSV(text); if(a.length<2) throw new Error('No lineup rows found.');
  const h = a[0].map(x=>x.trim());
  // repeated FLEX headers are read by position, never through an object keyed by header
  const capCols = [], flexCols = [];
  h.forEach((x,i)=>{ const u=x.toUpperCase(); if(u==='CPT'||u==='CAPTAIN'||u==='MVP') capCols.push(i); else if(u==='FLEX'||u==='UTIL') flexCols.push(i); });
  if(capCols.length!==1 || !flexCols.length) throw new Error('Need one CPT column and FLEX columns.');
  const cols = {}; for(const [k,names] of Object.entries(SET_COLS)) cols[k] = findCol(h, names);
  const rows = [], issues = [];
  a.slice(1).forEach((r,ri)=>{
    if(!r.some(x=>String(x).trim())) return;
    const cptId = String(r[capCols[0]]||'').trim(), flexIds = flexCols.map(j=>String(r[j]||'').trim());
    const row = {line: ri+2, cptId, flexIds, raw: r};
    for(const k of Object.keys(SET_COLS)) if(k!=='stack') row[k] = cols[k]>=0 ? num(r[cols[k]]) : null;
    if(!cptId || flexIds.some(x=>!x)){ row.invalid = 'missing player ID'; issues.push(`Line ${ri+2}: missing player ID`); }
    else if(new Set([cptId,...flexIds]).size !== flexIds.length+1){ row.invalid = 'same player twice'; issues.push(`Line ${ri+2}: same player twice`); }
    row.idKey = JSON.stringify([['CPT',[cptId]],['FLEX',[...flexIds].sort()]]);
    rows.push(row);
  });
  if(!rows.length) throw new Error('No lineup rows found.');
  const fm = String(fileName||'').match(/^([a-z]+)-(dk|fd)-(.+?)-(\d{4}-\d{2}-\d{2})/i);
  return {kind:'set', fileName: fileName||'', header: h, capCol: capCols[0], flexCols, cols, rows, issues,
    sport: fm ? fm[1].toUpperCase() : '', site: fm ? fm[2].toUpperCase() : '', date: fm ? fm[4] : ''};
}

// ---------- payouts ----------
/* Estimated DraftKings-style payout table (the actual payout structure isn't in the standings file).
   pool   = prize pool if given, else fieldSize x fee x (1 - rake). The page defaults to a 13% rake estimate, stated in the UI.
   paid   = floor(20% of field), at least 1.  1st = 30% of pool.  Min cash = 1.5 x fee.
   ranks 2..paid: minCash x (paid / r)^alpha, alpha solved so ranks 2..paid total the other 70%
   (the power curve from the original Dupe Checker; the last paid rank gets exactly the min cash).
   Unrounded dollars; totals reconcile to the pool. Infeasible cases fall back and say why. */
function payoutTable({fieldSize, fee, prizePool, rakePct}){
  if(!fieldSize || !(fee>0)) return null;
  const notes = [];
  const pool = prizePool>0 ? prizePool : fieldSize*fee*(1-(rakePct||0)/100);
  const paid = Math.max(1, Math.floor(fieldSize*0.2));
  const pays = new Float64Array(paid+2);
  if(paid===1){ pays[1]=pool; notes.push('Only one paid place: it takes the whole pool.'); return {pool, paid, first:pool, minCash:pool, alpha:null, pays, notes, feasible:false}; }
  const first = 0.30*pool, minCash = 1.5*fee, rest = pool-first;
  pays[1] = first;
  if(minCash*(paid-1) > rest + 1e-9){
    for(let r=2;r<=paid;r++) pays[r] = rest/(paid-1);
    notes.push('Min cash of 1.5x fee is not feasible for this pool; ranks 2+ split the remaining 70% evenly.');
    return {pool, paid, first, minCash: rest/(paid-1), alpha:null, pays, notes, feasible:false};
  }
  const tot = a => { let z=0; for(let r=2;r<=paid;r++) z += minCash*Math.pow(paid/r,a); return z; };
  let lo=0, hi=1; while(tot(hi) < rest && hi<64) hi*=2;
  for(let k=0;k<100;k++){ const mid=(lo+hi)/2; if(tot(mid) < rest) lo=mid; else hi=mid; }
  const alpha=(lo+hi)/2;
  for(let r=2;r<=paid;r++) pays[r] = minCash*Math.pow(paid/r,alpha);
  // tiny numeric correction so the table sums exactly to the pool (spread above min cash)
  const diff = rest - tot(alpha); if(Math.abs(diff)>0) pays[2] += diff;
  if(pays[2] > first){ notes.push('2nd place would exceed 1st under this curve; capped at 1st.'); }
  let feasible = true;
  if(pays[2] > first){ const over = pays[2]-first; pays[2]=first; pays[3] += over; feasible=false; }
  return {pool, paid, first, minCash, alpha, pays, notes, feasible};
}
// field points sorted descending, for rank lookups
function sortedDesc(points){ return Float64Array.from(points.filter(Number.isFinite)).sort().reverse(); }
function countAbove(desc, p){ let lo=0, hi=desc.length; while(lo<hi){ const m=(lo+hi)>>1; if(desc[m] > p+1e-9) lo=m+1; else hi=m; } return lo; }
function countAtLeast(desc, p){ let lo=0, hi=desc.length; while(lo<hi){ const m=(lo+hi)>>1; if(desc[m] >= p-1e-9) lo=m+1; else hi=m; } return lo; }
// payout for a score. inserted=true: a hypothetical entry added to the field (joins the tie group).
function payoutFor(points, desc, table, inserted){
  if(points===null || !Number.isFinite(points) || !table) return null;
  const gt = countAbove(desc, points), eq = countAtLeast(desc, points) - gt + (inserted ? 1 : 0);
  if(eq<=0) return null;
  let total = 0; for(let r=gt+1; r<=gt+eq; r++) if(r<=table.paid) total += table.pays[r];
  return total/eq;
}
function rankFor(points, desc){ return points===null || !Number.isFinite(points) ? null : countAbove(desc, points)+1; }

// ---------- contest analysis ----------
/* Builds everything the UI needs from parsed inputs.
   std: parseStandings() result (or a rebuilt one from storage)
   proj: parseProjections() result or null
   opts: {fee, prizePool, rakePct, overrides, tracked:[usernames]} */
function analyzeContest(std, proj, opts){
  opts = opts || {};
  const valid = std.entries.filter(e=>e.slots);
  const groups = new Map();
  for(const e of valid){
    const key = lineupKey(e.slots, nameId); e.key = key;
    let g = groups.get(key);
    if(!g){ g = {key, slots: e.slots, cap: e.slots.filter(s=>roleClass(s.role)!=='FLEX').map(s=>s.name), flex: e.slots.filter(s=>roleClass(s.role)==='FLEX').map(s=>s.name).sort((a,b)=>a.localeCompare(b)), count:0, entries:[], points:null};
      groups.set(key, g); }
    g.count++; g.entries.push(e);
    if(e.points!==null && (g.points===null || e.points>g.points)) g.points = e.points;
  }
  const glist = [...groups.values()];
  // contest names (display) for matching
  const names = new Map(); for(const g of glist) for(const s of g.slots){ const n=normName(s.name); if(!names.has(n)) names.set(n, s.name); }
  const pm = proj ? matchProjections([...names.values()], proj, opts.overrides) : null;
  const projOf = name => pm ? pm.match.get(normName(name)) || null : null;
  const slotProj = s => { const p = projOf(s.name); if(!p) return null; const c = roleClass(s.role);
    return c==='FLEX' ? p.flexProj : (c==='CPT'||c==='MVP') ? p.cptProj : null; };
  const lineupProj = slots => { if(!pm) return null; let t=0; for(const s of slots){ const v=slotProj(s); if(v===null) return null; t+=v; } return t; };
  for(const g of glist) g.proj = lineupProj(g.slots);
  const projected = glist.filter(g=>g.proj!==null);
  const ceiling = projected.length ? Math.max(...projected.map(g=>g.proj)) : null;
  // best projection at or below each times-played level (field benchmark, independent of any filter)
  const byCount = [...projected].sort((a,b)=>a.count-b.count || b.proj-a.proj);
  const steps = []; let best = null;
  for(const g of byCount){ if(!best || g.proj>best.proj){ best=g; } if(steps.length && steps[steps.length-1].count===g.count) steps[steps.length-1].best = best; else steps.push({count:g.count, best}); }
  const bestAtOrBelow = tp => { let lo=0, hi=steps.length-1, ans=null; while(lo<=hi){ const m=(lo+hi)>>1; if(steps[m].count<=tp){ ans=steps[m].best; lo=m+1; } else hi=m-1; } return ans; };
  // Pareto frontier: nobody has >= projection and <= times played with one strict
  const frontier = []; let runMax = -Infinity;
  for(let i=0;i<byCount.length;){
    let j=i; while(j<byCount.length && byCount[j].count===byCount[i].count) j++;
    const top = byCount[i].proj;
    if(top > runMax + 1e-9){ for(let k=i;k<j && byCount[k].proj>=top-1e-9;k++) frontier.push(byCount[k]); runMax = top; }
    i=j;
  }
  // role-specific field exposure (counts over valid entries)
  const exposure = entries => { const m = new Map(); for(const e of entries) for(const s of e.slots){ const n=normName(s.name); const z = m.get(n) || {name:s.name, cpt:0, flex:0, other:0}; const c=roleClass(s.role); if(c==='FLEX') z.flex++; else if(c==='CPT'||c==='MVP') z.cpt++; else z.other++; m.set(n,z); } return m; };
  const fieldExp = exposure(valid);
  // player results from the standings (role-specific actual points and %drafted)
  const results = new Map(); for(const p of std.players){ results.set(normName(p.name)+'|'+roleClass(p.role), p); }
  // scores for ranks: every entry with known points, including entries without a valid lineup (they paid in too)
  const allPts = std.entries.map(e=>e.points).filter(v=>v!==null && Number.isFinite(v));
  const desc = sortedDesc(allPts);
  const fieldSize = std.entries.length;
  const table = payoutTable({fieldSize, fee: opts.fee, prizePool: opts.prizePool, rakePct: opts.rakePct});
  const top1Cut = Math.floor(fieldSize*0.01), top01Cut = Math.floor(fieldSize*0.001);
  return {std, proj, pm, groups, glist, valid, names, projOf, slotProj, lineupProj, ceiling, bestAtOrBelow, frontier, fieldExp, exposure,
    results, desc, fieldSize, table, top1Cut, top01Cut, unknownPoints: std.entries.length - allPts.length,
    fee: opts.fee>0 ? opts.fee : null, opts};
}

// entries of one tracked user (exact, case-insensitive, entry suffix stripped). [] = not entered.
function userEntries(A, username){ const u = baseUser(username); return u ? A.valid.filter(e=>e.user===u) : []; }
function userAllEntries(A, username){ const u = baseUser(username); return u ? A.std.entries.filter(e=>e.user===u) : []; }

// one portfolio of actual entries -> metrics
function portfolioMetrics(A, entries, allEntriesOfUser){
  const myMax = (()=>{ const p = entries.map(e=>A.groups.get(e.key).proj).filter(v=>v!==null); return p.length ? Math.max(...p) : null; })();
  const rows = entries.map(e=>{
    const g = A.groups.get(e.key), proj = g.proj;
    const fb = proj!==null ? A.bestAtOrBelow(g.count) : null;
    const rank = rankFor(e.points, A.desc);
    return {e, g, times: g.count, dupes: g.count-1, proj, points: e.points,
      contestLoss: proj!==null && A.ceiling!==null ? A.ceiling-proj : null,
      myLoss: proj!==null && myMax!==null ? myMax-proj : null,
      fieldBest: fb, gap: fb && proj!==null ? fb.proj-proj : null,
      rank, top1: rank!==null ? rank<=A.top1Cut : null, top01: rank!==null ? rank<=A.top01Cut : null,
      payout: A.table ? payoutFor(e.points, A.desc, A.table, false) : null};
  });
  const all = allEntriesOfUser || entries;
  const invalidCount = all.length - entries.length;
  const distinct = new Map(); for(const r of rows) if(!distinct.has(r.e.key)) distinct.set(r.e.key, r);
  const ds = dupeStats(rows.map(r=>r.dupes));
  const dsDistinct = dupeStats([...distinct.values()].map(r=>r.dupes));
  const withProj = rows.filter(r=>r.proj!==null);
  // ROI over every paid entry of this user (entries with no lineup score 0 and cost a fee too)
  let roi = null, payoutTotal = null, cost = null;
  if(A.table && A.fee){
    const pays = all.map(e=>payoutFor(e.points, A.desc, A.table, false));
    if(pays.every(v=>v!==null)){ payoutTotal = pays.reduce((s,v)=>s+v,0); cost = all.length*A.fee; roi = cost ? (payoutTotal/cost - 1)*100 : null; }
  }
  const known = rows.filter(r=>r.rank!==null);
  return {rows, n: rows.length, invalidCount, distinct: distinct.size, dupes: ds, dupesDistinct: dsDistinct, myMax,
    avgProj: mean(withProj.map(r=>r.proj)), projCoverage: withProj.length, avgPoints: mean(rows.map(r=>r.points)),
    avgContestLoss: mean(rows.map(r=>r.contestLoss)), avgGap: mean(rows.map(r=>r.gap)),
    top1: known.length ? known.filter(r=>r.top1).length/known.length*100 : null, top1n: known.filter(r=>r.top1).length,
    top01: known.length ? known.filter(r=>r.top01).length/known.length*100 : null, top01n: known.filter(r=>r.top01).length, rankedN: known.length,
    roi, payoutTotal, cost};
}

// ---------- hypothetical set evaluation ----------
// resolve one set row into the contest's identity space. Returns {key|null, status}
function resolveSetRow(A, r){
  if(r.invalid) return {key:null, status:'invalid', why:r.invalid};
  if(!A.pm) return {key:null, status:'unresolved', why:'no projections loaded (IDs need the projections file)'};
  const unresolvedNames = A.pm.unmatched.length + A.pm.ambiguous.length;
  const ids = [r.cptId, ...r.flexIds], toks = []; let absent = false;
  for(const id of ids){
    const p = A.pm.byId.get(id);
    if(!p) return {key:null, status:'unresolved', why:`ID ${id} not in projections`};
    const n = A.pm.reverse.get(p);
    if(n) toks.push(n);
    else if(unresolvedNames) return {key:null, status:'unresolved', why:`${p.name} not matched to a contest name`};
    else { absent = true; toks.push('~'+normName(p.name)); } // nobody in the field played this player at all
  }
  const slots = [{role:'CPT', name:toks[0]}, ...toks.slice(1).map(t=>({role:'FLEX', name:t}))];
  const key = lineupKey(slots, s=>s.name);
  return {key, status: absent ? 'absent' : (A.groups.has(key) ? 'in field' : 'not in field'), names: [r.cptId, ...r.flexIds].map(id=>A.pm.byId.get(id).name)};
}
function evalSetRow(A, r){
  const res = resolveSetRow(A, r);
  const g = res.key ? A.groups.get(res.key) : null;
  const dupes = res.key ? (g ? g.count : 0) : null; // field entries already holding this lineup
  // projection from the same projection file as the field (consistency); supplied Proj kept separately
  let projCalc = null;
  if(A.pm && !r.invalid){ const c = A.pm.byId.get(r.cptId), f = r.flexIds.map(id=>A.pm.byId.get(id));
    if(c && c.cptProj!==null && f.every(x=>x && x.flexProj!==null)) projCalc = c.cptProj + f.reduce((s,x)=>s+x.flexProj,0); }
  // actual score: supplied Actual; else matched field lineup's points; else role-adjusted player results
  let roleScore = null;
  if(A.pm && !r.invalid){
    const look = (id, role) => { const p = A.pm.byId.get(id); if(!p) return null; const n = normName(A.pm.reverse.get(p) ? A.names.get(A.pm.reverse.get(p)) : p.name);
      const hit = A.results.get(n+'|'+role); if(hit && hit.fpts!==null) return hit.fpts;
      // DK showdown: CPT scores 1.5x; derive from the FLEX row if nobody captained this player
      if(role==='CPT'){ const fx = A.results.get(n+'|FLEX'); if(fx && fx.fpts!==null) return Math.round(fx.fpts*1.5*100)/100; }
      return null; };
    const parts = [look(r.cptId,'CPT'), ...r.flexIds.map(id=>look(id,'FLEX'))];
    if(parts.every(v=>v!==null)) roleScore = parts.reduce((s,v)=>s+v,0);
  }
  // exact sources first: the file's Actual is rounded to 0.1, which can move a rank across a tie
  let points = null, scoreSrc = 'unknown';
  if(g && g.points!==null){ points = g.points; scoreSrc = 'contest standings'; }
  else if(roleScore!==null){ points = roleScore; scoreSrc = 'player results'; }
  else if(r.actual!==null){ points = r.actual; scoreSrc = 'file Actual'; }
  const crossDiff = r.actual!==null && points!==null && scoreSrc!=='file Actual' ? r.actual - points : null;
  const N1 = A.fieldSize + 1;
  const rank = rankFor(points, A.desc);
  const tp = dupes!==null ? dupes+1 : null; // times played once inserted
  const fb = projCalc!==null && tp!==null ? A.bestAtOrBelow(tp) : null;
  return {...r, res, key:res.key, status:res.status, dupes, timesIfEntered: tp, projCalc,
    projDiff: r.proj!==null && projCalc!==null ? r.proj-projCalc : null,
    points, scoreSrc, roleScore, scoreDiff: crossDiff,
    rank, actTop1: rank!==null ? rank<=Math.floor(N1*0.01) : null, actTop01: rank!==null ? rank<=Math.floor(N1*0.001) : null,
    contestLoss: projCalc!==null && A.ceiling!==null ? A.ceiling-projCalc : null,
    fieldBest: fb, gap: fb ? fb.proj-projCalc : null,
    payout: A.table ? payoutFor(points, A.desc, A.table, true) : null};
}
function setMetrics(A, set){
  const rows = set.rows.map(r=>evalSetRow(A, r));
  const valid = rows.filter(r=>!r.invalid);
  const ds = dupeStats(valid.map(r=>r.dupes));
  const scored = valid.filter(r=>r.rank!==null);
  let roi=null, payoutTotal=null, cost=null;
  if(A.table && A.fee && valid.length){ const p = valid.map(r=>r.payout); if(p.every(v=>v!==null)){ payoutTotal=p.reduce((s,v)=>s+v,0); cost=valid.length*A.fee; roi=(payoutTotal/cost-1)*100; } }
  const distinctKeys = new Set(valid.map(r=>r.idKey));
  const pick = k => valid.map(r=>r[k]);
  return {rows, n: rows.length, valid: valid.length, invalid: rows.length-valid.length, distinct: distinctKeys.size, dupes: ds,
    resolved: valid.filter(r=>r.key).length, absent: valid.filter(r=>r.status==='absent').length,
    avgProj: mean(pick('proj')), avgProjCalc: mean(pick('projCalc')), avgP90: mean(pick('p90')), avgP50: mean(pick('p50')), avgP10: mean(pick('p10')),
    predRoi: mean(pick('roi')), predNormRoi: mean(pick('normRoi')), predTop1: mean(pick('top1')), predTop01: mean(pick('top01')), avgUniq: mean(pick('uniq')), avgSalary: mean(pick('salary')),
    avgPoints: mean(scored.map(r=>r.points)), scoredN: scored.length,
    top1: scored.length ? scored.filter(r=>r.actTop1).length/scored.length*100 : null, top1n: scored.filter(r=>r.actTop1).length,
    top01: scored.length ? scored.filter(r=>r.actTop01).length/scored.length*100 : null, top01n: scored.filter(r=>r.actTop01).length,
    avgContestLoss: mean(pick('contestLoss')), avgGap: mean(pick('gap')),
    roi, payoutTotal, cost, scoreMismatch: valid.filter(r=>r.scoreDiff!==null && Math.abs(r.scoreDiff)>0.051).length,
    projMismatch: valid.filter(r=>r.projDiff!==null && Math.abs(r.projDiff)>0.06).length};
}
// ---------- theoretical entries (DraftKings "edit entries" export) ----------
/* Entry ID, Contest Name, Contest ID, Entry Fee, then one column per roster slot (CPT, FLEX x5 for showdown)
   holding DK player IDs. The same file carries DK's player table further right
   (Position, Name + ID, Name, ID, Roster Position, ...), which is the only ID -> name map used.
   Blank lineups (reservations) are kept and reported, never scored. */
function parseEntriesFile(text, fileName){
  const rows = parseCSV(text); if(rows.length<2) throw new Error('No entry rows found.');
  const h = rows[0].map(x=>x.trim());
  const iId = findCol(h,['Entry ID','EntryId']), iCN = findCol(h,['Contest Name']), iCI = findCol(h,['Contest ID']), iFee = findCol(h,['Entry Fee']);
  if(iId<0 || iCI<0) throw new Error('Need Entry ID and Contest ID columns (the DraftKings entries export).');
  const slotCols = []; for(let j=Math.max(iId,iCN,iCI,iFee)+1; j<h.length && h[j] && !/^instructions$/i.test(h[j]); j++) slotCols.push(j);
  if(!slotCols.length) throw new Error('No roster columns (CPT, FLEX, ...) found after Entry Fee.');
  const idName = new Map(), idRole = new Map();
  for(const r of rows) for(let i=0;i<r.length-2;i++){ const m = /^(.+) \((\d+)\)$/.exec(String(r[i]).trim());
    if(m && String(r[i+2]).trim()===m[2]){ idName.set(m[2], String(r[i+1]).trim() || m[1]); if(r[i+3]) idRole.set(m[2], String(r[i+3]).trim().toUpperCase()); } }
  const out = [], contests = new Map();
  for(let ri=1; ri<rows.length; ri++){
    const r = rows[ri], entryId = String(r[iId]||'').trim(); if(!/^\d+$/.test(entryId)) continue;
    const e = {line: ri+1, entryId, contestName: iCN>=0 ? String(r[iCN]||'').trim() : '', contestId: String(r[iCI]||'').trim(), fee: iFee>=0 ? num(r[iFee]) : null,
      ids: slotCols.map(j=>String(r[j]||'').trim()), roles: slotCols.map(j=>h[j].toUpperCase())};
    if(e.ids.every(x=>!x)) e.invalid = 'no lineup (reservation)';
    else if(e.ids.some(x=>!x)) e.invalid = 'incomplete lineup';
    else { const miss = e.ids.filter(x=>!idName.has(x)); if(miss.length) e.invalid = 'player ID '+miss.join(', ')+' not in the file\'s player list';
      else e.slots = e.ids.map((id,k)=>({role: e.roles[k]==='CAPTAIN' ? 'CPT' : e.roles[k], name: idName.get(id), id})); }
    out.push(e);
    const c = contests.get(e.contestId) || {id:e.contestId, name:e.contestName, fee:e.fee, count:0, lineups:0}; c.count++; if(e.slots) c.lineups++; contests.set(e.contestId, c);
  }
  if(!out.length) throw new Error('No entry rows found.');
  return {kind:'entries', fileName: fileName||'', header: h, rows: out, contests: [...contests.values()], idName, idRole, players: idName.size};
}
/* Score theoretical entries as if they had been entered in this contest.
   - Each theoretical entry takes the place of the real entry with the same Entry ID (if that entry is in the standings);
     the other theoretical lineups are in the field together, the same way real entries are.
   - Dupes = other entries (field after replacement + other theoretical entries) holding the same lineup, i.e. times played - 1.
   - Points: the contest's score for that exact lineup if anyone played it, else the player results in the standings
     (CPT = the CPT row, or 1.5 x FLEX if nobody captained him). A player nobody drafted has no result: scored 0 and counted.
   - Ranks: competition ranking among the field after replacement. Payouts: the contest's estimated table, ties split evenly.
   rows: parsed entries rows (already filtered to one contest). */
function theoreticalMetrics(A, rows){
  const all = rows, use = rows.filter(r=>r.slots);
  const sig = A.std.signature, idSet = new Set(all.map(r=>r.entryId));
  const replaced = A.std.entries.filter(e=>idSet.has(String(e.id)));
  const replacedById = new Map(replaced.map(e=>[String(e.id), e]));
  const valid = [], invalid = all.filter(r=>!r.slots).map(r=>({r, why:r.invalid}));
  for(const r of use){ if(sig && signature(r.slots)!==sig){ invalid.push({r, why:'roster slots ('+signature(r.slots)+') don\'t match the contest ('+sig+')'}); continue; } valid.push(r); }
  // field after replacement
  const repCount = new Map(); for(const e of replaced) if(e.key) repCount.set(e.key, (repCount.get(e.key)||0)+1);
  const tk = new Map(), missing = new Set();
  const score = slots => { let t = 0, miss = 0;
    for(const s of slots){ const n = normName(s.name), c = roleClass(s.role);
      let v = null;
      if(c==='CPT'){ const hit = A.results.get(n+'|CPT'); if(hit && hit.fpts!==null) v = hit.fpts; else { const fx = A.results.get(n+'|FLEX'); if(fx && fx.fpts!==null) v = Math.round(fx.fpts*1.5*100)/100; } }
      else { const hit = A.results.get(n+'|'+c); if(hit && hit.fpts!==null) v = hit.fpts; }
      if(v===null){ miss++; missing.add(s.name); v = 0; }
      t += v; }
    return {t: Math.round(t*100)/100, miss}; };
  const items = valid.map(r=>{ const key = lineupKey(r.slots, nameId); tk.set(key, (tk.get(key)||0)+1);
    const g = A.groups.get(key); let points, src, miss = 0;
    if(g && g.points!==null){ points = g.points; src = 'contest standings'; }
    else { const sc = score(r.slots); points = sc.t; miss = sc.miss; src = miss ? 'player results ('+miss+' assumed 0)' : 'player results'; }
    return {r, key, g, points, src, miss}; });
  const keptPts = A.std.entries.filter(e=>!idSet.has(String(e.id))).map(e=>e.points).filter(v=>v!==null && Number.isFinite(v));
  const desc = sortedDesc(keptPts.concat(items.map(x=>x.points)));
  const N = A.std.entries.length - replaced.length + items.length;
  const top1Cut = Math.floor(N*0.01), top01Cut = Math.floor(N*0.001);
  const outRows = items.map(x=>{
    const fieldTimes = x.g ? x.g.count - (repCount.get(x.key)||0) : 0;
    const times = fieldTimes + tk.get(x.key), proj = A.lineupProj(x.r.slots);
    const fb = proj!==null ? A.bestAtOrBelow(times) : null, rank = rankFor(x.points, desc);
    const actual = replacedById.get(x.r.entryId) || null;
    return {entryId: x.r.entryId, slots: x.r.slots, key: x.key, cap: x.r.slots.filter(s=>roleClass(s.role)!=='FLEX').map(s=>s.name),
      flex: x.r.slots.filter(s=>roleClass(s.role)==='FLEX').map(s=>s.name).sort((a,b)=>a.localeCompare(b)),
      times, dupes: times-1, fieldDupes: fieldTimes, selfDupes: tk.get(x.key)-1, inField: !!x.g, points: x.points, scoreSrc: x.src, proj,
      contestLoss: proj!==null && A.ceiling!==null ? A.ceiling-proj : null, fieldBest: fb, gap: fb && proj!==null ? fb.proj-proj : null,
      rank, top1: rank!==null ? rank<=top1Cut : null, top01: rank!==null ? rank<=top01Cut : null,
      payout: A.table ? payoutFor(x.points, desc, A.table, false) : null,
      actual, sameAsActual: actual ? actual.key===x.key : null};
  });
  const withProj = outRows.filter(r=>r.proj!==null), known = outRows.filter(r=>r.rank!==null);
  const myMax = withProj.length ? Math.max(...withProj.map(r=>r.proj)) : null;
  const distinct = new Map(); for(const r of outRows) if(!distinct.has(r.key)) distinct.set(r.key, r);
  let roi = null, payoutTotal = null, cost = null;
  if(A.table && A.fee && outRows.length && outRows.every(r=>r.payout!==null)){ payoutTotal = outRows.reduce((s,r)=>s+r.payout,0); cost = outRows.length*A.fee; roi = (payoutTotal/cost-1)*100; }
  return {rows: outRows, n: outRows.length, invalid, invalidCount: invalid.length, distinct: distinct.size,
    dupes: dupeStats(outRows.map(r=>r.dupes)), dupesDistinct: dupeStats([...distinct.values()].map(r=>r.dupes)), fieldDupes: dupeStats(outRows.map(r=>r.fieldDupes)),
    myMax, avgProj: mean(withProj.map(r=>r.proj)), projCoverage: withProj.length, avgPoints: mean(outRows.map(r=>r.points)),
    avgContestLoss: mean(outRows.map(r=>r.contestLoss)), avgGap: mean(outRows.map(r=>r.gap)),
    top1: known.length ? known.filter(r=>r.top1).length/known.length*100 : null, top1n: known.filter(r=>r.top1).length,
    top01: known.length ? known.filter(r=>r.top01).length/known.length*100 : null, top01n: known.filter(r=>r.top01).length, rankedN: known.length,
    bestRank: known.length ? Math.min(...known.map(r=>r.rank)) : null, cashed: outRows.filter(r=>r.payout>0).length,
    roi, payoutTotal, cost, fieldSizeIfEntered: N, replaced, replacedN: replaced.length, same: outRows.filter(r=>r.sameAsActual).length,
    missingPlayers: [...missing], assumedZero: outRows.filter(r=>/assumed 0/.test(r.scoreSrc)).length};
}

// set overlap on exact canonical ID keys
function overlap(a, b){
  const A = new Set(a.rows.filter(r=>!r.invalid).map(r=>r.idKey)), B = new Set(b.rows.filter(r=>!r.invalid).map(r=>r.idKey));
  let shared=0; for(const k of A) if(B.has(k)) shared++;
  const union = A.size + B.size - shared;
  return {shared, sizeA:A.size, sizeB:B.size, jaccard: union ? shared/union : null, shareOfA: A.size ? shared/A.size : null};
}
// predicted uniqueness quintiles vs realised dupes, and predicted vs realised tails
function calibration(rows){
  const v = rows.filter(r=>!r.invalid);
  const u = v.filter(r=>r.uniq!==null && r.dupes!==null).sort((a,b)=>a.uniq-b.uniq);
  const q = Math.max(1, Math.floor(u.length/5));
  const lo = u.length>=5 ? u.slice(0,q) : [], hi = u.length>=5 ? u.slice(-q) : [];
  const t1 = v.filter(r=>r.top1!==null && r.actTop1!==null), t01 = v.filter(r=>r.top01!==null && r.actTop01!==null);
  const r1 = v.filter(r=>r.roi!==null && r.payout!==null);
  return {uniqN: u.length, uniqExcluded: v.length-u.length, quintileSize: q,
    lowUniq: lo.length ? {predicted: mean(lo.map(r=>r.uniq)), dupes: mean(lo.map(r=>r.dupes)), unique: lo.filter(r=>r.dupes===0).length/lo.length*100} : null,
    highUniq: hi.length ? {predicted: mean(hi.map(r=>r.uniq)), dupes: mean(hi.map(r=>r.dupes)), unique: hi.filter(r=>r.dupes===0).length/hi.length*100} : null,
    top1: {n: t1.length, excluded: v.length-t1.length, predicted: mean(t1.map(r=>r.top1)), actual: t1.length ? t1.filter(r=>r.actTop1).length/t1.length*100 : null},
    top01: {n: t01.length, excluded: v.length-t01.length, predicted: mean(t01.map(r=>r.top01)), actual: t01.length ? t01.filter(r=>r.actTop01).length/t01.length*100 : null},
    roiN: r1.length};
}

// ---------- alternatives ----------
// index builds for "one FLEX replaced" and "same roster, different CPT" lookups
function altIndex(builds){
  const oneFlex = new Map(), roster = new Map();
  for(const b of builds){
    const cap = b.capId, flex = b.flexIds;
    for(let i=0;i<flex.length;i++){ const k = cap+'\u0001'+flex.filter((_,j)=>j!==i).join('\u0001'); (oneFlex.get(k) || oneFlex.set(k,[]).get(k)).push(b); }
    const rk = [cap,...flex].sort().join('\u0001'); (roster.get(rk) || roster.set(rk,[]).get(rk)).push(b);
  }
  return {oneFlex, roster};
}
function alternativesFor(b, idx){
  const out = new Map();
  for(let i=0;i<b.flexIds.length;i++){
    const k = b.capId+'\u0001'+b.flexIds.filter((_,j)=>j!==i).join('\u0001');
    for(const o of idx.oneFlex.get(k)||[]) if(o.key!==b.key && !out.has(o.key)) out.set(o.key, {b:o, type:'1 FLEX swap', out: b.flexIds[i], in: o.flexIds.find(x=>!b.flexIds.includes(x))});
  }
  for(const o of idx.roster.get([b.capId,...b.flexIds].sort().join('\u0001'))||[]) if(o.key!==b.key && o.capId!==b.capId && !out.has(o.key)) out.set(o.key, {b:o, type:'CPT swap', out:b.capId, in:o.capId});
  return [...out.values()];
}

// ---------- paired strategy comparison across contests ----------
// perContest: [{contest, value}] for A and B; pairs on shared contests
function paired(aByContest, bByContest){
  const d = []; for(const [c,v] of aByContest) if(bByContest.has(c) && v!==null && bByContest.get(c)!==null) d.push(v - bByContest.get(c));
  const m = mean(d), s = sd(d);
  return {n: d.length, mean: m, se: s!==null ? s/Math.sqrt(d.length) : null};
}

const api = {CALC_VERSION, parseCSV, toCSV, num, normName, baseUser, hashStr, percentile, mean, sd, dupeStats,
  parseLineupString, lineupKey, roleClass, signature, formatFromSignature, parseStandings, parseProjections, matchProjections,
  parseLineupSet, payoutTable, payoutFor, rankFor, sortedDesc, analyzeContest, userEntries, userAllEntries, portfolioMetrics,
  resolveSetRow, evalSetRow, setMetrics, parseEntriesFile, theoreticalMetrics, overlap, calibration, altIndex, alternativesFor, paired};
if(typeof module!=='undefined' && module.exports) module.exports = api; else root.DupeCore = api;
})(typeof window!=='undefined' ? window : globalThis);
