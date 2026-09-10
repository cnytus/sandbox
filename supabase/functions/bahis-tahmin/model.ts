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

export const norm=(s)=> (s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\b(fc|afc|cf|sc|ac|cd|ssc|bk|club)\b/g,"").replace(/[^a-z0-9]/g,"");
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
export function evalMkt(code,hs,as){ const tot=hs+as; switch(code){ case"1":return hs>as; case"X":return hs===as; case"2":return as>hs; case"O":return tot>2.5; case"U":return tot<2.5; case"BY":return hs>=1&&as>=1; case"BN":return !(hs>=1&&as>=1);} return false; }
