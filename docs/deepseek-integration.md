# DeepSeek — ключи 20–27, Harness и общий бюджет

> Лимит ответа 64K и ограничение шести шагов сняты. Текущая политика — возможности внешней модели и личная недельная квота: [реализация и проверки](response-policy.md). Ограничения 64K ниже относятся к предыдущему обновлению.

> С 6 октября 2026 года действует generation 4: **личный лимит 1 000 000 токенов на ученика в неделю**, сброс воскресенье 23:59 МСК. [Текущая схема, миграция и проверки](weekly-quota.md). Общий lifetime budget ниже описывает предыдущую реализацию.

> Обновлено reasoning и max_tokens: доступны Off/Low/High/Max и вывод до 65 536 на вызов, budget generation 3. Актуальные параметры и новые проверки: [reasoning-settings](reasoning-settings.md). Ограничения 2048/16 KiB/generation 2 ниже описывают исходную версию кабинетов.

Состояние на 6 октября 2026 года. Ключи, сборки и проверки находятся на сервере `80.249.145.94`. Импортированы только записи №20–27. В браузер, исходники или чат эти ключи не передаются.

## Фактический результат

| Проверка                                                        | Платные запросы | Подтверждённые токены |
| --------------------------------------------------------------- | --------------: | --------------------: |
| Восемь ключей: authenticated GET /models и Messages             |               8 |                   152 |
| Исходный Harness: tool cycle и ответ                            |               2 |                   808 |
| Настоящий ученический UI: write_file и ответ в сохранённом чате |               2 |                  2175 |
| Холодные open/read, пять ученических профилей, outage/recovery  |               0 |                     0 |
| **Всего**                                                       |          **12** |              **3135** |

Фактическая usage включает input/output и cache read/write. Повтор terminal usage не учитывается второй раз. Незавершённых/uncertain запросов в итоговом ledger нет.

У первого ученика сохранились и файл `NOTES.md`, созданный через настоящий Harness, и ответ DeepSeek. Чат и файл видны после перезагрузки браузера. Все пять защищённых engine profiles дополнительно прошли холодное initialize/open/shutdown без генерации.

## Неизменный предел 1 000 000 токенов

Общая авторизация действует для всех восьми ключей и всех пяти кабинетов. Максимум не повышался и не сбрасывался. SQLite имеет CHECK для этого предела.

Текущая **generation 2** использует reserve/settle:

1. До каждой отправки atomically резервируются **65 536** токенов в FULL/WAL transaction. Подтверждённый расход плюс все активные/неясные резервы не может превысить миллион.
2. Только полная успешно завершённая SSE с проверенной terminal usage заменяет этот резерв фактической суммой input/output/cache read/cache write.
3. Cancel, ошибка upstream, оборванный stream, отсутствие usage, crash и иные неопределённые результаты оставляют полный резерв. Автоматического release/refund для них нет.
4. Duplicate request ID или повтор settlement не порождают вторую отправку/списание. Sent после startup recovery становится uncertain.
5. Результат фиксируется до пересылки message_stop. Вызов после исчерпания авторизации не отправляется upstream.

Один запрос: JSON до 16 KiB, только разрешённые text/tool messages, до 32 messages/64 blocks/8 tools; output до 2048. Thinking, изображения, remote files, произвольный endpoint и дополнительные provider fields запрещены. Резерв включает запас сверх bounded input/output. Исходные upstream errors не пересылаются caller. SSE ограничена 64 KiB/frame, 1 MiB/response, timeout 60 секунд. SDK retries отключены.

Текущий accounted debit: **3135**, доступная авторизация: **996865**, unresolved ceiling: **0**. `maxRemainingCalls=15` означает количество полных резервов, которые сейчас помещаются в остаток, а не пожизненный предел числа завершённых маленьких запросов.

### История generation 1

Первоначально каждая попытка безвозвратно учитывалась по потолку 65 536 независимо от меньшей usage. После десяти запросов старый debit был 655 360 при реальном расходе 960; это ограничивало дальнейший кабинет пятью попытками.

Переход на generation 2 введён явной миграцией с использованием проверенных завершённых usage. Старые request rows и token_budget generation 1 сохранены; legacyDebitedTokens=655360. Новый authorization ledger не стирает фактический расход и сохраняет полные суммы для неясных запросов. Исторические отчёты описывают прежнюю политику; текущая приведена выше.

Есть 20 offline tests: hard cap, parallel admission, duplicate, валидный terminal settlement, cache accounting, uncertain reservations, crash/reopen, повтор settlement, fail-closed generation/limit, vault/AAD tampering, wire limits и sanitation. Status идёт через private gateway HTTP и не открывает ledger вторым writer/не изменяет активный sent request.

## Хранение и привязка

- Ciphertext: `/var/lib/vibe-os/credentials/deepseek-20.json` … `deepseek-27.json`, AES-256-GCM, nonce 96 bit, AAD provider/credential ID/version.
- Master: `/etc/vibe-os/credentials/master.key`, root-only, вне Git/workspace.
- systemd LoadCredential передаёт master и opaque engine capability gateway process.
- Gateway UID 25000, ограниченный systemd unit; endpoint `/run/vibe-os-model/gateway.sock`, фиксированный upstream `https://api.deepseek.com`.
- Engine получает только capability закрытого gateway. API key, ciphertext directory, master и ledger в engine mount не присутствуют.
- Ученические tool ranges не получают model socket/capability.
- Студенты 1–5 используют keys 20–24 согласно root-owned profile; 25–27 остаются резервными. Учительский/classroom RBAC, ротация и restore credentials ещё не реализованы.

Root-only operator видит status, но browser API отдаёт лишь бюджет и доступность. Персональный project/Runner capability проверяется независимо от model capability.

## Harness и transport

Provider `school-deepseek`, model `deepseek-flash`; запуск через штатный `dsh --profile student`. Initialize принимает только фиксированную пару из профиля. Штатный credential adapter/fallback не подключён, глобальный fetch и agent loop не изменялись.

Использованы serializer/SSE decoder/translator upstream commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, MIT. AF_UNIX transport — собственный provider. Обновление pinned baseline требует повторных types/wire/composition tests.

Официальный [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/) поддерживает выбранный wire `/anthropic/v1/messages`. Доступность модели проверена authenticated GET /models каждого ключа.

## Доказательства

- [Discovery всех восьми keys](../evidence/deepseek-key-discovery.json), [Messages всех keys](../evidence/deepseek-key-smokes.json).
- [Исходный настоящий Harness](../evidence/deepseek-harness.json).
- [Настоящий ученический Harness в UI](../evidence/student-live-harness.json).
- [Холодные student sessions, outage и отзыв сессий](../evidence/student-lifecycle.json).
- [20 проверок gateway generation 2](../evidence/model-gateway-v2-tests.tap).
- [Исторический restart generation 1](../evidence/deepseek-budget-restart.json).
- [Исходная secret isolation](../evidence/deepseek-secret-isolation.json), [актуальный scan ключей/паролей/capabilities](../evidence/student-secret-scan.json).

Ранние диагностические артефакты сохранены отдельно и не заменяют последнюю passing suite.

## Оператор

Просмотр без генерации:

```sh
node /opt/vibe-os/model-gateway/services/model-gateway/operator.mjs status
```

`operator.mjs models` проверяет discovery. `smoke-all`, `tests/deepseek_harness.py` и `apps/portal/tests/live-ui.mjs` делают платные вызовы; не запускать их как health checks. Smoke-all отказывает после первого начала.

Исходники: `packages/credentials/vault.mjs`, `services/model-gateway/`, `profiles/deepseek-model.ts`. Runtime root-owned; секреты отдельно. Сведения о кабинетах: [student-portal](student-portal.md).

Денежные/day/classroom windows исходной control schema ещё не интегрированы. Текущий общий token authorization является жёсткой границей пользовательского допуска на тестирование и пробную работу.
