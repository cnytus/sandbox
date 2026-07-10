# CLAUDE.md — sandbox-git (BetFans GitHub mirror)

BetFans (betting-app) uygulamasının sürümlenen kaynağı.
**Global kurallar:** `C:\ClaudeDirectory\CLAUDE.md` geçerlidir.

## ⚠️ EN ÖNEMLİ KURAL
Repo **PUBLIC**: github.com/cnytus/sandbox. Buraya ASLA secret, API key, `.env`,
Supabase service key veya kişisel veri commit etme. Commit öncesi diff'te secret taraması yap.

## Yapı
- `index.html` + `supabase/` edge function (bahis-tahmin, deploy edilen v6/v8 sürümleri
  commit geçmişinde). Çalışma kopyası: `C:\ClaudeDirectory\betting-app` — asıl geliştirme
  orada yapılır, sürümleme burada (ayrıntı: betting-app/CLAUDE.md).
- Branch → PR akışı burada da geçerli (Hard Rule 3).
