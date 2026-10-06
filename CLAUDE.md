# CLAUDE.md — Helenka (pokladní deník)

## Co to je
Webová appka „Helenka" — pokladní deník pro klienta **Good Food**.
Není psaná od nuly u nás; přebíráme ji na správu a opravy.
Repo: `https://github.com/thegoodfood/helenka-pokladni-denik` (**public**, branch `main`)
— do repa tedy nic citlivého, ani do tohohle souboru.

## Stack a klíčové soubory
- **Vite + React 18.** Skripty: `npm run dev` / `build` / `preview`.
- Celá appka je prakticky **jediný soubor `src/App.jsx`** (~1 950 řádků).
  `src/main.jsx` a `index.html` jsou jen bootstrap.
- **Data jsou v Supabase** (projekt `ekfjznjzmlslrtatervl`) — URL a anon klíč
  jsou natvrdo v `App.jsx`. Tabulky mj. `transakce`, `firmy`, `zamestnanci`,
  `kategorie`, `limity`, `notifikace`; fotky dokladů v Storage bucketu `receipts`.
  Supabase token z Alfreda sem **neplatí** (Unauthorized) — na zásahy do DB
  je potřeba jiný přístup.
- **Google Sheets** = jen export, Apps Script webhook zvlášť pro každou ze 3 firem
  (`SHEETS_WEBHOOKS`), fire-and-forget. **Google Drive** = kopie příloh přes
  Apps Script (`DRIVE_URL`). Samotné Apps Scripty nejsou v repu.

## Nasazení — DŮLEŽITÉ
- Vercel tým `thegoodfood-6398s-projects` (účet `thegoodfood-6398`).
- **Push do `main` = okamžitě produkce**, a to do **dvou** Vercel projektů:
  - `helenka-pokladni-denik-jokz` → **ostrý**, doména **https://helenka.thegoodfood.cool**
    (+ `helenka-pokladni-denik-jokz.vercel.app`)
  - `helenka-pokladni-denik` → nejspíš duplikát (`helenka-pokladni-denik.vercel.app`).
    Petr ho chce zatím **nechat** — nemazat bez výslovného pokynu.
- **Postup oprav:** změna do větve → push → Vercel sám udělá preview →
  Petr odsouhlasí → `git merge --ff-only` do `main` → push.
  Preview URL: Vercel API `GET /v6/deployments?teamId=…` s `VERCEL_TOKEN` z `.env`.
- Preview jsou za Vercel přihlášením (Standard Protection) — otevře je jen
  přihlášený do účtu `thegoodfood`.
- ⚠️ **Preview používá stejnou Supabase DB a Sheets jako produkce** —
  zkušební transakce se objeví ve skutečném deníku (pak storno).
- Po nasazení ověř, že `helenka.thegoodfood.cool` servíruje nový
  `assets/index-*.js` (stejný hash jako lokální `npm run build`).
- **Nikdy nenasazuj na ostro bez odsouhlasení.**

## Git a přístup
- Repo patří účtu `thegoodfood`, ne `AutomatizaceKrekrrr`.
  Globální `gh` účet kvůli tomu **NEpřepínat**.
- Push jde přes vlastní fine-grained token `GH_TOKEN_GOODFOOD` v `.env`
  (repa alfred, helenka, meatup-web; Contents: Read and write) a repo-lokální
  `.git/credential-helper.sh` (nastaveno v `.git/config`). Helper ani `.git/`
  se neverzují — po novém klonu je potřeba je nastavit znovu (vzor v `Alfred/`).
- `gh` nad tímhle repem: `GH_TOKEN=$(sed -n 's/^GH_TOKEN_GOODFOOD=//p' .env) gh ...`
- V `.env` je i `VERCEL_TOKEN` (tým `thegoodfood-6398s-projects`).

## Pravidla práce
- **Piš česky.**
- **Jednoduchost první** — minimum kódu nutného k vyřešení.
- **Chirurgické změny** — neměň nesouvisející kód. `App.jsx` je velký,
  o to snadněji se v něm rozbije něco vedle.

## Secrets
Do repa nikdy (repo je veřejné). Tokeny jen do zdejšího `.env`
(`.gitignore` ho hlídá). Přístupy klienta žijí ve vaultu `AI generace VAULT`.

## Historie
- 31. 8. 2026 — převzato do správy.
- 6. 10. 2026 — nastaven push (token) a Vercel přístup; oprava: po „Ano“
  se ukáže „Ukládám…“ a zablokuje se dvojí uložení (hlášeno Samuelem —
  okno při nahrávání fotky viselo a vypadalo to, že ukládání nefunguje).
