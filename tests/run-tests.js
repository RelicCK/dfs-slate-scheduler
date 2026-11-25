// Contest Analytics calculation checks.
//   node tests/run-tests.js                 synthetic acceptance checks from the integration spec
//   node tests/run-tests.js <fixture dir>   also validates against the real fixture files (kept private, not in the repo):
//       contest-standings-195677826.csv, Sim-Savant-Projections-09-17-2026-DraftKings-DET-BUF.csv, nfl-dk-det-buf-2026-09-17.csv
const C = require('../js/dupe-core.js'), fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if(cond){ pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra!==undefined ? JSON.stringify(extra) : ''); } };
const near = (a, b, e=1e-6) => Math.abs(a-b) <= e;

console.log('Lineup identity');
const k = s => C.lineupKey(C.parseLineupString(s), sl=>C.normName(sl.name));
t('CPT A FLEX B,C == CPT A FLEX C,B', k('CPT A FLEX B FLEX C') === k('CPT A FLEX C FLEX B'));
t('CPT B FLEX A,C differs', k('CPT A FLEX B FLEX C') !== k('CPT B FLEX A FLEX C'));
t('names with role-like words parse', C.parseLineupString('CPT Amon-Ra St. Brown FLEX DJ Moore FLEX Bills ').map(x=>x.name).join('|') === 'Amon-Ra St. Brown|DJ Moore|Bills');
t('username suffix stripped, exact match', C.baseUser('RelicCK (8/45)')==='relicck' && C.baseUser('relicck2')!=='relicck');

console.log('Duplication');
function contest(lines, extra=[]){ // lines: [lineup, user, points]
  const rows = [['Rank','EntryId','EntryName','TimeRemaining','Points','Lineup','','Player','Roster Position','%Drafted','FPTS'],
    ...lines.map((l,i)=>[1, 1000+i, l[1]||'u'+i, 0, l[2]??10, l[0], '', '', '', '', '']), ...extra];
  return C.parseStandings(C.toCSV(rows), 'contest-standings-1.csv');
}
const nine = Array.from({length:9}, ()=>['CPT A FLEX B FLEX C FLEX D FLEX E FLEX F']);
const std = contest([...nine, ['CPT B FLEX A FLEX C FLEX D FLEX E FLEX F'], ['', 'empty']]);
const proj = C.parseProjections(C.toCSV([['Name','DFS ID','FLEX Proj','CPT Proj','FLEX Own','CPT Own'], ...'ABCDEFG'.split('').map((n,i)=>[n, String(i+1), 10, 15, 5, 1])]), 'p.csv');
const A = C.analyzeContest(std, proj, {});
const g = A.groups.get(k('CPT A FLEX B FLEX C FLEX D FLEX E FLEX F'));
t('9 field copies -> times played 9, actual entry dupes 8', g.count===9 && g.count-1===8);
const set = C.parseLineupSet(C.toCSV([['CPT','FLEX','FLEX','FLEX','FLEX','FLEX','Proj','Actual'], ['1','6','5','4','3','2','65',''], ['1','2','3','4','5','7','65',''], ['1','2','3','4','5','99','','']]), 's.csv');
const ev = set.rows.map(r=>C.evalSetRow(A, r));
t('hypothetical insertion of that lineup -> 9 dupes', ev[0].dupes===9 && ev[0].timesIfEntered===10, ev[0].dupes);
t('valid lineup absent from field -> 0 dupes', ev[1].dupes===0 && ev[1].status!=='unresolved', [ev[1].dupes, ev[1].status]);
t('unresolved ID -> unknown, not 0', ev[2].dupes===null && ev[2].status==='unresolved');
t('repeated FLEX columns all kept', set.rows[0].flexIds.length===5 && set.rows[0].flexIds.join()==='6,5,4,3,2');
t('missing lineup skipped and reported', std.skipped.length===1 && A.valid.length===10 && A.fieldSize===11);
t('repeated entry IDs counted once', (()=>{ const s = C.parseStandings('EntryId,EntryName,Points,Lineup\n1,a,5,CPT A FLEX B\n1,a,5,CPT A FLEX B\n2,b,4,CPT A FLEX C', 'x'); return s.entries.length===2 && s.dupIds===1; })());
const ds = C.dupeStats([0,0,1,2,3,4,5,6,7,8]);
t('nearest-rank percentiles', ds.median===3 && ds.p90===7 && ds.p75===6 && ds.unique===20 && ds.le1===30 && ds.le4===60, ds);

console.log('Projection');
const p3 = C.parseProjections('Name,DFS ID,FLEX Proj,CPT Proj\nA,1,10,15\nB,2,10,15\nC,3,8,12', 'p.csv');
const s3 = C.parseStandings('EntryId,EntryName,Points,Lineup\n1,a,5,CPT A FLEX B FLEX C', 'x');
const A3 = C.analyzeContest(s3, p3, {});
t('CPT 15 + FLEX 10 + FLEX 8 = 33, not 40.5', near(A3.glist[0].proj, 33));
const p4 = C.parseProjections('Name,DFS ID,FLEX Proj,CPT Proj\nA,1,10,15\nB,2,10,15', 'p.csv');
t('missing projection is null, never 0', C.analyzeContest(s3, p4, {}).glist[0].proj===null);
t('contest loss 106.03 - 102.76 = 3.27; gap 104 - 102.76 = 1.24', near(106.03-102.76, 3.27, 1e-9) && near(104-102.76, 1.24, 1e-9));
{ // frontier / benchmark
  const rows = [['CPT A FLEX B FLEX C', 'x', 1], ['CPT A FLEX B FLEX C', 'y', 1], ['CPT C FLEX A FLEX B', 'z', 1], ['CPT B FLEX A FLEX C', 'w', 1]];
  const s = C.parseStandings(C.toCSV([['EntryId','EntryName','Points','Lineup'], ...rows.map((r,i)=>[i+1, r[1], r[2], r[0]])]), 'x');
  const p = C.parseProjections('Name,DFS ID,FLEX Proj,CPT Proj\nA,1,10,20\nB,2,9,14\nC,3,8,12', 'p.csv');
  const Z = C.analyzeContest(s, p, {});
  t('field best at or below a limit', Z.bestAtOrBelow(1).proj===32 && Z.bestAtOrBelow(2).proj===37, [Z.bestAtOrBelow(1)?.proj, Z.bestAtOrBelow(2)?.proj]);
  t('Pareto frontier', Z.frontier.map(g=>g.proj).join()==='32,37', Z.frontier.map(g=>[g.count,g.proj]));
}

console.log('Payouts');
{
  const tbl = {paid:3, pays: Float64Array.from([0, 200, 100, 60, 0])};
  const desc = Float64Array.from([50, 40, 40, 10, 5]);
  t('tied ranks 2-3 paying 100 and 60 -> 80 each', C.payoutFor(40, desc, tbl, false)===80);
  t('inserted entry joins the tie group (3 way: 2,3,4)', near(C.payoutFor(40, desc, tbl, true), 160/3));
  const T = C.payoutTable({fieldSize:59453, fee:5});
  const sum = Array.from(T.pays).reduce((a,b)=>a+b, 0);
  t('payout table sums to the pool', near(sum, T.pool, 1e-6), [sum, T.pool]);
  t('1st = 30%, min cash 1.5x, 2nd <= 1st, 20% paid', near(T.pays[1], T.pool*.3) && near(T.pays[T.paid], 7.5, 1e-9) && T.pays[2] <= T.pays[1] && T.paid===11890);
  const small = C.payoutTable({fieldSize:4, fee:5});
  t('tiny contest handled (1 paid takes pool)', small.paid===1 && small.pays[1]===20);
  t('no fee -> no table (ROI unknown, not 0)', C.payoutTable({fieldSize:100, fee:null})===null);
  const pool = C.payoutTable({fieldSize:1000, fee:10, prizePool:8500});
  t('entered prize pool is used', pool.pool===8500 && near(Array.from(pool.pays).reduce((a,b)=>a+b,0), 8500, 1e-6));
}

const dir = process.argv[2];
if(dir){
  console.log('Fixtures in '+dir);
  const rd = n => fs.readFileSync(path.join(dir, n), 'utf8');
  const std = C.parseStandings(rd('contest-standings-195677826.csv'), 'contest-standings-195677826.csv');
  const proj = C.parseProjections(rd('Sim-Savant-Projections-09-17-2026-DraftKings-DET-BUF.csv'), 'Sim-Savant-Projections-09-17-2026-DraftKings-DET-BUF.csv');
  const set = C.parseLineupSet(rd('nfl-dk-det-buf-2026-09-17.csv'), 'nfl-dk-det-buf-2026-09-17.csv');
  const A = C.analyzeContest(std, proj, {fee:5});
  const dupG = A.glist.filter(g=>g.count>1);
  t('59,355 valid entries', A.valid.length===59355, A.valid.length);
  t('12,613 distinct builds', A.glist.length===12613, A.glist.length);
  t('7,025 duplicated builds', dupG.length===7025, dupG.length);
  t('53,767 entries in duplicated builds', dupG.reduce((s,g)=>s+g.count,0)===53767);
  t('max times played 368', Math.max(...A.glist.map(g=>g.count))===368);
  t('98 skipped rows', std.skipped.length===98, std.skipped.length);
  const me = C.userEntries(A, 'relicck');
  t('relicck 150 entries, 20 unique', me.length===150 && me.filter(e=>A.groups.get(e.key).count===1).length===20);
  t('contest ceiling 106.03', near(A.ceiling, 106.03, 1e-9), A.ceiling);
  t('every contest player matched a projection', A.pm.unmatched.length===0 && A.pm.ambiguous.length===0);
  t('CPT points in standings are already 1.5x', near(A.results.get('josh allen|CPT').fpts, A.results.get('josh allen|FLEX').fpts*1.5, 0.01));
  const sm = C.setMetrics(A, set);
  t('set: 150 lineups, all IDs resolved', sm.valid===150 && sm.resolved===150);
  t('set: computed projections match file Proj (rounding)', sm.rows.filter(r=>Math.abs(r.projDiff)>0.051).length<=1);
  t('set: scores agree with file Actual', sm.scoreMismatch===0);
  t('set: no CPT/FLEX sum (role separation)', sm.rows.every(r=>!r.res.names || r.res.names.length===6));
  console.log(`      relicck avg dupes ${C.dupeStats(me.map(e=>A.groups.get(e.key).count-1)).avg.toFixed(2)}, set avg dupes ${sm.dupes.avg.toFixed(2)}, set unique ${sm.dupes.unique.toFixed(1)}%`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
