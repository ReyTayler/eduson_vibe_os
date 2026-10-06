# Недельные кредиты: учёт денег и токенов

Текущая политика платформы, generation 5, введена 7 октября 2026. Она заменяет admission по сырым токенам из [generation 4](weekly-quota.md). Ученические проекты, чаты, файлы и журнал модельных запросов сохраняются.

## Бюджет и единицы

- Каждому ученику: 1 000 кредитов = $1 за московскую неделю, на все его проекты и чаты вместе.
- 1 кредит = $0.001; минимальная внутренняя единица — nano-USD ($0.000000001). Расчёт хранится целыми числами; отображение с двумя десятичными знаками не меняет ledger.
- Начисления администратора: целое положительное количество кредитов, отдельная операция на выбранный аккаунт.
- student01: отдельно одобренный бонус 2 000 кредитов ($2); суммарный лимит 3 000 до 11 октября 2026, 23:59 МСК. Фактический остаток ниже лимита на уже накопленный расход и активные резервы.
- Сброс: воскресенье ровно 23:59:00 Europe/Moscow. Остаток и дополнительные кредиты не переносятся. История остаётся.
- Операторский бюджет платных испытаний остаётся отдельным: 1 млн сырых токенов за всё время; новый лимит денег учеников его не увеличивает.

## Проверенный тариф

[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/), проверено 07.10.2026. Используется `deepseek-flash` (DeepSeek-V4.1-Flash). Цены в долларах за миллион токенов:

| Категория    | Вне пика |   Пик |
| ------------ | -------: | ----: |
| Вход из кэша |    0.003 | 0.006 |
| Новый вход   |     0.15 |  0.30 |
| Выход модели |     0.60 |  1.20 |

Пик: будни 01:00–04:00 и 06:00–10:00 UTC, то есть 04:00–07:00 и 09:00–13:00 МСК, исключая китайские государственные праздники. Другие часы и выходные — вне пика.

Календарь 2026 взят из [уведомления Госсовета КНР](https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html): 01–03 января, 15–23 февраля, 04–06 апреля, 01–05 мая, 19–21 июня, 25–27 сентября, 01–07 октября. В рабочие субботы действует правило выходного дня DeepSeek. Для ещё не подтверждённого календаря другого года возможные будние пиковые интервалы считаются пиковыми. Это консервативная оценка; календарь следует обновить до 2027.

Расчёт стоимости использует подтверждённые `usage` API и опубликованный тариф. Он обозначен `published-tariff-estimate`: это не сверка счёта провайдера. Изменение цены или модели требует проверки и новой версии pricing; старые записи не переоцениваются автоматически.

## Какие токены считаются

Шлюз читает Anthropic SSE, а не длину видимого текста. У этого протокола независимые счётчики:

| Поле upstream                 | Наше поле               | Тариф  |
| ----------------------------- | ----------------------- | ------ |
| `input_tokens`                | inputTokens: новый вход | input  |
| `cache_read_input_tokens`     | cacheReadTokens         | cache  |
| `cache_creation_input_tokens` | cacheWriteTokens        | input  |
| `output_tokens`               | outputTokens            | output |

Сохранение нового кэша учитывается как новый вход; по имеющимся реальным ответам этот счётчик равен нулю. Reasoning является частью output; отдельно ещё раз не начисляется. Протокол [DeepSeek Anthropic](https://api-docs.deepseek.com/guides/anthropic_api/) отличается от Responses/OpenAI, где cached_tokens является подмножеством input_tokens: нельзя переносить формулу без нормализации.

```text
cost_nanos =
  (input_tokens + cache_creation_input_tokens) * input_rate_nanos
  + cache_read_input_tokens * cache_rate_nanos
  + output_tokens * output_rate_nanos

spent_credits = cost_nanos / 1_000_000
cache_fraction_of_input = cache_read / (input + cache_read + cache_write)
```

Пример сохранённого ученического запроса из восьми вызовов: 3 078 нового входа, 492 928 кэша, 7 320 выхода; всего 503 326. Кэш составляет 97.93% всех токенов и 99.38% входа. Внепиковая оценка: $0.006332484 = 6.332484 кредита. Восемь повторных подач растущего контекста создают большой сырой счётчик без сравнимого денежного расхода. Подробные численные свидетельства — [разбор usage](../evidence/credit-usage-diagnosis.json).

## Admission и settlement

`services/model-gateway/credit-ledger.mjs` — единственный writer денежного ledger. Наследование legacy Ledger используется для сохранения старой схемы и операторской политики, но student admission через сырые `reserve()` запрещён: `CREDIT_ENVELOPE_REQUIRED`.

В SQLite `BEGIN IMMEDIATE` один вызов атомарно:

1. Проверяет уникальный request UUID, student capability, enabled и watermark недели.
2. Выбирает московский bucket.
3. Вычисляет `remaining = base + grants - spent - held`.
4. Резервирует вход по верхней оценке `bytes(request UTF-8) + 32768` токенов и пиковой цене. Кэш заранее не предполагается.
5. Вычисляет разрешённый max_tokens из остатка денег, размера контекста и обнаруженного лимита модели. Платформа не вводит фиксированного меньшего лимита отдельного ответа.
6. Записывает исходный token envelope, student/week scope и точный денежный резерв.
7. Фиксирует транзакцию **до** передачи запроса провайдеру.

```text
input_reserve_nanos = input_ceiling * peak_input_rate
max_output = min(requested, provider_max, context-input_ceiling,
                 floor((remaining_nanos-input_reserve_nanos)/peak_output_rate))
reserve_nanos = input_reserve_nanos + max_output*peak_output_rate
```

Резерв использует peak даже вне пика: вызов без абсолютного deadline может пересечь границу тарифа. Обычный завершённый вызов целиком вне пика списывает внепиковую стоимость. При пересечении используется наибольший тариф в интервале отправка–завершение; это консервативное правило, а не утверждение о точном моменте тарификации DeepSeek.

На `message_stop` в одной транзакции CAS `sent → settled` записывает сырые usage, стоимость, версию pricing, конкретные ставки и время. Неиспользованная часть резерва освобождается. Повторный settlement запрещён. Если usage превысил envelope или стоимость — резерв, новые вызовы глобально блокируются до разбора оператором.

Отклонение до inference с HTTP 400/401/402/403/404/413/422/429 освобождает денежный резерв с нулевой стоимостью; статус HTTP остаётся в журнале. Для 5xx, разрыва/отмены потока, отсутствующего message_stop или рестарта после sent стоимость неизвестна: весь резерв остаётся held и **не отображается как подтверждённое списание**. При отсутствии API usage нельзя обещать точный расход. Операторская сверка неопределённых запросов остаётся отдельной задачей; автоматического возврата таких сумм нет.

Поздний settlement сохраняет исходную неделю, включая старый бонус. На границе периода новая неделя доступна без cron/очистки истории. Watermark не разрешает заново открыть прежнюю неделю при откате системных часов.

## Схема и миграция

`model_requests`, `request_scopes`, `weekly_budgets` и `weekly_grants` сохраняются. Старые `limitTokens` и `remainingAuthorizationTokens` — архивные диагностические поля; они не решают student admission после generation 5.

Новые таблицы в той же `tokens.sqlite`:

- `credit_policy`: generation, фиксированная денежная база, версия pricing.
- `credit_requests`: request_id FK, версия, created_ms, reserved_nanos, actual_nanos, ставки input/cache/output, band, ended_ms, estimated.
- `weekly_credit_grants`: UUID PK, student, period_start FK, nanos, actor, note, created_ms. UPDATE/DELETE запрещены триггерами.

Перед production migration остановлены новые portal admission; проверено отсутствие queued/running; сделаны согласованные SQL backups. Исторические settled requests пересчитаны один раз по сохранённым usage, их времени и тарифу. Неподтверждённые старые envelopes оцениваются консервативно по peak_output для всего envelope: старые записи не содержат отдельной верхней границы input/output. Исходные журналы и токеновые бонусы не меняются. При последующих стартах уже записанная стоимость не пересчитывается.

## API и интерфейс

- Model student `/v1/status`: только собственный budget; `unit=credits`, limit/spent/reserved/remaining Credits, usage breakdown, период и pricingVersion.
- Root operator `/v1/admin/overview`, `/v1/admin/grants?student=N`, `/v1/admin/usage?student=N`. Usage возвращает до 30 последних вызовов.
- Root-only broker relay: `admin-budgets`, `admin-grants`, `admin-usage`, `admin-grant`; capabilities не попадают в browser/API user response.
- Browser `GET /api/admin/students` и `GET /api/admin/students/:id/{grants,usage}`: независимая администраторская cookie.
- `POST /api/admin/students/:id/grants`: requestId, credits, note, periodStartsAt. Student ID выводится из server user row; actor — из authenticated admin. Не принимать tokens на новом write API.
- Начисление требует admin session, Origin и CSRF. Один UUID повторяется при retry неизвестного результата; другой payload с тем же UUID даёт 409. При смене недели устаревшее новое начисление отклоняется.
- Старая форма с tokens после миграции отклоняется; для текущего UI нужна перезагрузка страницы.

В настройках ученика видны доступные/потраченные/зарезервированные кредиты, лимит и бонус, точный сброс и три категории токенов со стоимостью. В админке дополнительно доступны выбранный аккаунт, эквивалент начисления в USD, архив токенового бонуса и последние вызовы. UI обновляет остаток раз в 30 секунд, при visibility и на границе недели. Сервер делает admission по свежему ledger, независимо от UI cache.

## Проверки и эксплуатация

[93 offline tests](../evidence/credit-unit-tests.tap) проверяют миграцию, действительные SSE usage, денежный reserve/refund, >1m дешёвых cached tokens, concurrency, peak/holidays/boundaries, неизвестные исходы, explicit rejections, restart, CAS, бонус/idempotency, CSRF/identity и late settlement. Live acceptance выполняет единственную авторизованную операцию student01 +$2 с заранее сохранённым root-only UUID и проверяет доступ/UI без платных модельных запросов.

```sh
node --test --test-reporter=tap tests/model-gateway.test.mjs tests/weekly-budget.test.mjs tests/response-budget.test.mjs tests/model-history.test.mjs tests/extra-budget.test.mjs tests/credit-budget.test.mjs apps/portal/tests/admin-api.test.mjs
node apps/portal/tests/admin-credit-live.mjs
node apps/portal/tests/weekly-quota.mjs
node apps/portal/tests/history-harness.mjs
node apps/portal/tests/secret-scan.mjs
```

Backups и approved grant intent: root-only `/var/lib/vibe-os/operator-snapshots/credit-policy-20261007/`. Нельзя возвращать старую БД поверх новых расходов и начислений. Старый gateway будет считать токены, поэтому rollback к generation 4 после перехода — смена продуктовой политики, требующая отдельного решения и сохранения нового ledger. Для обычного исправления используют новую forward migration.

Расценки 2026 фиксированы явно; резерв гарантирует ограничение **по этой оценке**, при корректном reported usage и тарифе. Он не ограничивает расходы других систем на тех же API keys и не заменяет общий provider balance/account reconciliation.

## Результат развёртывания

[Финальная проверка](../evidence/credit-final.json): денежная квота работает на основной платформе, все пять сервисов active/enabled, распределение проектов пяти учеников — 3/0/0/0/0. Все исходные portal-данные и raw request/grant journals побайтово по значениям сохранены при миграции.

[Live admin acceptance](../evidence/admin-credit-acceptance.json) выполнила student01 +2 000 кредитов ровно один раз, проверила повтор/конфликт/CSRF, пять личных квот, московскую дату в браузере с другим timezone и desktop/mobile UI. Остаток на момент проверки: 2 920.875126 кредита, расход 79.124874 кредита ($0.079124874). Это snapshot, не постоянный остаток.

[Native Harness acceptance](../evidence/credit-history-harness.json): 20 tool rounds, 40 успешных файловых операций, продолжение того же чата после рестарта, корректные ошибки 429/обрыва потока/недельных кредитов; временный fixture удалён. 24 вызова использовали только локальный имитатор. Платных DeepSeek-вызовов этой работы — 0. [Проверка секретов](../evidence/student-secret-scan.json): восемь API keys, шесть паролей и двенадцать capabilities не найдены в исходниках, web assets, истории Harness/Git, журналах и process args/env.

[Обычная приёмка пяти недельных кошельков](../evidence/credit-weekly-acceptance.json) также прошла: mapping broker/API → собственный monetary ledger, защита от подмены student ordinal, точный московский сброс и бесплатная инициализация нового native Harness. Старый executable admin-bonus-live.mjs явно запрещён на generation 5, чтобы не подтверждать денежную политику архивными token-полями.
