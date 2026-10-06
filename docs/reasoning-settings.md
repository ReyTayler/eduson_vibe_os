# Reasoning и вывод 64K

> Лимит ответа 64K и ограничение шести шагов сняты. Текущая политика — возможности внешней модели и личная недельная квота: [реализация и проверки](response-policy.md). Ограничения 64K ниже относятся к предыдущему обновлению.

> С 6 октября 2026 года действует generation 4: **личный лимит 1 000 000 токенов на ученика в неделю**, сброс воскресенье 23:59 МСК. [Текущая схема, миграция и проверки](weekly-quota.md). Общий lifetime budget ниже описывает предыдущую реализацию.

Обновление 6 октября 2026 года. Доступно на `https://80.249.145.94/`. Модель остаётся DeepSeek V4.1 Flash / `deepseek-flash`.

## Пользовательский интерфейс

В каждом чате над полем сообщения есть «Рассуждения»:

| Выбор     | Native Anthropic Messages                                        |
| --------- | ---------------------------------------------------------------- |
| Выключены | `thinking: {type: "disabled"}`, без output_config                |
| Low       | `thinking: {type: "enabled"}`, `output_config: {effort: "low"}`  |
| High      | `thinking: {type: "enabled"}`, `output_config: {effort: "high"}` |
| Max       | `thinking: {type: "enabled"}`, `output_config: {effort: "max"}`  |

Выбор сохраняется отдельно для чата. Существующие и новые чаты по умолчанию используют «Выключены». Настройка фиксируется в run при отправке; дальнейшее изменение чата не меняет уже принятую работу. Пока помощник работает, UI блокирует выбор. Перезагрузка страницы сохраняет настройку.

`max_tokens=65536` для одного вызова. 64K здесь означает 65 536. Это верхний предел вывода, а не обязательная длина каждого ответа. При включённых рассуждениях reasoning расходует output tokens в том же лимите. Выбор reasoning не меняет модель.

Официальные параметры: [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/), [models metadata](https://api-docs.deepseek.com/api/list-models/). В native Anthropic wire используется output_config.effort; OpenAI reasoning_effort в этот endpoint не передаётся.

## Реализация

- `apps/portal/src/Workspace.tsx`: четыре режима, сохранение через authenticated PATCH чата; защита от отправки со старой настройкой при смене чата.
- `apps/portal/api/server.mjs`: idempotent migrations reasoning_mode в chats/runs, enum CHECK, ownership/CSRF, immutable run snapshot, idempotency также сравнивает режим.
- `services/workspace-broker/server.mjs`: передача режима через initialize; bounded engine lifecycle и native history cursor.
- `profiles/school-sdk.ts`: ReasoningEffortId передаётся в agent create/resume; max_tokens=65536 из root profile. Старый mock route сохраняет прежний default.
- `profiles/deepseek-model.ts`: четыре advertised усилия; serialization штатным pinned codec. Off явно превращается в thinking.type=disabled.
- `services/model-gateway/server.mjs`: exact enum/field validation; assistant thinking/signature replay допускается для tool cycles. Пользовательские thinking blocks, unknown effort и contradictory disabled+effort отклоняются до upstream.

Existing root-owned profiles обновлены, новые проекты получают те же параметры. Стартовые проекты, пользовательские проекты, чаты, пароли и ключи сохранены. Временные QA projects удалены; проекты ученика, созданные после первой выдачи кабинетов, не удаляются.

## Длинный ответ

Лимиты обновлены по всему пути, а не только в max_tokens:

- LLM request до 512 KiB, включая native reasoning replay; контекст объявлен 1 048 576 согласно модели, bounded request остаётся отдельным cap.
- Streaming response до 64 MiB, frame до 4 MiB; UTF-8/SSE обрабатываются через chunk boundaries.
- SDK event до 4 MiB, read page до 6 MiB; engine JSON-RPC и итоговый result до 8 MiB.
- Прежние срезы ответа/partial на 65 536 символах удалены; при превышении byte cap возвращается ошибка, без silent truncation.
- Один model call: до 20 минут; engine run: до 30 минут. Таймауты broker/API/SSE согласованы с этим временем.
- Предел protected history 8 MiB и project quota 128 MiB сохраняются. Длинные ответы могут раньше потребовать нового независимого чата.
- До шести модельных шагов в одной работе; 65 536 — предел каждого вызова, личный недельный token budget отдельно ограничивает все проекты и чаты ученика.
- Отображается итоговый ответ; reasoning history сохраняется для корректного native tool replay и не выводится отдельным полем в UI.

## Миллион токенов и миграция generation 3

Глобальный предел **1 000 000** сохранён. Расход не сбрасывался, новые ключи не добавлялись.

Перед upstream резервируется `max(131072, requestUtf8Bytes + 32768 + max_tokens)`. Сумма включает ограниченный input, output, запас для протокола и cache accounting. Большой replay получает больший резерв. Реальный terminal usage input/output/cache read/write заменяет резерв только после успешного завершения. Error/cancel/crash/unknown оставляют весь резерв.

Generation 3 разрешает разные debit envelopes. Миграция FULL/WAL атомарна, старые requests и authorization сохраняются в generation2 snapshot tables и переносятся с прежними ID, состояниями и usage. CHECK общего предела остаётся 1 000 000; unsupported generation отклоняется. Старые неизвестные запросы сохраняют свой исходный потолок, а новые получают увеличенный.

Перед обновлением создана root-only согласованная SQLite backup в `/var/lib/vibe-os/operator-snapshots/reasoning-20261006/`. Это локальная recovery copy, не внешний backup. Восстанавливать старый budget поверх новых платных записей нельзя.

## Проверка

- [27 offline gateway tests](../evidence/model-gateway-v3-tests.tap): 65536 accepted / 65537 rejected, четыре режима, explicit disabled, thinking/signature replay, malformed effort, native stream больше прежнего cutoff, atomic admission, migration v1/v2, неизменный cap и uncertain envelopes.
- [Бесплатная приёмка UI и настоящего Harness initialize](../evidence/reasoning-free-acceptance.json): четыре настройки, persistence/reload, mobile, maxTokens=65536.
- [Настоящий DeepSeek](../evidence/reasoning-live-acceptance.json): off/low/high/max, low write_file tool cycle, immutable snapshots и idempotency. Пять запросов, 4940 новых подтверждённых токенов.
- [Переключение внутри существующего чата](../evidence/reasoning-replay-acceptance.json): High → Off → Max с native history, три запроса, 2745 токенов.
- Строгая TypeScript и production build проходят. Новый функционал не требует смены ученических паролей.

Native canaries принимают max_tokens=65536, но намеренно просят короткие ответы. Генерация всех 64K ради проверки не проводилась; длинный stream проверен без платных токенов.
