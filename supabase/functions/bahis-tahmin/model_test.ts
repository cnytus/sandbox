// @ts-nocheck
// Calistir: npx deno test supabase/functions/bahis-tahmin/model_test.ts
import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import { probs, probsLite, shinDevig, median, norm, findKey, findPair, evalMkt, extraPick, dutchPrice, dnbPrice } from "./model.ts";
import { Phi, overWP, fitMu, sideWP, lineResult } from "./model.ts";

Deno.test("probs: olasiliklar 1'e toplanir, U=1-O, top 4 skor", () => {
  const r = probs(1.5, 1.1, -0.12);
  assertAlmostEquals(r["1"] + r["X"] + r["2"], 1, 1e-9);
  assertAlmostEquals(r["O"] + r["U"], 1, 1e-9);
  assertAlmostEquals(r["BY"] + r["BN"], 1, 1e-9);
  assertEquals(r.top.length, 4);
  assert(r["1"] > r["2"], "ev lambda buyukse ev kazanma olasiligi buyuk olmali");
  const l = probsLite(1.5, 1.1, -0.12);
  assertAlmostEquals(l.p1, r["1"], 1e-9); assertAlmostEquals(l.o, r["O"], 1e-9);
});

Deno.test("shinDevig: overround'u kaldirir, toplam 1, sira korunur", () => {
  const raw = [1 / 1.9, 1 / 3.6, 1 / 4.2]; // toplam ~1.04
  const d = shinDevig(raw);
  assertAlmostEquals(d.reduce((a, b) => a + b, 0), 1, 1e-6);
  assert(d[0] > d[1] && d[1] > d[2]);
  assert(d[0] < raw[0], "favori olasiligi ham degerden dusmeli");
  // margin yoksa degismez
  const fair = shinDevig([0.5, 0.3, 0.2]);
  assertAlmostEquals(fair[0], 0.5, 1e-9);
});

Deno.test("median", () => {
  assertEquals(median([]), null);
  assertEquals(median([3, 1, 2]), 2);
  assertEquals(median([4, 1, 3, 2]), 2.5);
});

Deno.test("norm: aksan, ek ve noktalama temizlenir", () => {
  assertEquals(norm("Beşiktaş JK"), "besiktasjk");
  assertEquals(norm("Manchester City FC"), "manchestercity");
  assertEquals(norm("Nott'm Forest"), "nottmforest");
});

Deno.test("findKey: tam eslesme > tek substring; belirsizlik null", () => {
  const map = { manchestercity: 1, manchesterunited: 1, arsenal: 1, wolverhamptonwanderers: 1 };
  assertEquals(findKey("Manchester City", map), "manchestercity");
  assertEquals(findKey("Wolves", map), null); // substring degil, alias tablosu isi
  assertEquals(findKey("Wolverhampton", map), "wolverhamptonwanderers");
  assertEquals(findKey("Manchester", map), null); // iki aday -> eslestirme yapma
  assertEquals(findKey("", map), null);
});

Deno.test("findPair: home|away anahtari", () => {
  const done = { "arsenal|chelsea": 1, "manchestercity|liverpool": 1, "manchesterunited|liverpool": 1 };
  assertEquals(findPair("Arsenal FC", "Chelsea FC", done), "arsenal|chelsea");
  assertEquals(findPair("Man City", "Liverpool", done), null); // "mancity" substring degil
  assertEquals(findPair("Manchester", "Liverpool", done), null); // belirsiz
});

Deno.test("evalMkt: 7 pazar", () => {
  assertEquals(evalMkt("1", 2, 1), true); assertEquals(evalMkt("X", 1, 1), true); assertEquals(evalMkt("2", 0, 1), true);
  assertEquals(evalMkt("O", 2, 1), true); assertEquals(evalMkt("U", 1, 1), true);
  assertEquals(evalMkt("BY", 1, 1), true); assertEquals(evalMkt("BN", 0, 3), true);
  assertEquals(evalMkt("O", 1, 1), false); assertEquals(evalMkt("BY", 0, 3), false);
});

Deno.test("evalMkt: ek pazarlar (DC, DNB, Ust 1.5, Alt 3.5)", () => {
  assertEquals(evalMkt("DC1X", 1, 1), true); assertEquals(evalMkt("DC1X", 0, 1), false);
  assertEquals(evalMkt("DCX2", 0, 0), true); assertEquals(evalMkt("DC12", 1, 1), false); assertEquals(evalMkt("DC12", 2, 1), true);
  assertEquals(evalMkt("DNB1", 2, 0), true); assertEquals(evalMkt("DNB2", 2, 0), false);
  assertEquals(evalMkt("O15", 1, 1), true); assertEquals(evalMkt("O15", 1, 0), false);
  assertEquals(evalMkt("U35", 2, 1), true); assertEquals(evalMkt("U35", 2, 2), false);
});

Deno.test("dutching: DC ve DNB fiyati", () => {
  assertAlmostEquals(dutchPrice(2, 4), 1 / (0.5 + 0.25), 1e-12);        // 1.333
  assertAlmostEquals(dnbPrice(2, 3.5), 2 * 2.5 / 3.5, 1e-12);          // 1.4286
});

Deno.test("extraPick: esik, oran siniri, model uyumu", () => {
  const fp = { "1": 0.55, "X": 0.25, "2": 0.20 };                    // adil: 1X=0.80 -> 1.25
  const base = { fp, kp: fp, mp: fp, thr: 2, maxEdge: 10, book: { "1": "A", "X": "B", "2": "C" } };
  // 1X dutch = 1/(1/1.95+1/4.6) = 1.3696 -> pe = 1.3696*0.80-1 = +9.6% -> secilir
  const x = extraPick({ ...base, best: { "1": 1.95, "X": 4.6, "2": 5.0 } });
  assertEquals(x.code, "DC1X"); assert(x.pe > 9 && x.pe < 10);
  assertAlmostEquals(x.legs[0].share + x.legs[1].share, 1, 1e-12);
  // adil fiyat (edge 0) -> aday yok
  assertEquals(extraPick({ ...base, best: { "1": 1 / 0.55, "X": 4, "2": 5 } }), null);
  // model karsi (kp < mp) -> DC reddedilir
  const kp = { "1": 0.50, "X": 0.25, "2": 0.25 };
  assertEquals(extraPick({ ...base, kp, best: { "1": 1.95, "X": 4.6, "2": 4.0 } }), null);
  // Ust 1.5: fiyat 1.30, adil olasilik 0.80 -> pe +4% -> secilir; 1.9 oran sinir disi
  const o = extraPick({ thr: 2, maxEdge: 10, ou: { O15: { price: 1.30, book: "Z", fp: 0.80, kp: 0.82 } } });
  assertEquals(o.code, "O15");
  assertEquals(extraPick({ thr: 2, maxEdge: 10, ou: { O15: { price: 1.9, book: "Z", fp: 0.56, kp: 0.6 } } }), null);
  // Ust/Alt icin edge ust siniri %5 (Footiqo backtest'i): 1.35 x 0.80 = +8% -> reddedilir
  assertEquals(extraPick({ thr: 2, maxEdge: 10, ou: { O15: { price: 1.35, book: "Z", fp: 0.80, kp: 0.82 } } }), null);
});

Deno.test("basketbol cizgi cevirisi + sonuc", () => {
  assert(Math.abs(Phi(0)-0.5)<1e-7 && Math.abs(Phi(1.96)-0.975)<1e-4);
  const [w,pu]=overWP(170.5,170.5,16); assert(Math.abs(w-0.5)<1e-6 && pu===0);
  // tam sayi cizgide kosullu adil olasilik geri kurulur, iade ~%2-3
  const mu=fitMu(170,0.55,16), [w2,p2]=overWP(170,mu,16); assert(Math.abs(w2/(1-p2)-0.55)<1e-6 && p2>0.02 && p2<0.03);
  // Pinnacle 170'te adil %50 ise Alt 170.5 >%50 kazanir (170 artik kazanc)
  const [wu]=sideWP("U",170.5,fitMu(170,0.5,16),16); assert(wu>0.51);
  assertEquals(lineResult("O@170.5",90,81),"hit"); assertEquals(lineResult("U@170",85,85),"void"); assertEquals(lineResult("U@170.5",85,86),"miss");
  assertEquals(lineResult("H1@-5.5",90,84),"hit"); assertEquals(lineResult("H1@-5.5",90,85),"miss"); assertEquals(lineResult("H2@+5",90,85),"void");
  assertEquals(lineResult("H2@+5.5",86,81),"hit"); assertEquals(lineResult("O15",2,1),null);
});
