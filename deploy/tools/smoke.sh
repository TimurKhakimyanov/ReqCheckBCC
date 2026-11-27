#!/usr/bin/env bash
# Смоук-тест инфраструктуры: доступность и здоровье postgres, redis, qdrant и S3 (SeaweedFS).
# Запуск: docker compose --profile test run --rm --build test-infra
set -uo pipefail

fail=0
ok()   { printf '  [OK]   %s\n' "$1"; }
bad()  { printf '  [FAIL] %s\n' "$1"; fail=1; }
step() { printf '\n== %s\n' "$1"; }

step "PostgreSQL ($PGHOST/$PGDATABASE)"
if pg_isready -q -t 10; then ok "pg_isready"; else bad "pg_isready"; fi
if v=$(psql -XAtq -v ON_ERROR_STOP=1 -c "select current_setting('server_version')" 2>&1); then
  ok "SELECT, версия сервера $v"
else bad "SELECT: $v"; fi
if out=$(psql -XAtq -v ON_ERROR_STOP=1 <<'SQL' 2>&1
create temp table smoke_t(id int, s text);
insert into smoke_t values (1, 'привет');
select s from smoke_t where id = 1;
SQL
); then
  [[ "$out" == "привет" ]] && ok "запись/чтение во временную таблицу (UTF-8)" || bad "неожиданный ответ: $out"
else bad "запись во временную таблицу: $out"; fi

step "Redis ($REDIS_HOST)"
export REDISCLI_AUTH="$REDIS_PASSWORD"
if [[ "$(redis-cli -h "$REDIS_HOST" ping 2>&1)" == "PONG" ]]; then ok "PING"; else bad "PING"; fi
key="smoke:$(date +%s%N)"
if redis-cli -h "$REDIS_HOST" set "$key" 1 EX 30 >/dev/null 2>&1 && [[ "$(redis-cli -h "$REDIS_HOST" get "$key")" == "1" ]]; then
  ok "SET/GET"; redis-cli -h "$REDIS_HOST" del "$key" >/dev/null
else bad "SET/GET"; fi
policy=$(redis-cli -h "$REDIS_HOST" config get maxmemory-policy 2>/dev/null | tail -n1)
[[ "$policy" == "noeviction" ]] && ok "maxmemory-policy=noeviction" || bad "maxmemory-policy=$policy (нужно noeviction для Celery)"
if REDISCLI_AUTH=wrong-password redis-cli -h "$REDIS_HOST" ping 2>&1 | grep -q PONG; then
  bad "Redis пускает с неверным паролем"
else ok "без пароля доступ закрыт"; fi

step "Qdrant ($QDRANT_URL)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$QDRANT_URL/readyz")
[[ "$code" == "200" ]] && ok "/readyz" || bad "/readyz → $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$QDRANT_URL/collections")
[[ "$code" == "401" || "$code" == "403" ]] && ok "без API-ключа доступ закрыт ($code)" || bad "без API-ключа → $code (ожидали 401/403)"
coll="smoke_$(date +%s)"
H=(-H "api-key: $QDRANT_API_KEY" -H 'Content-Type: application/json')
if curl -sf "${H[@]}" -X PUT "$QDRANT_URL/collections/$coll" -d '{"vectors":{"size":4,"distance":"Cosine"}}' >/dev/null \
  && curl -sf "${H[@]}" -X PUT "$QDRANT_URL/collections/$coll/points?wait=true" \
       -d '{"points":[{"id":1,"vector":[0.1,0.2,0.3,0.4],"payload":{"t":"smoke"}}]}' >/dev/null \
  && [[ "$(curl -sf "${H[@]}" -X POST "$QDRANT_URL/collections/$coll/points/query" \
       -d '{"query":[0.1,0.2,0.3,0.4],"limit":1,"with_payload":true}' | jq -r '.result.points[0].payload.t')" == "smoke" ]]; then
  ok "коллекция: создание, upsert, поиск"
else bad "коллекция: создание/upsert/поиск"; fi
curl -s "${H[@]}" -X DELETE "$QDRANT_URL/collections/$coll" >/dev/null || true

step "S3 / SeaweedFS ($S3_ENDPOINT_URL, бакет $S3_BUCKET)"
if rclone lsd s3: 2>/dev/null | grep -qE "[[:space:]]${S3_BUCKET}$"; then ok "бакет $S3_BUCKET существует"; else bad "бакета $S3_BUCKET нет"; fi
obj="smoke/$(date +%s%N).txt"
payload="reqcheck smoke $(date -u +%FT%TZ)"
if printf '%s' "$payload" | rclone rcat "s3:$S3_BUCKET/$obj" 2>/tmp/rclone.err \
   && [[ "$(rclone cat "s3:$S3_BUCKET/$obj" 2>>/tmp/rclone.err)" == "$payload" ]]; then
  ok "создание и чтение объекта"
else bad "создание/чтение объекта: $(tail -n3 /tmp/rclone.err)"; fi
rclone deletefile "s3:$S3_BUCKET/$obj" >/dev/null 2>&1 || true
if RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=wrong rclone lsd s3: >/dev/null 2>&1; then
  bad "S3 пускает с неверным ключом"
else ok "с неверным ключом доступ закрыт"; fi

echo
if [[ $fail -eq 0 ]]; then echo "ИТОГ: инфраструктура в порядке"; else echo "ИТОГ: есть ошибки"; fi
exit $fail
