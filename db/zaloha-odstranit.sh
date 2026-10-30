#!/usr/bin/env bash
# Návrat k db/zaloha.sh: smaže tabulky jedné zálohy ze schématu `zaloha`.
# Živá data v public ani soubory v receipts nemění.
#
# Použití: db/zaloha-odstranit.sh <přípona>
set -euo pipefail
cd "$(dirname "$0")/.."

REF=ekfjznjzmlslrtatervl
SUF=${1:?Zadej příponu zálohy, např. 20261030_1405}
[[ $SUF =~ ^[0-9_]+$ ]] || { echo "Přípona smí obsahovat jen číslice a _" >&2; exit 1; }
TOKEN=$(sed -n 's/^SUPABASE_ACCESS_TOKEN_GOODFOOD=//p' .env)
TABULKY=(drive_log firmy kategorie limity notifikace sheets_log transakce transakce_historie zamestnanci zamestnanec_firma storage_objects)

sql="begin;"
for t in "${TABULKY[@]}"; do sql+=" drop table if exists zaloha.${t}_$SUF;"; done
sql+=" commit;"
curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$sql" '{query:$q}')"
echo
echo "Záloha $SUF odstraněna."
