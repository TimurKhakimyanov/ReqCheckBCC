# Ollama с моделями, вшитыми в образ на этапе сборки (профили offline и gpu).
# Список моделей — переменная OLLAMA_MODELS в .env (через запятую), в сборку приходит как OLLAMA_PULL_MODELS.
# Имя аргумента отличается намеренно: OLLAMA_MODELS внутри Ollama — это путь к каталогу моделей.
# Интернет нужен только при сборке; готовый образ работает без сети.
FROM ollama/ollama:0.40.18

ARG OLLAMA_PULL_MODELS=""
ENV OLLAMA_MODELS=/models \
    OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_NOPRUNE=1

RUN set -eu; \
    mkdir -p /models; \
    models=$(printf '%s' "$OLLAMA_PULL_MODELS" | tr ',' ' '); \
    if [ -z "$(printf '%s' "$models" | tr -d ' ')" ]; then \
      echo "OLLAMA_MODELS пуст — образ без моделей (скачайте позже: docker compose exec ollama ollama pull <модель>)"; \
      exit 0; \
    fi; \
    ollama serve >/tmp/ollama-build.log 2>&1 & \
    pid=$!; \
    i=0; until ollama list >/dev/null 2>&1; do \
      i=$((i + 1)); [ "$i" -gt 60 ] && { cat /tmp/ollama-build.log; exit 1; }; sleep 1; \
    done; \
    for m in $models; do echo "==> ollama pull $m"; ollama pull "$m"; done; \
    ollama list; \
    kill "$pid"; wait "$pid" 2>/dev/null || true; \
    rm -f /tmp/ollama-build.log

EXPOSE 11434
