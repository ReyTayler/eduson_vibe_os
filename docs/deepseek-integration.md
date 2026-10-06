# DeepSeek — ключи 20–27 и результаты интеграции

Состояние на 6 октября 2026 года. Хранение, сборки и тесты выполнены на сервере `80.249.145.94`. Из предоставленного файла импортированы только записи №20–27. Другие записи не загружались.

## Результат

Все восемь ключей прошли authenticated GET /models и отдельный настоящий запрос Messages. Затем Harness выполнил двухшаговый agent cycle: модель выбрала `poc_pipeline`, инструмент записал файл через FS provider, нашёл его jailed rg, запустил jailed Python через shell, после чего модель вернула `HARNESS_LIVE_OK`.

| Проверка | Платные запросы | Подтверждённые токены |
|---|---:|---:|
| Ключи №20–27: каждый вернул `VIBE_OK` | 8 | 152 |
| Harness: tool call и ответ после tool result | 2 | 808 |
| Холодное чтение истории и restart gateway | 0 | 0 |
| Всего | **10** | **960** |

960 включает input, output и cache read/write из terminal usage; повторы usage внутри сохранённого stream не считаются второй раз. Незавершённых/неопределённых платных запросов в итоговом ledger нет.

## Ограничение в 1 000 000 токенов

Одна авторизация общая для всех восьми ключей. До каждой отправки в DeepSeek одна транзакция SQLite FULL/WAL безвозвратно списывает **65 536** токенов из допуска. Фактическая usage сохраняется отдельно; меньшая usage не возвращает допуск. Разрешается максимум **15 платных попыток**, суммарный консервативный допуск **983 040**, затем новые отправки блокируются.

Один запрос: JSON ≤16 KiB, только text/tool messages, ≤32 messages, ≤64 content blocks и ≤8 tools. Images, remote files, arbitrary endpoint, дополнительные provider fields и thinking запрещены. Максимальный output — 2048, в live profile — 1024. У текстового ввода резерв существенно превышает размер UTF-8 payload и добавляет запас для шаблона Messages. Резерв не означает, что провайдер потратил столько токенов.

На момент завершения списано из допуска **655 360**, остаток **344 640** — ещё максимум пять попыток. Ledger сохраняется после restart; автоматического сброса, refund или retry нет. Duplicate request ID не порождает вторую отправку. Cancel, HTTP error, stream error и потерянный terminal usage сохраняют полный debit; после crash записи sent становятся uncertain. Допуск распространяется на запросы данного gateway.

Gateway фиксирует terminal usage до пересылки `message_stop`. Исходные provider errors не пересылаются caller. SSE проходит потоково с ограничением 64 KiB/frame, 1 MiB/response и общим timeout 60 seconds.

## Хранение и роли

- Ciphertext: `/var/lib/vibe-os/credentials/deepseek-20.json` … `deepseek-27.json`, AES-256-GCM, новый nonce 96 bit, AAD с provider/credential ID/version.
- Master key: `/etc/vibe-os/credentials/master.key`, root-only, вне Git и workspace.
- systemd 249 `LoadCredential` передаёт master и engine capability основному gateway process. `ExecStartPost` проверяет готовность Unix listener без чтения credentials.
- Gateway UID 25000: 192 MiB, 32 tasks, CPUQuota 50%, ProtectHome/ProtectSystem, без root capabilities.
- Engine UID 23000: в jail есть gateway capability и bind закрытого Unix socket; реального API-ключа, ciphertext directory, master и ledger нет.
- Commands UID 23001: model capability и socket недоступны.
- Endpoint: `/run/vibe-os-model/gateway.sock`. Upstream жёстко задан: `https://api.deepseek.com`.

Реальный профиль `school-live` использует credential №20. Все восемь credential зарегистрированы в gateway; root operator адресует каждый по номеру. Привязка ключа к аккаунту конкретного ученика и classroom RBAC ещё не реализованы.

## Harness

Provider `school-deepseek`, model `deepseek-flash`. Initialize принимает только пару из root-owned profile. Модель не выбирает собственный ключ, origin или output cap. Штатный credential adapter/fallback не подключён.

Использованы serializer, SSE decoder и translator исходного Harness commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`. Они собраны отдельным codec bundle с внешними `@deepseek-ai/*` imports; AF_UNIX транспорт реализован своим provider. Глобальный fetch и agent loop не изменялись. MIT license включена в артефакт. При смене baseline повторить build/types и wire tests: codec helpers являются зависимостью от внутреннего API этого commit.

Официальный [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/) поддерживает выбранный формат. Gateway использует `/anthropic/v1/messages`. Доступность модели проверена GET /models каждого ключа.

## Доказательства

- [Все ключи: discovery](../evidence/deepseek-key-discovery.json).
- [Все ключи: живые Messages](../evidence/deepseek-key-smokes.json).
- [Harness и холодная история](../evidence/deepseek-harness.json).
- [15 проверок gateway без провайдера](../evidence/model-gateway-tests.tap): общий предел, parallel admission, duplicate, WAL recovery, AES-GCM/AAD tampering, invalid input, fragmented CRLF SSE, cancel, error sanitation и terminal usage.
- [Restart не сбрасывает бюджет](../evidence/deepseek-budget-restart.json).
- [Недоступность секретов engine/tools](../evidence/deepseek-secret-isolation.json).
- [Поиск утечек в исходниках, JSONL, process args, environment и journal](../evidence/deepseek-secret-scan.json).
- [5 повторных отрицательных проверок Harness](../evidence/harness-denials-after-gateway.json).
- Файлы `*-first.json` сохраняют раннюю диагностику; текущие результаты — по ссылкам выше.

## Код и оператор

Исходники: `packages/credentials/vault.mjs`, `services/model-gateway/`, `profiles/deepseek-model.ts`, `profiles/cordis.live.patch.yml`. Runtime отдельно скопирован в root-owned `/opt/vibe-os/model-gateway` и `/opt/vibe-os/poc-profile`.

Просмотр без генерации: `node /opt/vibe-os/model-gateway/services/model-gateway/operator.mjs status`.

`operator.mjs models` проверяет discovery. `smoke-all` и `tests/deepseek_harness.py` выполняют платные запросы; не включать их в повторяющийся health check. Полный smoke-all отказывает после первого начала теста.

Учебный UI, регистрация, multi-user capabilities, encrypted credential rotation/restore и per-user/day/classroom денежные бюджеты остаются следующими задачами. Новый token ledger ограничивает текущую авторизацию тестирования; интеграция с денежными windows исходного control schema ещё требуется.
