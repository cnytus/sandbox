// Bahis Tahmin API - surum: VERSION sabiti (asagida). Degisiklik gecmisi:
// v10.5) hardening: env anahtarlari zorunlu (fallback yok), admin action'lar x-admin-key ister,
//        tek supabase client, saf matematik model.ts'e (deno test), findKey/findPair tek-aday kurali,
//        yutulan hatalar console.error, opening_odds tek RPC, fixtures cevabina rho eklendi.
// v10.4) autosave (sunucu tarafi gunluk fis kaydi)
// v10.3) API-Football injury signal: absent-player differential -> goal diff adj
// v10.2) per-league learned x12s via league_params + fit_blend log-loss stacking
// v10.1) backtest perf: mu lookup table, weekly refits, sparse rho grid
// v10) P1 walk-forward backtest; P2 median per-book devig; P3 full-archive rho MLE;
//      P4 CLV-driven calibration; P5 team home advantage; P6 draw breakdown; P7 exposure cap.
// v9.x) CSV source (T1 + SoT blend); DC ratings; rest; steam. v8.x/v7 in git history.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { poisson, dc, probs, probsLite, shinDevig, avg, median, norm, findKey, findPair, evalMkt, extraPick, fitMu, sideWP, lineResult, lineQuotes, parseLine, bestLineRaw, basketElo, eloPredict, ahResult, ahBest } from "./model.ts";

// v10.6) sprint-1: backtest'e Pinnacle-kapanis CLV + Ust/Alt 2.5; capture_closing Pinnacle kapanisi (clv_pin_pct);
//        kalibrasyon >=50 ornek ve yalniz clv_pin; sprint-2: lig bazli yari omur (league_params.halflife_days),
//        Kelly 1/8 + tek bahis %3.
const VERSION="10.14";
const CORS={ "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type, x-admin-key", "Access-Control-Allow-Methods":"GET, POST, OPTIONS" };
const J=(o,s=200)=> new Response(JSON.stringify(o),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
// Anahtarlar YALNIZ Supabase secret'larindan gelir; kodda fallback yok (public repoda sizmisti, rotasyon yapildi).
const ODDS_KEY=Deno.env.get("ODDS_API_KEY")||"";
const FOOTBALL_API_KEY=Deno.env.get("FOOTBALL_API_KEY")||""; // API-Football (api-sports.io); bos ise sakatlik sinyali kapali
const FD_KEY=Deno.env.get("FOOTBALL_DATA_KEY")||"";
// Yazan / pahali action'lar (settle, calibrate, backtest, ...) bu header'i ister. pg_cron komutlari da gonderir.
const ADMIN_KEY=Deno.env.get("BAHIS_ADMIN_KEY")||"";
const ADMIN_ACTIONS=new Set(["save","settle","autosave","capture_closing","calibrate","backtest","inj_debug","sportmonks_debug","fd_debug","markets_probe","fd_csv","odds_hist","tg_test","collect_results","ah_scan"]);
// FOOTBALL_DATA_KEY zorunlu degil (CSV birincil form kaynagi; FD yalniz yedek + Dunya Kupasi formu)
const MISSING_ENV=["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","ODDS_API_KEY"].filter((k)=>!Deno.env.get(k));
// Tani: hangi secret'lar tanimli (degerler asla donmez)
const ENV_PRESENT=Object.fromEntries(["ODDS_API_KEY","FOOTBALL_DATA_KEY","FOOTBALL_API_KEY","SPORTMONKS_API_KEY","BAHIS_ADMIN_KEY"].map((k)=>[k,!!Deno.env.get(k)]));
const SPORTMONKS_KEY=Deno.env.get("SPORTMONKS_API_KEY")||"";
const SB=createClient(Deno.env.get("SUPABASE_URL")||"", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"");
function sb(){ return SB; }
// Yutulan hatalar Supabase log'unda gorunsun: hangi sinyalin (form/csv/elo/inj) sessizce dustugu belli olsun.
const warn=(ctx,e)=>console.error(`[bahis-tahmin] ${ctx}:`, e instanceof Error ? e.message : String(e));

const MKID=["1","X","2","O","U","BY","BN"];
const MKN={ "1":"MS 1 (Ev)","X":"Beraberlik","2":"MS 2 (Dep)","O":"Üst 2.5","U":"Alt 2.5","BY":"KG Var","BN":"KG Yok" };
const FAMILY={ "1":"1x2","X":"1x2","2":"1x2","O":"ou","U":"ou","BY":"btts","BN":"btts" };
// football-data.org kodlari (form yedegi; Sampiyonlar Ligi icin BIRINCIL kaynak - football-data.co.uk'de CL CSV'si yok)
const COMP={ soccer_epl:"PL", soccer_spain_la_liga:"PD", soccer_italy_serie_a:"SA", soccer_germany_bundesliga:"BL1", soccer_france_ligue_one:"FL1", soccer_uefa_champs_league:"CL", soccer_portugal_primeira_liga:"PPL", soccer_efl_champ:"ELC" };
const CSV_COMP={ soccer_epl:"E0", soccer_spain_la_liga:"SP1", soccer_italy_serie_a:"I1", soccer_germany_bundesliga:"D1", soccer_france_ligue_one:"F1", soccer_turkey_super_league:"T1",
  // 2026-09-28: yeni ligler (backtest 22/23-25/26, fiyat-edge %2, x12s 0): Serie B 248 bahis ROI +20 CLV +7,2 · Championship 186 / +8 / +5,1 ·
  // Iskocya 61 / +13,5 / +4,1 · Portekiz 62 / +6,8 / +4,7. Eredivisie (-15) ve Belcika (-36) ROI negatif -> eklenmedi.
  soccer_portugal_primeira_liga:"P1", soccer_italy_serie_b:"I2", soccer_efl_champ:"E1", soccer_spl:"SC0" };
const CSV_ALIAS={ mancity:"manchestercity", manunited:"manchesterunited", nottmforest:"nottinghamforest", wolves:"wolverhamptonwanderers",
  athmadrid:"atleticomadrid", athbilbao:"athleticbilbao", betis:"realbetis", sociedad:"realsociedad", celta:"celtavigo", espanol:"espanyol", vallecano:"rayovallecano",
  mgladbach:"borussiamonchengladbach", einfrankfurt:"eintrachtfrankfurt", fckoln:"fccologne",
  parissg:"parissaintgermain", stetienne:"saintetienne",
  buyuksehyr:"istanbulbasaksehir",
  splisbon:"sportinglisbon", academicoviseu:"academicodeviseu", guimaraes:"vitoriasc", qpr:"queensparkrangers", sheffieldweds:"sheffieldwednesday" };
const WORLD_CUP_SPORT="soccer_fifa_world_cup";

function estimateLambdas(pH,pA,pOver,rho){
  const lines=(pOver!=null&&typeof pOver==="object")? pOver : (pOver!=null? {"2.5":pOver} : null);
  const LKEY={"1.5":"O15","2.5":"O","3.5":"O35"};
  const err=(lh,la)=>{ const r=probs(lh,la,rho); let e=Math.pow(r["1"]-pH,2)+Math.pow(r["2"]-pA,2);
    if(lines) for(const ln in lines){ const k=LKEY[ln]; if(k&&lines[ln]!=null) e+=(ln==="2.5"?2:1)*Math.pow(r[k]-lines[ln],2); }
    return e; };
  let best={lh:1.3,la:1.1,err:1e9};
  for(let lh=0.2;lh<=3.6;lh+=0.2) for(let la=0.2;la<=3.6;la+=0.2){ const e=err(lh,la); if(e<best.err) best={lh,la,err:e}; }
  const loLh=Math.max(0.05,best.lh-0.25), hiLh=Math.min(4.0,best.lh+0.25);
  const loLa=Math.max(0.05,best.la-0.25), hiLa=Math.min(4.0,best.la+0.25);
  for(let lh=loLh;lh<=hiLh;lh+=0.02) for(let la=loLa;la<=hiLa;la+=0.02){ const e=err(lh,la); if(e<best.err) best={lh,la,err:e}; }
  return best; }
function marketAdj(lh,la){ const mu=lh+la,diff=lh-la; return { lh:Math.max(0.05,(mu*0.9+2.6*0.1+diff*0.82)/2), la:Math.max(0.05,(mu*0.9+2.6*0.1-diff*0.82)/2) }; }

const DEFAULT_PARAMS={ version:1, rho:-0.12, edge_threshold_base:5, family_correction:1.73, recency_halflife_days:45, home_elo_bonus:60 };
const FORM_TOTAL_W=0.35;
const GOAL_PROB_SHRINK=0.6;
const FALLBACK_TOTAL_MU=2.7;
const X12_PROB_SHRINK=0.85;
const WC_FORM_D_W=0.3;
// 2026-09-11 FIYAT-EDGE KURALI: pick = en iyi fiyat / Pinnacle fiyati - 1 >= esik VE model karsi cikmiyor (model edge >= 0).
// Esik = model_params.edge_threshold_base x family_correction (DB'den, kalibrasyon CLV ile oynatir). Gerekce: backtest'te
// model secimi ortalama oranda Pinnacle kapanisina kaybediyor; kazanc yalniz en iyi fiyattan geliyor (IMPROVEMENT_PLAN 2c).
const PIN_EDGE_MIN_PCT=2; // yalniz backtest cfg varsayilani; canli esik DB'den
// Ust sinir: Pinnacle'in %10+ ustundeki "en iyi fiyat" buyuk olasilikla bayat/hatali veya limitli hat.
// Backtest: pinMin 2->5 arttikca kapanis-CLV artiyor ama gerceklesen ROI dusuyor (-2 -> -19) -> asiri fiyatlar alinamiyor.
const PIN_EDGE_MAX_PCT=10;
// Oran ust siniri (2026-09-26 backtest, 6 lig x 4 sezon, fiyat-edge %2): oran <=6 -> 927 bahis ROI +12; oran >6 -> 285 bahis ROI -30
// (5/6 ligde negatif; CLV pozitif olsa da uzun oranlarda favori-uzun oran yanliligi gercek ROI'yi yutuyor). Kanit: IMPROVEMENT_PLAN 2g.
const PIN_MAX_ODDS=6;
// Kalibrasyon esik tabani: 1.16 x family_correction 1.73 = %2 (fiyat-edge backtest esigi). Eski taban 3 (=%5.2) fiyat-edge
// kuralinda her kalibrasyonda esigi geri yukseltip tum pick'leri kesiyordu (14.09-26.09 canli: 0 pick).
const THR_BASE_MIN=1.16;
// Ek pazarlar (2026-09-27): Ust 1,5 / Alt 3,5 icin Odds API alternate_totals mac basina ayri cagri (1 kredi). Yalniz
// basina ALT_WINDOW_D gun kalan maclar, 12 saat onbellek, istek basina en fazla ALT_MAX_CALLS cagri (kredi korumasi).
const ALT_WINDOW_D=4, ALT_TTL_H=12, ALT_MAX_CALLS=25;
const XMKN={ DC1X:"Çifte Şans 1X", DCX2:"Çifte Şans X2", DC12:"Çifte Şans 12", DNB1:"Beraberlikte İade 1", DNB2:"Beraberlikte İade 2", O15:"Üst 1.5", U35:"Alt 3.5" };
const KELLY_FRACTION=0.125; // 2026-09-10: 1/4 -> 1/8 (model belirsizligi; 1000 bahise kadar)
const KELLY_CAP_PCT=3;      // 2026-09-10: 5 -> 3
const ELO_K_WC=50;
const ODDS_CACHE_TTL_S=900; // 15 dk - aylik 500 krediyi korumak icin (eski: 300)
const REST_COEF=0.035;
const STEAM_W=0.30;
const DC_ITERS=12;
const INJ_COEF=0.02;      // eksik oyuncu basina gol farki etkisi (muhafazakar)
const INJ_CLAMP=0.12;     // toplam sakatlik duzeltmesi siniri
const INJ_CACHE_TTL_S=21600; // 6 saat DB cache (100 istek/gun kotasini korur)
const API_FOOTBALL_LEAGUE={ soccer_epl:39, soccer_spain_la_liga:140, soccer_italy_serie_a:135, soccer_germany_bundesliga:78, soccer_france_ligue_one:61, soccer_turkey_super_league:203, soccer_uefa_champs_league:2, soccer_fifa_world_cup:1 };
// autosave'in dolastigi ligler: CSV'li olanlar + yalniz football-data.org'lu olanlar (CL)
// Basketbol (Faz 1, 2026-09-27): yalniz Mac Sonucu (2 yonlu, uzatma dahil), model yok; secim = fiyat-edge (en iyi fiyat / Pinnacle adil).
// Esik %2 sabit: Euroleague 25/26 backtest'i (tools/basket_backtest.py) %2'de 38 bahis, kapanis adiline karsi CLV +%2,3 (±0,95).
// Futbol kalibrasyonu (calibrate) basketbol satirlarini kullanmaz; esigi etkilemez.
const BASKET_SPORTS=["basketball_nba","basketball_euroleague"]; const BASKET_PE_MIN=2;
// Faz 2 (2026-09-27): Toplam Sayi A/U + Handikapli MS. Pinnacle genelde tam sayi cizgi (170, -5), bahisciler bucuklu (170.5, -5.5):
// Pinnacle cizgisi+adil olasiliktan normal dagilim ortalamasi kurulur, bahiscinin cizgisi o ortalamayla fiyatlanir (model.ts fitMu/sideWP).
// Sigma: NBA SBRO kapanis artiklari (fark ~13, toplam ~18); Euroleague fark sapmasi 12,8, toplam 16 varsayim.
// Backtest Euroleague 01-05.2026, esik %2: toplam 13 bahis CLV +2,29 (±0,65), handikap 15 bahis +2,77 (±1,01). Handikap sigmaya
// duyarli (sigma 15 -> +0,48); toplam degil (14..18 -> +3,4..+1,6). Pinnacle cizgisinden en fazla 1,5 sayi uzak cizgiler.
const BASKET_SIGMA={ basketball_euroleague:{ totals:16, spreads:13 }, basketball_nba:{ totals:18, spreads:13 } }; const BASKET_LINE_WIN=1.5;
const isBasket=(sp)=>String(sp||"").startsWith("basketball_");
const AUTOSAVE_SPORTS=[...new Set([...Object.keys(CSV_COMP), ...Object.keys(COMP), ...BASKET_SPORTS])];
const WC_HOSTS=new Set(["usa","unitedstates","canada","mexico"]);
function wcHomeBonus(home,away,bonus){
  const h=WC_HOSTS.has(norm(home)), a=WC_HOSTS.has(norm(away));
  if(h&&!a) return bonus;
  if(a&&!h) return -bonus;
  return 0;
}
async function getParams(){
  try{ const {data,error}=await sb().rpc("bahis_get_active_params"); if(error) throw error; if(data && data.length){ const p=data[0]; return { version:p.version, rho:+p.rho, edge_threshold_base:+p.edge_threshold_base, family_correction:+p.family_correction, recency_halflife_days:+p.recency_halflife_days, home_elo_bonus:+p.home_elo_bonus }; } }catch(e){ warn("getParams -> DEFAULT_PARAMS",e); }
  return DEFAULT_PARAMS;
}
// v10.2: per-league learned blend weight (x12s) from walk-forward log-loss fit
let leagueParamsCache=null;
async function getLeagueParams(){
  if(leagueParamsCache && Date.now()-leagueParamsCache.t<3600000) return leagueParamsCache.v;
  try{ const {data}=await sb().rpc("bahis_league_params"); const m={};
    for(const r of (data||[])) m[r.sport]={ x12s:r.x12s==null?null:+r.x12s, halflife_days:r.halflife_days==null?null:+r.halflife_days };
    leagueParamsCache={t:Date.now(),v:m}; return m;
  }catch(e){ warn("getLeagueParams",e); return {}; }
}

// v10.3: API-Football injuries -> per-team "Missing Fixture" player count (DB-cached)
async function fetchInjuries(sport){
  if(!FOOTBALL_API_KEY) return null;
  const lid=API_FOOTBALL_LEAGUE[sport]; if(!lid) return null;
  const key="inj:"+sport;
  try{ const {data}=await sb().rpc("bahis_get_odds_cache",{sp:key,max_age_seconds:INJ_CACHE_TTL_S}); if(data) return data; }catch(_){}
  const now=new Date(); const y=now.getUTCFullYear(), m=now.getUTCMonth()+1;
  const season=(sport===WORLD_CUP_SPORT)? y : ((m>=7)? y : y-1);
  try{
    const r=await fetch(`https://v3.football.api-sports.io/injuries?league=${lid}&season=${season}`,{headers:{"x-apisports-key":FOOTBALL_API_KEY}});
    if(!r.ok) return null;
    const d=await r.json();
    if(d.errors && Object.keys(d.errors).length) return null; // plan/kota hatasi -> sinyal kapali, cache yazma
    const cnt={}; const seen={};
    for(const row of (d.response||[])){
      const p=row.player||{}, t=row.team||{};
      if((p.type||"")!=="Missing Fixture") continue;
      const tn=norm(t.name||""); if(!tn) continue;
      const pk=tn+"|"+(p.id||p.name); if(seen[pk]) continue; seen[pk]=1;
      cnt[tn]=(cnt[tn]||0)+1;
    }
    try{ await sb().rpc("bahis_set_odds_cache",{sp:key,p:cnt}); }catch(e){ warn("fetchInjuries cache write",e); }
    return cnt;
  }catch(e){ warn("fetchInjuries",e); return null; }
}
function injuryDiff(home,away,inj){
  if(!inj) return {d:0,h:0,a:0};
  const hk=findKey(home,inj), ak=findKey(away,inj);
  const h=(hk!=null&&inj[hk])?inj[hk]:0, a=(ak!=null&&inj[ak])?inj[ak]:0;
  return { d: Math.max(-INJ_CLAMP, Math.min(INJ_CLAMP, INJ_COEF*(a-h))), h, a };
}

const formCache={};
async function fetchCompetitionForm(comp,halflife){
  const key=comp+"|"+halflife; const c=formCache[key]; if(c&&Date.now()-c.t<3600000) return c.v;
  try{
    const now=new Date(); const y=now.getUTCFullYear();
    const urls=[ `https://api.football-data.org/v4/competitions/${comp}/matches?status=FINISHED`,
                 `https://api.football-data.org/v4/competitions/${comp}/matches?status=FINISHED&season=${y-1}` ];
    let all=[];
    for(const u of urls){ try{ const r=await fetch(u,{headers:{"X-Auth-Token":FD_KEY}}); if(r.ok){ const d=await r.json(); if(Array.isArray(d.matches)) all=all.concat(d.matches); } else warn(`fetchCompetitionForm ${comp} HTTP ${r.status}`,(await r.text().catch(()=>"")).slice(0,160)); }catch(e){ warn(`fetchCompetitionForm ${comp}`,e); } }
    const v=buildRecencyForm(all,halflife,now);
    if(v) formCache[key]={t:Date.now(),v}; else warn(`fetchCompetitionForm ${comp}`,"yetersiz mac -> form yok");
    return v;
  }catch(e){ warn("fetchCompetitionForm",e); return null; }
}
const SOT_W=0.35;
async function fetchCsvForm(sport,halflife){
  const code=CSV_COMP[sport]; if(!code) return null;
  const key="CSV|"+code+"|"+halflife; const c=formCache[key]; if(c&&Date.now()-c.t<3600000) return c.v;
  const now=new Date();
  const y=now.getUTCFullYear(), m=now.getUTCMonth()+1;
  const startY=(m>=7)? y : y-1;
  const seasons=[ String(startY%100).padStart(2,"0")+String((startY+1)%100).padStart(2,"0"),
                  String((startY-1)%100).padStart(2,"0")+String(startY%100).padStart(2,"0") ];
  const raw=[];
  for(const s of seasons){
    try{
      const r=await fetch(`https://www.football-data.co.uk/mmz4281/${s}/${code}.csv`);
      if(!r.ok) continue;
      const txt=await r.text();
      const lines=txt.replace(/^\uFEFF/,"").split(/\r?\n/); if(lines.length<2) continue;
      const H=lines[0].split(","); const ix=(n)=>H.indexOf(n);
      const iD=ix("Date"),iH=ix("HomeTeam"),iA=ix("AwayTeam"),iFH=ix("FTHG"),iFA=ix("FTAG"),iHS=ix("HST"),iAS=ix("AST");
      if(iD<0||iH<0||iA<0||iFH<0||iFA<0) continue;
      for(let li=1; li<lines.length; li++){
        const cells=lines[li].split(","); if(cells.length<5) continue;
        const dm=(cells[iD]||"").split("/"); if(dm.length!==3) continue;
        let yy=+dm[2]; if(yy<100) yy+=2000;
        const iso=`${yy}-${String(+dm[1]).padStart(2,"0")}-${String(+dm[0]).padStart(2,"0")}T15:00:00Z`;
        const gh=+cells[iFH], ga=+cells[iFA]; if(isNaN(gh)||isNaN(ga)) continue;
        const sh=iHS>=0? +cells[iHS] : NaN, sa=iAS>=0? +cells[iAS] : NaN;
        raw.push({ h:(cells[iH]||"").trim(), a:(cells[iA]||"").trim(), gh, ga, sh:isNaN(sh)?null:sh, sa:isNaN(sa)?null:sa, iso });
      }
    }catch(e){ warn(`fetchCsvForm ${code}/${s}`,e); }
  }
  if(raw.length<30){ warn(`fetchCsvForm ${code}`,`yalniz ${raw.length} satir -> form yok`); return null; }
  let g=0,s2=0; for(const r of raw){ if(r.sh!=null&&r.sa!=null){ g+=r.gh+r.ga; s2+=r.sh+r.sa; } }
  const conv=(s2>50)? g/s2 : 0.30;
  const alias=(name)=>{ const n=norm(name); return CSV_ALIAS[n]||n; };
  const eff=(goals,sot)=> (sot==null)? goals : (1-SOT_W)*goals+SOT_W*conv*sot;
  const matches=raw.map(r=>({ status:"FINISHED", utcDate:r.iso,
    homeTeam:{name:alias(r.h)}, awayTeam:{name:alias(r.a)},
    score:{fullTime:{home:eff(r.gh,r.sh), away:eff(r.ga,r.sa)}} }));
  const v=buildRecencyForm(matches,halflife,now);
  if(v) formCache[key]={t:Date.now(),v};
  return v;
}
function buildRecencyForm(matches,halflife,now){
  const rows=[]; const teams={}; let thG=0,thW=0,taG=0,taW=0; const lastMatch={};
  for(const m of matches){
    if(m.status!=="FINISHED") continue;
    const sc=m.score&&m.score.fullTime; if(!sc||sc.home==null||sc.away==null) continue;
    const md=new Date(m.utcDate).getTime();
    const days=(now.getTime()-md)/86400000; if(days<0) continue;
    const w=Math.pow(0.5, days/halflife);
    const hn=norm(m.homeTeam&&m.homeTeam.name), an=norm(m.awayTeam&&m.awayTeam.name); if(!hn||!an) continue;
    rows.push({hn,an,gh:sc.home,ga:sc.away,w});
    teams[hn]=1; teams[an]=1;
    if(!lastMatch[hn]||md>lastMatch[hn]) lastMatch[hn]=md;
    if(!lastMatch[an]||md>lastMatch[an]) lastMatch[an]=md;
    thG+=sc.home*w; thW+=w; taG+=sc.away*w; taW+=w;
  }
  if(thW<8||taW<8) return null;
  const muH=thG/thW, muA=taG/taW, muM=(muH+muA)/2;
  const att={}, def={}, wSum={};
  for(const t in teams){ att[t]=1; def[t]=1; wSum[t]=0; }
  for(const r of rows){ wSum[r.hn]+=r.w; wSum[r.an]+=r.w; }
  for(let it=0; it<DC_ITERS; it++){
    const gfN={},gfD={},gaN={},gaD={};
    for(const t in teams){ gfN[t]=0; gfD[t]=1e-9; gaN[t]=0; gaD[t]=1e-9; }
    for(const r of rows){
      gfN[r.hn]+=r.w*r.gh; gfD[r.hn]+=r.w*muH*def[r.an];
      gfN[r.an]+=r.w*r.ga; gfD[r.an]+=r.w*muA*def[r.hn];
      gaN[r.hn]+=r.w*r.ga; gaD[r.hn]+=r.w*muA*att[r.an];
      gaN[r.an]+=r.w*r.gh; gaD[r.an]+=r.w*muH*att[r.hn];
    }
    for(const t in teams){
      att[t]=(gfN[t]+2*muM)/(gfD[t]+2*muM);
      def[t]=(gaN[t]+2*muM)/(gaD[t]+2*muM);
      att[t]=Math.min(3,Math.max(0.3,att[t])); def[t]=Math.min(3,Math.max(0.3,def[t]));
    }
  }
  const hAdv={}; const hN={},hD={};
  for(const t in teams){ hN[t]=0; hD[t]=1e-9; }
  for(const r of rows){ hN[r.hn]+=r.w*r.gh; hD[r.hn]+=r.w*muH*att[r.hn]*def[r.an]; }
  const kk=4*muM;
  for(const t in teams){ hAdv[t]=Math.min(1.25,Math.max(0.8,(hN[t]+kk)/(hD[t]+kk))); }
  return { att, def, muH, muA, lastMatch, wSum, hAdv };
}
function formLambdas(h0,a0,S,marketMu,matchTime,extraD){
  const hk=findKey(h0,S.att), ak=findKey(a0,S.att); if(!hk||!ak) return null;
  if((S.wSum[hk]||0)<1||(S.wSum[ak]||0)<1) return null;
  let lh=S.muH*S.att[hk]*S.def[ak]*((S.hAdv&&S.hAdv[hk])||1), la=S.muA*S.att[ak]*S.def[hk];
  let d=lh-la;
  d+=restAdj(S.lastMatch[hk],S.lastMatch[ak],matchTime);
  if(extraD) d+=extraD;
  const T0=(marketMu!=null&&marketMu>0.6&&marketMu<7)? FORM_TOTAL_W*(lh+la)+(1-FORM_TOTAL_W)*marketMu : lh+la;
  lh=(T0+d)/2; la=(T0-d)/2;
  return { lh:Math.min(4.5,Math.max(0.15,lh)), la:Math.min(4.5,Math.max(0.15,la)) }; }
function restAdj(lastH,lastA,matchTime){
  if(!lastH||!lastA||!matchTime) return 0;
  const rH=(matchTime-lastH)/86400000, rA=(matchTime-lastA)/86400000;
  if(rH<0||rA<0||rH>21||rA>21) return 0;
  return REST_COEF*Math.max(-4,Math.min(4,rH-rA));
}

async function fetchWcForm(halflife){
  const key="WC|"+halflife; const c=formCache[key]; if(c&&Date.now()-c.t<3600000) return c.v;
  try{
    const r=await fetch(`https://api.football-data.org/v4/competitions/WC/matches?status=FINISHED`,{headers:{"X-Auth-Token":FD_KEY}});
    if(!r.ok) return null;
    const d=await r.json(); if(!Array.isArray(d.matches)) return null;
    const v=buildRecencyForm(d.matches,halflife,new Date());
    if(v) formCache[key]={t:Date.now(),v};
    return v;
  }catch(e){ warn("fetchWcForm",e); return null; }
}
function wcFormDiff(h0,a0,S,mu,matchTime){
  if(!S) return null;
  const hk=findKey(h0,S.att), ak=findKey(a0,S.att); if(!hk||!ak) return null;
  if((S.wSum[hk]||0)<0.8||(S.wSum[ak]||0)<0.8) return null;
  let lh=S.att[hk]*S.def[ak], la=S.att[ak]*S.def[hk]; const s=lh+la; if(s<=0) return null;
  lh=mu*lh/s; la=mu*la/s;
  const conf=Math.min(1,(S.wSum[hk]+S.wSum[ak])/4);
  let d=(lh-la)*conf;
  d+=restAdj(S.lastMatch[hk],S.lastMatch[ak],matchTime);
  return { d, conf };
}

async function getEloMap(){
  try{ const {data,error}=await sb().rpc("bahis_all_elo"); if(error) throw error; if(!data) return null;
    const map={}; for(const r of data) map[norm(r.team_name)]=+r.elo;
    return Object.keys(map).length? map : null;
  }catch(e){ warn("getEloMap",e); return null; }
}
function eloLambdas(home,away,map,homeBonus,rho,mu,formD,extraD){
  const hk=findKey(home,map), ak=findKey(away,map); if(hk==null||ak==null) return null;
  const diff=(map[hk]+homeBonus)-map[ak];
  const We=1/(Math.pow(10,-diff/400)+1);
  const M=(mu!=null&&mu>0.6&&mu<7)? mu : FALLBACK_TOTAL_MU;
  const mk=(d)=>({ lh:Math.max(0.05,(M+d)/2), la:Math.max(0.05,(M-d)/2) });
  const err=(d)=>{ const {lh,la}=mk(d); const r=probs(lh,la,rho); return Math.pow((r["1"]+0.5*r["X"])-We,2); };
  const dMax=Math.min(2.6, M-0.1);
  let best={d:0,err:err(0)};
  for(let d=-dMax; d<=dMax; d+=0.1){ const e=err(d); if(e<best.err) best={d,err:e}; }
  for(let d=Math.max(-dMax,best.d-0.12); d<=Math.min(dMax,best.d+0.12); d+=0.02){ const e=err(d); if(e<best.err) best={d,err:e}; }
  let d=best.d;
  if(formD!=null&&isFinite(formD)) d=Math.max(-dMax,Math.min(dMax,(1-WC_FORM_D_W)*d+WC_FORM_D_W*formD));
  if(extraD) d=Math.max(-dMax,Math.min(dMax,d+extraD));
  return mk(d);
}

// Borsalar (Betfair/Matchbook "back" fiyati): komisyonlu ve likiditeye bagli -> "en iyi bahisci fiyati" sayilmaz.
// Konsensus/devig'e girer (keskin fiyat), best (pick orani, CLV) disinda tutulur.
const EXCHANGE_KEYS=/betfair_ex|matchbook/;
function buildConsensus(ev){
  const books=ev.bookmakers||[];
  const trip=[]; const best={}; const book={};
  const up=(m,o,bk)=>{ if(o&&o.price>1&&o.price>(best[m]||0)){ best[m]=o.price; book[m]=bk.title||bk.key; } };
  const TOTAL_LINES=[1.5,2.5,3.5];
  const linePairs={}; for(const L of TOTAL_LINES) linePairs[L]=[];
  for(const bk of books){
    const isEx=EXCHANGE_KEYS.test(bk.key||"");
    const h2h=bk.markets&&bk.markets.find((m)=>m.key==="h2h");
    if(h2h){
      const oh=h2h.outcomes.find((o)=>o.name===ev.home_team);
      const oa=h2h.outcomes.find((o)=>o.name===ev.away_team);
      const od=h2h.outcomes.find((o)=>o.name==="Draw");
      if(!isEx){ up("1",oh,bk); up("2",oa,bk); up("X",od,bk); }
      if(oh&&oa&&oh.price>1&&oa.price>1) trip.push({h:1/oh.price, x:(od&&od.price>1)?1/od.price:null, a:1/oa.price});
    }
    const tot=bk.markets&&bk.markets.find((m)=>m.key==="totals");
    if(tot){
      for(const L of TOTAL_LINES){
        const ov=tot.outcomes.find((o)=>o.name==="Over"&&Math.abs((o.point??99)-L)<0.01);
        const un=tot.outcomes.find((o)=>o.name==="Under"&&Math.abs((o.point??99)-L)<0.01);
        if(!isEx&&L===2.5){ up("O",ov,bk); up("U",un,bk); }
        if(ov&&un&&ov.price>1&&un.price>1) linePairs[L].push({o:1/ov.price, u:1/un.price});
      }
    }
  }
  let pH=null,pD=null,pA=null,pOver=null,pOvers=null;
  const dh=[],dx=[],da=[];
  for(const b of trip){
    if(b.x!=null){ const [d1,dX,d2]=shinDevig([b.h,b.x,b.a]); dh.push(d1); dx.push(dX); da.push(d2); }
    else { const [d1,d2]=shinDevig([b.h,b.a]); dh.push(d1); da.push(d2); }
  }
  if(dh.length&&da.length){
    pH=median(dh); pA=median(da); pD=dx.length? median(dx) : null;
    const s=pH+pA+(pD||0);
    if(pD!=null){ pH/=s; pD/=s; pA/=s; } else { pH/=s; pA/=s; }
  }
  for(const L of TOTAL_LINES){
    if(linePairs[L].length){
      const dos=linePairs[L].map(p=>{ const [dO,dU]=shinDevig([p.o,p.u]); return dO/(dO+dU); });
      const m=median(dos); (pOvers=pOvers||{})[String(L)]=m; if(L===2.5) pOver=m;
    }
  }
  return { pH,pD,pA,pOver,pOvers, odds:best, book, books:books.length };
}

function buildAuto(home,away,mLh,mLa,odds,indep,rho,threshold,extra={},x12s=X12_PROB_SHRINK,pin={}){
  const market=probs(mLh,mLa,rho);
  let mdLh,mdLa,source;
  if(indep){ mdLh=indep.lh; mdLa=indep.la; source=extra.__wc?"elo":"form"; }
  else { const md=marketAdj(mLh,mLa); mdLh=md.lh; mdLa=md.la; source="market"; }
  const model=probs(mdLh,mdLa,rho);
  const markets=MKID.map((m)=>{ let mod=model[m]; const mkt=market[m];
    if(source!=="market"){
      const s=(FAMILY[m]==="ou"||FAMILY[m]==="btts")? GOAL_PROB_SHRINK : x12s;
      mod=mkt+s*(mod-mkt);
    }
    const edge=mod-mkt,odd=odds[m]||null;
    // Fiyat-edge: en iyi fiyat / Pinnacle FAIR (marjsiz) - 1 (yuzde); Pinnacle fiyati yoksa null -> value olamaz
    const pinOdd=(pin.raw||{})[m]||null; const pinFair=(pin.fair||{})[m]||null;
    const pinEdge=(odd&&pinFair&&pinFair>1)? +((odd/pinFair-1)*100).toFixed(2) : null;
    // value = source!="market" (form/Elo var) VE fiyat-edge >= esik VE model karsi cikmiyor (edge >= 0)
    const value=source!=="market" && pinEdge!=null && pinEdge>=threshold && pinEdge<=PIN_EDGE_MAX_PCT && edge>=0 && odd<=PIN_MAX_ODDS;
    return { code:m,name:MKN[m],family:FAMILY[m],model:+(mod*100).toFixed(1),mkt:+(mkt*100).toFixed(1),edge:+(edge*100).toFixed(1),odds:odd,odds_pin:pinOdd,odds_pin_fair:pinFair?+pinFair.toFixed(3):null,pin_edge:pinEdge,book:(pin.book||{})[m]||null,value }; });
  const best=markets.filter((x)=>x.value&&x.odds).sort((a,b)=>b.pin_edge-a.pin_edge)[0]||null;
  if(best&&best.odds&&best.odds>1){
    // Kelly olasiligi = Pinnacle ADIL olasiligi (fiyat-edge kurali: kazanc fiyattan gelir); model olasiligi yalniz Pinnacle yoksa.
    // Eski hal model olasiligini kullaniyordu -> fiyat-edge pick'lerinin cogunda Kelly 0 cikiyordu (2026-09-26 canli).
    const p=(best.odds_pin_fair&&best.odds_pin_fair>1)? 1/best.odds_pin_fair : best.model/100, b=best.odds-1;
    const kelly=Math.max(0,(p*best.odds-1)/b);
    best.kelly_pct=+Math.min(KELLY_CAP_PCT, KELLY_FRACTION*kelly*100).toFixed(1);
  }
  return { home,away,source,model_lh:+mdLh.toFixed(2),model_la:+mdLa.toFixed(2),market_lh:+mLh.toFixed(2),market_la:+mLa.toFixed(2),
    top:model.top.map((t)=>({score:t.s,p:+(t.p*100).toFixed(0)})), markets, pick:best, ...extra };
}

// Oran gecmisi (2026-09-27): taze cekimde etkinlik basina Pinnacle + en iyi (borsa haric) fiyat ozeti -> bahis_tahmin.odds_snapshots.
// Ek kredi yok. Maca <=24 saat kalanlar her taze cekimde (~15 dk-1 saat), digerleri lig basina en fazla 6 saatte bir; 120 gun saklanir.
// Anahtar "pazar:taraf[@cizgi]" (taraf H/A/Draw/Over/Under), ornek "h2h:H", "totals:Over@2.5", "spreads:A@5.5".
function snapOf(ev){ const pin={}, best={};
  for(const b of (ev.bookmakers||[])){ const ex=EXCHANGE_KEYS.test(b.key||"");
    for(const m of (b.markets||[])) for(const o of (m.outcomes||[])){ if(!(o.price>1)) continue;
      const k=m.key+":"+(o.name===ev.home_team?"H":o.name===ev.away_team?"A":o.name)+(o.point!=null?"@"+o.point:"");
      if(b.key==="pinnacle") pin[k]=o.price; if(!ex&&o.price>(best[k]||0)) best[k]=o.price; } }
  return { pin, best }; }
async function saveSnapshots(sport,events){ try{
  const now=Date.now(); let far=true;
  try{ const {data}=await sb().rpc("bahis_get_odds_cache",{sp:"snap:"+sport,max_age_seconds:6*3600}); if(data) far=false; }catch(_){ /* yoksa kaydet */ }
  const rows=[];
  for(const ev of (events||[])){ const t=new Date(ev.commence_time).getTime(); if(!(t>now)) continue; if(t-now>86400000&&!far) continue;
    rows.push({ sport, event_id:ev.id, commence_time:ev.commence_time, home:ev.home_team, away:ev.away_team, ...snapOf(ev) }); }
  if(rows.length){ const {error}=await sb().rpc("bahis_add_odds_snapshots",{p:rows}); if(error) warn("odds snapshots",error); }
  if(far) await sb().rpc("bahis_set_odds_cache",{sp:"snap:"+sport,p:{t:now}});
}catch(e){ warn("odds snapshots",e); } }

// Kredi korumasi (2026-09-27, site herkese acik): kalan kredi ODDS_CREDIT_FLOOR altindaysa herkese acik istekler (pub) API'yi
// cagirmaz, bayat onbellekle yetinir; cron'lar (autosave/kapanis/settle) calismaya devam eder. Kalan kredi her cekimde "credits" anahtarina yazilir.
const ODDS_CREDIT_FLOOR=2000;
async function fetchOddsEvents(sport,pub=false){
  try{ const {data}=await sb().rpc("bahis_get_odds_cache",{sp:sport,max_age_seconds:ODDS_CACHE_TTL_S}); if(data) return { events:data, cached:true }; }catch(e){ warn("odds cache read",e); }
  if(pub){ try{ const {data:cr}=await sb().rpc("bahis_get_odds_cache",{sp:"credits",max_age_seconds:86400});
    if(cr&&cr.remaining!=null&&cr.remaining<ODDS_CREDIT_FLOOR){ const {data:st}=await sb().rpc("bahis_get_odds_cache",{sp:sport,max_age_seconds:30*86400}); return { events:st||[], cached:true, stale:true }; } }catch(e){ warn("credit guard",e); } }
  const res=await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=${isBasket(sport)?"h2h,spreads,totals":"h2h,totals"}&oddsFormat=decimal`);
  if(!res.ok){ warn(`odds API ${sport} HTTP`,res.status); return { error:res.status }; }
  const events=await res.json();
  try{ await sb().rpc("bahis_set_odds_cache",{sp:sport,p:events}); }catch(e){ warn("odds cache write",e); }
  await saveSnapshots(sport,events);
  const rem=Number(res.headers.get("x-requests-remaining")); if(Number.isFinite(rem)){ try{ await sb().rpc("bahis_set_odds_cache",{sp:"credits",p:{remaining:rem}}); }catch(e){ warn("credits write",e); } }
  return { events, cached:false };
}

async function fetchAltTotals(sport,events){
  const now=Date.now(); const key="alt:"+sport; let map={};
  try{ const {data}=await sb().rpc("bahis_get_odds_cache",{sp:key,max_age_seconds:7*86400}); if(data&&typeof data==="object"&&!Array.isArray(data)) map=data; }catch(e){ warn("alt cache read",e); }
  const need=events.filter((ev)=>{ const t=new Date(ev.commence_time).getTime(); if(!(t>now&&t-now<=ALT_WINDOW_D*86400000)) return false;
    const c=map[ev.id]; return !c||now-c.t>ALT_TTL_H*3600000; }).slice(0,ALT_MAX_CALLS);
  let changed=false;
  for(const ev of need){ try{
    const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sport}/events/${ev.id}/odds?apiKey=${ODDS_KEY}&regions=eu&markets=alternate_totals&oddsFormat=decimal`);
    if(!r.ok){ warn(`alt totals ${sport} HTTP`,r.status); continue; }
    const d=await r.json(); map[ev.id]={ t:now, b:(d.bookmakers||[]).map((b)=>({ k:b.key, n:b.title||b.key, o:(((b.markets||[])[0])||{}).outcomes||[] })) }; changed=true;
  }catch(e){ warn("alt totals",e); } }
  if(changed){ for(const id in map){ if(now-map[id].t>7*86400000) delete map[id]; } try{ await sb().rpc("bahis_set_odds_cache",{sp:key,p:map}); }catch(e){ warn("alt cache write",e); } }
  return map;
}
// alternate_totals -> Ust 1,5 ve Alt 3,5: en iyi fiyat (borsalar haric) + Pinnacle adil olasilik (Shin devig)
function altOU(entry){
  if(!entry||!entry.b) return null; const best={}; let pin=null;
  for(const b of entry.b){ const g=(nm,pt)=>{ const x=(b.o||[]).find((o)=>o.name===nm&&Math.abs((o.point??99)-pt)<0.01); return (x&&x.price>1)? x.price : null; };
    if(b.k==="pinnacle") pin={ o15:g("Over",1.5), u15:g("Under",1.5), o35:g("Over",3.5), u35:g("Under",3.5) };
    if(!EXCHANGE_KEYS.test(b.k||"")) for(const [code,nm,pt] of [["O15","Over",1.5],["U35","Under",3.5]]){ const p=g(nm,pt); if(p&&p>((best[code]||{}).price||0)) best[code]={price:p,book:b.n}; } }
  if(!pin) return null; const out={};
  if(pin.o15&&pin.u15&&best.O15){ const f=shinDevig([1/pin.o15,1/pin.u15]); out.O15={...best.O15, fp:f[0]}; }
  if(pin.o35&&pin.u35&&best.U35){ const f=shinDevig([1/pin.o35,1/pin.u35]); out.U35={...best.U35, fp:f[1]}; }
  return out;
}

function bestLine(ev,key,s){ const best=bestLineRaw(ev,key,s,BASKET_LINE_WIN,EXCHANGE_KEYS); if(!best) return null; const pe=+(best.e*100).toFixed(2);
  return { code:best.code, name:best.code, family:key==="totals"?"ou":"hcp", model:+(best.w*100).toFixed(1), mkt:+(best.w*100).toFixed(1), edge:0, odds:best.price,
    odds_pin:null, odds_pin_fair:+((1-best.pu)/best.w).toFixed(3), pin_edge:pe, book:best.book, value: pe>=BASKET_PE_MIN && pe<=PIN_EDGE_MAX_PCT && best.price<=PIN_MAX_ODDS }; }

// Basketbol sonuc arsivi (2026-09-28): scores (daysFrom=3, lig basina 2 kredi) gunde bir (autosave) -> bahis_tahmin.game_results.
// Elo modeli (bilgi amacli, secimlere karismaz) bu arsivden hesaplanir. Ev avantaji Elo cinsinden.
const BASKET_HCA={ basketball_nba:60, basketball_euroleague:90 };
async function collectResults(){ const out={};
  for(const sp of BASKET_SPORTS){ try{
    const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/scores/?daysFrom=3&apiKey=${ODDS_KEY}`); if(!r.ok){ out[sp]=`HTTP ${r.status}`; continue; }
    const rows=[]; for(const g of ((await r.json())||[])){ if(!g.completed||!g.scores) continue;
      const hs=Number(g.scores.find((s)=>s.name===g.home_team)?.score), as=Number(g.scores.find((s)=>s.name===g.away_team)?.score); if(isNaN(hs)||isNaN(as)) continue;
      rows.push({ sport:sp, event_id:g.id, commence_time:g.commence_time, home:g.home_team, away:g.away_team, home_score:hs, away_score:as }); }
    if(rows.length){ const {data,error}=await sb().rpc("bahis_upsert_results",{p:rows}); if(error) throw error; out[sp]=data; } else out[sp]=0;
  }catch(e){ warn(`collectResults ${sp}`,e); out[sp]=String(e); } }
  return out; }
async function basketModel(sport){ try{ const {data,error}=await sb().rpc("bahis_get_results",{sp:sport}); if(error) throw error;
    const games=(data||[]).map((g)=>({ t:new Date(g.commence_time).getTime(), home:g.home, away:g.away, hs:g.home_score, as:g.away_score }));
    return { m:basketElo(games,BASKET_HCA[sport]??60), n:games.length }; }catch(e){ warn("basketModel",e); return null; } }

// ---- Futbol Asya handikabi (2026-09-29): gunluk tarama (autosave), lig basina spreads = 1 kredi. Yalniz Pinnacle ile AYNI cizgi.
// Backtest (football-data, 10 lig, 19/20-25/26, %2, Max oran): 1219 bahis ROI +7,0, CLV +2,05; 7 sezonun 6'si, 10 ligin 9'u pozitif.
// Canli kapsam dar (lig basina 3-5 bahisci) -> backtest'ten az secim beklenir. Sonuc "ah:<lig>" onbellegine (kart/kupon) + autosave kaydi.
const AH_PE_MIN=2;
async function ahScan(){ const all=[], out={};
  for(const sp of Object.keys(CSV_COMP)){ try{
    const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=spreads&oddsFormat=decimal`);
    if(!r.ok){ out[sp]=`HTTP ${r.status}`; continue; }
    const now=Date.now(), map={}; let n=0;
    for(const ev of ((await r.json())||[])){ if(!(new Date(ev.commence_time).getTime()>now)) continue;
      const b=ahBest(ev,EXCHANGE_KEYS); if(!b) continue; const pe=+(b.e*100).toFixed(2);
      if(!(pe>=AH_PE_MIN&&pe<=PIN_EDGE_MAX_PCT&&b.price<=PIN_MAX_ODDS)) continue;
      const pick={ code:b.code, odds:b.price, book:b.book, prob:+(b.p*100).toFixed(1), fair_odds:+(1/b.p).toFixed(3), pin_edge:pe, t:now };
      map[norm(ev.home_team)+"|"+norm(ev.away_team)]=pick; n++; all.push({ sport:sp, home:ev.home_team, away:ev.away_team, commence:ev.commence_time, pick }); }
    await sb().rpc("bahis_set_odds_cache",{sp:"ah:"+sp,p:map}); out[sp]=n;
  }catch(e){ warn(`ahScan ${sp}`,e); out[sp]=String(e); } }
  return { out, all }; }

async function fetchBasket(sport,pub=false){
  const oe=await fetchOddsEvents(sport,pub);
  if(oe.error) return { error:`Oran API hatası (${oe.error}).` };
  const bm=await basketModel(sport), hca=BASKET_HCA[sport]??60;
  const out=[];
  for(const ev of oe.events){
    if(ev.commence_time && new Date(ev.commence_time).getTime()<=Date.now()){ out.push({ home:ev.home_team, away:ev.away_team, commence:ev.commence_time, live:true, markets:[], pick:null, source:"live", bk:true }); continue; }
    const cons=buildConsensus(ev), pin=pinnacleFair(ev);
    const markets=["1","2"].map((m)=>{ const odd=cons.odds[m]||null, pf=(pin.fair||{})[m]||null, p=(pf&&pf>1)? 1/pf : null;
      const pe=(odd&&p)? +((odd/pf-1)*100).toFixed(2) : null;
      const value=pe!=null && pe>=BASKET_PE_MIN && pe<=PIN_EDGE_MAX_PCT && odd<=PIN_MAX_ODDS;
      return { code:m, name:MKN[m], family:"1x2", model:p!=null? +(p*100).toFixed(1) : null, mkt:p!=null? +(p*100).toFixed(1) : null, edge:0, odds:odd,
        odds_pin:(pin.raw||{})[m]||null, odds_pin_fair:pf? +pf.toFixed(3) : null, pin_edge:pe, book:(cons.book||{})[m]||null, value }; });
    const pin_ready=markets.every((x)=>x.model!=null); // Pinnacle genelde mac gunune yakin acilir; o zamana kadar secim yok
    for(const key of ["totals","spreads"]){ const b=bestLine(ev,key,(BASKET_SIGMA[sport]||{})[key]); if(b) markets.push(b); }
    const best=markets.filter((x)=>x.value).sort((a,b)=>b.pin_edge-a.pin_edge)[0]||null;
    if(best){ const p=best.model/100; best.kelly_pct=+Math.min(KELLY_CAP_PCT, KELLY_FRACTION*Math.max(0,(p*best.odds-1)/(best.odds-1))*100).toFixed(1); }
    out.push({ home:ev.home_team, away:ev.away_team, commence:ev.commence_time, source:"price", bk:true, pin_ready, elo: bm? { ...eloPredict(bm.m,ev.home_team,ev.away_team,hca), league_games:bm.n } : null, model_lh:null, model_la:null, markets, pick:best, books_used:cons.books });
  }
  return { matches:out, count:out.length, rule:"price_edge", edge_threshold_pct:BASKET_PE_MIN, basketball:true };
}

async function fetchFixtures(sport,pub=false){
  if(isBasket(sport)) return fetchBasket(sport,pub);
  const params=await getParams();
  const lpAll=await getLeagueParams();
  const lp=lpAll[sport];
  const x12s=(lp&&lp.x12s!=null)? lp.x12s : X12_PROB_SHRINK;
  // Lig bazli yari omur (backtest: EPL 45->250 gun ile model piyasayi gecer); yoksa global model_params degeri
  const halflife=(lp&&lp.halflife_days>0)? lp.halflife_days : params.recency_halflife_days;
  const oe=await fetchOddsEvents(sport,pub);
  if(oe.error) return { error:`Oran API hatası (${oe.error}).` };
  const events=oe.events;
  const isWC=sport===WORLD_CUP_SPORT;
  let form=null;
  if(!isWC){
    if(CSV_COMP[sport]) form=await fetchCsvForm(sport,halflife);
    if(!form && COMP[sport]) form=await fetchCompetitionForm(COMP[sport],halflife);
  }
  const eloMap=isWC? await getEloMap() : null;
  const wcForm=isWC? await fetchWcForm(21) : null;
  const inj=await fetchInjuries(sport);
  const alt=isWC? {} : await fetchAltTotals(sport, events.filter((ev)=>!(ev.commence_time&&new Date(ev.commence_time).getTime()<=Date.now())));
  const out=[]; let formCount=0;
  const evKey=(ev)=>norm(ev.home_team)+"|"+norm(ev.away_team)+"|"+String(ev.commence_time).slice(0,10);
  // 1. gecis: konsensus; 2. adim: acilis oranlarini TEK RPC ile al/yaz (eski: mac basina 1 RPC)
  const pre=[];
  for(const ev of events){
    if(ev.commence_time && new Date(ev.commence_time).getTime()<=Date.now()){ pre.push({ev,live:true}); continue; }
    const cons=buildConsensus(ev);
    if(cons.pH==null||cons.pA==null) continue;
    pre.push({ev,cons,key:evKey(ev)});
  }
  let opening={};
  try{
    const p=pre.filter(x=>x.cons).map(x=>({key:x.key, sport, ph:x.cons.pH, pa:x.cons.pA, pover:x.cons.pOver}));
    if(p.length){ const {data:op,error}=await sb().rpc("bahis_opening_odds",{p}); if(error) throw error; opening=op||{}; }
  }catch(e){ warn("bahis_opening_odds",e); }
  for(const {ev,cons,key,live} of pre){
    if(live){
      out.push({ home:ev.home_team, away:ev.away_team, commence:ev.commence_time, live:true, model_lh:0, model_la:0, markets:[], pick:null, source:"live" });
      continue;
    }
    const est=estimateLambdas(cons.pH,cons.pA,cons.pOvers||cons.pOver,params.rho);
    const marketMu=(cons.pOver!=null||cons.pOvers!=null)? est.lh+est.la : null;
    let steamD=0;
    const o=opening[key];
    if(o&&o.ph!=null){ const drift=cons.pH-(+o.ph); steamD=STEAM_W*Math.max(-0.5,Math.min(0.5,3*drift)); }
    const matchTime=ev.commence_time? new Date(ev.commence_time).getTime() : null;
    const injd=injuryDiff(ev.home_team,ev.away_team,inj);
    const extraD=steamD+injd.d;
    let indep=null;
    if(isWC&&eloMap){
      const fd=wcFormDiff(ev.home_team,ev.away_team,wcForm,marketMu??FALLBACK_TOTAL_MU,matchTime);
      const bonus=wcHomeBonus(ev.home_team,ev.away_team,params.home_elo_bonus);
      indep=eloLambdas(ev.home_team,ev.away_team,eloMap,bonus,params.rho,marketMu,fd?fd.d:null,extraD);
    }
    else if(form){ indep=formLambdas(ev.home_team,ev.away_team,form,marketMu,matchTime,extraD); }
    if(indep) formCount++;
    const threshold=params.edge_threshold_base*params.family_correction;
    const extra={ commence:ev.commence_time, params_version:params.version, books_used:cons.books, __wc:isWC };
    if(inj&&(injd.h||injd.a)) extra.inj_out={home:injd.h,away:injd.a};
    const pin=pinnacleFair(ev);
    const a=buildAuto(ev.home_team,ev.away_team,est.lh,est.la,cons.odds,indep,params.rho,threshold,extra,x12s,{...pin, book:cons.book});
    // Yuksek isabetli ek secim (Cifte Sans / Beraberlikte Iade / Ust 1,5 / Alt 3,5): ayni fiyat-edge esigi, form/Elo sarti
    if(a.source!=="market"){
      const pf=pin.fair||{}; const fp=(pf["1"]&&pf["X"]&&pf["2"])? {"1":1/pf["1"],"X":1/pf["X"],"2":1/pf["2"]} : null;
      const kp={}, mp={}; for(const x of a.markets){ kp[x.code]=x.model/100; mp[x.code]=x.mkt/100; }
      const ou=altOU(alt[ev.id]); const pm=probs(a.model_lh,a.model_la,params.rho);
      if(ou&&ou.O15) ou.O15.kp=pm.O15; if(ou&&ou.U35) ou.U35.kp=1-pm.O35;
      const x=extraPick({ best:cons.odds, book:cons.book, fp, kp, mp, ou, thr:threshold, maxEdge:PIN_EDGE_MAX_PCT });
      if(x){ const kel=Math.max(0,(x.prob*x.price-1)/(x.price-1));
        a.xpick={ code:x.code, name:XMKN[x.code], odds:+x.price.toFixed(3), prob:+(x.prob*100).toFixed(1), fair_odds:+(1/x.prob).toFixed(3), pin_edge:+x.pe.toFixed(2),
          legs:x.legs.map((l)=>({ code:l.code, odds:l.odds, book:l.book, share:+l.share.toFixed(3) })), kelly_pct:+Math.min(KELLY_CAP_PCT,KELLY_FRACTION*kel*100).toFixed(1), value:true }; }
    }
    out.push(a);
  }
  const pk=out.filter(m=>m.pick&&m.pick.kelly_pct);
  const totK=pk.reduce((s,m)=>s+m.pick.kelly_pct,0);
  if(totK>15) for(const m of pk) m.pick.kelly_pct=+(m.pick.kelly_pct*15/totK).toFixed(1);
  try{ const {data:ahm}=await sb().rpc("bahis_get_odds_cache",{sp:"ah:"+sport,max_age_seconds:36*3600}); // gunluk Asya handikabi taramasi
    if(ahm&&typeof ahm==="object") for(const m of out){ const x=!m.live&&ahm[norm(m.home)+"|"+norm(m.away)]; if(x) m.ahpick=x; } }catch(e){ warn("ah cache",e); }
  return { matches:out, count:out.length, form_count:formCount, params_version:params.version, rho:params.rho, league_x12s:x12s, halflife_days:halflife, injury_signal:!!inj, edge_threshold_pct:+(params.edge_threshold_base*params.family_correction).toFixed(2), rule:"price_edge", extra_markets:true };
}

async function savePreds(picks){ try{ const {data,error}=await sb().rpc("bahis_save_predictions",{p:picks}); if(error) return {ok:false,error:error.message}; return {ok:true,saved:data}; }catch(e){ return {ok:false,error:String(e)}; } }
async function getHistory(sport){ try{ const {data,error}=await sb().rpc("bahis_history",{lim:3000,sp:sport||null}); if(error) return {error:error.message}; return {rows:data}; }catch(e){ return {error:String(e)}; } }
async function settle(){ try{
  const {data:pend,error}=await sb().rpc("bahis_pending"); if(error) return {error:error.message}; if(!pend||!pend.length) return {settled:0};
  const bySport={}; for(const r of pend){ const sp=r.sport||""; (bySport[sp]=bySport[sp]||[]).push(r); }
  const updates=[]; const wcSettled={}; let voided=0;
  const ageDays=(d)=>(Date.now()-new Date(d+"T00:00:00Z").getTime())/86400000;
  for(const sp in bySport){ if(!sp) continue;
    const done={};
    const addDone=(home,away,hs,as)=>{ if(home&&away&&!isNaN(hs)&&!isNaN(as)) done[norm(home)+"|"+norm(away)]={hs,as,home,away}; };
    try{ const sr=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/scores/?daysFrom=3&apiKey=${ODDS_KEY}`); if(!sr.ok) warn(`settle scores ${sp} HTTP`,sr.status);
      else for(const g of ((await sr.json())||[])){ if(g.completed&&g.scores) addDone(g.home_team,g.away_team,Number(g.scores.find((s)=>s.name===g.home_team)?.score),Number(g.scores.find((s)=>s.name===g.away_team)?.score)); } }catch(e){ warn(`settle scores ${sp}`,e); }
    // Odds API skorlari en fazla 3 gun geriye gider; daha eski bekleyenler (API kesintisi, 14-26.09 gibi) football-data.org'dan
    if(COMP[sp]&&FD_KEY&&bySport[sp].some((r)=>ageDays(r.match_date)>3)){
      try{ const r=await fetch(`https://api.football-data.org/v4/competitions/${COMP[sp]}/matches?status=FINISHED`,{headers:{"X-Auth-Token":FD_KEY}});
        if(r.ok){ for(const m of (((await r.json()).matches)||[])) addDone(m.homeTeam?.name,m.awayTeam?.name,Number(m.score?.fullTime?.home),Number(m.score?.fullTime?.away)); } else warn(`settle FD ${sp} HTTP`,r.status); }catch(e){ warn(`settle FD ${sp}`,e); }
    }
    for(const r of bySport[sp]){ const key=findPair(r.home,r.away,done); const sc=key? done[key] : null;
      // 10 gun sonra skor yok (ertelenen/iptal/eslesmeyen isim): void -> tuttu/tutmadi sayilmaz, settle/capture cron'larini surekli tetiklemez
      if(!sc){ if(ageDays(r.match_date)>10){ updates.push({id:r.id, result:"void"}); voided++; } continue; }
      if(sp===WORLD_CUP_SPORT) wcSettled[norm(sc.home)+"|"+norm(sc.away)]=sc;
      const dnbPush=String(r.market).startsWith("DNB")&&sc.hs===sc.as; // beraberlikte iade: para geri -> void
      const lr=lineResult(r.market,sc.hs,sc.as)||ahResult(r.market,sc.hs,sc.as); // basketbol alt/ust + handikap, futbol Asya handikabi
      updates.push({id:r.id, actual_score:sc.hs+"-"+sc.as, result: lr || (dnbPush? "void" : (evalMkt(r.market,sc.hs,sc.as)?"hit":"miss"))}); } }
  if(updates.length){ const {data,error:e2}=await sb().rpc("bahis_set_results",{p:updates}); if(e2) return {error:e2.message};
    const eloUpd=await applyEloUpdates(wcSettled);
    return {settled:data, voided, elo_updated:eloUpd}; }
  return {settled:0};
}catch(e){ return {error:String(e)}; } }

async function applyEloUpdates(wcSettled){
  const keys=Object.keys(wcSettled); if(!keys.length) return 0;
  const map=await getEloMap(); if(!map) return 0;
  const nameByNorm={};
  try{ const {data}=await sb().rpc("bahis_all_elo"); for(const r of (data||[])) nameByNorm[norm(r.team_name)]=r.team_name; }catch(e){ warn("applyEloUpdates names",e); return 0; }
  const out=[];
  for(const k of keys){ const sc=wcSettled[k];
    const hk=findKey(sc.home,map), ak=findKey(sc.away,map); if(hk==null||ak==null||hk===ak) continue;
    const eH=map[hk], eA=map[ak];
    const We=1/(Math.pow(10,-(eH-eA)/400)+1);
    const W=sc.hs>sc.as?1:(sc.hs===sc.as?0.5:0);
    const N=Math.abs(sc.hs-sc.as);
    const G=N<=1?1:(N===2?1.5:(11+N)/8);
    const delta=ELO_K_WC*G*(W-We);
    out.push({team:nameByNorm[hk]||sc.home, elo:+(eH+delta).toFixed(1)});
    out.push({team:nameByNorm[ak]||sc.away, elo:+(eA-delta).toFixed(1)});
  }
  if(!out.length) return 0;
  try{ const {data:n,error}=await sb().rpc("bahis_apply_elo_updates",{p:out}); if(error) throw error; return n||0; }catch(e){ warn("bahis_apply_elo_updates",e); return 0; }
}

// Odds API event'inde Pinnacle fiyati (h2h: 1/X/2, totals 2.5: O/U); yoksa null
function pinnacleOdds(ev,market){
  const bk=(ev.bookmakers||[]).find((b)=>b.key==="pinnacle"); if(!bk) return null;
  const find=(mk,pred)=>{ const m=(bk.markets||[]).find((x)=>x.key===mk); const o=m&&(m.outcomes||[]).find(pred); return (o&&o.price>1)? o.price : null; };
  if(market==="1") return find("h2h",(o)=>o.name===ev.home_team);
  if(market==="2") return find("h2h",(o)=>o.name===ev.away_team);
  if(market==="X") return find("h2h",(o)=>o.name==="Draw");
  if(market==="O") return find("totals",(o)=>o.name==="Over"&&Math.abs((o.point??99)-2.5)<0.01);
  if(market==="U") return find("totals",(o)=>o.name==="Under"&&Math.abs((o.point??99)-2.5)<0.01);
  return null;
}
// Pinnacle FAIR (marjsiz) fiyatlari: kendi pazarini Shin ile devig et. Fiyat-edge bunun uzerinden olculur;
// ham Pinnacle fiyatina gore olcum, marj (~%2-3) kadar sahte edge uretir (22 kitabin max'i her zaman gecer).
function pinnacleFair(ev){
  const out={}; const p={}; for(const m of ["1","X","2","O","U"]) p[m]=pinnacleOdds(ev,m);
  if(p["1"]&&p["2"]){ const raw=p["X"]? [1/p["1"],1/p["X"],1/p["2"]] : [1/p["1"],1/p["2"]]; const f=shinDevig(raw);
    out["1"]=1/f[0]; if(p["X"]){ out["X"]=1/f[1]; out["2"]=1/f[2]; } else out["2"]=1/f[1]; }
  if(p["O"]&&p["U"]){ const f=shinDevig([1/p["O"],1/p["U"]]); out["O"]=1/f[0]; out["U"]=1/f[1]; }
  return { raw:p, fair:out };
}
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
      try{ const oe=await fetchOddsEvents(sp); if(oe.error) continue; events=oe.events; }catch(e){ warn(`captureClosing odds ${sp}`,e); continue; }
      const evByKey={};
      for(const ev of events){ evByKey[norm(ev.home_team)+"|"+norm(ev.away_team)]=ev; }
      const updates=[];
      let ahByKey=null;
      for(const r of pend){
        if(/^AH[12]@/.test(r.market)){ // Asya handikabi kapanisi: spreads lig basina bir kez (1 kredi), yalniz ayni cizgi
          if(ahByKey===null){ ahByKey={}; try{ const rr=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=spreads&oddsFormat=decimal`);
            if(rr.ok) for(const e of ((await rr.json())||[])) ahByKey[norm(e.home_team)+"|"+norm(e.away_team)]=e; }catch(e){ warn("closing ah",e); } }
          const k2=findPair(r.home,r.away,ahByKey), e2=k2? ahByKey[k2] : null; if(!e2) continue;
          const mm=/^AH([12])@(.+)$/.exec(r.market), side=mm[1], hl= side==="1"? +mm[2] : -(+mm[2]); let pinF=null, bestC=null;
          for(const b of (e2.bookmakers||[])){ const m=(b.markets||[]).find((x)=>x.key==="spreads"); if(!m) continue;
            const h=m.outcomes.find((o)=>o.name===e2.home_team), a=m.outcomes.find((o)=>o.name===e2.away_team); if(!h||!a||h.point==null||Math.abs(h.point-hl)>1e-9||!(h.price>1&&a.price>1)) continue;
            const pr= side==="1"? h.price : a.price;
            if(b.key==="pinnacle") pinF=1/shinDevig([1/h.price,1/a.price])[side==="1"?0:1]; else if(!EXCHANGE_KEYS.test(b.key||"")&&pr>(bestC||0)) bestC=pr; }
          if(pinF||bestC) updates.push({ id:r.id, closing_odds:bestC, closing_pin:pinF? +pinF.toFixed(3) : null });
          continue; }
        const k=findPair(r.home,r.away,evByKey); const ev=k? evByKey[k] : null;
        if(!ev) continue;
        const pl=parseLine(r.market);
        if(pl&&isBasket(sp)){ const [key,side,L]=pl, {pin,q}=lineQuotes(ev,key,EXCHANGE_KEYS), s=(BASKET_SIGMA[sp]||{})[key];
          const same=q.filter((x)=>x[0]===side&&x[1]===L).map((x)=>x[2]); let cpin=null;
          if(pin&&s){ const [w,pu]=sideWP(side,L,fitMu(pin.L,pin.p,s),s); if(w>0) cpin=+((1-pu)/w).toFixed(3); }
          if(same.length||cpin) updates.push({ id:r.id, closing_odds:same.length? Math.max(...same) : null, closing_pin:cpin });
          continue; }
        const cons=buildConsensus(ev);
        let closing=null;
        if(r.market==="1"||r.market==="X"||r.market==="2"||r.market==="O"||r.market==="U") closing=cons.odds[r.market]||null;
        if(closing==null) continue;
        // Pinnacle FAIR (Shin devig) kapanisi: clv_pin_pct = alinan oran / adil kapanis - 1; pick kurali da ayni referansi kullanir.
        // Ham Pinnacle ile olcum marj (~%2-3) kadar sahte CLV veriyordu. Satirlar RPC ile yalniz mac oncesi 3 saat penceresinde gelir
        // ve mac baslayana kadar her saat uzerine yazilir (son yazim = kapanis).
        updates.push({ id:r.id, closing_odds:closing, closing_pin:(pinnacleFair(ev).fair||{})[r.market]||null });
      }
      if(updates.length){ const {data:n}=await sb().rpc("bahis_update_closing",{p:updates}); totalUpdated+=(n||0); details.push({sport:sp, updated:n||0}); }
    }
    return { updated: totalUpdated, details };
  }catch(e){ return {error:String(e)}; }
}

async function calibrate(){
  try{
    const {data:rows0,error}=await sb().rpc("bahis_settled_for_calibration",{lim:3000});
    if(error) return {error:error.message};
    const rows=(rows0||[]).filter((r)=>(r.result==="hit"||r.result==="miss")&&!isBasket(r.sport)&&r.family!=="ah");
    const n=rows.length;
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

    const buckets=[{lo:-1e9,hi:0,label:"<0%"},{lo:0,hi:5,label:"0-5%"},{lo:5,hi:10,label:"5-10%"},{lo:10,hi:15,label:"10-15%"},{lo:15,hi:1e9,label:"15%+"}];
    const bucketStats=buckets.map((b)=>({label:b.label,n:0,hitRate:0,avgModel:0}));
    for(const r of rows){
      if(r.edge_pct==null||r.model_prob==null) continue;
      const e=+r.edge_pct;
      const bi=buckets.findIndex((b)=>e>=b.lo&&e<b.hi); if(bi<0) continue;
      const bs=bucketStats[bi]; bs.n++; bs.hitRate += (r.result==="hit"?1:0); bs.avgModel += +r.model_prob;
    }
    for(const bs of bucketStats){ if(bs.n){ bs.hitRate=+(bs.hitRate/bs.n).toFixed(4); bs.avgModel=+(bs.avgModel/bs.n).toFixed(4); } }

    let newThreshold=paramsBefore.edge_threshold_base;
    const vHit=valueRows.length? avg(valueRows.map((r)=>r.result==="hit"?1:0)) : null;
    const vMkt=valueRows.length? avg(valueRows.filter((r)=>r.market_prob!=null).map((r)=>+r.market_prob)) : null;
    // A4 (2026-09-10): esik ayari icin >=50 ornek; eski 15/10 esikleri 13-22 bahislik gurultuye tepki veriyordu
    const CAL_MIN=50;
    let thresholdNote=`not enough value-flagged samples to adjust threshold (need ${CAL_MIN})`;
    if(valueRows.length>=CAL_MIN && vHit!=null && vMkt!=null){
      if(vHit>vMkt+0.02){ newThreshold=Math.max(THR_BASE_MIN, paramsBefore.edge_threshold_base-0.3); thresholdNote=`value picks beat market (${(vHit*100).toFixed(1)}% hit vs ${(vMkt*100).toFixed(1)}% implied) -> lowering threshold slightly`; }
      else { newThreshold=Math.min(15, paramsBefore.edge_threshold_base+0.5); thresholdNote=`value picks did not clear their own market-implied rate (${(vHit*100).toFixed(1)}% hit vs ${(vMkt*100).toFixed(1)}% implied) -> raising threshold`; }
    }
    // Bilincli: CLV >=10 satir varsa yukaridaki hit-rate karari EZILIR - CLV kucuk orneklemde
    // hit-rate'ten daha guvenilir sinyal. Iki sinyali birlestirmek istenirse burasi degisir.
    // A3+A4: yalniz Pinnacle kapanisina gore CLV (clv_pin_pct); max-oran CLV'si (clv_pct) karar icin kullanilmaz
    const clvRows=valueRows.filter((r)=>r.clv_pin_pct!=null);
    if(clvRows.length>=CAL_MIN){
      const avgClv=avg(clvRows.map((r)=>+r.clv_pin_pct));
      if(avgClv>1){ newThreshold=Math.max(THR_BASE_MIN, paramsBefore.edge_threshold_base-0.3); thresholdNote=`CLV +${avgClv.toFixed(2)}% over ${clvRows.length} value picks -> lowering threshold`; }
      else if(avgClv<0){ newThreshold=Math.min(15, paramsBefore.edge_threshold_base+0.5); thresholdNote=`CLV ${avgClv.toFixed(2)}% negative over ${clvRows.length} picks -> raising threshold`; }
      else { newThreshold=paramsBefore.edge_threshold_base; thresholdNote=`CLV ${avgClv.toFixed(2)}% neutral over ${clvRows.length} picks -> threshold kept`; }
    }

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

    const {error:se}=await sb().rpc("bahis_save_params",{p:{ rho:newRho, edge_threshold_base:+newThreshold.toFixed(2), notes:`auto-calibrated ${new Date().toISOString()} | n=${n} | ${thresholdNote} | ${rhoNote}` }});
    if(se) return {error:"bahis_save_params: "+se.message};
    const paramsAfter=await getParams();
    const {error:le}=await sb().rpc("bahis_log_calibration",{p:{ sample_size:n, brier_score:brier, bucket_stats:bucketStats, params_before:paramsBefore, params_after:paramsAfter, notes:`${thresholdNote} || ${rhoNote}` }});
    if(le) warn("bahis_log_calibration",le);
    return { sample_size:n, brier_score:brier, bucket_stats:bucketStats, params_before:paramsBefore, params_after:paramsAfter, threshold_note:thresholdNote, rho_note:rhoNote };
  }catch(e){ return {error:String(e)}; }
}

// ---------- v10: walk-forward backtest over football-data.co.uk archives ----------
async function backtest(body){
  const sport=body.sport||"soccer_epl"; const code=CSV_COMP[sport]||(/^[A-Z]{1,2}\d?$/.test(String(body.code||""))? String(body.code) : null); if(!code) return {error:"csv kodu yok"}; // body.code: henuz eklenmemis aday ligler
  const seasons=(Array.isArray(body.seasons)? body.seasons : ["2223","2324","2425","2526","2627"]).filter((s)=>/^\d{4}$/.test(String(s))).slice(0,8);
  if(!seasons.length) return {error:"seasons: 'YYYY' bicimi (orn. 2425), en fazla 8"};
  const cfgIn={}; for(const k of ["sotW","formW","hl","thr","x12s","rho","ouShrink","pinMin","pinMax","maxOdds"]){ const v=+(body.cfg||{})[k]; if(isFinite(v)) cfgIn[k]=v; }
  const cfg={ sotW:SOT_W, formW:FORM_TOTAL_W, hl:45, thr:9.86, x12s:X12_PROB_SHRINK, rho:-0.12, ouShrink:GOAL_PROB_SHRINK, pinMin:PIN_EDGE_MIN_PCT, pinMax:PIN_EDGE_MAX_PCT, maxOdds:PIN_MAX_ODDS, ...cfgIn }; // maxOdds 0 = sinirsiz
  const raw=[]; const cols={ pinnacle_closing:false, pinnacle_ou_closing:false, max_ou:false }; const refN={ mac_oncesi:{}, kapanis:{} };
  for(const s of seasons){ try{
    const r=await fetch(`https://www.football-data.co.uk/mmz4281/${s}/${code}.csv`); if(!r.ok) continue;
    const lines=(await r.text()).replace(/^\uFEFF/,"").split(/\r?\n/);
    const H=lines[0].split(",").map((x)=>x.trim()); const ix=(n)=>H.indexOf(n);
    const pick2=(a,b)=>{ const i=ix(a); return i>=0? i : ix(b); };
    // PSC*/PC>2.5 = Pinnacle KAPANIS (2019/20+); yoksa PS*/P>2.5 (Pinnacle acilis) ile yetin ve bayrakla
    const c={ d:ix("Date"),h:ix("HomeTeam"),a:ix("AwayTeam"),gh:ix("FTHG"),ga:ix("FTAG"),sh:ix("HST"),sa:ix("AST"),
      ah:pick2("AvgH","B365H"), ad:pick2("AvgD","B365D"), aa:pick2("AvgA","B365A"),
      mh:pick2("MaxH","B365H"), md:pick2("MaxD","B365D"), ma:pick2("MaxA","B365A"),
      po:pick2("Avg>2.5","B365>2.5"), pu:pick2("Avg<2.5","B365<2.5"),
      xo:pick2("Max>2.5","B365>2.5"), xu:pick2("Max<2.5","B365<2.5"),
      // Referans gruplari (sira = oncelik), SATIR bazinda secilir: football-data Pinnacle sutunlarini 2025/26 ortasinda birakti
      // (sutun var ama bos), 2026/27'de hic yok -> Betfair borsa (BFE) yedegi. Pinnacle'li satirlarda davranis ayni.
      cl1:[["PSCH","PSCD","PSCA"],["PSH","PSD","PSA"],["BFECH","BFECD","BFECA"],["BFEH","BFED","BFEA"]].map((g)=>g.map(ix)),
      clOU:[["PC>2.5","PC<2.5"],["P>2.5","P<2.5"],["BFEC>2.5","BFEC<2.5"],["BFE>2.5","BFE<2.5"]].map((g)=>g.map(ix)),
      pre1:[["PSH","PSD","PSA"],["BFEH","BFED","BFEA"]].map((g)=>g.map(ix)),
      preOU:[["P>2.5","P<2.5"],["BFE>2.5","BFE<2.5"]].map((g)=>g.map(ix)),
    };
    if(ix("PSCH")>=0) cols.pinnacle_closing=true; if(ix("PC>2.5")>=0) cols.pinnacle_ou_closing=true; if(ix("Max>2.5")>=0) cols.max_ou=true;
    if(c.d<0||c.h<0||c.gh<0) continue;
    const num=(i,L)=> (i>=0 && L[i]!==""&&L[i]!=null)? (+L[i]||null) : null;
    const grp=(gs,L)=>{ for(let k=0;k<gs.length;k++){ const v=gs[k].map((i)=>num(i,L)); if(v.every((x)=>x)) return {v,k}; } return {v:gs[0].map(()=>null),k:-1}; };
    for(let i=1;i<lines.length;i++){ const L=lines[i].split(","); if(L.length<6) continue;
      const dm=(L[c.d]||"").split("/"); if(dm.length!==3) continue; let yy=+dm[2]; if(yy<100)yy+=2000;
      const t=Date.UTC(yy,+dm[1]-1,+dm[0],15);
      const gh=+L[c.gh], ga=+L[c.ga]; if(isNaN(gh)||isNaN(ga)) continue;
      raw.push({ t, h:(L[c.h]||"").trim(), a:(L[c.a]||"").trim(), gh, ga,
        sh:(c.sh>=0&&L[c.sh]!=="")?+L[c.sh]:null, sa:(c.sa>=0&&L[c.sa]!=="")?+L[c.sa]:null,
        oh:num(c.ah,L), od:num(c.ad,L), oa:num(c.aa,L),
        xh:num(c.mh,L), xd:num(c.md,L), xa:num(c.ma,L),
        po:num(c.po,L), pu:num(c.pu,L), xo:num(c.xo,L), xu:num(c.xu,L),
        ...(()=>{ const C1=grp(c.cl1,L), CO=grp(c.clOU,L), P1=grp(c.pre1,L), PO=grp(c.preOU,L);
          const t1=["pin","bfe"][P1.k]||"yok", t2=["pin","pin_acilis","bfe","bfe_acilis"][C1.k]||"yok";
          refN.mac_oncesi[t1]=(refN.mac_oncesi[t1]||0)+1; refN.kapanis[t2]=(refN.kapanis[t2]||0)+1;
          return { ref1:t1, ch:C1.v[0], cd:C1.v[1], ca:C1.v[2], co:CO.v[0], cu:CO.v[1], ph:P1.v[0], pd:P1.v[1], pa:P1.v[2], po2:PO.v[0], pu2:PO.v[1] }; })() });
    }
  }catch(e){ warn(`backtest csv ${code}/${s}`,e); }}
  raw.sort((x,y)=>x.t-y.t);
  if(raw.length<300) return { error:"yetersiz veri", n:raw.length };
  let g=0,s2=0; for(const r of raw){ if(r.sh!=null&&r.sa!=null){ g+=r.gh+r.ga; s2+=r.sh+r.sa; } }
  const conv=(s2>50)? g/s2 : 0.30;
  const alias=(n)=>{ const x=norm(n); return CSV_ALIAS[x]||x; };
  const fitUpTo=(idx,nowT)=>{
    const ms=raw.slice(0,idx).map(r=>({ status:"FINISHED", utcDate:new Date(r.t).toISOString(),
      homeTeam:{name:alias(r.h)}, awayTeam:{name:alias(r.a)},
      score:{fullTime:{ home:r.sh!=null?(1-cfg.sotW)*r.gh+cfg.sotW*conv*r.sh:r.gh,
                        away:r.sa!=null?(1-cfg.sotW)*r.ga+cfg.sotW*conv*r.sa:r.ga }} }));
    return buildRecencyForm(ms,cfg.hl,new Date(nowT));
  };
  // perf: one-time mu lookup table (pOver -> total goals) instead of per-match grid solve
  const muTab=[]; for(let m2=1.6;m2<=4.201;m2+=0.05){ muTab.push({mu:m2, pO:probsLite(m2/2,m2/2,cfg.rho).o}); }
  const muFromPO=(pO)=>{ let b=muTab[0]; for(const e of muTab){ if(Math.abs(e.pO-pO)<Math.abs(b.pO-pO)) b=e; } return b.mu; };
  const warm=Math.min(150,Math.floor(raw.length/4));
  const REFIT_MS=6.5*86400000; // weekly refits - ratings drift slowly
  let S=null,lastFit=-1;
  let bets=0,hits=0,flat=0,kellyBank=1,brK=0,brM=0,rpsK=0,rpsM=0,nn=0,xBets=0,xHits=0,xFlat=0,edgeSum=0;
  // A1: CLV vs Pinnacle kapanisi (alinan oran / kapanis - 1); max oranla ve ortalama oranla ayri ayri
  const clv={ n:0, sumMax:0, sumAvg:0, posMax:0 };
  // A2: Ust/Alt 2.5 pazari - ayni walk-forward, model=probsLite().o, piyasa=devig(Avg>2.5,Avg<2.5)
  const ou={ n:0, bets:0, hits:0, flat:0, brK:0, brM:0, clvN:0, clvSum:0, clvSumAvg:0, clvPos:0 }; const RO=[];
  // Fiyat-edge kurali: max oran / Pinnacle mac-oncesi - 1 >= pinMin VE model karsi cikmiyor (edge>=0); CLV = max / Pinnacle KAPANIS - 1
  const pr={ bets:0, hits:0, flat:0, clvN:0, clvSum:0, clvPos:0, ouBets:0, ouHits:0, ouFlat:0, ouClvN:0, ouClvSum:0, ouClvPos:0, bins:{} };
  // Oran ust siniri karari icin: 1x2 fiyat-edge bahisleri oran aralig(bin)ina gore ayri toplanir (kumulatif okunarak her cap turetilir)
  const ODDS_BINS=[[2,"<=2"],[3,"2-3"],[4,"3-4"],[6,"4-6"],[10,"6-10"],[1e9,">10"]];
  const prBet=(won,odds,pc,isOU)=>{ const B=isOU?"ouBets":"bets", H=isOU?"ouHits":"hits", F=isOU?"ouFlat":"flat", N=isOU?"ouClvN":"clvN", S=isOU?"ouClvSum":"clvSum", P=isOU?"ouClvPos":"clvPos";
    pr[B]++; if(won) pr[H]++; pr[F]+= won? odds-1 : -1; if(pc&&pc>1){ pr[N]++; const c=odds/pc-1; pr[S]+=c; if(c>0) pr[P]++; }
    if(!isOU){ const bn=ODDS_BINS.find((x)=>odds<=x[0])[1]; const b=pr.bins[bn]||(pr.bins[bn]={bets:0,hits:0,flat:0,clvN:0,clvSum:0}); b.bets++; if(won) b.hits++; b.flat+= won? odds-1 : -1; if(pc&&pc>1){ b.clvN++; b.clvSum+=odds/pc-1; } } };
  const R=[]; // raw walk-forward (model,market,outcome) rows for fit_blend stacking
  // Tani (2026-09-27): 1X2 fiyat-edge bahisleri referans kaynagina gore (pin / bfe) + body.debug_bets ile bahis listesi
  const byRef={}; const betList=[];
  // 2026-09-27 ek pazarlar. Cifte sans ve beraberlikte iade (DNB) 1X2 fiyatlarindan BIREBIR kurulabilir (dutching):
  // DC 1X fiyati = 1/(1/o1+1/oX); DNB ev fiyati = o1*(oX-1)/oX. Boylece CSV'deki Max/Pinnacle oranlariyla gercek backtest yapilir.
  // Ust 1,5 ve KG icin CSV'de oran yok -> yalniz kalibrasyon (tahmin edilen olasilik vs gerceklesen).
  const xp={ dc:{bets:0,hits:0,flat:0,clvN:0,clvSum:0,bins:{}}, dnb:{bets:0,hits:0,push:0,flat:0,clvN:0,clvSum:0,bins:{}} };
  const XB=[[1.3,"<=1.3"],[1.5,"1.3-1.5"],[1.8,"1.5-1.8"],[2.2,"1.8-2.2"],[1e9,">2.2"]];
  const xbin=(t,odds,pl,won)=>{ const k=XB.find((x)=>odds<=x[0])[1]; const b=t.bins[k]||(t.bins[k]={bets:0,hits:0,flat:0}); b.bets++; if(won) b.hits++; b.flat+=pl; };
  const CAL=[[0.5,"<50"],[0.6,"50-60"],[0.7,"60-70"],[0.8,"70-80"],[0.9,"80-90"],[1.01,"90+"]];
  const cal={ o15:{model:{},market:{}}, btts:{model:{}}, base:{n:0,o15:0,btts:0} };
  const calAdd=(t,p,y)=>{ const k=CAL.find((x)=>p<x[0])[1]; const b=t[k]||(t[k]={n:0,sumP:0,hits:0}); b.n++; b.sumP+=p; b.hits+=y; };
  for(let i=warm;i<raw.length;i++){ const r=raw[i];
    if(!r.oh||!r.od||!r.oa) continue;
    if(!S || r.t-lastFit>REFIT_MS){ S=fitUpTo(i,r.t); lastFit=r.t; }
    if(!S) continue;
    const s0=1/r.oh+1/r.od+1/r.oa, mH=(1/r.oh)/s0, mD=(1/r.od)/s0, mA=(1/r.oa)/s0;
    let mu=null;
    if(r.po&&r.pu){ mu=muFromPO((1/r.po)/((1/r.po)+(1/r.pu))); }
    const hk=findKey(alias(r.h),S.att), ak=findKey(alias(r.a),S.att);
    if(!hk||!ak||(S.wSum[hk]||0)<1||(S.wSum[ak]||0)<1) continue;
    let lh=S.muH*S.att[hk]*S.def[ak]*((S.hAdv&&S.hAdv[hk])||1), la=S.muA*S.att[ak]*S.def[hk];
    let d=lh-la + restAdj(S.lastMatch[hk],S.lastMatch[ak],r.t);
    const T0=(mu!=null)? cfg.formW*(lh+la)+(1-cfg.formW)*mu : lh+la;
    lh=Math.min(4.5,Math.max(0.15,(T0+d)/2)); la=Math.min(4.5,Math.max(0.15,(T0-d)/2));
    const pm=probsLite(lh,la,cfg.rho);
    const k1=mH+cfg.x12s*(pm.p1-mH), kX=mD+cfg.x12s*(pm.px-mD), k2=mA+cfg.x12s*(pm.p2-mA);
    const o=(r.gh>r.ga)?0:(r.gh===r.ga?1:2);
    const pv=[k1,kX,k2], mv=[mH,mD,mA]; nn++;
    R.push({p1:pm.p1,px:pm.px,p2:pm.p2,mH,mD,mA,o});
    for(let j=0;j<3;j++){ brK+=Math.pow(pv[j]-(o===j?1:0),2)/3; brM+=Math.pow(mv[j]-(o===j?1:0),2)/3; }
    let cK=0,cM=0,cO=0;
    for(let j=0;j<3;j++){ cK+=pv[j]; cM+=mv[j]; cO+=(o===j?1:0); rpsK+=Math.pow(cK-cO,2)/2; rpsM+=Math.pow(cM-cO,2)/2; }
    const cand=[[k1-mH,r.xh,o===0,k1,"1"],[kX-mD,r.xd,o===1,kX,"X"],[k2-mA,r.xa,o===2,k2,"2"]];
    let bestE=null; for(const e of cand){ if(e[0]*100>=cfg.thr && e[1]&&e[1]>1 && (!bestE||e[0]>bestE[0])) bestE=e; }
    if(bestE){ bets++; edgeSum+=bestE[0]; const won=bestE[2];
      if(won) hits++;
      flat += won? bestE[1]-1 : -1;
      const kf=Math.max(0,Math.min(0.05,KELLY_FRACTION*((bestE[3]*bestE[1]-1)/(bestE[1]-1))));
      kellyBank *= won? (1+kf*(bestE[1]-1)) : (1-kf);
      if(bestE[4]==="X"){ xBets++; if(won)xHits++; xFlat += won? bestE[1]-1 : -1; }
      const ci={"1":0,"X":1,"2":2}[bestE[4]]; const pc=[r.ch,r.cd,r.ca][ci], av=[r.oh,r.od,r.oa][ci];
      if(pc&&pc>1){ clv.n++; const cm=bestE[1]/pc-1; clv.sumMax+=cm; if(cm>0) clv.posMax++; if(av&&av>1) clv.sumAvg+=av/pc-1; }
    }
    // ---- Fiyat-edge kurali (1x2): referans Pinnacle FAIR (PSH/PSD/PSA Shin-devig); aday = pinEdge en yuksek, tek bahis/mac ----
    { let bestP=null;
      let pins=[null,null,null];
      if(r.ph>1&&r.pd>1&&r.pa>1){ const f=shinDevig([1/r.ph,1/r.pd,1/r.pa]); pins=[1/f[0],1/f[1],1/f[2]]; }
      const maxs=[r.xh,r.xd,r.xa], ks=[k1-mH,kX-mD,k2-mA], pcs=[r.ch,r.cd,r.ca];
      for(let j=0;j<3;j++){ if(!pins[j]||pins[j]<=1||!maxs[j]||maxs[j]<=1) continue; const pe=maxs[j]/pins[j]-1;
        if(pe*100>=cfg.pinMin && pe*100<=cfg.pinMax && ks[j]>=0 && (!(cfg.maxOdds>0)||maxs[j]<=cfg.maxOdds) && (!bestP||pe>bestP.pe)) bestP={pe,j}; }
      if(bestP){ prBet(o===bestP.j, maxs[bestP.j], pcs[bestP.j], false);
        const won=o===bestP.j, od=maxs[bestP.j], rb=byRef[r.ref1]||(byRef[r.ref1]={bets:0,hits:0,flat:0,clvN:0,clvSum:0}); rb.bets++; if(won) rb.hits++; rb.flat+= won? od-1 : -1;
        const pc=pcs[bestP.j]; if(pc&&pc>1){ rb.clvN++; rb.clvSum+=od/pc-1; }
        if(body.debug_bets) betList.push({ d:new Date(r.t).toISOString().slice(0,10), h:r.h, a:r.a, pick:["1","X","2"][bestP.j], odds:od, fair:+pins[bestP.j].toFixed(3), edge:+(bestP.pe*100).toFixed(2), close:pc||null, score:r.gh+"-"+r.ga, won, ref:r.ref1 }); }
      // ---- Cifte sans (1X, X2, 12) ve DNB: referans Pinnacle adil, fiyat = Max oranlarla dutching, tek bahis/mac ----
      if(pins[0]&&r.xh>1&&r.xd>1&&r.xa>1){
        const fp=[1/pins[0],1/pins[1],1/pins[2]]; const kk=[k1,kX,k2], mm=[mH,mD,mA];
        let cf=null; if(r.ch>1&&r.cd>1&&r.ca>1){ const f=shinDevig([1/r.ch,1/r.cd,1/r.ca]); cf=f; }
        const dutch=(a,b)=>1/(1/a+1/b);
        const DC=[[0,1],[1,2],[0,2]]; let bd=null;
        for(const [a,b] of DC){ const price=dutch(maxs[a],maxs[b]); const pf=fp[a]+fp[b]; const pe=price*pf-1;
          if(price<=cfg.maxOdds && pe*100>=cfg.pinMin && pe*100<=cfg.pinMax && (kk[a]+kk[b])>=(mm[a]+mm[b]) && (!bd||pe>bd.pe)) bd={pe,price,a,b}; }
        if(bd){ const won=(o===bd.a||o===bd.b); const pl=won? bd.price-1 : -1; xp.dc.bets++; if(won) xp.dc.hits++; xp.dc.flat+=pl; xbin(xp.dc,bd.price,pl,won);
          if(cf){ xp.dc.clvN++; xp.dc.clvSum+=bd.price*(cf[bd.a]+cf[bd.b])-1; } }
        let bn=null;
        for(const j of [0,2]){ const price=maxs[j]*(maxs[1]-1)/maxs[1]; const q=2-j; const pf=fp[j]/(fp[j]+fp[q]); const pe=price*pf-1;
          if(price<=cfg.maxOdds && pe*100>=cfg.pinMin && pe*100<=cfg.pinMax && kk[j]/(kk[j]+kk[q])>=mm[j]/(mm[j]+mm[q]) && (!bn||pe>bn.pe)) bn={pe,price,j,q}; }
        if(bn){ const push=(o===1), won=(o===bn.j); const pl=push? 0 : (won? bn.price-1 : -1); xp.dnb.bets++; if(won) xp.dnb.hits++; if(push) xp.dnb.push++; xp.dnb.flat+=pl; xbin(xp.dnb,bn.price,pl,won);
          if(cf&&!push){ xp.dnb.clvN++; xp.dnb.clvSum+=bn.price*(cf[bn.j]/(cf[bn.j]+cf[bn.q]))-1; } }
      } }
    // ---- Ust 1,5 / KG kalibrasyonu (oran yok): model = form+piyasa lambdalari; piyasa = O2.5 ortalama oranindan Poisson toplam ----
    { const g=r.gh+r.ga; const y15=g>=2?1:0, yb=(r.gh>=1&&r.ga>=1)?1:0;
      const e1=Math.exp(-lh), e2=Math.exp(-la), eT=Math.exp(-(lh+la));
      const pO15=1-eT*(1+lh+la), pB=(1-e1)*(1-e2);
      calAdd(cal.o15.model,pO15,y15); calAdd(cal.btts.model,pB,yb);
      if(mu!=null){ const pm15=1-Math.exp(-mu)*(1+mu); calAdd(cal.o15.market,pm15,y15); }
      cal.base.n++; cal.base.o15+=y15; cal.base.btts+=yb; }
    // ---- Ust/Alt 2.5 ----
    if(r.po&&r.pu&&r.po>1&&r.pu>1){
      const mO=(1/r.po)/((1/r.po)+(1/r.pu)); const kO=mO+cfg.ouShrink*(pm.o-mO); const over=(r.gh+r.ga)>2.5;
      // fiyat-edge (O/U): referans Pinnacle FAIR (P>2.5/P<2.5 devig)
      if(r.po2&&r.po2>1&&r.xo&&r.xo>1&&r.pu2&&r.pu2>1&&r.xu&&r.xu>1){
        const fo=shinDevig([1/r.po2,1/r.pu2]); const fairO=1/fo[0], fairU=1/fo[1];
        const peO=r.xo/fairO-1, peU=r.xu/fairU-1; const eOraw=kO-mO;
        if(peO*100>=cfg.pinMin && eOraw>=0 && peO>=peU) prBet(over, r.xo, r.co, true);
        else if(peU*100>=cfg.pinMin && eOraw<=0) prBet(!over, r.xu, r.cu, true);
      }
      ou.n++; ou.brK+=Math.pow(kO-(over?1:0),2); ou.brM+=Math.pow(mO-(over?1:0),2); RO.push({p:pm.o,m:mO,o:over?1:0});
      const eO=kO-mO; let side=null;
      if(eO*100>=cfg.thr && r.xo&&r.xo>1) side={won:over, odds:r.xo, avg:r.po, pc:r.co};
      else if(-eO*100>=cfg.thr && r.xu&&r.xu>1) side={won:!over, odds:r.xu, avg:r.pu, pc:r.cu};
      if(side){ ou.bets++; if(side.won) ou.hits++; ou.flat+= side.won? side.odds-1 : -1;
        if(side.pc&&side.pc>1){ ou.clvN++; const c2=side.odds/side.pc-1; ou.clvSum+=c2; if(c2>0) ou.clvPos++; if(side.avg&&side.avg>1) ou.clvSumAvg+=side.avg/side.pc-1; } }
    }
  }
  const out={ sport, seasons, cfg, n_matches:nn, bets,
    hit_rate: bets? +(hits/bets).toFixed(3):null,
    avg_edge_pct: bets? +(100*edgeSum/bets).toFixed(1):null,
    flat_roi_pct: bets? +(100*flat/bets).toFixed(1):null,
    kelly_growth: +kellyBank.toFixed(3),
    brier_model:+(brK/nn).toFixed(4), brier_market:+(brM/nn).toFixed(4),
    rps_model:+(rpsK/nn).toFixed(4), rps_market:+(rpsM/nn).toFixed(4),
    draw:{bets:xBets, hits:xHits, flat_roi:xBets? +(100*xFlat/xBets).toFixed(1):null},
    cols:{ ...cols, referans:refN },
    price_rule: { pin_min_pct:cfg.pinMin, pin_max_pct:cfg.pinMax, max_odds:cfg.maxOdds||null,
      x12_by_ref: Object.fromEntries(Object.entries(byRef).map(([k,b])=>[k,{ bets:b.bets, hit_rate:+(b.hits/b.bets).toFixed(3), flat_roi_pct:+(100*b.flat/b.bets).toFixed(1), clv_close_avg_pct:b.clvN? +(100*b.clvSum/b.clvN).toFixed(2):null }])),
      bets_list: body.debug_bets? betList : undefined,
      x12_by_odds: Object.fromEntries(ODDS_BINS.map((x)=>x[1]).filter((k)=>pr.bins[k]).map((k)=>{ const b=pr.bins[k]; return [k,{ bets:b.bets, hit_rate:+(b.hits/b.bets).toFixed(3), flat_roi_pct:+(100*b.flat/b.bets).toFixed(1), clv_close_avg_pct:b.clvN? +(100*b.clvSum/b.clvN).toFixed(2):null }]; })),
      x12:{ bets:pr.bets, hit_rate:pr.bets? +(pr.hits/pr.bets).toFixed(3):null, flat_roi_pct:pr.bets? +(100*pr.flat/pr.bets).toFixed(1):null, clv_close_n:pr.clvN, clv_close_avg_pct:pr.clvN? +(100*pr.clvSum/pr.clvN).toFixed(2):null, clv_pos_rate:pr.clvN? +(pr.clvPos/pr.clvN).toFixed(3):null },
      ou:{ bets:pr.ouBets, hit_rate:pr.ouBets? +(pr.ouHits/pr.ouBets).toFixed(3):null, flat_roi_pct:pr.ouBets? +(100*pr.ouFlat/pr.ouBets).toFixed(1):null, clv_close_n:pr.ouClvN, clv_close_avg_pct:pr.ouClvN? +(100*pr.ouClvSum/pr.ouClvN).toFixed(2):null, clv_pos_rate:pr.ouClvN? +(pr.ouClvPos/pr.ouClvN).toFixed(3):null } },
    extra_markets: (()=>{ const f=(t)=>({ bets:t.bets, hit_rate:t.bets? +(t.hits/t.bets).toFixed(3):null, push:t.push, flat_roi_pct:t.bets? +(100*t.flat/t.bets).toFixed(1):null, clv_close_avg_pct:t.clvN? +(100*t.clvSum/t.clvN).toFixed(2):null,
        by_odds:Object.fromEntries(XB.map((x)=>x[1]).filter((k)=>t.bins[k]).map((k)=>{ const b=t.bins[k]; return [k,{bets:b.bets,hit_rate:+(b.hits/b.bets).toFixed(3),flat_roi_pct:+(100*b.flat/b.bets).toFixed(1)}]; })) });
      const c=(t)=>Object.fromEntries(CAL.map((x)=>x[1]).filter((k)=>t[k]).map((k)=>{ const b=t[k]; return [k,{n:b.n,pred:+(b.sumP/b.n).toFixed(3),hit:+(b.hits/b.n).toFixed(3)}]; }));
      return { double_chance:f(xp.dc), draw_no_bet:f(xp.dnb),
        o15_calibration:{ base_rate:cal.base.n? +(cal.base.o15/cal.base.n).toFixed(3):null, model:c(cal.o15.model), market_poisson:c(cal.o15.market) },
        btts_calibration:{ base_rate:cal.base.n? +(cal.base.btts/cal.base.n).toFixed(3):null, model:c(cal.btts.model) } }; })(),
    clv_pinnacle: clv.n? { n:clv.n, avg_pct_max_odds:+(100*clv.sumMax/clv.n).toFixed(2), avg_pct_avg_odds:+(100*clv.sumAvg/clv.n).toFixed(2), pos_rate_max_odds:+(clv.posMax/clv.n).toFixed(3) } : null,
    ou: ou.n? { n:ou.n, bets:ou.bets, hit_rate:ou.bets? +(ou.hits/ou.bets).toFixed(3):null, flat_roi_pct:ou.bets? +(100*ou.flat/ou.bets).toFixed(1):null,
      brier_model:+(ou.brK/ou.n).toFixed(4), brier_market:+(ou.brM/ou.n).toFixed(4),
      clv_pinnacle: ou.clvN? { n:ou.clvN, avg_pct_max_odds:+(100*ou.clvSum/ou.clvN).toFixed(2), avg_pct_avg_odds:+(100*ou.clvSumAvg/ou.clvN).toFixed(2), pos_rate:+(ou.clvPos/ou.clvN).toFixed(3) } : null } : null };
  // v10.2 stacking: learn blend weight w (p = market + w*(model-market)) by out-of-sample log-loss
  if(body.fit_blend){
    const LL=(w)=>{ let s=0; for(const r of R){ const pp=[r.mH+w*(r.p1-r.mH), r.mD+w*(r.px-r.mD), r.mA+w*(r.p2-r.mA)][r.o]; s+=-Math.log(Math.max(1e-9,pp)); } return s/Math.max(1,R.length); };
    let wBest=0,best=1e9; const curve=[];
    for(let w=0;w<=1.201;w+=0.05){ const l=LL(w); curve.push({w:+w.toFixed(2),ll:+l.toFixed(5)}); if(l<best-1e-12){ best=l; wBest=+w.toFixed(2); } }
    out.blend={ w_best:wBest, ll_market:+LL(0).toFixed(5), ll_w085:+LL(0.85).toFixed(5), ll_best:+best.toFixed(5), n:R.length };
    if(body.curve) out.blend.curve=curve;
    if(RO.length){ // Ust/Alt icin ayni stacking (ikili log-loss)
      const LLO=(w)=>{ let s=0; for(const r of RO){ const p=Math.min(1-1e-9,Math.max(1e-9,r.m+w*(r.p-r.m))); s+=-(r.o? Math.log(p) : Math.log(1-p)); } return s/RO.length; };
      let wb=0,bb=1e9; for(let w=0;w<=1.201;w+=0.05){ const l=LLO(w); if(l<bb-1e-12){ bb=l; wb=+w.toFixed(2); } }
      out.ou.blend={ w_best:wb, ll_market:+LLO(0).toFixed(5), ll_w06:+LLO(0.6).toFixed(5), ll_best:+bb.toFixed(5), n:RO.length };
    }
  }
  if(body.skip_rho) return out;
  const Sf=fitUpTo(raw.length, raw[raw.length-1].t+86400000);
  let rhoBest=cfg.rho, ll0=-Infinity;
  for(let cnd=-0.30; cnd<=0.101; cnd+=0.04){ let ll=0;
    for(const r of raw){ const hk=findKey(alias(r.h),Sf.att), ak=findKey(alias(r.a),Sf.att); if(!hk||!ak) continue;
      const lh2=Math.min(4.5,Sf.muH*Sf.att[hk]*Sf.def[ak]), la2=Math.min(4.5,Sf.muA*Sf.att[ak]*Sf.def[hk]);
      const p=probsLite(lh2,la2,cnd); const oo=(r.gh>r.ga)?"p1":(r.gh===r.ga?"px":"p2");
      ll += Math.log(Math.max(1e-9,p[oo])); }
    if(ll>ll0){ ll0=ll; rhoBest=+cnd.toFixed(2); } }
  out.rho_mle=rhoBest;
  return out;
}

// v10.4: sunucu tarafinda gunluk fis kaydi - site acilmasa da ogrenme dongusu veri alir
// ---- Telegram bildirimi (2026-09-28): autosave'in bu calismada ekledigi deger secimleri tek mesajda (bot + sohbet kimligi
// bahis_tahmin.settings'te, REST'e kapali). Bildirim hatasi kaydi etkilemez.
const LG_TR={ soccer_epl:"Premier Lig", soccer_spain_la_liga:"La Liga", soccer_italy_serie_a:"Serie A", soccer_germany_bundesliga:"Bundesliga",
  soccer_france_ligue_one:"Ligue 1", soccer_turkey_super_league:"Süper Lig", soccer_uefa_champs_league:"Şampiyonlar Ligi", soccer_italy_serie_b:"Serie B",
  soccer_efl_champ:"Championship", soccer_portugal_primeira_liga:"Portekiz", soccer_spl:"İskoçya", basketball_nba:"🏀 NBA", basketball_euroleague:"🏀 Euroleague" };
function mktLabel(c){ let m=/^AH([12])@(.+)$/.exec(c||""); if(m) return "Asya Hnd. "+m[1]+" ("+m[2]+")";
  m=/^([OU])@(.+)$/.exec(c||""); if(m) return (m[1]==="O"?"Üst ":"Alt ")+m[2];
  m=/^H([12])@(.+)$/.exec(c||""); if(m) return "Hnd. MS "+m[1]+" ("+m[2]+")"; return MKN[c]||XMKN[c]||c; }
async function getSetting(k){ try{ const {data,error}=await sb().rpc("bahis_get_setting",{k}); if(error) throw error; return data||null; }catch(e){ warn("setting "+k,e); return null; } }
async function sendTelegram(text){
  const tok=await getSetting("telegram_bot_token"), chat=await getSetting("telegram_chat_id"); if(!tok||!chat) return { sent:0, reason:"ayar yok" };
  const parts=[]; let cur=""; for(const ln of text.split("\n")){ if((cur+ln).length>3800){ parts.push(cur); cur=""; } cur+=ln+"\n"; } if(cur.trim()) parts.push(cur);
  let sent=0; for(const t of parts){ try{ const r=await fetch(`https://api.telegram.org/bot${tok}/sendMessage`,{ method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ chat_id:chat, text:t, disable_web_page_preview:true }) }); if(r.ok) sent++; else warn("telegram HTTP",r.status); }catch(e){ warn("telegram",e); } }
  return { sent }; }
const trTime=(iso)=>{ try{ return new Date(iso).toLocaleString("tr-TR",{ timeZone:"Europe/Istanbul", weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" }); }catch(_){ return String(iso).slice(0,16).replace("T"," "); } };
async function notifyNewPicks(since){ try{
  const {data:rows,error}=await sb().rpc("bahis_recent_autosave",{since}); if(error) throw error; if(!rows||!rows.length) return { sent:0, picks:0 };
  const lines=[`🎯 BetFans — ${rows.length} yeni değer seçimi`];
  for(const r of rows) lines.push(`${trTime(r.commence_time)} · ${LG_TR[r.sport]||r.sport}\n${r.home} – ${r.away}\n➡️ ${mktLabel(r.market)} @ ${(+r.odds).toFixed(2)}${r.pin_edge_pct!=null?` (Pinnacle'a göre +%${(+r.pin_edge_pct).toFixed(1)})`:""}`);
  lines.push("https://bet-fans.com");
  return { ...(await sendTelegram(lines.join("\n\n"))), picks:rows.length };
}catch(e){ warn("notifyNewPicks",e); return { sent:0, error:String(e) }; } }

async function autosave(){
  const sports=AUTOSAVE_SPORTS; const since=new Date().toISOString();
  const results=await collectResults();
  const detail={}; let total=0;
  for(const sp of sports){
    try{
      const fx=await fetchFixtures(sp);
      if(fx.error){ detail[sp]=fx.error; continue; }
      const picks=[];
      for(const m of (fx.matches||[])){
        if(m.live||!m.pick||!m.pick.value||!m.commence) continue;
        const dt=new Date(m.commence).getTime()-Date.now();
        if(dt<=0||dt>8*86400000) continue;
        picks.push({ sport:sp, home:m.home, away:m.away, match_date:String(m.commence).slice(0,10),
          market:m.pick.code, family:m.pick.family, model_prob:m.pick.model/100, market_prob:m.pick.mkt/100,
          edge_pct:m.pick.edge, odds:m.pick.odds, odds_pinnacle:m.pick.odds_pin, pin_edge_pct:m.pick.pin_edge, is_value:true, source:"autosave", commence_time:m.commence,
          lambda_home:m.model_lh, lambda_away:m.model_la, params_version:m.params_version });
      }
      for(const m of (fx.matches||[])){ const x=m.xpick; if(m.live||!x||!m.commence) continue;
        const dt=new Date(m.commence).getTime()-Date.now(); if(dt<=0||dt>8*86400000) continue;
        picks.push({ sport:sp, home:m.home, away:m.away, match_date:String(m.commence).slice(0,10), market:x.code, family:"extra",
          model_prob:x.prob/100, market_prob:x.prob/100, edge_pct:0, odds:x.odds, odds_pinnacle:x.fair_odds, pin_edge_pct:x.pin_edge, is_value:true, source:"autosave", commence_time:m.commence,
          lambda_home:m.model_lh, lambda_away:m.model_la, params_version:m.params_version }); }
      let saved=0;
      if(picks.length){ const r=await savePreds(picks); saved=r.saved||0; }
      detail[sp]={candidates:picks.length, saved};
      total+=saved;
    }catch(e){ detail[sp]=String(e); }
  }
  const ah=await ahScan();
  const ahPicks=ah.all.filter((x)=>{ const dt=new Date(x.commence).getTime()-Date.now(); return dt>0&&dt<=8*86400000; }).map((x)=>({ sport:x.sport, home:x.home, away:x.away,
    match_date:String(x.commence).slice(0,10), market:x.pick.code, family:"ah", model_prob:x.pick.prob/100, market_prob:x.pick.prob/100, edge_pct:0, odds:x.pick.odds,
    odds_pinnacle:x.pick.fair_odds, pin_edge_pct:x.pick.pin_edge, is_value:true, source:"autosave", commence_time:x.commence }));
  { let saved=0; if(ahPicks.length){ const r=await savePreds(ahPicks); saved=r.saved||0; } total+=saved; detail.asya_handikap={ candidates:ahPicks.length, saved, scan:ah.out }; }
  const telegram=total>0? await notifyNewPicks(since) : { sent:0, picks:0 };
  return { total_saved:total, detail, telegram, results };
}

Deno.serve(async (req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  if(req.method==="GET"){ let health=null; try{ const {data}=await sb().rpc("bahis_health"); health=data; }catch(e){ warn("bahis_health",e); }
    return J({ ok:MISSING_ENV.length===0, service:`bahis-tahmin API v${VERSION}`, missing_env:MISSING_ENV.length? MISSING_ENV : undefined, env:ENV_PRESENT, health }); }
  if(req.method==="POST"){ let body={}; try{ body=await req.json(); }catch{ return J({error:"geçersiz JSON"},400); }
    if(MISSING_ENV.length) return J({ error:"eksik secret: "+MISSING_ENV.join(", ") },503);
    if(ADMIN_ACTIONS.has(body.action)){
      if(!ADMIN_KEY) return J({ error:"BAHIS_ADMIN_KEY secret'i tanimli degil; admin action kapali" },503);
      if(req.headers.get("x-admin-key")!==ADMIN_KEY) return J({ error:"yetkisiz" },401);
    }
    if(body.action==="fixtures") return J(await fetchFixtures(body.sport||WORLD_CUP_SPORT,true)); // herkese acik: kredi korumasi
    if(body.action==="save") return J(await savePreds(body.picks||[]));
    if(body.action==="history") return J(await getHistory(body.sport));
    if(body.action==="settle") return J(await settle());
    if(body.action==="autosave") return J(await autosave());
    if(body.action==="collect_results") return J(await collectResults());
    if(body.action==="ah_scan") return J(await ahScan()); // kaydetmeden tarama (onbellegi gunceller)
    if(body.action==="tg_test") return J(await sendTelegram("✅ BetFans bildirim testi — yeni değer seçimleri buraya gelecek.\nhttps://bet-fans.com"));
    if(body.action==="capture_closing") return J(await captureClosing());
    if(body.action==="calibrate") return J(await calibrate());
    if(body.action==="backtest") return J(await backtest(body));
    if(body.action==="inj_debug"){
      if(!FOOTBALL_API_KEY) return J({key:false});
      const lid=body.league||39, season=body.season||2025;
      try{
        const r=await fetch(`https://v3.football.api-sports.io/injuries?league=${lid}&season=${season}`,{headers:{"x-apisports-key":FOOTBALL_API_KEY}});
        const d=await r.json().catch(()=>({}));
        return J({key:true, status:r.status, results:d.results??null, errors:d.errors??null,
          sample:(d.response||[]).slice(0,3).map((x)=>({team:x.team&&x.team.name, player:x.player&&x.player.name, type:x.player&&x.player.type}))});
      }catch(e){ return J({key:true, fetch_error:String(e)}); }
    }
    if(body.action==="markets_probe"){ // ek pazar kapsami: tek mac, AB bolgesi (anahtar donmez)
      const sp=body.sport||"soccer_epl"; const mk=body.markets||"double_chance,draw_no_bet,btts,alternate_totals";
      try{ const er=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/events?apiKey=${ODDS_KEY}`); const evs=await er.json();
        const ev=(evs||[]).sort((a,b)=>String(a.commence_time).localeCompare(String(b.commence_time)))[Math.min(+body.idx||0,(evs||[]).length-1)]; if(!ev) return J({events:0});
        const r=await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/events/${ev.id}/odds?apiKey=${ODDS_KEY}&regions=${body.regions||"eu"}&markets=${mk}&oddsFormat=decimal`);
        const d=await r.json(); const cov={};
        for(const b of (d.bookmakers||[])) for(const m of (b.markets||[])){ const c=cov[m.key]||(cov[m.key]={books:[],lines:{}}); c.books.push(b.key); for(const o of (m.outcomes||[])){ const L=(o.name||"")+(o.point!=null?" "+o.point:""); c.lines[L]=(c.lines[L]||0)+1; } }
        return J({ status:r.status, event:ev.home_team+" - "+ev.away_team, commence:ev.commence_time, credits_last:r.headers.get("x-requests-last"), credits_remaining:r.headers.get("x-requests-remaining"), coverage:cov });
      }catch(e){ return J({fetch_error:String(e)}); }
    }
    if(body.action==="odds_hist"){ // The Odds API gecmis oran vekili (yerel backtest icin; anahtar sunucuda kalir). path: odds|events|usage
      const path=String(body.path||"odds"), sp=String(body.sport||""), dt=String(body.date||""), mk=String(body.markets||"h2h");
      const hdr=(r)=>({ credits_last:r.headers.get("x-requests-last"), credits_used:r.headers.get("x-requests-used"), credits_remaining:r.headers.get("x-requests-remaining") });
      if(path==="usage"){ const r=await fetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_KEY}`); return J({ status:r.status, ...hdr(r) }); } // /sports kredi harcamaz
      if(!/^(basketball|soccer)_[a-z0-9_]+$/.test(sp)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(dt)||!/^(h2h|totals|spreads)(,(h2h|totals|spreads))*$/.test(mk)||!["odds","events"].includes(path)) return J({error:"path/sport/date/markets"},400);
      const q= path==="odds"? `&regions=eu&markets=${mk}&oddsFormat=decimal` : "";
      const r=await fetch(`https://api.the-odds-api.com/v4/historical/sports/${sp}/${path}?apiKey=${ODDS_KEY}&date=${dt}${q}`);
      return J({ status:r.status, ...hdr(r), body: r.ok? await r.json() : await r.text() });
    }
    if(body.action==="fd_csv"){ // football-data.co.uk CSV aktarimi (yerel backtest icin; gelistirici agi bu siteye erisemiyor)
      const c=String(body.code||""), se=String(body.season||"");
      if(!/^[A-Z0-9]{1,4}$/.test(c)||!/^\d{4}$/.test(se)) return J({error:"code/season"},400);
      const r=await fetch(`https://www.football-data.co.uk/mmz4281/${se}/${c}.csv`);
      return new Response(await r.text(),{status:r.status,headers:{...CORS,"Content-Type":"text/csv; charset=utf-8"}});
    }
    if(body.action==="fd_debug"){ // football-data.org anahtar/plan tanisi (anahtar donmez)
      if(!FD_KEY) return J({key:false});
      const out={key:true, key_len:FD_KEY.length};
      for(const comp of (body.comps||["CL","PL"])){
        try{ const r=await fetch(`https://api.football-data.org/v4/competitions/${comp}/matches?status=FINISHED`,{headers:{"X-Auth-Token":FD_KEY}});
          const txt=await r.text(); let n=null; try{ n=(JSON.parse(txt).matches||[]).length; }catch(_){}
          out[comp]={status:r.status, matches:n, body:n==null? txt.slice(0,200) : undefined};
        }catch(e){ out[comp]={fetch_error:String(e)}; }
      }
      return J(out);
    }
    if(body.action==="sportmonks_debug"){ // plan kapsami: abonelikteki ligler (anahtar donmez)
      const tok=SPORTMONKS_KEY||FOOTBALL_API_KEY; if(!tok) return J({key:false});
      try{
        const r=await fetch(`https://api.sportmonks.com/v3/football/leagues?per_page=50`,{headers:{"Authorization":tok}});
        const d=await r.json().catch(()=>({}));
        return J({ key:true, key_source:SPORTMONKS_KEY?"SPORTMONKS_API_KEY":"FOOTBALL_API_KEY", status:r.status, message:d.message??null,
          leagues:(d.data||[]).map((l)=>({id:l.id,name:l.name,country_id:l.country_id})), subscription:d.subscription??null, rate_limit:d.rate_limit??null });
      }catch(e){ return J({key:true, fetch_error:String(e)}); }
    }
    if(body.action==="params"){ return J(await getParams()); }
    if(body.action==="compute"){ const params=await getParams(); const threshold=params.edge_threshold_base*params.family_correction;
      const matches=(body.matches||[]).map((m)=>{ const lh=+m.lh||1.2,la=+m.la||1.0; const r=probs(lh,la,params.rho); const odds=m.odds||{};
        const markets=MKID.map((k)=>{ const mod=r[k]; const odd=odds[k]||null; const mkt=odd?1/odd:null; const edge=mkt!=null?mod-mkt:null; return { code:k,name:MKN[k],model:+(mod*100).toFixed(1),mkt:mkt!=null?+(mkt*100).toFixed(1):null,edge:edge!=null?+(edge*100).toFixed(1):null,odds:odd,value:edge!=null?(edge*100)>=threshold:false }; });
        return { home:m.home||"Ev",away:m.away||"Dep",source:"manual",model_lh:+lh.toFixed(2),model_la:+la.toFixed(2),top:r.top.map((t)=>({score:t.s,p:+(t.p*100).toFixed(0)})),markets }; });
      return J({ matches }); }
    return J({ error:"bilinmeyen action" },400); }
  return J({ error:"method" },405);
});
