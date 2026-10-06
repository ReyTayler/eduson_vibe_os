# Следующие этапы реализации Vibe OS

Этот файл описывает переход от серверного технического прототипа к учебному MVP. Текущее состояние и проверенные ограничения находятся в [отчёте](build-report.md).

## 1. Завершить безопасную интеграцию модели

**Файлы:** создать `services/model-gateway/`, `packages/credentials/`, `profiles/deepseek-model.ts`. Продолжать использовать ядро Harness из зафиксированного коммита.

- Создать отдельный provider ID `school-deepseek`. Не выбирать `deepseek-official` через SDK initialize, чтобы не появлялся штатный fallback.
- Повторно сверить официальный DeepSeek Anthropic Messages wire и поддержку модели. По исследованному baseline штатный adapter использует `/anthropic/v1/messages`; OpenAI Chat Completions здесь нельзя подставить без проверки совместимости.
- Добавить узкий транспорт provider → Unix gateway. Проверить abort, частичные SSE chunks, error frames и terminal usage. Не применять глобальную подмену fetch.
- Создать root-only credential directory. Master key хранить вне DB через совместимый с systemd 249 `LoadCredential`. Не рассчитывать на `LoadCredentialEncrypted`.
- Шифровать школьный ключ AES-256-GCM с nonce 96 bit и AAD, содержащим владельца, credential ID и key version. Ключи учеников должны иметь разные fingerprints. Не наследовать ключ в engine/command environment.
- Реальная credential применяется только в gateway. Engine получает ограниченную capability run/project/model/budget и доступ к одному Unix endpoint.
- Включить ядро pre-reserve/settle из `packages/control/` в gateway. Worst-case резервируется до отправки. Usage считается доверенным только после проверенного provider response. Не отпускать uncertain резерв по кнопке отмены и не делать слепой replay.
- Реальный canary провести на отдельном тестовом ключе с жёстким небольшим лимитом и без записи key в лог. Пока такой ключ на сервере не предоставлен.

**Приёмка:** ключ не виден в tool output, traces, браузере, JSONL и engine env; duplicate/cancel/crash/midnight tests проходят; повторная доставка события usage не меняет spent второй раз.

## 2. Развернуть настоящий BFF и writer

**Файлы:** `apps/api/`, `packages/control/migrations/`, `packages/contracts/`.

- Fastify 5, TypeScript strict; точные версии закрепить lockfile после повторной проверки перед установкой.
- Сохранить один SQLite writer в отдельном worker. В прототипе используется встроенная SQLite Node 3.53.4. Если будет выбран better-sqlite3, проверить фактическую embedded SQLite и WAL fix в новом бинарном артефакте.
- Развивать schema generation 1 последовательными миграциями. Не переписывать уже применённые поколения и не делать downgrade.
- Ввести classroom/membership, session projection, credential records, idempotency, durable jobs/outbox, audit retention и caps сущностей.
- Добавить закрытые одноразовые invitations: random token, SHA-256 verifier, TTL, atomic consume.
- Пароли Argon2id. Непредсказуемая серверная сессия, Secure/HttpOnly/__Host cookie, CSRF и отзыв session epoch. Email не обязателен.
- Каждый HTTP/SSE/files/chat route проверяет ownership и действующую membership. Учитель ограничен своим классом.
- В browser request никогда не принимать user ID как источник полномочий, runner paths, UID, stop receipts, grant signature или plaintext credential.
- Доработать корневой Runner до typed multi-project registry: capability scoped per run, peer roles engine/control, validated root-owned specs, generation fences, durable recovery. Не открыть общий root shell.

**Приёмка:** отрицательные ownership tests между двумя учениками и двумя классами; повторная активация приглашения запрещена; disabled user теряет HTTP/SSE/preview доступ; SQLite connection не допускает запрещённые pragmas и REPLACE.

## 3. Сделать workspace, editor и AI lifecycle

**Файлы:** `apps/web/`, `services/ai-worker/`, `packages/workspaces/`.

- React, Vite, русские тексты интерфейса, редактор с ограниченным файловым API.
- Save применяет base revision CAS и отказывает при активной mutation lease. Queued AI intent не блокирует save до dispatch.
- Fair queue по ученикам; для начала ограничить одновременные engine, фиксировать p95 ожидания. Не обещать класс из 30 учеников по памяти и скорости fake fixture.
- Каждый AI run работает в staging копии конкретной revision. Ученик не пишет одновременно в этот staging.
- Реализовать все нужные методы FS/subprocess/shell перед загрузкой штатных consumers; не оставлять частичные provider как общую замену.
- Расширить tool caps до обоснованного профиля для Python/Node. Сохранить CPU/memory/pids, no INET/INET6, bounded output, exit/cgroup ACK.
- Продолжить school open/read/cancel/delta протокол. Разделять tentative stream и durable settlement.
- Ограничить рост history до dispatch, сделать отдельный archive index/stream reader и независимую summary-rollover session. Fork с inherited prefix не решает проблему размера.
- Добавить file/event/entity caps, итоговый combined result byte cap и worst-case RSS измерение под 512 MiB.

**Приёмка:** cancel во время файловой операции и model streaming; crash между flush/artifact seal/SQL projection; resume с ровно одной writer lease; превышение истории не запускает полный decode; изменения на базе старой revision не коммитятся.

## 4. Реализовать пользовательскую публикацию и постоянный хостинг

**Файлы:** `services/release-sealer/`, `services/runtime-coordinator/`, `packages/approvals/`.

- HMAC-код преподавателя имеет minute/group/classroom scope и ограниченный TTL. Созданная approval привязана к точному sealed release/profile/data policy; обычный approved runtime переживает reboot без нового minute code.
- Закрыть mutation admission и остановить все writers/commands/build helpers; дождаться cgroup empty. Копировать release в новые inode, без staging hardlinks и удерживаемых writable FD.
- Manifest включает содержимое, dependency/profile digests, UID/network/resource policy и правила данных.
- Live SQLite отделить от staging/preview/dev DB. Первый seed проверить хешем; обновление кода сохраняет live DB. До cutover делать согласованный backup; автоматический rollback DDL не обещать.
- Применить проверенные три hosting_slots на ученика и глобальный pool для прототипа. Failed/unknown/stopping сохраняют reserved capacity до ACK.
- Координатор меняет ingress и запускает ровно один runtime generation. Stop старого поколения не останавливает новое.
- При boot/restart/cutover снова проверить grant, restriction, digest и membership.
- Квоты распределять из tenant pool по каждому project ID; учитывать код, releases, staging, live DB/WAL и engine home. Отдельно ограничить control metadata и retention.

**Приёмка:** обновление при старом открытом FD не меняет approved bytes; новая версия не создаёт четвёртый runtime; потерянный ACK удерживает слот; teacher restriction не снимается pupil enable; quota fill не блокирует оператора.

## 5. Разнести домены и включить preview

- Нужны отдельные registrable domains для портала и пользовательских приложений, wildcard DNS и TLS. Адрес/домен сейчас не предоставлен.
- Proxy маршрутизирует только зарегистрированные exact targets. Ни URL браузера, ни произвольный Host не становятся upstream.
- Не публиковать database files, dotfiles, source maps с секретами и служебные логи.
- Preview bearer означает передаваемый доступ. User ID внутри capability не подтверждает личность получателя. Для приватных материалов требуется отдельная проверка сессии и membership.
- Публичные посетительские paid API по умолчанию выключены; только отдельный allowlist gateway с собственными бюджетами.

## 6. Подготовить эксплуатацию и пилот

- Перенести данные на подходящий XFS том либо отдельно зафиксировать поддерживаемую схему одного диска и доказать IO SLO под fsync flood.
- Зафиксировать journald/log/control WAL caps, метрики очереди и бюджета, disk/inode headroom, kill/recovery и cleanup lag.
- Подключить внешнее S3 хранение. SQLite backup API и fsync watermarks; не копировать отдельно `.db` при живом WAL.
- Проверить восстановление на чистый сервер, отдельное хранение master key, отзыв приглашений/preview/session capabilities и применение актуальных revocations перед запуском восстановленных apps.
- Пилот 5–10 учеников провести после регистрации, ключей, доменов, backup/restore и отрицательных изоляционных тестов.
- Library, ручные screenshot/cards, курс/PDF/VK links и прогресс учителя добавить после устойчивого editor/AI/hosting цикла.

Нагрузку 30 учеников и 90 динамических приложений проверять отдельно. Сервер 4 vCPU / 8 GiB был выбран для технического прототипа.
