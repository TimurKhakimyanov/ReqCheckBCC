#!/bin/sh
# Заполняет пустые секреты в .env случайными значениями. Запускается только в Docker, из корня репозитория:
#   docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work alpine:3 sh deploy/secrets/generate.sh
# Если .env нет — создаёт его из .env.example. Непустые значения не меняет (повторный запуск безопасен).
# Значения change-me тоже считаются пустыми. Сами секреты на экран не выводятся.
set -eu

ENV_FILE="${1:-.env}"
EXAMPLE=".env.example"

if [ ! -f "$ENV_FILE" ]; then
  [ -f "$EXAMPLE" ] || { echo "Нет ни $ENV_FILE, ни $EXAMPLE — запускайте из корня репозитория" >&2; exit 1; }
  cp "$EXAMPLE" "$ENV_FILE"
  echo "Создан $ENV_FILE из $EXAMPLE"
fi

rand_alnum() { tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"; }
# Ключ Fernet: 32 случайных байта в base64url (44 символа) — то же, что cryptography.fernet.Fernet.generate_key().
fernet_key() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n'; }

current() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r'; }

set_value() {
  key="$1"; value="$2"
  if grep -q "^$key=" "$ENV_FILE"; then
    tmp="$ENV_FILE.tmp.$$"
    awk -v k="$key" -v v="$value" 'BEGIN { FS = OFS = "=" } $1 == k { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"   # сохраняем владельца и права файла
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

generated=""
fill() {
  key="$1"; gen="$2"
  val="$(current "$key")"
  if [ -z "$val" ] || [ "$val" = "change-me" ]; then
    set_value "$key" "$($gen)"
    generated="$generated $key"
  fi
}

pw() { rand_alnum 32; }
long() { rand_alnum 48; }

fill APP_SECRET_KEY long
fill APP_ENCRYPTION_KEY fernet_key
fill ADMIN_PASSWORD pw
fill POSTGRES_PASSWORD pw
fill REDIS_PASSWORD pw
fill QDRANT_API_KEY long
fill S3_SECRET_KEY long
fill GRAFANA_ADMIN_PASSWORD pw

# Логины: если пусты — значения по умолчанию.
for pair in ADMIN_USERNAME:admin POSTGRES_USER:reqcheck S3_ACCESS_KEY:reqcheck GRAFANA_ADMIN_USER:admin; do
  key="${pair%%:*}"; def="${pair#*:}"
  [ -n "$(current "$key")" ] || { set_value "$key" "$def"; generated="$generated $key"; }
done

chmod 600 "$ENV_FILE" 2>/dev/null || true

if [ -n "$generated" ]; then
  echo "Заполнено в $ENV_FILE:$generated"
  echo "Пароль входа в веб: ADMIN_USERNAME / ADMIN_PASSWORD, в Grafana: GRAFANA_ADMIN_USER / GRAFANA_ADMIN_PASSWORD (см. $ENV_FILE)."
else
  echo "Все секреты в $ENV_FILE уже заданы — ничего не изменено."
fi
