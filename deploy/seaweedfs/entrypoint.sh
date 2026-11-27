#!/bin/sh
# Запуск SeaweedFS (master + volume + filer + S3 в одном процессе) с ключами S3 из окружения.
# s3.json не умеет подставлять переменные, поэтому собираем его при каждом старте контейнера.
# В фоне создаём бакет ${S3_BUCKET}; healthcheck зелёный только когда бакет существует.
set -eu

: "${S3_ACCESS_KEY:?S3_ACCESS_KEY не задан}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY не задан}"
: "${S3_BUCKET:?S3_BUCKET не задан}"

RUN_DIR=/tmp/seaweedfs
READY_FLAG="$RUN_DIR/bucket-ready"
mkdir -p "$RUN_DIR"
rm -f "$READY_FLAG"

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

umask 077
cat > "$RUN_DIR/s3.json" <<EOF
{
  "identities": [
    {
      "name": "reqcheck",
      "credentials": [
        { "accessKey": "$(json_escape "$S3_ACCESS_KEY")", "secretKey": "$(json_escape "$S3_SECRET_KEY")" }
      ],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    }
  ]
}
EOF
umask 022

# Фоновое создание бакета: ждём master и S3, затем s3.bucket.create (идемпотентно).
(
  i=0
  until wget -q -O /dev/null http://127.0.0.1:9333/cluster/healthz 2>/dev/null \
     && wget -q -O /dev/null http://127.0.0.1:8333/healthz 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -gt 120 ] && { echo "[seaweedfs-init] S3 не поднялся за 120 с" >&2; exit 1; }
    sleep 1
  done
  i=0
  while :; do
    if echo "s3.bucket.list" | weed shell -master=127.0.0.1:9333 2>/dev/null | grep -qE "^[[:space:]]*${S3_BUCKET}([[:space:]]|$)"; then
      touch "$READY_FLAG"
      echo "[seaweedfs-init] бакет ${S3_BUCKET} готов"
      exit 0
    fi
    echo "s3.bucket.create -name ${S3_BUCKET}" | weed shell -master=127.0.0.1:9333 >/dev/null 2>&1 || true
    i=$((i + 1))
    [ "$i" -gt 60 ] && { echo "[seaweedfs-init] не удалось создать бакет ${S3_BUCKET}" >&2; exit 1; }
    sleep 2
  done
) &

exec weed server \
  -dir=/data \
  -ip=seaweedfs \
  -ip.bind=0.0.0.0 \
  -master.volumeSizeLimitMB="${SEAWEEDFS_VOLUME_SIZE_MB:-1024}" \
  -volume.max=0 \
  -filer \
  -s3 \
  -s3.config="$RUN_DIR/s3.json" \
  -metricsPort=9324
