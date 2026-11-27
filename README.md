# ReqCheck — агент проверки требований

ИИ-агент статической проверки документа с требованиями по ISO/IEC/IEEE 29148:2018 (п. 5.2.5, 5.2.6)
и IEEE Std 830-1998 (п. 4.3). Выделяет требования, проверяет каждое и набор целиком, пишет отчёт на русском.
Есть CLI (одна команда) и веб-интерфейс со стеком для развёртывания у себя.

- Постановка: [docs/task.md](docs/task.md)
- Архитектура: [docs/architecture.md](docs/architecture.md), HTTP API: [docs/api.md](docs/api.md)
- Бэклог: [BACKLOG.md](BACKLOG.md)

<!-- ===================== Раздел сессии «Ядро» ===================== -->
## Быстрый прогон агента (CLI)

> Раздел дописывает сессия «Ядро»: как получить ключ LLM, куда положить, команда запуска, куда ляжет отчёт.

<!-- ===================== Раздел сессии «Инфраструктура» ===================== -->
## Развёртывание

> Раздел дописывает сессия «Инфраструктура».

```bash
cp .env.example .env   # заменить все change-me
docker compose up -d --build
```

<!-- ===================== Раздел сессии «Бэкенд» ===================== -->
## API и воркер

> Раздел дописывает сессия «Бэкенд».

<!-- ===================== Раздел сессии «Веб» ===================== -->
## Веб-интерфейс

> Раздел дописывает сессия «Веб».

<!-- ===================== Общий раздел ===================== -->
## Тесты

Все тесты запускаются только в Docker:

```bash
docker compose --profile test run --rm --build test-contracts
docker compose --profile test run --rm --build test-core
docker compose --profile test run --rm --build test-api
docker compose --profile test run --rm --build test-worker
docker compose --profile test run --rm --build test-embedder
docker compose --profile test run --rm --build test-web
```
