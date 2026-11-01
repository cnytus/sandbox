"""BetFans otomatik TUTTU kartı (2026-09-29).

Geçmiş tahminlerde yeni TUTAN (result=hit) ve oranı >= MIN_ODDS olan her seçim için
Canva TUTTU zemini üstüne kart çizer -> OUT/<ad>.jpg + <ad>-k.webp, OUT/kartlar.json (galeri).
Yeni kartı onaylı üyelere + yöneticiye Batfanbot'tan fotoğraf olarak yollar (her kart bir kez; STATE/gonderilen.json).

Kullanım:  python kart.py              # üret + bildir
           python kart.py --no-notify  # üret, bildirmeden "gönderildi" say (ilk doldurma)
           python kart.py --test       # öz-denetim (ağ yok)
Ortam: OUT (/out), STATE (/state), MIN_ODDS (2.0), CARD_KEY, SITE (https://bet-fans.com)
"""
import json, os, re, sys, unicodedata, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from PIL import Image, ImageDraw, ImageFilter, ImageFont

API = "https://wrmyxcittludopbjyits.supabase.co/functions/v1/bahis-tahmin"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("OUT", "/out")
STATE = os.environ.get("STATE", "/state")
SITE = os.environ.get("SITE", "https://bet-fans.com")
MIN_ODDS = float(os.environ.get("MIN_ODDS", "2.0"))  # eşik BetFans adil oranına (1/model_prob) uygulanır
GALLERY_MAX = 12
NOTIFY_MAX = 5  # ponytail: bir koşuda en çok 5 bildirim; durum dosyası kaybolursa sel olmasın

LIG = {
    "soccer_epl": "İngiltere Premier Lig", "soccer_spain_la_liga": "İspanya La Liga",
    "soccer_italy_serie_a": "İtalya Serie A", "soccer_germany_bundesliga": "Almanya Bundesliga",
    "soccer_france_ligue_one": "Fransa Ligue 1", "soccer_turkey_super_league": "Türkiye Süper Lig",
    "soccer_uefa_champs_league": "Şampiyonlar Ligi", "soccer_italy_serie_b": "İtalya Serie B",
    "soccer_efl_champ": "İngiltere Championship", "soccer_portugal_primeira_liga": "Portekiz Liga",
    "soccer_spl": "İskoçya Premiership", "soccer_fifa_world_cup": "Dünya Kupası 2026",
    "basketball_nba": "NBA", "basketball_euroleague": "Euroleague",
}
PAZAR = {"1": "MS 1 (Ev sahibi)", "X": "Beraberlik", "2": "MS 2 (Deplasman)", "O": "Üst 2.5", "U": "Alt 2.5",
         "BY": "KG Var", "BN": "KG Yok", "DC1X": "Çifte Şans 1X", "DCX2": "Çifte Şans X2", "DC12": "Çifte Şans 12",
         "DNB1": "Beraberlikte İade 1", "DNB2": "Beraberlikte İade 2", "O15": "Üst 1.5", "U35": "Alt 3.5"}
AY = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
TR = timezone(timedelta(hours=3))  # Türkiye yaz/kış saati yok


def pazar(code):
    m = re.fullmatch(r"AH([12])@(.+)", code or "")
    if m: return f"Asya Hnd. {m[1]} ({m[2]})"
    m = re.fullmatch(r"([OU])@(.+)", code or "")
    if m: return ("Üst " if m[1] == "O" else "Alt ") + m[2]
    m = re.fullmatch(r"H([12])@(.+)", code or "")
    if m: return f"Hnd. MS {m[1]} ({m[2]})"
    return PAZAR.get(code)


PAZAR_EN = {"1": "Home win", "X": "Draw", "2": "Away win", "O": "Over 2.5", "U": "Under 2.5", "BY": "BTTS yes", "BN": "BTTS no",
            "DC1X": "Double chance 1X", "DCX2": "Double chance X2", "DC12": "Double chance 12", "DNB1": "Draw no bet 1", "DNB2": "Draw no bet 2",
            "O15": "Over 1.5", "U35": "Under 3.5"}


def pazar_en(code):
    m = re.fullmatch(r"AH([12])@(.+)", code or "")
    if m: return f"Asian hcp {m[1]} ({m[2]})"
    m = re.fullmatch(r"([OU])@(.+)", code or "")
    if m: return ("Over " if m[1] == "O" else "Under ") + m[2]
    m = re.fullmatch(r"H([12])@(.+)", code or "")
    if m: return f"Handicap {m[1]} ({m[2]})"
    return PAZAR_EN.get(code) or pazar(code)


def gun(r):
    """Maç günü (TR saati) -> date."""
    if r.get("commence_time"):
        return datetime.fromisoformat(r["commence_time"].replace("Z", "+00:00")).astimezone(TR).date()
    return datetime.strptime(r["match_date"][:10], "%Y-%m-%d").date()


def slug(s):
    s = unicodedata.normalize("NFKD", s.replace("ı", "i")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def ad(r):
    return f"kart-{gun(r):%Y-%m-%d}-{slug(r['home'])}-{slug(r['away'])}-{slug(r['market'])}"


def adil(r):
    """BetFans adil oranı = 1 / model olasılığı. Uyum (2026-09-30, 7258 md.5): bahis şirketi oranı gösterilmez."""
    return 1 / float(r["model_prob"])


def uygun(r):
    return (r.get("result") == "hit" and r.get("model_prob") and adil(r) >= MIN_ODDS
            and r.get("sport") in LIG and pazar(r.get("market")) and r.get("home") and r.get("away")
            and (r.get("commence_time") or r.get("match_date")))


# --- çizim ---
F_XB = os.path.join(HERE, "SairaCondensed-ExtraBold.ttf")
F_B = os.path.join(HERE, "SairaCondensed-Bold.ttf")
SHEAR = 0.2  # italik eğim


def yazi(img, text, font_path, size, cy, fill, max_w=720, glow=None):
    """Ortalanmış, italik (shear), gerekirse küçülen tek satır."""
    while True:
        f = ImageFont.truetype(font_path, size)
        l, t, r, b = f.getbbox(text)
        w, h = r - l, b - t
        if w + SHEAR * h <= max_w or size <= 20: break
        size -= 2
    pad, vp = int(SHEAR * h) + 60, 60  # parlama bulanıklığı katman kenarında kesilmesin
    lay = Image.new("RGBA", (w + 2 * pad, h + 2 * vp), (0, 0, 0, 0))
    ImageDraw.Draw(lay).text((pad - l, vp - t), text, font=f, fill=fill)
    H = lay.height
    lay = lay.transform(lay.size, Image.AFFINE, (1, SHEAR, -SHEAR * H / 2, 0, 1, 0), Image.BICUBIC)
    x, y = 540 - lay.width // 2, int(cy - lay.height / 2)
    if glow:
        g = Image.new("RGBA", lay.size, glow)
        g.putalpha(lay.getchannel("A").filter(ImageFilter.GaussianBlur(18)))
        img.alpha_composite(g, (x, y))
    img.alpha_composite(lay, (x, y))


def ciz(r, zemin):
    img = zemin.copy()
    d = gun(r)
    yazi(img, f"{r['home']} - {r['away']}", F_XB, 62, 606, (255, 255, 255, 255))
    yazi(img, f"{LIG[r['sport']]}   •   {d.day} {AY[d.month - 1]} {d.year}", F_B, 40, 688, (255, 255, 255, 205))
    yazi(img, f"{pazar(r['market'])} · %{round(100 * float(r['model_prob']))} · adil oran", F_XB, 62, 792, (255, 255, 255, 255))
    yazi(img, f"{adil(r):.2f}", F_XB, 200, 948, (80, 232, 59, 255), max_w=560, glow=(80, 232, 59, 150))
    yazi(img, "Skor: " + (r.get("actual_score") or "-"), F_XB, 62, 1118, (255, 255, 255, 255))
    return img.convert("RGB")


def ciz_intl(r, zemin):
    """Yurtdışı üyeler için (intl_view açıkken): büyük sayı gerçek oran. Türkiye'de gösterilmez."""
    img = zemin.copy()
    d = gun(r)
    yazi(img, f"{r['home']} - {r['away']}", F_XB, 62, 606, (255, 255, 255, 255))
    yazi(img, f"{LIG[r['sport']]}   •   {d.day} {AY[d.month - 1]} {d.year}", F_B, 40, 688, (255, 255, 255, 205))
    yazi(img, "Pazar: " + pazar(r["market"]), F_XB, 62, 792, (255, 255, 255, 255))
    yazi(img, f"{float(r['odds']):.2f}", F_XB, 200, 948, (80, 232, 59, 255), max_w=560, glow=(80, 232, 59, 150))
    yazi(img, "Skor: " + (r.get("actual_score") or "-"), F_XB, 62, 1118, (255, 255, 255, 255))
    return img.convert("RGB")


def kaydet(img, name):
    img.save(os.path.join(OUT, name + ".jpg"), quality=88, optimize=True, progressive=True)
    img.resize((432, 540), Image.LANCZOS).save(os.path.join(OUT, name + "-k.webp"), quality=82)


def kupon_ad(c):
    return f"kart-kupon-{c['day']}-{c['kind']}-{c['size']}"


def kupon_baslik(c, en=False):
    if en: return ("VALUE COUPON" if c["kind"] == "value" else "FAVOURITES COUPON") + f" · {c['size']} MATCHES"
    return ("DEĞER KUPONU" if c["kind"] == "value" else "FAVORİ KUPONU") + f" · {c['size']} MAÇ"


def ciz_kupon(c, zemin):
    """TUTAN kupon: başlık, ayaklar (maç · pazar · skor), büyük sayı = adil toplam oran (1 ÷ olasılık çarpımı)."""
    img = zemin.copy()
    yazi(img, kupon_baslik(c), F_XB, 58, 572, (255, 255, 255, 255))
    legs = c["legs"]
    y0, step = 650, (62 if len(legs) <= 3 else 50)
    for i, l in enumerate(legs):
        sk = f" · {l['score']}" if l.get("score") else ""
        yazi(img, f"{l['home']} - {l['away']} · {pazar(l['market']) or l['market']}{sk}", F_B, 36 if len(legs) <= 3 else 32, y0 + i * step, (255, 255, 255, 230), max_w=940)
    yazi(img, f"{1 / float(c['prob']):.2f}", F_XB, 180, 948 if len(legs) <= 3 else 972, (80, 232, 59, 255), max_w=560, glow=(80, 232, 59, 150))
    d = datetime.strptime(c["day"], "%Y-%m-%d").date()
    yazi(img, f"adil toplam oran · olasılık %{round(100 * float(c['prob']))} · {d.day} {AY[d.month - 1]}", F_XB, 46, 1118, (255, 255, 255, 255))
    return img.convert("RGB")


def kupon_alt(c):
    return f"{kupon_baslik(c)} tuttu: " + "; ".join(f"{l['home']} – {l['away']} {pazar(l['market']) or l['market']}" for l in c["legs"]) + f"; adil toplam oran {1 / float(c['prob']):.2f}"


def kuponlar():
    h = {"Content-Type": "application/json"}
    if os.environ.get("CARD_KEY"): h["x-card-key"] = os.environ["CARD_KEY"]
    req = urllib.request.Request(API, data=b'{"action":"coupons"}', headers=h)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp).get("coupons", [])


def telegram_kupon(c, name):
    key = os.environ.get("CARD_KEY")
    if not key: print("bildirim: CARD_KEY yok"); return False
    url = f"{SITE}/assets/paylasim/{name}.jpg"
    o = 1 / float(c["prob"])
    satir = lambda en: "\n".join(f"• {l['home']} – {l['away']} · {(pazar_en if en else pazar)(l['market']) or l['market']} · {l.get('score') or '-'}" for l in c["legs"])
    cap = "\n".join([f"✅ KUPON TUTTU! {kupon_baslik(c)}", satir(False), f"Adil toplam oran {o:.2f} · olasılık %{round(100 * float(c['prob']))}",
                     "Adil oran = 1 ÷ olasılık; bahis şirketi oranı değildir.", "", f"Tüm kuponlar (tutmayanlar dahil): {SITE}", f"Paylaş: {url}",
                     "18+ · Geçmiş sonuç garanti değildir.", "Bu bildirimleri kapatmak için /durdur yaz."])
    cap_en = "\n".join([f"✅ COUPON WON! {kupon_baslik(c, True)}", satir(True), f"Fair total odds {o:.2f} · probability {round(100 * float(c['prob']))}%",
                        "Fair odds = 1 ÷ probability; not a bookmaker's odds.", "", f"All coupons (including misses): {SITE}", f"Share: {url}",
                        "18+ · Past results are no guarantee.", "Send /stop to turn off these messages."])
    body = json.dumps({"action": "card_broadcast", "f": name, "caption": cap[:1000], "caption_en": cap_en[:1000]}).encode()
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json", "x-card-key": key})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            d = json.load(resp)
        print("gönderim:", name, {k: d.get(k) for k in ("sent", "total", "fail", "error", "reason")})
        return (d.get("sent") or 0) > 0
    except Exception as e:  # anahtar asla loglanmaz
        print("bildirim hatası:", type(e).__name__, getattr(e, "code", "")); return False


def alt(r):
    return f"Tuttu: {r['home']} – {r['away']}, {pazar(r['market'])}, olasılık %{round(100 * float(r['model_prob']))}, adil oran {adil(r):.2f}, skor {r.get('actual_score') or '-'}"


# --- ağ ---
def gecmis():
    """Geçmiş + intl_view bayrağı. CARD_KEY ile oranlar da gelir (yalnız yurtdışı kartı için; Türkiye kartında kullanılmaz)."""
    h = {"Content-Type": "application/json"}
    if os.environ.get("CARD_KEY"): h["x-card-key"] = os.environ["CARD_KEY"]
    req = urllib.request.Request(API, data=b'{"action":"history"}', headers=h)
    with urllib.request.urlopen(req, timeout=60) as resp:
        d = json.load(resp)
    return d.get("rows", []), bool(d.get("intl_view"))


def telegram(r, name, intl=False):
    """Kartı onaylı üyelere + yöneticiye gönderir (bahis-tahmin card_broadcast; üye kimlikleri fonksiyonda kalır)."""
    key = os.environ.get("CARD_KEY")
    if not key: print("bildirim: CARD_KEY yok"); return False
    url = f"{SITE}/assets/paylasim/{name}.jpg"
    cap = "\n".join([
        "✅ TUTTU!", f"{r['home']} – {r['away']}",
        f"{pazar(r['market'])} · olasılık %{round(100 * float(r['model_prob']))} · adil oran {adil(r):.2f} · skor {r.get('actual_score') or '-'}",
        "Adil oran = 1 ÷ model olasılığı; bahis şirketi oranı değildir.", "",
        f"Tüm sonuçlar (tutmayanlar dahil): {SITE}", f"Paylaş: {url}", "18+ · Geçmiş sonuç garanti değildir.",
        "Bu bildirimleri kapatmak için /durdur yaz."])
    cap_en = "\n".join([
        "✅ WON!", f"{r['home']} – {r['away']}",
        f"{pazar_en(r['market'])} · probability {round(100 * float(r['model_prob']))}% · fair odds {adil(r):.2f} · score {r.get('actual_score') or '-'}",
        "Fair odds = 1 ÷ model probability; not a bookmaker's odds.", "",
        f"All results (including misses): {SITE}", f"Share: {url}", "18+ · Past results are no guarantee.", "Send /stop to turn off these messages."])
    msg = {"action": "card_broadcast", "f": name, "caption": cap, "caption_en": cap_en}
    if intl and r.get("odds"):
        msg["f_intl"] = name
        msg["caption_intl"] = "\n".join([
            "✅ WON!", f"{r['home']} – {r['away']}",
            f"{pazar_en(r['market'])} · odds {float(r['odds']):.2f} · score {r.get('actual_score') or '-'}", "",
            f"All results: {SITE}", "18+ · Past results are no guarantee.", "Send /stop to turn off these messages."])
    body = json.dumps(msg).encode()
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json", "x-card-key": key})
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            d = json.load(resp)
        print("gönderim:", name, {k: d.get(k) for k in ("sent", "total", "fail", "error", "reason")})
        return (d.get("sent") or 0) > 0
    except Exception as e:  # anahtar asla loglanmaz
        print("bildirim hatası:", type(e).__name__, getattr(e, "code", "")); return False


def calis(notify=True):
    os.makedirs(OUT, exist_ok=True); os.makedirs(STATE, exist_ok=True)
    zemin = Image.open(os.path.join(HERE, "kart-zemin.png")).convert("RGBA")
    tum, intl = gecmis()
    rows = [r for r in tum if uygun(r)]
    idir = os.path.join(OUT, "intl"); os.makedirs(idir, exist_ok=True)
    rows.sort(key=lambda r: (gun(r), adil(r)), reverse=True)
    yeni = []
    for r in rows:
        name = ad(r)
        if not os.path.exists(os.path.join(OUT, name + ".jpg")):
            kaydet(ciz(r, zemin), name); yeni.append(name); print("kart:", name)
        ip = os.path.join(idir, name + ".jpg")
        if intl and r.get("odds") and not os.path.exists(ip):
            ciz_intl(r, zemin).save(ip, quality=88, optimize=True, progressive=True)
    if not intl:  # ayar kapalıyken gerçek oranlı kart sunucuda durmaz
        for fn in os.listdir(idir): os.remove(os.path.join(idir, fn))
    try:
        kup = [c for c in kuponlar() if c.get("result") == "hit" and c.get("legs")]
    except Exception as e:
        print("kuponlar alınamadı:", type(e).__name__); kup = []
    for c in kup:
        name = kupon_ad(c)
        if not os.path.exists(os.path.join(OUT, name + ".jpg")):
            kaydet(ciz_kupon(c, zemin), name); yeni.append(name); print("kupon kartı:", name)
    manifest = [{"f": ad(r), "alt": alt(r), "d": f"{gun(r):%Y-%m-%d}", "o": round(adil(r), 2)} for r in rows]
    manifest += [{"f": kupon_ad(c), "alt": kupon_alt(c), "d": c["day"], "o": round(1 / float(c["prob"]), 2)} for c in kup]
    manifest = sorted(manifest, key=lambda m: (m["d"], m["o"]), reverse=True)[:GALLERY_MAX]
    tmp = os.path.join(OUT, "kartlar.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh: json.dump(manifest, fh, ensure_ascii=False)
    os.replace(tmp, os.path.join(OUT, "kartlar.json"))

    sp = os.path.join(STATE, "gonderilen.json")
    sent = set(json.load(open(sp, encoding="utf-8"))) if os.path.exists(sp) else set()
    n = 0
    for r in rows:
        name = ad(r)
        if name in sent: continue
        if notify:
            if n >= NOTIFY_MAX: break
            if not telegram(r, name, intl): continue  # gönderilemedi -> sonraki koşu tekrar dener
            n += 1
        sent.add(name)
    for c in kup:
        name = kupon_ad(c)
        if name in sent: continue
        if notify:
            if n >= NOTIFY_MAX: break
            if not telegram_kupon(c, name): continue
            n += 1
        sent.add(name)
    with open(sp, "w", encoding="utf-8") as fh: json.dump(sorted(sent), fh)
    print(f"uygun={len(rows)} yeni_kart={len(yeni)} bildirim={n}")


def test():
    import tempfile
    assert pazar("X") == "Beraberlik" and pazar("AH1@-0.75") == "Asya Hnd. 1 (-0.75)"
    assert pazar("O@170.5") == "Üst 170.5" and pazar("H2@+5.5") == "Hnd. MS 2 (+5.5)" and pazar("ZZ") is None
    assert slug("Málaga İstanbul FC") == "malaga-istanbul-fc"
    r = {"sport": "soccer_france_ligue_one", "home": "Paris Saint Germain", "away": "AS Monaco", "market": "2",
         "model_prob": 0.281, "actual_score": "1-2", "result": "hit", "match_date": "2026-09-04", "commence_time": None}
    assert uygun(r) and not uygun({**r, "model_prob": 0.6}) and not uygun({**r, "result": "half_hit"}) and not uygun({**r, "sport": "x"})
    assert gun({"commence_time": "2026-09-20T22:30:00Z"}).day == 21  # TR saatine göre ertesi gün
    assert ad(r) == "kart-2026-09-04-paris-saint-germain-as-monaco-2"
    global OUT
    OUT = tempfile.mkdtemp()
    img = ciz(r, Image.open(os.path.join(HERE, "kart-zemin.png")).convert("RGBA"))
    assert img.size == (1080, 1350)
    assert ciz_intl({**r, "odds": 7.6}, Image.open(os.path.join(HERE, "kart-zemin.png")).convert("RGBA")).size == (1080, 1350)
    kaydet(img, ad(r))
    c = {"day": "2026-11-01", "kind": "value", "size": 4, "prob": 0.1512, "result": "hit",
         "legs": [{"home": "Çaykur Rizespor", "away": "Fenerbahce", "market": "2", "score": "0-3"}, {"home": "Real Betis", "away": "CA Osasuna", "market": "1", "score": "5-2"},
                  {"home": "Lazio", "away": "Monza", "market": "U", "score": "1-0"}, {"home": "Arsenal", "away": "Leeds United", "market": "1", "score": "2-0"}]}
    assert kupon_ad(c) == "kart-kupon-2026-11-01-value-4" and ciz_kupon(c, Image.open(os.path.join(HERE, "kart-zemin.png")).convert("RGBA")).size == (1080, 1350)
    kaydet(ciz_kupon(c, Image.open(os.path.join(HERE, "kart-zemin.png")).convert("RGBA")), kupon_ad(c))
    assert os.path.getsize(os.path.join(OUT, ad(r) + ".jpg")) > 50_000
    print("test OK ->", OUT)


if __name__ == "__main__":
    if "--test" in sys.argv: test()
    else: calis(notify="--no-notify" not in sys.argv)
