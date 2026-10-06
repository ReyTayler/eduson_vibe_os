# Vibe OS — отчёт о сборке технического прототипа

Дата: 6 октября 2026 года. Сервер: `80.249.145.94`. Исходники, сборки, испытания и этот отчёт находятся на сервере. Репозиторий: `/opt/vibe-os/platform`, ветка `codex/vibe-os-poc`.

## Что готово

Собрано ядро DeepSeek Harness и отдельный школьный профиль. Процесс агента и исполняемые команды работают в разных пространствах имён и под разными UID. Файловые операции, shell и прямой subprocess проходят через собственные провайдеры. Нативные модули загрузчика и flock работают внутри подготовленной песочницы Ubuntu 22.04.

Работают три настоящих приложения с отдельными SQLite. Подготовлен четвёртый кандидат для переключения. Новый проект занимает слот после остановки предыдущего и подтверждения пустой cgroup. Выключение сохраняет данные. Разрешённые проекты восстанавливаются после перезагрузки без нового кода преподавателя. Постоянная блокировка переживает перезагрузку.

Подключены ключи №20–27 и реальный маршрут `school-deepseek / deepseek-flash` через закрытый gateway. Десять настоящих запросов использовали 960 токенов; общий консервативный допуск ограничен 1 000 000. Подробности — в [отчёте об интеграции](deepseek-integration.md). Регистрация и учебный редактор ещё не реализованы.

## Фактический стек

| Компонент | Установленная версия / реализация |
|---|---|
| ОС | Ubuntu 22.04.5 LTS |
| Ядро | 5.15.0-198-generic |
| systemd | 249.11-0ubuntu3.22 |
| Node.js | 24.21.0 |
| Go | 1.27.1 |
| pnpm | 11.7.0 |
| TypeScript | Из lockfile Harness; строгая проверка собственных провайдеров |
| Harness | `5badb15009ae1756c3afe0ae0cef1faafc290ccc`, 0.2.1-alpha.1 |
| NsJail | `4ff54a6e0d5b65a0e1633d6e2fd1425ba6c882ce` + локальная совместимость заголовков Ubuntu |
| Go Linux API | `golang.org/x/sys v0.48.0` |
| SQLite Node/control/apps | Встроенная 3.53.4 |
| SQLite Python в песочнице | Отдельная проверенная сборка 3.51.3; системная библиотека Ubuntu не заменяется |
| Данные | XFS-образ 16 GiB на единственном системном SSD 80 GiB, `prjquota,nodev,nosuid,noexec` |
| Просмотр тестового стенда | Nginx на порту 80 → локальная консоль `127.0.0.1:8810`; публично доступны только доверенные демопроекты |

Node и Go проверены по SHA-256 официальных архивов. Исходник SQLite проверяется по опубликованному SHA3-256 `sqlite3.c`. Версии и хеши собраны в `evidence/`.

## Границы процессов

| Роль | UID / GID | Доступ |
|---|---:|---|
| Root Runner | 0 | Только закрытый Unix API одного тестового workspace; создаёт ограниченные systemd ranges |
| Операторская консоль | 22000 | Читает небольшую проекцию статуса; не открывает изменяемую WAL-базу |
| Harness engine | 23000 | Подготовленный rootfs, личный DSH_HOME и capability; без INET/INET6 |
| Команды проекта | 23001–23004 | Только rootfs и workspace своего проекта |
| Model gateway | 25000 | AES-GCM credentials через LoadCredential, отдельный token ledger, только фиксированный DeepSeek upstream |
| Hosted runtime | 24001–24004 | Только неизменяемый код, отдельные live data и свой ingress socket |

UID и GID назначены явно. Секрет capability находится вне workspace, инструментам не монтируется. Runner проверяет одновременно Unix peer UID и 256-битную capability. Это фиксированная capability технического прототипа одного проекта; схема выдачи коротких capability для каждого ученика и run остаётся отдельной задачей MVP.

Корень сервера не используется как rootfs песочницы. В engine монтируется отдельная копия собранного Harness с новыми inode, принадлежащая root и доступная только на чтение. В tools не монтируются Harness home, история, control DB, live DB приложений и SSH-ключи.

Файловый helper применяет `openat2` с `BENEATH / NO_SYMLINKS / NO_MAGICLINKS / NO_XDEV`, атомарную публикацию нового файла и проверку наблюдаемой версии. Перед освобождением диапазона процессов проверяется его cgroup. После аварии Runner восстанавливает список своих ranges и останавливает остатки до допуска новых операций.

## Ограничения

| Объект | Настройки прототипа |
|---|---|
| Tool range | 256 MiB, 64 tasks, 50% одного CPU, дедлайн 50–3000 ms |
| Engine | В испытаниях 512 MiB, 64 tasks, 100% одного CPU |
| Hosted runtime | 256 MiB, 64 tasks, 25% одного CPU |
| Долгий runtime | `time_limit=0`, `rlimit_cpu_type=INF`, systemd RuntimeMax=infinity |
| Проектные данные | 32 MiB и 512 inode для каждого тестового project ID |
| Engine history | 8 MiB до холодного открытия, 20 000 events, 128 KiB/event |
| Протокол | 64 KiB/frame, 8 KiB/prompt, 230 KiB/read page, 16 live sessions, 12 steps |
| Реальный API | Общий допуск 1 000 000 токенов, 15 попыток по 65 536 без refund; text-only 16 KiB/input, output ≤2048 |
| Captured output | Хвост 64 KiB для stdout и stderr |

Engine home, workspace и live data первого проекта имеют один XFS project ID. Таким образом, квота применяется к сумме этих каталогов. Control plane остаётся вне ученического тома.

XFS в loop-файле подходит для функциональной проверки hard quotas. Такие измерения не доказывают справедливость физического IO между учениками. До учебного запуска требуется отдельный тест fsync/IO flood и контроль задержек control plane на конкретном хранилище.

## Результаты испытаний

| Набор | Результат | Артефакт |
|---|---:|---|
| Изоляция Runner: Python/Node, сеть, пути, symlink, stale writes, stdout, deadline, detached grandchildren, RAM/PID, квоты | 17/17 | [runner-isolation.json](../evidence/runner-isolation.json) |
| SQL: слоты, ownership, grant/restriction, REPLACE, project/run FK, dispatch lease, бюджеты, WAL reopen | 25/25 | [control-tests.tap](../evidence/control-tests.tap) |
| Engine и протокол: INET/INET6, host data, fallback, prompt, cold history, frame size | 5/5 | [harness-denials.json](../evidence/harness-denials.json) |
| Реальный lifecycle четырёх кандидатов в трёх слотах | 4/4 | [hosting-lifecycle.json](../evidence/hosting-lifecycle.json) |
| Перезагрузка: mount, данные, разрешённые runtime, ограничение, Runner | 4/4 | [reboot-after.json](../evidence/reboot-after.json) |
| Python SQLite: WAL, независимый reader, checkpoint, integrity check | Прошёл | [python-sqlite-validation.json](../evidence/python-sqlite-validation.json) |
| SIGKILL Runner во время команды: reconnect и пустая cgroup | Прошёл | [runner-recovery.json](../evidence/runner-recovery.json) |
| Настоящий запуск dsh profile: FS → rg → bash → JSONL → cancel → новый процесс → resume | Оба сценария прошли | [harness-composition.json](../evidence/harness-composition.json) |

В коротком keyless сценарии sampled cgroup peak engine составил примерно 54 MiB. Это наблюдение небольшого сценария; оно не является оценкой памяти длинного реального диалога или нагрузки класса. Частота выборки 20 ms записана в артефакте.

## Что исправлено после аудита

- Авторизация новых запусков отделена от наблюдаемых состояний. Revocation не мешает записать failure и остановить runtime.
- Job связывается с agent run составным FK по project ID.
- Writer скрыт за интерфейсом, который запрещает `INSERT OR REPLACE / REPLACE INTO / UPDATE OR REPLACE / ON CONFLICT REPLACE`; FK и recursive triggers проверяются на каждой connection.
- Постоянная deployment restriction проверяется при enable, restart и boot.
- Запрос модели и tool dispatch ожидают настоящий persisted cursor; окончательное settled отправляется после storage flush и подтверждения quiescence.
- Холодная история ограничивается до полного декодирования. Live read остаётся логическим чтением ограниченного лога; потоковый архивный индекс пока отсутствует.
- Сам engine изолирован от host FS и INET, отдельно от исполняемого кода.
- Бюджетные holds сохраняют неизменяемые IDs исходных периодов; uncertain удерживает резерв; settlement выполняется атомарно с CAS.
- Мутационная lease берётся при dispatch с проверкой base revision. Очередь не блокирует ручное сохранение заранее.

Функции SQL stop receipt принимают подтверждение только от доверенного Runner adapter. При разработке BFF нельзя принимать `cgroupEmpty` или receipt из JSON браузера. В текущем прототипе coordinator запускает root-оператор через SSH; публичного command API нет.

## Отличия от полноценной платформы

Собственные FS/shell/subprocess провайдеры реализуют функции текущего тестового consumer. Binary/image reads, полноценный lstat для symlink, произвольные subprocess/PTY, background job protocol и весь набор штатных файловых инструментов ещё требуют реализации и проверок. Нельзя объявлять эти провайдеры совместимыми со всеми пакетами Harness.

Пока не готовы: закрытая регистрация, пароль и сессия ученика, RBAC по классу, редактор, AI queue/fairness, привязка credentials к ученикам и полные денежные gateway budgets, HMAC-код преподавателя, staging/sealing пользовательских релизов, отдельные домены портала/приложений, previews, library, внешние backup/restore и тест нагрузки 5–10 учеников. Control schema — исполняемое ядро инвариантов, а не полная схема MVP из исходной дорожной карты.

Тестовые приложения содержат доверенный пример. До завершения этих задач нельзя отдавать операторскую консоль ученикам или использовать её origin для произвольного пользовательского HTML.

## Где читать исходники

- [Runner](../services/runner/main.go), [Go module](../services/runner/go.mod).
- [School SDK](../profiles/school-sdk.ts), [FS](../profiles/fs-provider.ts), [shell](../profiles/shell-provider.ts), [subprocess](../profiles/subprocess-provider.ts).
- [Школьная композиция](../profiles/cordis.patch.yml).
- [Control schema](../packages/control/schema.sql), [транзакционные операции](../packages/control/index.mjs).
- [Hosted coordinator](../services/hosting/cli.mjs), [проверка approved digest](../services/hosting/authorize.mjs).
- [Bootstrap](../infra/bootstrap/), [systemd](../infra/systemd/), [NsJail](../infra/nsjail/).
- [Следующие этапы](implementation-next.md).

## Просмотр и управление

На своём ПК открыть SSH-туннель:

```powershell
ssh -N -L 8810:127.0.0.1:8810 root@80.249.145.94
```

Открыть `http://127.0.0.1:8810`. Все приложения и данные остаются на сервере.

Операторские команды выполняются на сервере:

```bash
node /opt/vibe-os/poc-hosting/cli.mjs status
node /opt/vibe-os/poc-hosting/cli.mjs disable 1
node /opt/vibe-os/poc-hosting/cli.mjs enable 4 1
node /opt/vibe-os/poc-hosting/cli.mjs disable 4
node /opt/vibe-os/poc-hosting/cli.mjs enable 1 1
```

Второй аргумент enable — номер проекта, третий — слот. Сейчас заняты слоты 1–3 проектами 1–3. Проект 4 выключен и готов к переключению. Переключение не удаляет live data.

## Публичный тестовый стенд — 2026-10-06

Стенд опубликован на [http://80.249.145.94/](http://80.249.145.94/). Проверен доступ с ПК вне сервера; корневая страница и три работающих демопроекта возвращают HTTP 200. Четвёртый проект выключен и возвращает 503. Это текущий технический PoC: редактор, чат, ученический вход и браузерное управление проектами ещё не реализованы.

Отдельный boot-enabled `vibe-os-test-web.service` использует `/etc/vibe-os/nginx-poc.conf`; исходные настройки в `infra/nginx/test-web.conf` и `infra/systemd/vibe-os-test-web.service`. Открыты только GET/HEAD корня и `/projects/1/`…`/projects/4/`, POST запрещён, прочие пути возвращают 404. Model gateway, credentials, Runner и операторский CLI остаются на закрытых локальных каналах. Запуск сайта не вызывает модель и не расходует токены.

Публичный HTTP на IP пригоден для просмотра этих доверенных fixtures без ввода секретов. Перед ученическим MVP нужны домены, TLS, аутентификация и отдельные origins для пользовательских приложений; этот proxy не заменяет проектируемый production ingress. Лимиты запросов/соединений и фиксированные upstream снижают случайную нагрузку. Unit ограничивает память до 128 MiB, файловые записи — runtime-каталогом и начальным логом Nginx; основной лог ошибок идёт в journal, access log отключён. Остановка только публичного входа: `systemctl stop vibe-os-test-web.service`.

Проверки без платных запросов сохранены в `evidence/public-test-web.json`. Бюджет DeepSeek остался прежним: 10 запросов, 960 подтверждённых токенов, 655360 консервативно зарезервированных единиц разрешения из 1000000.
