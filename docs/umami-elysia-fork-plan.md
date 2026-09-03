# План: лёгкий self-hosted Umami на Elysia

## Идея

Umami — монолит на Next.js (SSR-дашборд + API-роуты в одном процессе), поэтому
жрёт ~220MB даже в простое. Аналитика в проде нам нужна только со стороны
API (трекинг + MCP), дашборд смотрим редко и не с VPS.

Разделяем:

- **Бэкенд** (приём трекинга + REST API) — тонкая обёртка на **Elysia/Bun**,
  которая вендорит и напрямую импортирует бизнес-логику из апстрима Umami
  (`lib/`, `queries/`, `prisma/`, нужные `route.ts`). Крутится 24/7 на VPS.
  Цель — уложиться в **<100MB**.
- **Фронтенд** — оригинальный, непорченный Next.js-дашборд Umami. На VPS не
  живёт вообще. Запускается локально на своей машине только когда нужно
  посмотреть глазами — подключается к той же БД (Neon Postgres) напрямую.

Разделения по HTTP между ними нет — единственная точка связи — общая база.
Дашборд читает через свои же `/api/*`-роуты (client-side fetch,
`WebsitesPage.tsx` и т.п. помечены `'use client'`), но исполняет их в своём
собственном локальном Next-процессе, который просто ходит в тот же Neon.

## Почему это реально (проверено на исходниках v3.3.1)

- `src/app/api/send/route.ts` (главный ingestion-эндпоинт, на который бьёт
  `script.js`) и `src/app/api/batch/route.ts` — **ноль импортов `next/*`**,
  чистый Web-standard `Request`/`Response`. Сам Umami внутри уже вызывает
  `send.POST(newRequest)` напрямую в обход роутинга Next — то есть авторы
  сами трактуют это как чистую функцию.
- `checkAuth`/`parseRequest` (`src/lib/auth.ts`, `src/lib/request.ts`) —
  bearer-токен из `request.headers.get('authorization')`, не
  `cookies()`/`headers()` из `next/headers`. Не завязаны на Next-контекст.
- Next-специфичный код (`NextResponse`) нашёлся только в
  `(collect)/p/[slug]` (email pixel-трекинг) и `(collect)/q/[slug]`
  (короткие ссылки с редиректом) — обе фичи мы не используем, можно не
  портировать вообще.
- Дашборд — не SSR с прямыми Prisma-вызовами в Server Component, а
  client-side SPA поверх Next (`'use client'` + react-query), поэтому не
  требует какой-либо интеграции с бэкендом кроме общей БД.

## Что вендорим из апстрима

```
lib/            — auth.ts, jwt.ts, crypto.ts, password.ts, db.ts, prisma.ts,
                   request.ts, response.ts, schema.ts, filters.ts, ...
                   (+ их *.test.ts — бесплатное регресс-покрытие)
queries/         — prisma/ и sql/ слои
prisma/          — schema + migrations (как есть)
app/api/         — только нужные route.ts:
                     auth/, send, batch, heartbeat, websites/, teams/,
                     users/, realtime/, reports/, boards/, me/, config/
```

**Не трогаем**: `src/app/(main)/*` (дашборд UI), `src/components/*`,
`(collect)/p`, `(collect)/q` (pixel/link — не нужны).

## Elysia-обёртка

- Роутинг: `app.post('/api/auth/login', ({request}) => loginRoute.POST(request))`
  и так по каждому вендоренному `route.ts` — тонкая склейка, не рерайт логики.
- Мидлвары через готовые плагины Elysia (`@elysiajs/cors`, rate-limit) —
  не реализуем вручную.
- Тот же `DATABASE_URL` (Neon), тот же Prisma-schema.
- `APP_SECRET` может отличаться от локального Next — токены не шарятся
  между инстансами, каждый минтит свои.

## Prisma-клиент под Bun (без Rust query engine)

Апстримный Umami генерирует классический Prisma Client (`provider = "prisma-client-js"`),
который тащит за собой нативный Rust query engine (`libquery_engine`, десятки MB
бинарника под платформу). В library engine mode (дефолт) это не отдельный
процесс, а N-API-аддон, загруженный в тот же процесс — то есть поверх уже
поднятого V8/Bun-рантайма живёт второй рантайм (свой tokio thread pool, свой
connection pool с дефолтными настройками). Driver adapter (`adapter-pg`)
убирает этот второй рантайм: соединения идут через обычный `pg.Pool`,
который явно контролируется (`max: N`), без встроенного Rust-движка.

Что это даёт **точно**: меньше размер образа/бандла (нет платформенного
бинарника) и быстрее cold start. Что **не проверено**: реальный выигрыш по
steady-state RSS для долгоживущего процесса на VPS — официальные материалы
Prisma про driver adapters упирают в основном на bundle size и
serverless/edge cold start, а не на RSS-бенчмарки 24/7-процесса. Поэтому
перед тем как закладывать это в цель «<100MB», нужно **измерить** RSS
обоих вариантов (`prisma-client-js` vs `prisma-client`+`adapter-pg`) на
реальном Neon-подключении под нагрузкой, а не полагаться на предположение
(см. [bun.com/guides/ecosystem/prisma-postgres](https://bun.com/guides/ecosystem/prisma-postgres) — сам гайд про
это не пишет, там только setup):

- Зависимости: `@prisma/client` + `@prisma/adapter-pg` (вместо стандартного
  движка), `prisma` как dev-dependency.
- В вендоренном `prisma/schema.prisma` меняем generator-блок на:
  ```prisma
  generator client {
    provider   = "prisma-client"
    output     = "./generated"
    engineType = "client"
    runtime    = "bun"
  }
  ```
  (апстримный generator `prisma-client-js` — не трогаем остальную часть
  схемы/миграций, только generator-секцию в форке).
- Инициализация клиента через `PrismaPg`-адаптер (`@prisma/adapter-pg`) с тем
  же `DATABASE_URL` (Neon) — `prisma/db.ts` создаёт `new PrismaClient({adapter})`.
- **Важно**: Bun не подхватывает `.env` автоматически при запуске CLI с
  `--bun`, поэтому все Prisma-команды идут с явным `--env-file=.env`:
  - генерация клиента: `bun run --bun --env-file=.env prisma generate`
  - миграции: `bun run --bun --env-file=.env prisma migrate deploy`
    (в проде — `deploy`, не `dev`)
- Нужно перепроверить, что вендоренные `queries/prisma/*` (raw Prisma Client
  API вызовы) совместимы с новым client-generator API — интерфейс в целом
  совместим, но это отдельная точка проверки на M0, до переноса остальных
  route-групп.

## CI/CD: автоматический трекинг релизов Umami

1. Периодический воркфлоу (cron) или watch на новые теги
   `umami-software/umami`.
2. При новом релизе: синхронизировать вендоренные директории
   (`lib/`, `queries/`, `prisma/`, список `route.ts`) в форк.
3. `tsc --noEmit` — компилятор сразу указывает, что из апстрима сломало
   сигнатуры/импорты (в этом весь смысл — "тихого дрифта" не бывает).
4. Прогнать тесты — как собственные (эндпоинты, auth), так и вендоренные
   `*.test.ts` из `lib/` (они идут в комплекте с исходниками).
5. **Зелёный CI → авто-деплой** (тот же паттерн, что уже используется для
   shalotts: GitHub Release + poller на VPS подхватывает новый образ).
6. **Красный CI → ручной патч** мелочей (обычно 2-3 места, на которые
   указал компилятор), затем деплой вручную.

Ожидание: большинство релизов Umami проходят автоматически (ingestion-путь
уже показал себя стабильным/чистым), ручное вмешательство — редкое
исключение при более глубоких рефакторах апстрима.

## Деплой на VPS

Заменяет текущий `ghcr.io/umami-software/umami` контейнер на новый лёгкий
образ. Домен/Caddy-конфиг (`stats.shalotts.site`) не меняются — внешний
API-контракт идентичен (те же пути `/api/*`), MCP-интеграция продолжает
работать без изменений.

## Открытые риски / что проверить перед стартом

- Остальные route-группы (`websites/`, `teams/`, `reports/`, `boards/`,
  `realtime/`) пока не аудированы на Next-coupling — проверены только
  `send`, `batch`, `auth/login`, `heartbeat`. Нужен точечный проход перед
  переносом каждой.
- Redis/ClickHouse сейчас не используются нигде в проде — если понадобятся
  session replay/heatmaps/geoip в будущем, эти code-path'ы не проверялись.
- Нужно решить, где хранить форк (отдельный репозиторий) и на чём крутить
  CI (GitHub Actions, как у shalotts).
- Смена Prisma generator'а (`prisma-client-js` → `prisma-client` + adapter-pg)
  — не проверена на реальном коде `queries/prisma/*` апстрима; если там есть
  места, завязанные на специфику старого клиента (например, `$transaction`
  особенности, raw SQL хелперы), потребуется точечная адаптация на M0.
- Выигрыш driver adapter'а по RAM (не только по размеру образа) — гипотеза,
  не измерение. Нужно на M0 сравнить RSS обоих вариантов клиента под
  реальной нагрузкой на VPS, прежде чем считать это частью бюджета <100MB.

## Порядок реализации

1. **M0** — каркас Elysia-приложения, вендорим `lib/`+`queries/`+`prisma/`,
   переводим generator на `prisma-client`/`engineType = "client"`/
   `runtime = "bun"` + `@prisma/adapter-pg` (см. «Prisma-клиент под Bun»),
   поднимаем `/api/heartbeat`, `/api/auth/login`, `/api/send` — ручная
   проверка против Neon.
2. **M1** — остальные нужные route-группы (`websites`, `teams`, `users`,
   `realtime`, `reports`, `boards`, `me`, `config`, `batch`).
3. **M2** — Dockerfile + compose-сервис на VPS, `mem_limit`, замена текущего
   контейнера umami, сквозная проверка (трекер + MCP работают).
4. **M3** — автоматизация: sync-скрипт + CI-воркфлоу слежения за релизами
   апстрима, авто-деплой на зелёный прогон.
5. **M4** (опционально) — локальный workflow "поднять дашборд на своей
   машине по требованию", задокументировать (`.env` → тот же `DATABASE_URL`).
