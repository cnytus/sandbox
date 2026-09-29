// @ts-nocheck -- proje bilincli olarak tipsiz JS-stili
// BetFans uyelik yardimcilari (2026-09-29): saf fonksiyonlar, I/O yok (bkz. auth_test.ts).
// Sifre: PBKDF2-SHA256, 210.000 tur, 16 bayt tuz -> "pbkdf2$<tur>$<tuz b64>$<ozet b64>". Oturum/jeton: 32 bayt rastgele, DB'de SHA-256 ozeti.
const enc=new TextEncoder();
const b64=(u8)=>btoa(String.fromCharCode(...u8));
const unb64=(s)=>Uint8Array.from(atob(s),(c)=>c.charCodeAt(0));
const hex=(buf)=>[...new Uint8Array(buf)].map((b)=>b.toString(16).padStart(2,"0")).join("");
async function pbkdf2(pw,salt,iter){ const k=await crypto.subtle.importKey("raw",enc.encode(pw),"PBKDF2",false,["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt, iterations:iter },k,256)); }
export async function hashPassword(pw,iter=210000){ const salt=crypto.getRandomValues(new Uint8Array(16)); return `pbkdf2$${iter}$${b64(salt)}$${b64(await pbkdf2(pw,salt,iter))}`; }
export async function verifyPassword(pw,stored){ try{ const [alg,it,s,h]=String(stored).split("$"); if(alg!=="pbkdf2") return false;
    const got=await pbkdf2(pw,unb64(s),+it), want=unb64(h); if(got.length!==want.length) return false;
    let d=0; for(let i=0;i<got.length;i++) d|=got[i]^want[i]; return d===0; }catch(_){ return false; } }
export function randomToken(){ return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function sha256hex(s){ return hex(await crypto.subtle.digest("SHA-256",enc.encode(s))); }
export async function hmacHex(key,msg){ const k=await crypto.subtle.importKey("raw",enc.encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return hex(await crypto.subtle.sign("HMAC",k,enc.encode(msg))); }
export function safeEq(a,b){ a=String(a||""); b=String(b||""); if(a.length!==b.length) return false; let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0; }
export function validEmail(e){ e=String(e||"").trim(); return e.length<=254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
// Telefon -> E.164. TR: 05xx / 5xx / 905xx / +905xx -> +905xxxxxxxxx; diger ulkeler +<10-15 hane>. Gecersizse null.
export function normPhone(p){ let s=String(p||"").replace(/[\s()\-.]/g,""); if(s.startsWith("00")) s="+"+s.slice(2);
  if(/^\+\d{10,15}$/.test(s)) return (s.startsWith("+90")&&!/^\+905\d{9}$/.test(s))? null : s;
  if(/^0?5\d{9}$/.test(s)) return "+90"+s.replace(/^0/,""); if(/^905\d{9}$/.test(s)) return "+"+s; return null; }
export function validPassword(p){ p=String(p||""); return p.length>=8 && p.length<=128; }
