// @ts-nocheck
// Calistir: npx deno test supabase/functions/bahis-tahmin/model_test.ts
import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import { probs, probsLite, shinDevig, median, norm, findKey, findPair, evalMkt } from "./model.ts";

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
