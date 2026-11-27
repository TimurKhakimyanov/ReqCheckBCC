# Предложения к контракту API от сессии «Веб»

Контракт (`docs/api.md`) не менялся. Ниже — что веб предполагает там, где контракт молчит, и что было бы удобнее.
Мок-сервер (`services/web/src/mocks/handlers.ts`) реализует именно эти предположения — его можно использовать как пример ответов.

## Уточнения формы (веб уже на них рассчитан)

1. **`Run.summary` / `RunShort.summary`** — в контракте тип не задан. Веб ожидает
   `{requirements_total, findings_total, by_severity: {critical, major, minor}, critical_finding_ids, ready_for_development}`,
   т. е. `Report.summary` + `Report.conclusion.ready_for_development`. Без `ready_for_development` в истории прогонов
   не будет колонки «Итог».
2. **`FindingReview`** = `{finding_id, status: open|accepted|false_positive|fixed, comment: string|null, updated_at: string|null}`.
   Для дефекта без решения `GET /runs/{id}/findings` отдаёт `review` со `status: "open"` (не `null`).
3. **`POST /auth/login` и `PATCH /auth/me`** — веб принимает и `{user: User}`, и сам `User`.
4. **`GET /usage`** — элементы: `by_provider: [Usage & {provider, model?}]`, `by_day: [Usage & {day: "YYYY-MM-DD"}]`.
5. **`GET /audit`** — `details` — объект (JSON) или строка; `target` может быть `null`.
6. **`GET /search`** без `kind` ищет и требования, и дефекты.
7. **`ProgressEvent` в SSE прогресса** — для стадии `checking_requirements` веб показывает `current / total`, если они есть.

## Предложения

1. **Ошибка в потоке чата.** Если модель упала посреди ответа, отдавать `event: error` с `data: {"detail": "...", "code": "..."}`
   перед закрытием потока (веб это уже обрабатывает). Сейчас контракт описывает только `token` и `done`.
2. **Лимит загрузки в UI.** `MAX_UPLOAD_MB` веб сейчас знает только как константу 25. Удобно отдать его, например,
   в `GET /health` (`limits: {max_upload_mb}`) или в `GET /auth/me` — тогда проверка размера на клиенте совпадёт с сервером.
3. **Выгрузки и исходный файл.** Веб скачивает их через `fetch` + Blob (работает с cookie). Нужен заголовок
   `Content-Disposition: attachment; filename*=UTF-8''<имя>` — имя файла берётся из него.
4. **`Document.last_run`** — включать `summary` (как в п. 1), чтобы в списке документов были счётчики дефектов без доп. запросов.
5. **Встроенные материалы базы знаний** (`source: builtin`) — веб не даёт их удалять; лучше, чтобы и API отвечал `409` на `DELETE`.
