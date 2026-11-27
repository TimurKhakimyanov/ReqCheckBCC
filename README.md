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

React + TypeScript + Vite, Tailwind + shadcn/ui, TanStack Query, i18next. Код — `services/web`.
Открывается на `http://localhost:${WEB_PORT}` (по умолчанию 8080), вход — `ADMIN_USERNAME` / `ADMIN_PASSWORD` из `.env`.

**Показать интерфейс без бэкенда** (все методы API имитируются MSW по `sample_report.json`, прогресс и чат — потоком):

```bash
docker compose --profile mock up -d --build web-mock   # http://localhost:8081, логин admin / admin
```

Порт меняется переменной `WEB_MOCK_PORT`. В демо-режиме прогон документа с `fail` в имени файла завершается ошибкой —
чтобы показать экран сбоя.

Что есть: вход; документы (drag & drop PDF/DOCX/MD/TXT, история прогонов); запуск прогона (провайдер, модель, опции);
прогресс по SSE; отчёт — текст документа с подсветкой цитат ↔ список дефектов, фильтры, решения по дефектам
(принят / ложное срабатывание / исправлен + комментарий), вкладки «Сводка и итог», «Нарезка», «Матрица», «Проверка набора»,
«Чек-лист», «Паспорт», выгрузка PDF/DOCX/MD/JSON; чат по отчёту; поиск по прошлым прогонам; база знаний; кабинет
(ключи провайдеров, проверка подключения, модель по умолчанию, язык, тема, пароль); расход токенов; журнал аудита.

- **Языки**: файл на язык в `services/web/src/locales/` (`ru.json`, `en.json`, черновик `kk.json`). Новый язык — новый файл,
  он появится в переключателе сам. Недостающие казахские строки показываются по-русски.
- **Тема и стиль**: все цвета, радиусы и шрифты — CSS-переменные в `services/web/src/index.css` (светлая и тёмная).
  Перекраска под фирменный стиль — правка токенов, компоненты не трогаются.
- **Типы отчёта** генерируются из JSON Schema контракта и лежат в git (`src/api/report.gen.ts`); тест падает, если они устарели.
  Перегенерировать: `docker compose -p reqcheck-web --profile test run --rm --build test-web pnpm gen:types` с монтированием
  каталога либо любой Node-контейнер с `pnpm gen:types` в `services/web`.
- **Корпоративный прокси с подменой TLS**: если сборка падает на `unable to verify the first certificate`, положите корневой
  сертификат в `services/web/certs/*.crt` (в git не попадает, см. `services/web/certs/README.md`).
- Пожелания веба к API: [docs/contract-changes/web.md](docs/contract-changes/web.md).

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
