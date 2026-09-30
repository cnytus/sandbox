"""Türkiye IP aralıklarını (DB-IP IP to Country Lite, CC BY 4.0) bahis-tahmin'e yükler (tr_ip_set, x-card-key).
Yurtdışı görünüm kontrolü bu listeyle yapılır; ayda bir cron. Kullanım: python trip.py"""
import csv, gzip, io, json, os, urllib.request
from datetime import date

API = "https://wrmyxcittludopbjyits.supabase.co/functions/v1/bahis-tahmin"


def indir():
    d = date.today()
    for y, m in ((d.year, d.month), (d.year - (d.month == 1), 12 if d.month == 1 else d.month - 1)):
        url = f"https://download.db-ip.com/free/dbip-country-lite-{y}-{m:02d}.csv.gz"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "BetFans-trip/1.0 (+https://bet-fans.com)"})  # DB-IP varsayılan Python UA'yı 403 ile reddediyor
            with urllib.request.urlopen(req, timeout=120) as r:
                return url, r.read()
        except Exception as e:
            print("indirilemedi:", url, type(e).__name__)
    raise SystemExit("DB-IP listesi indirilemedi")


def main():
    url, raw = indir()
    rows = [[a, b] for a, b, c in csv.reader(io.TextIOWrapper(gzip.GzipFile(fileobj=io.BytesIO(raw)), "utf-8")) if c == "TR"]
    assert len(rows) > 1000, f"TR aralığı şüpheli az: {len(rows)}"
    req = urllib.request.Request(API, data=json.dumps({"action": "tr_ip_set", "ranges": rows}).encode(),
                                 headers={"Content-Type": "application/json", "x-card-key": os.environ["CARD_KEY"]})
    with urllib.request.urlopen(req, timeout=120) as r:
        print(url, "->", json.load(r))


if __name__ == "__main__":
    main()
