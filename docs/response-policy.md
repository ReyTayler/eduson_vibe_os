# Ответы без отдельного лимита платформы

Изменение опубликовано 6 октября 2026 года на https://80.249.145.94/. Прежний лимит **65 536 токенов на вызов снят**. Собственный лимит числа шагов работы, абсолютный таймер модели 20 минут и таймер работы 30 минут также удалены. Недельная квота остаётся **1 000 000 токенов на ученика**, сброс воскресенье 23:59 МСК.

## Возможности внешней модели

Полностью бесконечный ответ внешний API не поддерживает. SDK получает contextWindow и maxOutputTokens через защищённый gateway GET /v1/models; эти параметры не задаются в ученическом профиле.

Подтверждено authenticated GET /models: DeepSeek-V4.1-Flash / deepseek-flash, контекст 1 048 576, вывод до **393 216 токенов на вызов**. [Сохранённая metadata без ключей](../evidence/response-provider-metadata.json). Этот предел устанавливает DeepSeek. Gateway использует обновлённые metadata, поэтому изменение внешнего maximum не требует добавления нового ученического maxTokens.

Официальные источники: [модельные поля /models](https://api-docs.deepseek.com/api/list-models/), [Anthropic Messages совместимость](https://api-docs.deepseek.com/guides/anthropic_api/), [актуальные параметры моделей](https://api-docs.deepseek.com/quick_start/pricing/). Поле max_tokens необходимо для согласованного ограниченного вызова API; его фактическое значение теперь определяют возможности модели и остаток недельной квоты.

## Как проходит admission

Браузер не задаёт max_tokens и не управляет владельцем квоты. Reasoning остаётся отдельной настройкой чата: Off/Low/High/Max.

1. SchoolDeepSeek получает metadata по собственной непрозрачной capability ученика. Профиль не содержит maxTokens/maxSteps. SDK использует максимальный вывод провайдера; upstream codec и native thinking/tool replay сохраняются.
2. Gateway проверяет protocol и положительное целое max_tokens. Проверки «больше 64K» или иного фиксированного верхнего значения ответа здесь нет.
3. В одной BEGIN IMMEDIATE транзакции Ledger фиксирует student, календарное окно и доступный остаток с учётом уже принятых параллельных запросов. Input ceiling — requestUtf8Bytes + 32 768, тот же консервативный запас протокола.
4. Допускаемый вывод: `min(requestedOutput, providerMaximum, remainingWeek - inputCeiling, contextWindow - inputCeiling)`. Если остаётся хотя бы один допустимый выходной токен, reserve равен inputCeiling + maxOutput. Фиксированного минимального списания/резерва 131 072 у новых модельных вызовов нет.
5. Gateway передаёт рассчитанный max_tokens upstream и сообщает его во внутреннем X-Vibe-Max-Output-Tokens. Это защищённое серверное поле, а не браузерный параметр.
6. Успешный terminal usage заменяет резерв реальным input/output/cache расходом. При cancel/error/unknown полный допустимый envelope сохраняется в исходной неделе. Старые записи и их резервы не меняются.

Так остаток меньше прежних 131 072 не блокирует запрос автоматически: вывод уменьшается под оставшуюся неделю. Консервативный input reserve всё ещё должен помещаться; он не считается подтверждённым расходом после успешного settlement. 1 000 000 включает input и output, поэтому нельзя отдавать весь остаток output, игнорируя стоимость входного контекста.

ID дедуплицируется глобально; late finish списывается в период admission. Отдельные пользовательские capabilities, SQLite CHECK лимита 1 000 000, календарные правила и clock rollback guard сохранены. Полной миграции или обнуления SQL не было. Операторская квота остаётся отдельной.

## Полный ответ и длительная работа

- Убрана обрезка текущего текста в UI после 65 536 символов. Поток сохраняется целиком и перерисовывается пачками каждые 100 мс. SSE status перед повторным replay сбрасывает transient buffer, чтобы reconnect не дублировал ранее полученный текст.
- Удалены проверки 8 MiB длины partial и результата в broker/API. Protected SDK поддерживает большие native events и read pages. Результат собирается до исчерпания доступных страниц, без прежнего лимита 40 страниц/1024 events.
- Приватные JSON-RPC и SSE frames собираются из частей: каждый входной фрагмент обходится один раз. Полная строка соединяется при завершении frame. Это устранило таймаут при чтении большого ответа и повторное копирование растущей строки.
- Gateway применяет **idle** watchdog пять минут, обновляемый каждым входным provider chunk/ping. Это защита от зависшего соединения, без предела общей длительности ответа. SDK больше не создаёт 20-минутный AbortSignal; отмена пользователя сохраняется.
- RuntimeMaxSec=1800 для engine и absolute deadline broker удалены. Portal stream больше не закрывается из-за 30-минутного таймера; действуют expiry/revocation сессии и keepalive. Internal RPC read имеет отдельный timeout I/O, обновляемый входными frame bytes.
- Безопасность исполнения, ограничения входного request/context, файловые права, project quota, process memory и transport guards сохранены. Они ограничивают ресурсы сервера и повреждённый протокол, не задают отдельное число токенов для ответа.

Transport guards увеличены: provider stream 512 MB, provider frame 128 MiB, private frame 256 MiB, SDK event/read page 128 MiB, protected history 96 MiB. MemoryMax: gateway 512 MiB, broker/API по 768 MiB, один engine 1024 MiB; одновременно работает один engine. Проектная квота 128 MiB и изоляция Runner сохраняются.

## Проверки и публикация

**55 offline tests**: 27 базовых gateway, 14 недельных, 14 новых response/admission. [TAP](../evidence/response-budget-tests.tap). Новые проверки покрывают вывод свыше 64K, provider maximum, возможность увеличения metadata без правки профиля, resize при малом остатке, отсутствие старого minimum, конкуренцию проектов, settlement/refund, unknown outcomes, reset, большой SSE frame и idle watchdog без абсолютного срока.

[Настоящий Harness и интерфейс с offline моделью](../evidence/response-harness-acceptance.json): восемь настоящих read_file через Runner и девятый model step; native tool-result replay; 90 026 символов в текущем/сохранённом UI; точное восстановление после reload; mobile без overflow; второй ответ **9 437 206 bytes** прошёл SDK, broker и portal и совпал в сохранённом чате. Это контролируемый fixture провайдера, не платная генерация DeepSeek большого ответа.

[Личные квоты пяти кабинетов](../evidence/weekly-quota-acceptance.json) и [четыре reasoning режима](../evidence/reasoning-free-acceptance.json) повторно проверены на опубликованной сборке без model prompts. Strict TypeScript profiles и production portal build проходят.

[Деплой](../evidence/response-policy-deploy.json) сохранил три человеческих проекта, все чаты, пароли и исторический расход: **31 запрос / 240 599 подтверждённых токенов**, без новых платных запросов для этого изменения. Существующие и новые project profiles используют одинаковую политику.

Backup кода/config и consistent SQLite перед публикацией: root-only `/var/lib/vibe-os/operator-snapshots/response-policy-20261006/`. Не восстанавливать старый budget поверх новых usage records.

```sh
# На сервере root; полностью offline.
node --test --test-reporter=tap tests/model-gateway.test.mjs tests/weekly-budget.test.mjs tests/response-budget.test.mjs

# Действующий сервер; protected credentials; все fixture удаляются.
# response-harness запускает отдельный mock socket только для собственного проекта.
node apps/portal/tests/response-harness.mjs
node apps/portal/tests/weekly-quota.mjs
node apps/portal/tests/reasoning.mjs
node apps/portal/tests/secret-scan.mjs
```
