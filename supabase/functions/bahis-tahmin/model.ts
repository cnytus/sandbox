// @ts-nocheck -- proje bilincli olarak tipsiz JS-stili; deno test type-check kapali
// Saf model matematigi - I/O yok, Deno.serve yok; test edilebilir (bkz. model_test.ts)
export function poisson(k,l){ let f=1; for(let i=2;i<=k;i++) f*=i; return Math.exp(-l)*Math.pow(l,k)/f; }
export function dc(i,j,lh,la,rho){ if(i===0&&j===0)return 1-lh*la*rho; if(i===0&&j===1)return 1+lh*rho; if(i===1&&j===0)return 1+la*rho; if(i===1&&j===1)return 1-rho; return 1; }
export function probs(lh,la,rho){ const mx=8; const cells=[]; let tot=0;
  for(let i=0;i<mx;i++) for(let j=0;j<mx;j++){ let p=poisson(i,lh)*poisson(j,la); if(i<2&&j<2)p*=dc(i,j,lh,la,rho); cells.push({i,j,p}); tot+=p; }
  let ph=0,pd=0,pa=0,o=0,o15=0,o35=0,by=0; const grid=[];
  for(const c of cells){ const p=c.p/tot; if(c.i>c.j)ph+=p; else if(c.i===c.j)pd+=p; else pa+=p; const t=c.i+c.j; if(t>2.5)o+=p; if(t>1.5)o15+=p; if(t>3.5)o35+=p; if(c.i>=1&&c.j>=1)by+=p; grid.push({s:c.i+"-"+c.j,p}); }
  grid.sort((a,b)=>b.p-a.p); return { "1":ph,"X":pd,"2":pa,"O":o,"U":1-o,"O15":o15,"O35":o35,"BY":by,"BN":1-by, top:grid.slice(0,4) }; }
// perf: lean 1x2+O probabilities without allocations/sort - used in backtest hot loops
export function probsLite(lh,la,rho){ let ph=0,pd=0,pa=0,o=0;
  for(let i=0;i<8;i++){ const pi=poisson(i,lh); for(let j=0;j<8;j++){ let p=pi*poisson(j,la); if(i<2&&j<2)p*=dc(i,j,lh,la,rho);
    if(i>j)ph+=p; else if(i===j)pd+=p; else pa+=p; if(i+j>2.5)o+=p; } }
  const tot=ph+pd+pa; return { p1:ph/tot, px:pd/tot, p2:pa/tot, o:o/tot }; }

export function shinDevig(rawProbs){
  const S=rawProbs.reduce((a,b)=>a+b,0);
  if(S<=1) return rawProbs.map(p=>p/S);
  const f=(z)=>{ let s=0; for(const pi of rawProbs){ const inner=Math.max(0, z*z+4*(1-z)*pi*pi/S); s += (Math.sqrt(inner)-z)/(2*(1-z)); } return s-1; };
  let lo=0, hi=0.4, flo=f(lo), fhi=f(hi), tries=0;
  while(fhi>0 && hi<0.49 && tries<20){ hi+=0.02; fhi=f(hi); tries++; }
  for(let i=0;i<60;i++){ const mid=(lo+hi)/2, fm=f(mid); if(Math.abs(fm)<1e-9){ lo=hi=mid; break;} if((fm>0)===(flo>0)){ lo=mid; flo=fm; } else { hi=mid; fhi=fm; } }
  const z=(lo+hi)/2;
  return rawProbs.map(pi=> (Math.sqrt(Math.max(0,z*z+4*(1-z)*pi*pi/S))-z)/(2*(1-z)) );
}
export const avg=(a)=>a.reduce((x,y)=>x+y,0)/a.length;
export const median=(a)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2? s[m] : (s[m-1]+s[m])/2; };

export const norm=(s)=> (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\b(fc|afc|cf|sc|ac|cd|ssc|bk|club)\b/g,"").replace(/[^a-z0-9]/g,"");
// Takim adi -> map anahtari. Once tam eslesme; sonra substring, ama YALNIZ tek aday varsa
// (eski surum ilk substring'i aliyordu -> "manchester" city/united hangisi once gelirse).
export function findKey(name,map){
  const n=norm(name); if(!n) return null; if(map[n]!=null) return n;
  const cands=[]; for(const k in map){ if(k.length>2&&(k.includes(n)||n.includes(k))) cands.push(k); }
  if(cands.length===1) return cands[0];
  if(cands.length>1) console.warn("findKey ambiguous", name, cands);
  return null;
}
// "home|away" anahtarli map'te mac bul (settle / capture_closing). Ayni tek-aday kurali.
export function findPair(home,away,map){
  const h=norm(home), a=norm(away); const exact=h+"|"+a; if(map[exact]!=null) return exact;
  const cands=[]; for(const k of Object.keys(map)){ const [kh,ka]=k.split("|"); if(!kh||!ka) continue;
    if((kh.includes(h)||h.includes(kh))&&(ka.includes(a)||a.includes(ka))) cands.push(k); }
  if(cands.length===1) return cands[0];
  if(cands.length>1) console.warn("findPair ambiguous", home, away, cands);
  return null;
}
export function evalMkt(code,hs,as){ const tot=hs+as; switch(code){ case"1":return hs>as; case"X":return hs===as; case"2":return as>hs; case"O":return tot>2.5; case"U":return tot<2.5; case"BY":return hs>=1&&as>=1; case"BN":return !(hs>=1&&as>=1);
  // 2026-09-27 ek pazarlar (DNB beraberlikte iade: beraberlik settle'da void yapilir, burada false)
  case"DC1X":return hs>=as; case"DCX2":return as>=hs; case"DC12":return hs!==as; case"DNB1":return hs>as; case"DNB2":return as>hs; case"O15":return tot>1.5; case"U35":return tot<3.5;} return false; }

// ---- Yuksek isabetli ek secimler (2026-09-27) ----
// Cifte sans / beraberlikte iade 1X2 fiyatlarindan birebir kurulur (dutching): DC = 1/(1/o1+1/oX), DNB1 = o1*(oX-1)/oX.
// Backtest (6 lig x 4 sezon, Max oran vs Pinnacle adil, esik %2): DC oran <=1,8 -> 136 bahis %81 isabet ROI ~+15; >1,8 negatif.
// DNB oran <=2,2 -> 161 bahis ROI ~+11. Ust 1,5 / Alt 3,5 (canli referans Pinnacle alternate_totals): Footiqo 1xBet kapanis
// oranlari + Pinnacle kapanis 1X2/U2,5'ten Poisson adil olasilik, 6 lig 2019-2026 (~13.8k mac): oran <=1,8, fiyat-edge %2-5 ->
// Ust 1,5: 75 bahis %76 isabet ROI +11,8 | Alt 3,5: 492 bahis %66 isabet ROI +3,9 (iki donemde de pozitif). Edge %5 ustu
// cogunlukla model hatasi (esik 4-6%'da ROI duser) -> OU icin ust sinir %5. KG: Poisson KG'yi 2 puan dusuk tahmin ediyor -> eklenmedi.
export const XMAX={ DC:1.8, DNB:2.2, OU:1.8 };
export const XMAXE={ DC:10, DNB:10, OU:5 }; // pazar bazli fiyat-edge ust siniri (%)
export const dutchPrice=(a,b)=>1/(1/a+1/b);
export const dnbPrice=(o,ox)=>o*(ox-1)/ox;
// o={best:{1,X,2}, book:{1,X,2}, fp:{1,X,2} Pinnacle adil olasilik (yoksa null), kp/mp: model/piyasa olasiligi,
//    ou:{O15:{price,book,fp,kp},U35:{...}}, thr: esik %, maxEdge: ust sinir %}. En yuksek fiyat-edge'li aday ya da null.
export function extraPick(o){
  const c=[]; const b=o.best||{}, bk=o.book||{}, fp=o.fp, kp=o.kp||{}, mp=o.mp||{};
  const add=(x)=>{ if(x.price>1&&x.price<=x.max&&x.pe>=o.thr&&x.pe<=Math.min(o.maxEdge,x.emax??1e9)&&x.agree) c.push(x); };
  if(fp){
    for(const [x,y,code] of [["1","X","DC1X"],["X","2","DCX2"],["1","2","DC12"]]){ if(!(b[x]>1&&b[y]>1)) continue;
      const price=dutchPrice(b[x],b[y]), pf=fp[x]+fp[y], sx=(1/b[x])/(1/b[x]+1/b[y]);
      add({code,price,prob:pf,pe:(price*pf-1)*100,max:XMAX.DC,agree:(kp[x]+kp[y])>=(mp[x]+mp[y])-1e-9,
        legs:[{code:x,odds:b[x],book:bk[x]||null,share:sx},{code:y,odds:b[y],book:bk[y]||null,share:1-sx}]}); }
    for(const [j,q,code] of [["1","2","DNB1"],["2","1","DNB2"]]){ if(!(b[j]>1&&b["X"]>1)) continue;
      const price=dnbPrice(b[j],b["X"]), pf=fp[j]/(fp[j]+fp[q]), sx=1/b["X"];
      add({code,price,prob:pf,pe:(price*pf-1)*100,max:XMAX.DNB,agree:kp[j]/(kp[j]+kp[q])>=mp[j]/(mp[j]+mp[q])-1e-9,
        legs:[{code:j,odds:b[j],book:bk[j]||null,share:1-sx},{code:"X",odds:b["X"],book:bk["X"]||null,share:sx}]}); }
  }
  for(const code of ["O15","U35"]){ const u=(o.ou||{})[code]; if(!u||!(u.price>1)||!(u.fp>0)) continue;
    add({code,price:u.price,prob:u.fp,pe:(u.price*u.fp-1)*100,max:XMAX.OU,emax:XMAXE.OU,agree:u.kp>=u.fp-1e-9,legs:[{code,odds:u.price,book:u.book||null,share:1}]}); }
  return c.sort((a,z)=>z.pe-a.pe)[0]||null;
}

// ---- Basketbol alt/ust + handikap (Faz 2, 2026-09-27) ----
// Pinnacle cizgisi + adil olasiliktan normal dagilim ortalamasi (mu) kurulur, baska bahiscinin cizgisi bu mu ile fiyatlanir.
// Skorlar tam sayi: sureklilik duzeltmesi; tam sayi cizgide iade (push). Pinnacle'in iki yonlu adil fiyati iadesiz kosullu.
// Kodlar: "O@170.5" / "U@170.5" (toplam sayi), "H1@-5.5" / "H2@+5.5" (handikapli MS, uzatma dahil).
export function Phi(x){ const z=Math.abs(x)/Math.SQRT2, t=1/(1+0.3275911*z);
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-z*z);
  return x>=0? 0.5*(1+y) : 0.5*(1-y); }
// X ~ N(mu,s) tam sayi; "X > L" icin [kazanma, iade]
export function overWP(L,mu,s){ if(Math.abs(L-Math.round(L))<1e-9){ const a=Phi((L+.5-mu)/s), b=Phi((L-.5-mu)/s); return [1-a, a-b]; } return [1-Phi((L-mu)/s), 0]; }
export function fitMu(L,pOver,s){ let lo=L-80, hi=L+80; for(let i=0;i<80;i++){ const m=(lo+hi)/2, [w,pu]=overWP(L,m,s); if(w/(1-pu)<pOver) lo=m; else hi=m; } return (lo+hi)/2; }
// taraf "O": X > L, "U": X < L -> [kazanma, iade]
export function sideWP(side,L,mu,s){ const [w,pu]=overWP(L,mu,s); return side==="O"? [w,pu] : [1-w-pu,pu]; }
export function lineResult(code,hs,as){
  let m=/^([OU])@(\d+(?:\.\d+)?)$/.exec(code||"");
  if(m){ const L=+m[2], t=hs+as; if(t===L) return "void"; return ((m[1]==="O")===(t>L))? "hit" : "miss"; }
  m=/^H([12])@([+-]?\d+(?:\.\d+)?)$/.exec(code||"");
  if(m){ const d=(m[1]==="1"? hs-as : as-hs)+(+m[2]); if(d===0) return "void"; return d>0? "hit" : "miss"; }
  return null; }

// Pinnacle {L, p(X>L)} + bahisci teklifleri [taraf, L, oran, bahisci]; spreads'te X = ev-dep farki (ev -5.5 <=> X > 5.5)
export function lineQuotes(ev,key,exch=/betfair_ex|matchbook/){ let pin=null; const q=[];
  for(const b of (ev.bookmakers||[])){ const m=(b.markets||[]).find((x)=>x.key===key); if(!m) continue; let L,po,pu;
    if(key==="totals"){ const ov=m.outcomes.find((o)=>o.name==="Over"), un=m.outcomes.find((o)=>o.name==="Under"); if(!ov||!un||ov.point==null||ov.point!==un.point) continue; L=ov.point; po=ov.price; pu=un.price; }
    else { const h=m.outcomes.find((o)=>o.name===ev.home_team), a=m.outcomes.find((o)=>o.name===ev.away_team); if(!h||!a||h.point==null) continue; L=-h.point; po=h.price; pu=a.price; }
    if(!(po>1&&pu>1)) continue;
    if(b.key==="pinnacle") pin={ L, p:shinDevig([1/po,1/pu])[0] };
    if(!exch.test(b.key||"")) q.push(["O",L,po,b.title||b.key],["U",L,pu,b.title||b.key]); }
  return { pin, q }; }
const fmtHcp=(x)=>(x>0?"+":"")+(+x.toFixed(1));
const lineCode=(key,side,L)=> key==="totals"? side+"@"+L : (side==="O"? "H1@"+fmtHcp(-L) : "H2@"+fmtHcp(L));
export function parseLine(code){ let m=/^([OU])@(.+)$/.exec(code||""); if(m) return ["totals",m[1],+m[2]];
  m=/^H([12])@(.+)$/.exec(code||""); if(m) return ["spreads", m[1]==="1"?"O":"U", m[1]==="1"? -(+m[2]) : +m[2]]; return null; }
// En iyi (en yuksek beklenen deger) teklif; Pinnacle cizgisinden en fazla win sayi uzak. e = oran*kazanma + iade - 1
export function bestLineRaw(ev,key,s,win=1.5,exch=/betfair_ex|matchbook/){ const {pin,q}=lineQuotes(ev,key,exch); if(!pin||!s) return null; const mu=fitMu(pin.L,pin.p,s); let best=null;
  for(const [side,L,price,book] of q){ if(Math.abs(L-pin.L)>win) continue; const [w,pu]=sideWP(side,L,mu,s), e=price*w+pu-1;
    if(!best||e>best.e) best={ code:lineCode(key,side,L), price, book, w, pu, e }; }
  return best; }

// ---- Basketbol Elo (2026-09-28, bilgi amacli; secimlere KARISMAZ) ----
// FiveThirtyEight NBA Elo: K=20, MOV carpani ((MOV+3)^0.8)/(7.5+0.006*kazananin Elo farki), sezon gecisinde 0.75*R + 0.25*1505.
// Beklenen fark (sayi) = Elo farki / 28. Ev avantaji Elo cinsinden (NBA ~60 = ~2 sayi, Euroleague ~90 = ~3.2 sayi).
// games: [{t (ms), home, away, hs, as}] zaman sirali.
export const ELO_MEAN=1505;
const eloSeason=(t)=>{ const d=new Date(t); return d.getUTCMonth()>=6? d.getUTCFullYear() : d.getUTCFullYear()-1; };
export function basketElo(games,hca){ const R={}, N={}; let season=null;
  for(const g of games){ const s=eloSeason(g.t);
    if(season!=null&&s!==season) for(const k in R) R[k]=0.75*R[k]+0.25*ELO_MEAN;
    season=s;
    const rh=R[g.home]??ELO_MEAN, ra=R[g.away]??ELO_MEAN, diff=rh+hca-ra, exp=1/(1+Math.pow(10,-diff/400));
    const win=g.hs>g.as?1:0, mov=Math.abs(g.hs-g.as), wd=win? diff : -diff;
    const d=20*(Math.pow(mov+3,0.8)/(7.5+0.006*wd))*(win-exp);
    R[g.home]=rh+d; R[g.away]=ra-d; N[g.home]=(N[g.home]||0)+1; N[g.away]=(N[g.away]||0)+1; }
  return { R, N }; }
export function eloPredict(m,home,away,hca){ const diff=(m.R[home]??ELO_MEAN)+hca-(m.R[away]??ELO_MEAN);
  return { margin:+(diff/28).toFixed(1), p_home:+(1/(1+Math.pow(10,-diff/400))).toFixed(3), games:Math.min(m.N[home]||0, m.N[away]||0) }; }
