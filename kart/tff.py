"""Süper Lig cezalı oyuncuları: TFF ceza sorgusundan (tff.org pageId=633) okunur, bahis-tahmin'e yüklenir (tff_bans_set, x-card-key).
Günde bir cron. Yalnız bilgi amaçlı gösterilir (maç kartı + Telegram); seçim kuralına girmez.
Kaynak şartı (tff.org kullanım koşulları, 2026-10-11 doğrulandı): bilgiler KAYNAK GÖSTERİLEREK yayımlanabilir, TİCARİ amaçla kullanılamaz.
Site ücretli üyelik/reklam/sponsor alırsa önce TFF'den yazılı izin gerekir. Otomatik erişimi yasaklayan madde yok; yine de günde ~75 istek, aralıklı.
Kullanım: python tff.py [--dry]   (--dry: yüklemez, bulunanları yazdırır)"""
import html, http.cookiejar, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import date, datetime, timedelta

API = "https://wrmyxcittludopbjyits.supabase.co/functions/v1/bahis-tahmin"
URL = "https://www.tff.org/Default.aspx?pageId=633"
PRE = "ctl00$MPane$m_633_3254_ctnr$m_633_3254$"
SEL = PRE + "SezonLigMacOrgKulupSelector1$"
ENC = "windows-1254"
TUR = (("men", "MEN"), ("kırmızı", "KK"), ("sarı", "SK"))  # sonuç tablosundaki "Tür" metni -> kod
_op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
_op.addheaders = [("User-Agent", "BetFans-tff/1.0 (+https://bet-fans.com)")]


def get():
    with _op.open(URL, timeout=60) as r:
        return r.read().decode(ENC, "replace")


def post(f):
    data = urllib.parse.urlencode({k: v.encode(ENC, "replace") for k, v in f.items()}).encode()
    with _op.open(URL, data=data, timeout=60) as r:
        return r.read().decode(ENC, "replace")


def fields(t):
    """Formdaki gizli/metin alanları (VIEWSTATE dahil); düğme, radyo ve onay kutuları hariç."""
    f = {}
    for tag in re.findall(r"<input[^>]*>", t):
        n = re.search(r'name="([^"]*)"', tag)
        ty = re.search(r'type="([^"]*)"', tag)
        if not n or (ty and ty.group(1).lower() in ("submit", "button", "image", "radio", "checkbox")):
            continue
        v = re.search(r'value="([^"]*)"', tag)
        f[n.group(1)] = html.unescape(v.group(1)) if v else ""
    return f


def items(t, combo):
    """RadComboBox seçenekleri: [(metin, değer, sıra)]"""
    m = re.search(r'new RadComboBox\("' + combo + r'".*?\.Initialize\(\{.*?\},(\[.*?\])\);', t, re.S)
    return [(x.get("Text", ""), x.get("Value"), i) for i, x in enumerate(json.loads(m.group(1)))] if m else []


def choose(f, combo, it):
    for k, v in (("Input", it[0]), ("text", it[0]), ("value", it[1] or ""), ("index", str(it[2]))):
        f[f"{SEL}{combo}_{k}"] = v


def postback(t, target, combo=None, it=None):
    f = fields(t)
    if combo:
        choose(f, combo, it)
    f["__EVENTTARGET"], f["__EVENTARGUMENT"] = target, ("TextChange" if combo else "")
    return post(f)


def grid(t):
    """Sonuç tablosu satırları + varsa sonraki sayfanın postback hedefi."""
    g = re.search(r'<table[^>]*id="[^"]*rgrdSariKirmizi_ctl01"[^>]*>(.*?)</table>', t, re.S)
    if not g:
        return [], None
    body = g.group(1)
    rows = []
    for r in re.findall(r'<tr class="Grid(?:Alt)?Row[^"]*"[^>]*>(.*?)</tr>', body, re.S):
        c = [html.unescape(re.sub(r"<[^>]+>", "", x)).strip() for x in re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)]
        if len(c) == 10:
            rows.append(c)
    nx = re.search(r'title="Next page" href="javascript:__doPostBack\(&#39;([^&]+)&#39;', body)
    return rows, (nx.group(1) if nx else None)


def parse(c, club, org):
    """Tablo satırı -> kayıt; başka organizasyon (alt yaş, kadın, PAF) ve geçmiş maçlar elenir."""
    if c[7].strip() != org:
        return None
    try:
        d = datetime.strptime(c[5], "%d.%m.%Y").date()
    except ValueError:
        return None
    if d < date.today() - timedelta(days=1):
        return None
    mac = c[6]
    if mac.startswith(club + " - "):
        home, away = club, mac[len(club) + 3:]
    elif mac.endswith(" - " + club):
        home, away = mac[: -len(club) - 3], club
    else:
        return None
    low = c[9].lower()
    tur = next((k for s, k in TUR if s in low), "MEN")
    return {"club": club, "player": c[1], "type": tur, "home": home, "away": away, "date": d.isoformat()}


def topla():
    t = get()
    org = next(x for x in items(t, "cmbMacOrganizasyon") if "Süper Lig" in x[0] and "Kad" not in x[0])
    t1 = postback(t, SEL + "cmbMacOrganizasyon", "cmbMacOrganizasyon", org)
    clubs = [x for x in items(t1, "cmbKulup") if x[1]]
    assert 16 <= len(clubs) <= 22, f"kulüp sayısı şüpheli: {len(clubs)}"
    out, ok = {}, 0
    for kl in clubs:
        try:
            t2 = postback(t1, SEL + "cmbKulup", "cmbKulup", kl)
            for cz in [x for x in items(t2, "cmbCezaTuru") if x[1]]:
                f = fields(t2)
                choose(f, "cmbCezaTuru", cz)
                f["__EVENTTARGET"], f["__EVENTARGUMENT"], f[PRE + "btnSariKirmiziAra"] = "", "", "Ara"
                t3 = post(f)
                for _ in range(20):  # sayfa sınırı (emniyet)
                    rows, nx = grid(t3)
                    for c in rows:
                        r = parse(c, kl[0], org[0])
                        if r:
                            out.setdefault((r["player"], r["date"], r["home"], r["away"]), r)  # aynı ceza Men + Kırmızı'da tekrar edebilir
                    if not nx:
                        break
                    time.sleep(0.7)
                    t3 = postback(t3, nx)
                time.sleep(0.7)
            ok += 1
        except Exception as e:  # bir kulüp düşerse diğerleri devam eder; sunucu ok < 15 ise listeyi reddeder
            print("kulüp okunamadı:", kl[0], type(e).__name__, e)
    return sorted(out.values(), key=lambda r: (r["date"], r["home"], r["player"])), ok, len(clubs)


def main():
    rows, ok, n = topla()
    print(f"kulüp {ok}/{n}, cezalı kayıt {len(rows)}")
    if "--dry" in sys.argv:
        for r in rows:
            print(" ", r["date"], r["home"], "-", r["away"], "|", r["club"], "|", r["player"], "|", r["type"])
        return
    req = urllib.request.Request(API, data=json.dumps({"action": "tff_bans_set", "clubs": ok, "rows": rows}).encode(),
                                 headers={"Content-Type": "application/json", "x-card-key": os.environ["CARD_KEY"]})
    with urllib.request.urlopen(req, timeout=120) as r:
        print("->", json.load(r))


def _test():
    c = ["19464", "MIHAI-VALENTIN MIHAILA", "EYÜPSPOR - ÇAYKUR RİZESPOR A.Ş.", "X", "", (date.today() + timedelta(days=2)).strftime("%d.%m.%Y"),
         "ÇAYKUR RİZESPOR A.Ş. - FENERBAHÇE A.Ş.", "Süper Lig", "", "Yarışmadan Men"]
    r = parse(c, "ÇAYKUR RİZESPOR A.Ş.", "Süper Lig")
    assert r and r["home"] == "ÇAYKUR RİZESPOR A.Ş." and r["away"] == "FENERBAHÇE A.Ş." and r["type"] == "MEN"
    assert parse(c[:7] + ["U19 PAF LİGİ"] + c[8:], "ÇAYKUR RİZESPOR A.Ş.", "Süper Lig") is None          # başka organizasyon
    assert parse(c[:5] + ["01.01.2020"] + c[6:], "ÇAYKUR RİZESPOR A.Ş.", "Süper Lig") is None           # geçmiş maç
    assert parse(c[:9] + ["Kırmızı Kart"], "FENERBAHÇE A.Ş.", "Süper Lig")["type"] == "KK"              # deplasman tarafı
    print("tff.py test ok")


if __name__ == "__main__":
    _test() if "--test" in sys.argv else main()
