#!/usr/bin/env bash
# Záloha DB Helenky do schématu `zaloha` — celé uvnitř Supabase, nic se nestahuje lokálně.
# Každé spuštění vytvoří kopie tabulek s příponou, např. zaloha.transakce_20261030_1405,
# a k nim seznam souborů z bucketu receipts (zaloha.storage_objects_<přípona>).
# Schéma `zaloha` nemá práva pro anon/authenticated a PostgREST ho nevystavuje.
#
# Použití: db/zaloha.sh [přípona]        Návrat: db/zaloha-odstranit.sh <přípona>
set -euo pipefail
cd "$(dirname "$0")/.."

REF=ekfjznjzmlslrtatervl
SUF=${1:-$(date +%Y%m%d_%H%M)}
[[ $SUF =~ ^[0-9_]+$ ]] || { echo "Přípona smí obsahovat jen číslice a _" >&2; exit 1; }
TOKEN=$(sed -n 's/^SUPABASE_ACCESS_TOKEN_GOODFOOD=//p' .env)
ANON=$(sed -n 's/^const SB_KEY = "\(.*\)";/\1/p' src/App.jsx)
TABULKY=(drive_log firmy kategorie limity notifikace sheets_log transakce transakce_historie zamestnanci zamestnanec_firma)

# SQL přes Supabase Management API; při chybě skončí
q() {
  local out
  out=$(curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg q "$1" '{query:$q}')")
  jq -e 'type == "array"' >/dev/null 2>&1 <<<"$out" || { echo "Chyba SQL: $out" >&2; exit 1; }
  echo "$out"
}

# ── Kopie ───────────────────────────────────────────────────
sql="begin;
create schema if not exists zaloha;
revoke all on schema zaloha from public, anon, authenticated;"
for t in "${TABULKY[@]}"; do
  sql+=" create table zaloha.${t}_$SUF as table public.$t;"
done
sql+=" create table zaloha.storage_objects_$SUF as select * from storage.objects where bucket_id = 'receipts';
revoke all on all tables in schema zaloha from public, anon, authenticated;
commit;"
q "$sql" >/dev/null
echo "Záloha vytvořena: přípona $SUF"

# ── Ověření počtů (public = živá data, mohla mezitím přibýt) ─
sql=""
for t in "${TABULKY[@]}"; do
  sql+="select '$t' as tabulka, (select count(*) from public.$t) as public, (select count(*) from zaloha.${t}_$SUF) as zaloha union all "
done
sql+="select 'storage.objects receipts', (select count(*) from storage.objects where bucket_id = 'receipts'), (select count(*) from zaloha.storage_objects_$SUF)"
q "$sql" | jq -r '.[] | "  \(.tabulka): public \(.public), záloha \(.zaloha)"'

# ── Ověření, že anon/authenticated na zálohu nedosáhnou ─────
q "select bool_or(has_schema_privilege(r, 'zaloha', 'usage')) as schema_usage,
          bool_or(has_table_privilege(r, c.oid, 'select,insert,update,delete')) as tabulky
   from pg_class c cross join unnest(array['anon','authenticated']) r
   where c.relnamespace = 'zaloha'::regnamespace and c.relkind = 'r'" \
  | jq -r '.[0] | "  práva anon/authenticated: schéma \(.schema_usage), tabulky \(.tabulky) (obojí musí být false)"'
kod=$(curl -s -o /dev/null -w '%{http_code}' "https://$REF.supabase.co/rest/v1/firmy_$SUF" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "Accept-Profile: zaloha")
echo "  REST s anon klíčem na schéma zaloha: HTTP $kod (musí být 4xx)"
