// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { hashPassword, verifyPassword, normPhone, validEmail, validPassword, hmacHex, safeEq, sha256hex, randomToken } from "./auth.ts";
Deno.test("sifre", async () => {
  const h=await hashPassword("dogru-sifre-1",1000); assert(h.startsWith("pbkdf2$1000$"));
  assert(await verifyPassword("dogru-sifre-1",h)); assert(!(await verifyPassword("yanlis",h))); assert(!(await verifyPassword("x","bozuk")));
  assert((await hashPassword("a",1000))!==(await hashPassword("a",1000))); // tuz farkli
});
Deno.test("telefon/e-posta/sifre kurallari", () => {
  assertEquals(normPhone("0532 123 45 67"),"+905321234567"); assertEquals(normPhone("5321234567"),"+905321234567");
  assertEquals(normPhone("+90 (532) 123-45-67"),"+905321234567"); assertEquals(normPhone("00905321234567"),"+905321234567");
  assertEquals(normPhone("+4915112345678"),"+4915112345678"); assertEquals(normPhone("+902121234567"),null); assertEquals(normPhone("123"),null);
  assert(validEmail("a@b.co")); assert(!validEmail("a@b")); assert(!validEmail("a b@c.de"));
  assert(validPassword("12345678")); assert(!validPassword("1234567"));
});
Deno.test("jeton/hmac", async () => {
  assertEquals(randomToken().length,64); assertEquals((await sha256hex("x")).length,64);
  const a=await hmacHex("k","m"), b=await hmacHex("k","m"); assert(safeEq(a,b)); assert(!safeEq(a,await hmacHex("k2","m")));
});
