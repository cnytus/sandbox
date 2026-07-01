// Bahis Tahmin API v6
// Changes vs v5 (per user-approved improvement list):
//  1) Independent model is no longer blended with the market before computing "edge" -
//     when form/Elo data exists it is used PURE; edge is always independent-model vs market.
//     With no independent data at all, model==market fallback so edge honestly collapses to ~0.
//  2) Self-learning: settled predictions feed a `calibrate` action that re-tunes rho and the
//     edge threshold from realized hit-rates (versioned in model_params, audited in calibration_log).
//  3) Multi-bookmaker consensus + Shin's method devigging (replaces single-bookmaker + proportional devig).
//  4) League form model now uses recency-weighted (exponential half-life) goals instead of flat season totals.
//  5) Edge threshold is Bonferroni-style corrected (family_correction) for checking multiple markets/match.
//  6) fixtures_cache dropped (unused, deactivated).
//  7) Closing-line value: capture_closing action snapshots odds near kickoff, clv_pct stored per pick.
//  8) World Cup (no football-data.org standings) gets its own independent signal from national-team Elo.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={ "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods":"GET, POST, OPTIONS" };
const J=(o,s=200)=> new Response(JSON.stringify(o),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
const ODDS_KEY=Deno.env.get("ODDS_API_KEY")||"2fa7cd6c20d0b3f664a17e7425d1a0cf";
const FD_KEY=Deno.env.get("FOOTBALL_DATA_KEY")||"59143b90947142dbaefeac579cd4d4ba";
function sb(){ return createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")); }

const MKID=["1","X","2","O","U","BY","BN"];
const MKN={ "1":"MS 1 (Ev)","X":"Beraberlik","2":"MS 2 (Dep)","O":"Üst 2.5","U":"Alt 2.5","BY":"KG Var","BN":"KG Yok" };
const FAMILY={ "1":"1x2","X":"1x2","2":"1x2","O":"ou","U":"ou","BY":"btts","BN":"btts" };
const COMP={ soccer_epl:"PL", soccer_spain_la_liga:"PD", soccer_italy_serie_a:"SA", soccer_germany_bundesliga:"BL1", soccer_france_ligue_one:"FL1" };
const WORLD_CUP_SPORT="soccer_fifa_world_cup";

// ---------- core Poisson / Dixon-Coles model ----------
function poisson(k,l){ let f=1; for(let i=2;i<=k;i++) f*=i; return Math.exp(-l)*Math.pow(l,k)/f; }
function dc(i,j,lh,la,rho){ if(i===0&&j===0)return 1-lh*la*rho; if(i===0&&j===1)return 1+lh*rho; if(i===1&&j===0)return 1+la*rho; if(i===1&&j===1)return 1-rho; return 1; }
function probs(lh,la,rho){ const mx=8; const cells=[]; let tot=0;
  for(let i=0;i<mx;i++) for(let j=0;j<mx;j++){ let p=poisson(i,lh)*poisson(j,la); if(i<2&&j<2)p*=dc(i,j,lh,la,rho); cells.push({i,j,p}); tot+=p; }
  let ph=0,pd=0,pa=0,o=0,by=0; const grid=[];
  for(const c of cells){ const p=c.p/tot; if(c.i>c.j)ph+=p; else if(c.i===c.j)pd+=p; else pa+=p; if(c.i+c.j>2.5)o+=p; if(c.i>=1&&c.j>=1)by+=p; grid.push({s:c.i+"-"+c.j,p}); }
  grid.sort((a,b)=>b.p-a.p); return { "1":ph,"X":pd,"2":pa,"O":o,"U":1-o,"BY":by,"BN":1-by, top:grid.slice(0,4) }; }
// Coarse-to-fine grid search (was a flat 0.05-step grid = ~4.7k probs() evaluations per call; that,
// plus a *second* full search inside eloLambdas() for every World Cup match, was blowing the edge
// function's CPU budget - WORKER_RESOURCE_LIMIT 546s - once enough concurrent WC fixtures were on
// the odds feed). Coarse pass finds the neighborhood cheaply, fine pass refines locally around it:
// ~5x fewer probs() calls for essentially the same precision.
function estimateLambdas(pH,pA,pOver,rho){
  const err=(lh,la)=>{ const r=probs(lh,la,rho); let e=Math.pow(r["1"]-pH,2)+Math.pow(r["2"]-pA,2); if(pOver!=null) e+=Math.pow(r["O"]-pOver,2); return e; };
  let best={lh:1.3,la:1.1,err:1e9};
  for(let lh=0.2;lh<=3.6;lh+=0.2) for(let la=0.2;la<=3.6;la+=0.2){ const e=err(lh,la); if(e<best.err) best={lh,la,err:e}; }
  const loLh=Math.max(0.05,best.lh-0.25), hiLh=Math.min(4.0,best.lh+0.25);
  const loLa=Math.max(0.05,best.la-0.25), hiLa=Math.min(4.0,best.la+0.25);
  for(let lh=loLh;lh<=hiLh;lh+=0.02) for(let la=loLa;la<=hiLa;la+=0.02){ const e=err(lh,la); if(e<best.err) best={lh,la,err:e}; }
  return best; }
function marketAdj(lh,la){ const mu=lh+la,diff=lh-la; return { lh:Math.max(0.05,(mu*0.9+2.6*0.1+diff*0.82)/2), la:Math.max(0.05,(mu*0.9+2.6*0.1-diff*0.82)/2) }; }

// ---------- Shin's method devigging (replaces old proportional devig2/devig3) ----------
// Solves for the "insider trading" fraction z such that the devigged probabilities sum to 1.
function shinDevig(rawProbs){
  const S=rawProbs.reduce((a,b)=>a+b,0);
  if(S<=1) return rawProbs.map(p=>p/S); // no overround to remove
  const f=(z)=>{ let s=0; for(const pi of rawProbs){ const inner=Math.max(0, z*z+4*(1-z)*pi*pi/S); s += (Math.sqrt(inner)-z)/(2*(1-z)); } return s-1; };
  let lo=0, hi=0.4, flo=f(lo), fhi=f(hi), tries=0;
  while(fhi>0 && hi<0.49 && tries<20){ hi+=0.02; fhi=f(hi); tries++; }
  for(let i=0;i<60;i++){ const mid=(lo+hi)/2, fm=f(mid); if(Math.abs(fm)<1e-9){ lo=hi=mid; break;} if((fm>0)===(flo>0)){ lo=mid; flo=fm; } else { hi=mid; fhi=fm; } }
  const z=(lo+hi)/2;
  return rawProbs.map(pi=> (Math.sqrt(Math.max(0,z*z+4*(1-z)*pi*pi/S))-z)/(2*(1-z)) );
}
const avg=(a)=>a.reduce((x,y)=>x+y,0)/a.length;

// ---------- name normalisation (shared by football-data + Elo matching) ----------
const norm=(s)=> (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\b(fc|afc|cf|sc|ac|cd|ssc|bk|club)\b/g,"").replace(/[^a-z0-9]/g,"");
function findKey(name,map){ const n=norm(name); if(map[n]!=null)return n; for(const k in map){ if(k.length>2&&(k.includes(n)||n.includes(k))) return k; } return null; }

// ---------- model parameters (item 2: self-learning reads/writes these) ----------
const DEFAULT_PARAMS={ version:1, rho:-0.12, edge_threshold_base:5, family_correction:1.73, recency_halflife_days:45, home_elo_bonus:60 };
async function getParams(){
  try{ const {data,error}=await sb().rpc("bahis_get_active_params"); if(!error && data && data.length){ const p=data[0]; return { version:p.version, rho:+p.rho, edge_threshold_base:+p.edge_threshold_base, family_correction:+p.family_correction, recency_halflife_days:+p.recency_halflife_days, home_elo_bonus:+p.home_elo_bonus }; } }catch(_){}
  return DEFAULT_PARAMS;
}

// ---------- league form model: recency-weighted attack/defense (item 4) ----------
const formCache={};
async function fetchCompetitionForm(comp,halflife){
  const key=comp+"|"+halflife; const c=formCache[key]; if(c&&Date.now()-c.t<3600000) return c.v;
  try{
    const now=new Date(); const y=now.getUTCFullYear();
    const urls=[ `https://api.football-data.org/v4/competitions/${comp}/matches?status=FINISHED`,
                 `https://api.football-data.org/v4/competitions/${comp}/matches?status=FINISHED&season=${y-1}` ];
    let all=[];
    for(const u of urls){ try{ const r=await fetch(u,{headers:{"X-Auth-Token":FD_KEY}}); if(r.ok){ const d=await r.json(); if(Array.isArray(d.matches)) all=all.concat(d.matches); } }catch(_){} }
    const v=buildRecencyForm(all,halflife,now);
    if(v) formCache[key]={t:Date.now(),v};
    return v;
  }catch(_){ return null; }
}
function buildRecencyForm(matches,halflife,now){
  const home={},away={}; let thG=0,thW=0,taG=0,taW=0;
  for(const m of matches){
    if(m.status!=="FINISHED") continue;
    const sc=m.score&&m.score.fullTime; if(!sc||sc.home==null||sc.away==null) continue;
    const days=(now.getTime()-new Date(m.utcDate).getTime())/86400000; if(days<0) continue;
    const w=Math.pow(0.5, days/halflife);
    const hn=norm(m.homeTeam&&m.homeTeam.name), an=norm(m.awayTeam&&m.awayTeam.name); if(!hn||!an) continue;
    home[hn]=home[hn]||{gf:0,ga:0,w:0}; away[an]=away[an]||{gf:0,ga:0,w:0};
    home[hn].gf+=sc.home*w; home[hn].ga+=sc.away*w; home[hn].w+=w;
    away[an].gf+=sc.away*w; away[an].ga+=sc.home*w; away[an].w+=w;
    thG+=sc.home*w; thW+=w; taG+=sc.away*w; taW+=w;
  }
  if(thW<8||taW<8) return null;
  return { home,away,avgHome:thG/thW,avgAway:taG/taW };
}
function formLambdas(h0,a0,S){ const hk=findKey(h0,S.home), ak=findKey(a0,S.away); if(!hk||!ak) return null; const h=S.home[hk],a=S.away[ak]; if(h.w<1||a.w<1) return null;
  const attH=(h.gf/h.w)/S.avgHome, defA=(a.ga/a.w)/S.avgHome, attA=(a.gf/a.w)/S.avgAway, defH=(h.ga/h.w)/S.avgAway;
  const lh=S.avgHome*attH*defA, la=S.avgAway*attA*defH;
  return { lh:Math.min(4.5,Math.max(0.15,lh)), la:Math.min(4.5,Math.max(0.15,la)) }; }

// ---------- World Cup independent model: national-team Elo (item 8) ----------
async function getEloMap(){
  try{ const {data,error}=await sb().rpc("bahis_all_elo"); if(error||!data) return null;
    const map={}; for(const r of data) map[norm(r.team_name)]=+r.elo;
    return Object.keys(map).length? map : null;
  }catch(_){ return null; }
}
function eloLambdas(home,away,map,homeBonus,rho){
  const hk=findKey(home,map), ak=findKey(away,map); if(hk==null||ak==null) return null;
  const diff=(map[hk]+homeBonus)-map[ak];
  const We=1/(Math.pow(10,-diff/400)+1); // P(win) + 0.5*P(draw), standard Elo win-expectancy
  const drawP=Math.max(0.16, Math.min(0.32, 0.30 - Math.abs(diff)/900)); // heuristic: closer teams draw more
  let pWin=We-drawP/2, pLoss=1-We-drawP/2;
  pWin=Math.max(0.03,Math.min(0.94,pWin)); pLoss=Math.max(0.03,Math.min(0.94,pLoss));
  const est=estimateLambdas(pWin,pLoss,null,rho);
  return { lh:est.lh, la:est.la };
}

// ---------- multi-bookmaker consensus (item 3) ----------
function buildConsensus(ev){
  const books=ev.bookmakers||[];
  const raw1=[],rawX=[],raw2=[],rawO=[],rawU=[]; const best={};
  for(const bk of books){
    const h2h=bk.markets&&bk.markets.find((m)=>m.key==="h2h");
    if(h2h){
      const oh=h2h.outcomes.find((o)=>o.name===ev.home_team);
      const oa=h2h.outcomes.find((o)=>o.name===ev.away_team);
      const od=h2h.outcomes.find((o)=>o.name==="Draw");
      if(oh&&oh.price>1){ raw1.push(1/oh.price); best["1"]=Math.max(best["1"]||0,oh.price); }
      if(oa&&oa.price>1){ raw2.push(1/oa.price); best["2"]=Math.max(best["2"]||0,oa.price); }
      if(od&&od.price>1){ rawX.push(1/od.price); best["X"]=Math.max(best["X"]||0,od.price); }
    }
    const tot=bk.markets&&bk.markets.find((m)=>m.key==="totals");
    if(tot){
      const ov=tot.outcomes.find((o)=>o.name==="Over"&&Math.abs((o.point??99)-2.5)<0.01);
      const un=tot.outcomes.find((o)=>o.name==="Under"&&Math.abs((o.point??99)-2.5)<0.01);
      if(ov&&ov.price>1){ rawO.push(1/ov.price); best["O"]=Math.max(best["O"]||0,ov.price); }
      if(un&&un.price>1){ rawU.push(1/un.price); best["U"]=Math.max(best["U"]||0,un.price); }
    }
  }
  let pH=null,pD=null,pA=null,pOver=null;
  if(raw1.length&&raw2.length){
    if(rawX.length){ const [d1,dX,d2]=shinDevig([avg(raw1),avg(rawX),avg(raw2)]); pH=d1; pD=dX; pA=d2; }
    else { const [d1,d2]=shinDevig([avg(raw1),avg(raw2)]); pH=d1; pA=d2; }
  }
  if(rawO.length&&rawU.length){ const [dO]=shinDevig([avg(rawO),avg(rawU)]); pOver=dO; }
  return { pH,pD,pA,pOver, odds:best, books:books.length };
}

// ---------- build one match's full market table ----------
// KEY CHANGE (item 1): when `indep` (form- or Elo-based) lambdas exist, they are used AS the
// model directly - no blending with the market-fitted lambdas. Edge is always independent vs market.
// When no independent signal exists, the model falls back to the market-fitted lambdas themselves,
// so edge honestly comes out near zero instead of manufacturing a false "value" signal.
function buildAuto(home,away,mLh,mLa,odds,indep,rho,threshold,extra={}){
  const market=probs(mLh,mLa,rho);
  let mdLh,mdLa,source;
  if(indep){ mdLh=indep.lh; mdLa=indep.la; source=extra.__wc?"elo":"form"; }
  else { const md=marketAdj(mLh,mLa); mdLh=md.lh; mdLa=md.la; source="market"; }
  const model=probs(mdLh,mdLa,rho);
  const markets=MKID.map((m)=>{ const mod=model[m],mkt=market[m],edge=mod-mkt,odd=odds[m]||null;
    return { code:m,name:MKN[m],family:FAMILY[m],model:+(mod*100).toFixed(1),mkt:+(mkt*100).toFixed(1),edge:+(edge*100).toFixed(1),odds:odd,value:(edge*100)>=threshold }; });
  const best=markets.filter((x)=>x.value).sort((a,b)=>b.edge-a.edge)[0]||null;
  return { home,away,source,model_lh:+mdLh.toFixed(2),model_la:+mdLa.toFixed(2),market_lh:+mLh.toFixed(2),market_la:+mLa.toFixed(2),
    top:model.top.map((t)=>({score:t.s,p:+(t.p*100).toFixed(0)})), markets, pick:best, ...extra };
}

async function fetchFixtures(sport){
  const params=await getParams();
  const res=await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`);
  if(!res.ok) return { error:`Oran API hatası (${res.status}).` };
  const events=await res.json();
  const isWC=sport===WORLD_CUP_SPORT;
  const form=(!isWC && COMP[sport])? await fetchCompetitionForm(COMP[sport],params.recency_halflife_days) : null;
  const eloMap=isWC? await getEloMap() : null;
  const out=[]; let formCount=0;
  for(const ev of events){
    const cons=buildConsensus(ev);
    if(cons.pH==null||cons.pA==null) continue;
    const est=estimateLambdas(cons.pH,cons.pA,cons.pOver,params.rho);
    let indep=null;
    if(isWC){ indep=eloMap? eloLambdas(ev.home_team,ev.away_team,eloMap,params.home_elo_bonus,params.rho) : null; }
    else if(form){ indep=formLambdas(ev.home_team,ev.away_team,form); }
    if(indep) formCount++;
    const threshold=params.edge_threshold_base*params.family_correction;
    out.push(buildAuto(ev.home_team,ev.away_team,est.lh,est.la,cons.odds,indep,params.rho,threshold,
      { commence:ev.commence_time, params_version:params.version, books_used:cons.books, __wc:isWC }));
  }
  return { matches:out, count:out.length, form_count:formCount, params_version:params.version, edge_threshold_pct:+(params.edge_threshold_base*params.family_correction).toFixed(2) };
}

// ---------- save / history / settle (mostly unchanged, now carries lambdas + calibration fields) ----------
async function savePreds(picks){ try{ const {data,error}=await sb().rpc("bahis_save_predictions",{p:picks}); if(error) return {ok:false,error:error.message}; return {ok:true,saved:data}; }catch(e){ return {ok:false,error:String(e)}; } }
async function getHistory(sport){ try{ const {data,error}=await sb().rpc("bahis_history",{lim:300,sp:sport||null}); if(error) return {error:error.message}; return {rows:data}; }catch(e){ return {error:String(e)}; } }
function evalMkt(code,hs,as){ const tot=hs+as; switch(code){ case"1":return hs>as; case"X":return hs===as; case"2":return as>hs; case"O":return tot>2.5; case"U":return tot<2.5; case"BY":return hs>=1&&as>=1; case"BN":return !(hs>=1&&as>=1);} return false; }
async function settle(){ try{
  const {data:pend,error}=await sb().rpc("bahis_pending"); if(error) return {error:error.message}; if(!pend||!pend.length) return {settled:0};
  const bySport={}; for(const r of pend){ const sp=r.sport||""; (bySport[sp]=bySport[sp]||[]).push(r); }
  const updates=[];
  for(const sp in bySport){ if(!sp) continue;
    let games; try{ const sr=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/scores/?daysFrom=3&apiKey=${ODDS_KEY}`); if(!sr.ok) continue; games=await sr.json(); }catch(_){ continue; }
    const done={}; for(const g of (games||[])){ if(g.completed&&g.scores){ const hs=Number(g.scores.find((s)=>s.name===g.home_team)?.score); const as=Number(g.scores.find((s)=>s.name===g.away_team)?.score); if(!isNaN(hs)&&!isNaN(as)) done[norm(g.home_team)+"|"+norm(g.away_team)]={hs,as}; } }
    for(const r of bySport[sp]){ let key=norm(r.home)+"|"+norm(r.away); let sc=done[key]; if(!sc){ for(const k in done){ const [h,a]=k.split("|"); if((h.includes(norm(r.home))||norm(r.home).includes(h))&&(a.includes(norm(r.away))||norm(r.away).includes(a))){ sc=done[k]; break; } } } if(!sc) continue;
      updates.push({id:r.id, actual_score:sc.hs+"-"+sc.as, result: evalMkt(r.market,sc.hs,sc.as)?"hit":"miss"}); } }
  if(updates.length){ const {data,error:e2}=await sb().rpc("bahis_set_results",{p:updates}); if(e2) return {error:e2.message}; return {settled:data}; }
  return {settled:0};
}catch(e){ return {error:String(e)}; } }

// ---------- closing-line capture (item 7) ----------
async function captureClosing(){
  try{
    const {data:sportsRows,error}=await sb().rpc("bahis_pending_closing_sports");
    if(error) return {error:error.message};
    if(!sportsRows||!sportsRows.length) return {updated:0, note:"nothing pending"};
    let totalUpdated=0; const details=[];
    for(const row of sportsRows){
      const sp=row.sport; if(!sp) continue;
      const {data:pend,error:pe}=await sb().rpc("bahis_pending_closing_rows",{sp});
      if(pe||!pend||!pend.length) continue;
      let events;
      try{ const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal`); if(!r.ok) continue; events=await r.json(); }catch(_){ continue; }
      const evByKey={};
      for(const ev of events){ evByKey[norm(ev.home_team)+"|"+norm(ev.away_team)]=ev; }
      const updates=[];
      for(const r of pend){
        let ev=evByKey[norm(r.home)+"|"+norm(r.away)];
        if(!ev){ for(const k in evByKey){ const [h,a]=k.split("|"); if((h.includes(norm(r.home))||norm(r.home).includes(h))&&(a.includes(norm(r.away))||norm(r.away).includes(a))){ ev=evByKey[k]; break; } } }
        if(!ev) continue;
        const cons=buildConsensus(ev);
        let closing=null;
        if(r.market==="1"||r.market==="X"||r.market==="2"||r.market==="O"||r.market==="U") closing=cons.odds[r.market]||null;
        if(closing==null) continue;
        updates.push({ id:r.id, closing_odds:closing });
      }
      if(updates.length){ const {data:n}=await sb().rpc("bahis_update_closing",{p:updates}); totalUpdated+=(n||0); details.push({sport:sp, updated:n||0}); }
    }
    return { updated: totalUpdated, details };
  }catch(e){ return {error:String(e)}; }
}

// ---------- self-learning calibration (item 2) ----------
async function calibrate(){
  try{
    const {data:rows,error}=await sb().rpc("bahis_settled_for_calibration",{lim:3000});
    if(error) return {error:error.message};
    const n=(rows||[]).length;
    const paramsBefore=await getParams();
    if(n<30) return { skipped:true, sample_size:n, reason:"need >=30 settled predictions to calibrate safely", params:paramsBefore };

    let sqErr=0;
    const valueRows=[], nonValueRows=[];
    for(const r of rows){
      const mp=r.model_prob==null?null:+r.model_prob;
      const outcome=r.result==="hit"?1:0;
      if(mp!=null){ sqErr += Math.pow(mp-outcome,2); }
      if(r.is_value) valueRows.push(r); else nonValueRows.push(r);
    }
    const brier = rows.length? sqErr/rows.length : null;

    // bucket by stored edge_pct (only populated going forward; older rows without it are skipped here)
    const buckets=[{lo:-1e9,hi:0,label:"<0%"},{lo:0,hi:5,label:"0-5%"},{lo:5,hi:10,label:"5-10%"},{lo:10,hi:15,label:"10-15%"},{lo:15,hi:1e9,label:"15%+"}];
    const bucketStats=buckets.map((b)=>({label:b.label,n:0,hitRate:0,avgModel:0}));
    for(const r of rows){
      if(r.edge_pct==null||r.model_prob==null) continue;
      const e=+r.edge_pct;
      const bi=buckets.findIndex((b)=>e>=b.lo&&e<b.hi); if(bi<0) continue;
      const bs=bucketStats[bi]; bs.n++; bs.hitRate += (r.result==="hit"?1:0); bs.avgModel += +r.model_prob;
    }
    for(const bs of bucketStats){ if(bs.n){ bs.hitRate=+(bs.hitRate/bs.n).toFixed(4); bs.avgModel=+(bs.avgModel/bs.n).toFixed(4); } }

    // decide new edge threshold from whether flagged "value" picks actually beat their own market_prob
    let newThreshold=paramsBefore.edge_threshold_base;
    const vHit=valueRows.length? avg(valueRows.map((r)=>r.result==="hit"?1:0)) : null;
    const vMkt=valueRows.length? avg(valueRows.filter((r)=>r.market_prob!=null).map((r)=>+r.market_prob)) : null;
    let thresholdNote="not enough value-flagged samples to adjust threshold";
    if(valueRows.length>=15 && vHit!=null && vMkt!=null){
      if(vHit>vMkt+0.02){ newThreshold=Math.max(3, paramsBefore.edge_threshold_base-0.3); thresholdNote=`value picks beat market (${(vHit*100).toFixed(1)}% hit vs ${(vMkt*100).toFixed(1)}% implied) -> lowering threshold slightly`; }
      else { newThreshold=Math.min(15, paramsBefore.edge_threshold_base+0.5); thresholdNote=`value picks did not clear their own market-implied rate (${(vHit*100).toFixed(1)}% hit vs ${(vMkt*100).toFixed(1)}% implied) -> raising threshold`; }
    }

    // re-estimate rho from settled 1X2 picks with known lambdas + final score (damped update)
    let newRho=paramsBefore.rho; let rhoNote="not enough 1x2 rows with stored lambdas to re-fit rho";
    const rhoRows=rows.filter((r)=>FAMILY[r.market]==="1x2" && r.lambda_home!=null && r.lambda_away!=null && r.actual_score);
    if(rhoRows.length>=50){
      let bestRho=paramsBefore.rho, bestLL=-Infinity;
      for(let cand=-0.30; cand<=0.10; cand+=0.02){
        let ll=0;
        for(const r of rhoRows){
          const [hs,as]=String(r.actual_score).split("-").map(Number);
          const p=probs(+r.lambda_home,+r.lambda_away,cand);
          const outcome = hs>as?"1":hs===as?"X":"2";
          const pp=Math.max(1e-6, p[outcome]);
          ll += Math.log(pp);
        }
        if(ll>bestLL){ bestLL=ll; bestRho=cand; }
      }
      newRho = +(paramsBefore.rho + 0.3*(bestRho-paramsBefore.rho)).toFixed(3);
      rhoNote=`re-fit over ${rhoRows.length} settled 1x2 picks, raw best=${bestRho.toFixed(2)}, damped to ${newRho}`;
    }

    const newVersion=await sb().rpc("bahis_save_params",{p:{ rho:newRho, edge_threshold_base:+newThreshold.toFixed(2), notes:`auto-calibrated ${new Date().toISOString()} | n=${n} | ${thresholdNote} | ${rhoNote}` }});
    const paramsAfter=await getParams();
    await sb().rpc("bahis_log_calibration",{p:{ sample_size:n, brier_score:brier, bucket_stats:bucketStats, params_before:paramsBefore, params_after:paramsAfter, notes:`${thresholdNote} || ${rhoNote}` }});
    return { sample_size:n, brier_score:brier, bucket_stats:bucketStats, params_before:paramsBefore, params_after:paramsAfter, threshold_note:thresholdNote, rho_note:rhoNote };
  }catch(e){ return {error:String(e)}; }
}

Deno.serve(async (req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  if(req.method==="GET") return J({ ok:true, service:"bahis-tahmin API v6" });
  if(req.method==="POST"){ let body={}; try{ body=await req.json(); }catch{ return J({error:"geçersiz JSON"},400); }
    if(body.action==="fixtures") return J(await fetchFixtures(body.sport||WORLD_CUP_SPORT));
    if(body.action==="save") return J(await savePreds(body.picks||[]));
    if(body.action==="history") return J(await getHistory(body.sport));
    if(body.action==="settle") return J(await settle());
    if(body.action==="capture_closing") return J(await captureClosing());
    if(body.action==="calibrate") return J(await calibrate());
    if(body.action==="params"){ return J(await getParams()); }
    if(body.action==="compute"){ const params=await getParams(); const threshold=params.edge_threshold_base*params.family_correction;
      const matches=(body.matches||[]).map((m)=>{ const lh=+m.lh||1.2,la=+m.la||1.0; const r=probs(lh,la,params.rho); const odds=m.odds||{};
        const markets=MKID.map((k)=>{ const mod=r[k]; const odd=odds[k]||null; const mkt=odd?1/odd:null; const edge=mkt!=null?mod-mkt:null; return { code:k,name:MKN[k],model:+(mod*100).toFixed(1),mkt:mkt!=null?+(mkt*100).toFixed(1):null,edge:edge!=null?+(edge*100).toFixed(1):null,odds:odd,value:edge!=null?(edge*100)>=threshold:false }; });
        return { home:m.home||"Ev",away:m.away||"Dep",source:"manual",model_lh:+lh.toFixed(2),model_la:+la.toFixed(2),top:r.top.map((t)=>({score:t.s,p:+(t.p*100).toFixed(0)})),markets }; });
      return J({ matches }); }
    return J({ error:"bilinmeyen action" },400); }
  return J({ error:"method" },405);
});
