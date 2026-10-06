# Vibe OS — оставшаяся дорожная карта

Состояние на 6 октября 2026 года. Текущая работающая сборка описана в [student-portal](student-portal.md). Предыдущая дорожная карта сохранена в [generation 1](implementation-next-generation1.md) для сопоставления аудита.

## Что уже реализовано

На сервере работают пять независимых ученических кабинетов, React UI, authenticated Fastify API, проекты/папки/файлы/директории, CodeMirror, guarded saves, изолированный Python/Node, реальные отдельные Harness sessions, durable messages/runs, fair queue, scoped multi-project Runner, ciphertext keys 20–27, личные недельные квоты generation 4 (1 млн на ученика, воскресенье 23:59 МСК), статический preview и постоянная публикация с тремя слотами на ученика. Есть trusted HTTPS на IP и renewal timer. Старый публичный тестовый стенд отключён.

[Недельные квоты и их проверки](weekly-quota.md). Приёмочные suites перечислены в [отчёте кабинетов](student-portal.md). Кабинеты подходят для просмотра UI и пробной работы пяти учеников. Ниже перечислены реальные незавершённые части.

## 1. Приглашения, классы и преподаватель

Файлы для развития: `apps/portal/api/`, migrations/contracts нового control layer.

- Перевести bootstrap из пяти фиксированных users в classroom/membership с teacher/admin roles.
- Одна авторитетная схема ownership/membership; согласовать две текущие SQL projections с оригинальными control invariants.
- Одноразовый invitation: random token, SHA-256 verifier, TTL, атомарное consume; rate limits, закрытый reset/revoke.
- Все HTTP/SSE/project/AI routes проверяют действующий membership. Epoch/revocation распространяются на уже открытые streams и preview capabilities.
- Добавить teacher cabinet, просмотр проектов своего класса, лимиты и restriction; pupil enable не снимает restriction.
- Журнал operator/teacher действий с retention без plaintext key/password.

Приёмка: два класса, чужой teacher/ученик, повтор invitation, disable во время SSE/очереди/hosting, revoked preview и парольный reset.

## 2. Постоянные backend-приложения

Текущие slots обслуживают статические snapshots. Для Python/Node HTTP runtimes использовать исходные invariants в `packages/control/` и проверенный принцип root coordinator, сохраняя отдельные UID/rootfs/quotas.

- Ввести точный release/profile/dependencies manifest, boot/cutover grant и generation fences.
- HMAC minute/group/classroom code преподавателя связывается с конкретным sealed release и data policy. После одобрения неизменённый release переживает reboot без нового minute code.
- Для каждого приложения ограниченный transient/persistent systemd range + NsJail, фиксированный listener и exact registered ingress target.
- Пользовательские SQLite/live data отдельно от source/release/preview. Обновление кода сохраняет live DB; seed проверяется manifest.
- Новое приложение получает слот лишь после stop ACK и empty cgroup предыдущего. Unknown/stopping держит capacity. Максимум три на ученика плюс измеренный общий pool.
- Разрешения сети и установки dependencies оформить отдельно: не открывать общий host network/socket и платные API посетителям.
- Перед cutover согласованный backup; автоматический rollback произвольного DDL не обещать.

Приёмка: stable URL, switch/off/on/update/reboot, writable old FD не меняет release, утраченный ACK, late stop старой generation, fill quota, restriction после restore.

## 3. AI staging и atomic commit

Сейчас mutation lease защищает живой workspace. Cancel/error может оставить частичные изменения, и UI сообщает об этом.

- Run фиксирует base revision и работает в staging copy с отдельной квотой.
- Команды, FS и background helpers ограничены staging данного run.
- Перед seal закрыть writer admission, остановить дочерние ranges, получить empty cgroup ACK и копировать в новые inode.
- Commit/merge применяет CAS к base revision. Изменённая учеником revision требует явного resolution, а не silent overwrite.
- Отдельно хранить tentative stream, durable history и committed files; crash recovery не делает model replay автоматически.
- Idempotency/outbox согласовывает staging, history и SQL. Failed cleanup остаётся видимым для оператора.

Приёмка: два окна браузера, stale save, cancel при write, engine crash после artifact flush до SQL, reopen и повтор commit.

## 4. Более длинные чаты и dependency tooling

Текущий gateway intentionally bounded: request до 512 KiB, output до 65536, один engine, до 6 модельных шагов. Это может ограничивать длинную переписку и генерацию большого проекта.

- Ввести archive index, bounded stream reader и summary/rollover sessions; полный history decode под hard RSS cap не разрешать.
- При расширении payload/output заново обосновать worst-case token reservation до изменения cap.
- Реализовать изолированный build/dependency cache и разрешённые package sources с lockfile/content digest.
- Отдельный bounded gateway для package downloads; запрет credentials/host paths/DNS rebinding.
- Улучшить UX diff/accept changes, checkpoints и восстановление файлов.
- Привязку credentials сделать операционными versioned records с per-user/classroom RBAC, ротацией/отзывом; сохранить global 1 000 000 authorization пока пользователь не изменит его явно.
- Реализовать денежные/day/classroom budgets, admission и settle/uncertainty без обхода global cap.

## 5. Домены и эксплуатация

Текущий IP HTTPS + порт 8443 использует opaque CSP sandbox и credential stripping. Расширять browser capabilities следует после появления отдельных registrable domains.

- Portal и пользовательские приложения на независимых registrable domains; wildcard DNS/TLS и exact ingress mappings.
- Пересмотреть CSP, cookies, CORS, preview bearer и private previews для новых capabilities.
- Внешние S3 backups: SQLite backup API, fsync watermarks, snapshots/data/master key отдельными защищёнными объектами.
- Проверить восстановление на чистый сервер; актуальные revocations применяются до запуска восстановленных apps.
- Согласовать XFS loop на одном SSD с IO SLO; для расширения выделить data volume и проверить quota/fsync flood.
- Лимиты control SQL, logs/journal, histories, artifacts, snapshots и metadata. Нынешний проектный cap не заменяет operator headroom.
- Метрики queue wait/run latency/cancel cleanup, budget uncertainty, TLS expiry/renew, disk/inode headroom, cgroup leak и backup age.

## 6. Пилот и нагрузка

Сначала пробная работа пяти учеников и сбор фактических UX ошибок. Далее — пилот 5–10 после teacher/invitation, backend runtime при необходимости и внешнего restore.

Нагрузочные проверки: конкурирующие saves/chats/runs/publications, cgroup cleanup, SQLite contention, noisy neighbor по памяти/CPU/IO, очередь модели и долговременный рост history/release storage.

Класс из 30 учеников и 90 постоянных backend apps — отдельная нагрузочная задача. Сервер 4 vCPU / 8 GiB не даёт такой гарантии без измерений.

Library, прогресс учителя, загрузка изображений/PDF и дополнительные учебные материалы идут после устойчивого основного цикла. Полный переносимый installer нужен перед повторным развёртыванием; сейчас runtime и paths закреплены для текущего сервера.
