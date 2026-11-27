# syntax=docker/dockerfile:1.7
# ReqCheck embedder. Контекст сборки — корень репозитория.
# Локальная модель скачивается на этапе сборки — в рантайме сервис работает без интернета.
FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv
ENV UV_SYSTEM_PYTHON=1 UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/models
WORKDIR /repo
# torch только CPU (без CUDA, образ в разы меньше)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --index-url https://download.pytorch.org/whl/cpu "torch>=2.4,<3"
COPY services/embedder services/embedder
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install -e "./services/embedder[local]"

FROM base AS runtime
ARG AGENT_VERSION=dev
ARG EMBEDDINGS_MODEL=intfloat/multilingual-e5-small
ENV AGENT_VERSION=${AGENT_VERSION} EMBEDDINGS_MODEL=${EMBEDDINGS_MODEL}
RUN python -c "import os; from sentence_transformers import SentenceTransformer as S; \
m = S(os.environ['EMBEDDINGS_MODEL'], device='cpu'); print('model ready, dim', m.get_sentence_embedding_dimension())" \
    && chmod -R a+rX /models
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=2
RUN useradd --system --uid 10001 --home /nonexistent app
WORKDIR /repo/services/embedder
USER app
EXPOSE 8001
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=10 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/info', timeout=2)"
CMD ["uvicorn", "embedder.main:app", "--host", "0.0.0.0", "--port", "8001", "--no-access-log"]

FROM base AS test
RUN --mount=type=cache,target=/root/.cache/uv uv pip install -e "./services/embedder[test]"
ENV HF_HUB_OFFLINE=1 EMBEDDINGS_PROVIDER=hash
WORKDIR /repo/services/embedder
CMD ["pytest", "-q", "-p", "no:cacheprovider"]
