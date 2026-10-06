# Vibe OS — сборка пяти ученических кабинетов

> Обновлено reasoning и max_tokens: доступны Off/Low/High/Max и вывод до 65 536 на вызов, budget generation 3. Актуальные параметры и новые проверки: [reasoning-settings](reasoning-settings.md). Ограничения 2048/16 KiB/generation 2 ниже описывают исходную версию кабинетов.

Состояние: 6 октября 2026 года. Сервер: Ubuntu 22.04, 4 vCPU / 8 GiB, один SSD. Все исходники, сборки и испытания выполнены на сервере. Пользовательская версия опубликована на `https://80.249.145.94/`.

## Результат для пользователя

Созданы `student01`, `student02`, `student03`, `student04`, `student05`, каждый со своим паролем, сессиями, проектами, папками и чатами. Самостоятельная публичная регистрация закрыта. Существующие кабинеты provisioned оператором; приглашения, класс и учительская роль остаются отдельной задачей.

У `student01` папка «Первые проекты», веб-проект «Моя первая идея» и «Первые шаги в Python». Веб-проект опубликован, занимает один из трёх слотов. В чате «Первые идеи для проекта» DeepSeek действительно создал `NOTES.md` через `write_file`; это не синтетический ответ. `student02`–`student05` пустые после удаления приёмочных fixtures.

Пользователь может:

- Создавать и переименовывать папки проектов, менять папку проекта; удаление папки сохраняет проекты.
- Создавать веб-, Python- и Node-проекты; переименовывать и удалять проект.
- Создавать директории и вложенные файлы; читать, сохранять, переименовывать и удалять их.
- Редактировать код с подсветкой HTML/CSS/JS/Python/Markdown, сохранять кнопкой или Ctrl+S.
- Выполнять Python/Node и команды в ограниченной песочнице, видеть stdout/stderr и код завершения.
- Создавать отдельные чаты проекта, переименовывать их, работать с настоящим Harness и восстанавливать историю.
- Предпросматривать сайт в изолированном iframe, публиковать сохранённую версию и выключать хостинг.
- Менять имя и пароль, выходить с отзывом сессии.

Оформление: белый и голубой, полупрозрачные панели, Manrope, CSS/SVG-графика и анимации. Шрифт обслуживается самим сервером. Есть мобильная компоновка, поддержка reduced motion, клавиатурный focus trap диалогов. CodeMirror загружается отдельно от экрана входа.

## Фактический стек

| Слой | Реализация |
|---|---|
| Интерфейс | React/React DOM 19.3.0, TypeScript 6.0.3 strict |
| Сборка | Vite 8.3.3, plugin React 6.1.2, pnpm 11.7.0; lockfile |
| Редактор | @uiw/react-codemirror 4.25.12, CodeMirror 6 language extensions |
| Иконки | lucide-react 1.52.0 |
| API | Node 24.21.0, Fastify 5.12.5; отдельный пользователь UID/GID 27000 |
| Пароли | @node-rs/argon2 2.2.2; Argon2id, 19 MiB, t=2, p=1 |
| Метаданные | Встроенная SQLite Node 3.53.4, WAL/FULL, foreign keys, busy timeout |
| Root coordinator | Node builtin API, Unix socket, фиксированный список операций |
| Файловый Runner | Go 1.27.1, anchored openat2, собственный Unix RPC, SO_PEERCRED |
| Harness | DeepSeek Harness commit 5badb15009ae1756c3afe0ae0cef1faafc290ccc, штатный `dsh --profile student` |
| Изоляция | NsJail, отдельные UID, rootfs и workspace mounts, systemd cgroup v2 |
| Модель | school-deepseek / deepseek-flash, закрытый Anthropic Messages gateway |
| HTTPS | Nginx, Let’s Encrypt IP short-lived certificate, certbot 5.8.0 |
| Проверка интерфейса | Playwright 1.63.0, Chromium на сервере |
| Данные проектов | XFS 16 GiB loop volume на текущем SSD, prjquota/nodev/nosuid/noexec |

Точные версии также закреплены в `apps/portal/package.json` и `pnpm-lock.yaml`. Upstream Harness не переписывался: отдельный школьный SDK/profile заменяет транспорт, FS, shell/subprocess providers и ограничивает agent loop. Codec использует helpers конкретного pinned commit, поэтому обновление upstream требует повторной проверки совместимости.

## Поток запроса и границы доверия

```text
Браузер
  │ HTTPS 443: HttpOnly cookie + CSRF
Nginx → Fastify API (UID 27000, localhost:8820)
  │ ownership + session epoch + типизированный запрос
  │ Unix broker.sock + capability, недоступная браузеру
Root workspace coordinator
  ├─ Unix runner.sock → Go Runner → NsJail tool range
  ├─ dsh --profile student → NsJail engine range
  │    ├─ собственный protected DSH_HOME и history
  │    ├─ FS/shell/subprocess → scoped Runner RPC
  │    └─ model provider → private gateway.sock → api.deepseek.com
  └─ sealed release → localhost API resolver → Nginx HTTPS 8443
```

API не получает root shell и не принимает пользовательские UID, user_id, host paths или upstream адрес. Связь с root broker идёт через socket `0660 root:27000` и защищённый capability. Runner сверяет UID соединения, конкретный project ID и capability из root-owned registry. Tool UID не имеет model socket/capability.

UID: engine `28001`–`28005`, tool `29001`–`29005`, model gateway `25000`. UID общий для проектов одного ученика; jail открывает только workspace конкретного проекта, и каждый проект имеет отдельный Runner capability и engine home. Это не пять контейнеров с полным host filesystem.

Runtime Harness — отдельная root-owned копия с новыми inode. Изменение build checkout не меняет исполняемый артефакт. Ученические команды не видят репозиторий, Docker socket, ключи, родительские проекты, SSH или host `/proc`.

Файловый Runner отказывает symlink/hardlink/FIFO, path traversal и выходу через mount. Запись атомарная; API дополнительно передаёт revision и файловую version. Старая revision даёт 409.

## Проекты и файловые операции

API хранит users/sessions/folders/projects/chats/messages/runs в `/var/lib/vibe-os/portal/portal.sqlite`. Root broker хранит проекты, hosting slots, snapshots и quota counter в `/var/lib/vibe-os/portal-broker/runtime.sqlite`. Обе базы имеют одного writer в своём процессе.

Данные проекта: `/srv/vibe-os/data/student-projects/<project-id>/`:

- `workspace/` — редактируемый код, tool-owned 0700.
- `engine/` — личный DSH_HOME/history, engine-owned 0700.
- `releases/` — root-owned запечатанные копии для preview/publication.

Root registry: `/var/lib/vibe-os/student-registry/`; jail configs: `/etc/vibe-os/student-projects/`. Проект ограничен 128 MiB и 4096 inode, до 10 проектов на ученика и 50 всего. Квота включает workspace, engine home и releases. Квоты выделяются монотонным root counter; удаление проекта не позволяет обойти общий cap одновременных проектов.

Создание проекта записывает выбранный реальный стартовый шаблон, а не только карточку. Приёмка проверила Python/Node templates. Первые веб-файлы дополнительно отформатированы с CAS guard; созданный агентом `NOTES.md` сохранён.

Состояние очереди AI и ручные операции используют mutation admission: в одном проекте нельзя одновременно сохранять, переименовывать, запускать код и выполнять agent mutation. Пока queued/running AI держит проект, UI показывает занятость; отдельные чаты этого проекта не дают обойти lock.

**Ограничение текущей реализации:** AI работает с живым workspace, без staging copy и transactional merge. При отмене/ошибке часть изменений может сохраниться. В интерфейсе есть соответствующее сообщение; автоматического отката или replay нет. Staging/approve/merge остаются в дорожной карте.

## Harness, история и бюджет

Каждый запуск идёт через `dsh --profile student`, отдельный transient systemd unit и NsJail. Сначала initialize, затем session/open, prompt, read, shutdown и Runner barrier. Смена чата переключает другую protected session того же проекта. SQL хранит видимую проекцию, DSH_HOME — исходную историю.

На холодном open SDK возвращает persistedCursor. Broker читает только события после этого cursor: старые assistant/tool events не повторяются в новом ответе. После рестарта API незавершённые runs получают interrupted; отправка в модель автоматически не повторяется.

Очередь одна, fair по ученикам, одновременно один engine. Один run: до 6 модельных шагов, output до 2048 токенов; ограниченная история, payload и tool output. Отдельный engine unit: 512 MiB, 64 tasks, CPU 100%, 240 секунд. Tool range: 256 MiB, 64 tasks, CPU 50%, до 3 секунд. Общие student slices ограничены по RAM/PIDs/CPU.

Ключи №20–27 зашифрованы AES-256-GCM и используются только gateway. Студенты 1–5 закреплены за credentials 20–24 в root-owned profile; 25–27 доступны оператору как резерв. Это фиксированная provisioning-привязка, полноценного per-classroom credential RBAC/rotation ещё нет.

Общий cap **1 000 000** неизменен. Перед отправкой atomically резервируются 65 536 токенов. Только завершённая проверенная terminal usage заменяет резерв фактическим расходом; cache read/write включены. Для неясного/оборванного/failed запроса остаётся полный резерв. Исторические записи не стираются. Подробнее: [DeepSeek](deepseek-integration.md).

После всех платных проверок: **12 запросов, 3 135 подтверждённых токенов, 0 unresolved reservations**. Холодные opens пяти профилей, outage/recovery и все остальные проверки новых платных вызовов не делали.

## Постоянная публикация и три слота

Статический проект публикуется как sealed snapshot в новые inode; изменение исходного workspace не меняет текущий сайт до следующей публикации. Snapshot содержит разрешённые HTML/CSS/JS/JSON/TXT/SVG/MD, без dotfiles, максимум 256 файлов, 2 MiB суммарно и 256 KiB на файл.

Root SQLite обеспечивает UNIQUE(student,slot), slot 1..3. Четвёртое включение возвращает 409. Выключение освобождает слот и сохраняет проект. Повторное включение/обновление оставляет прежний URL проекта. Сохранение SQL hosting state даёт постоянный хостинг и после рестарта API/broker.

Первый сайт: `https://80.249.145.94:8443/published/12e647862bad399d0b6052c65fc122e2/`.

Preview имеет случайный 128-bit release URL с TTL один час. URL передаваемый; это bearer link. Удаление/выключение published alias даёт 404. Retention сохраняет published snapshot и ограниченное число последних previews.

Текущий resolver обслуживает **статические файлы**. Постоянные процессы Python/Node, серверные БД пользовательских приложений, WebSocket и установка зависимостей с интернетом здесь ещё не реализованы. Выполнение кода в редакторе остаётся отдельной ограниченной командой.

## HTTPS и изоляция пользовательского сайта

Порт 80 только ACME challenge и redirect на 443. На 443 доступны портал и authenticated API. На 8443 доступны только GET/HEAD `/published/...`; маршруты auth/API/root/health возвращают 404. Nginx удаляет Cookie и Authorization перед resolver.

Разные порты дают разные origins, но cookies не ограничиваются портом. Поэтому отдельный порт сам по себе не считается границей изоляции. Для пользовательского HTML обязательны CSP `sandbox allow-scripts`, iframe sandbox без allow-same-origin, запрет connect/form/frame/base-uri и stripping credential headers. Скрипт получает opaque origin и не получает portal cookies/API. Это сознательная схема для прототипа на IP; для расширения capabilities нужны отдельные registrable domains и новая проверка политики.

IP-сертификат доверенный и короткоживущий. Timer проверяет продление каждые два часа, webroot остаётся на порту 80, deploy hook проверяет Nginx config и reload. Certbot dry-run renewal успешно прошёл.

Официальная схема: [Let’s Encrypt IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability), [Certbot и shorter certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html).

## Сессии и отказ модели

Сессия: 256-bit случайный token, в SQL SHA-256, cookie `__Host-vibe_session`, HttpOnly/Secure/SameSite=Strict, срок 7 суток. Мутации требуют exact Origin и CSRF. Все маршруты файлов, чатов, запуска и hosting проверяют владельца; чужой ID даёт 404.

Logout удаляет сессию и немедленно закрывает открытые SSE. Смена пароля увеличивает epoch, удаляет сессии и закрывает streams пользователя; heartbeat также проверяет expiry/epoch. API rate limits дополняют ограничения Nginx.

Недоступность gateway не останавливает HTTPS/API/broker: соответствующие systemd зависимости — Wants. Status показывает model.ready=false; новый prompt получает 503 до admission. Файлы и ручной запуск продолжают работать. Проверено реальным отключением gateway и восстановлением.

## Проверки и доказательства

| Сценарий | Результат | Артефакт |
|---|---|---|
| Пять аккаунтов, ownership, CSRF, traversal, file/directory CRUD, Python/Node, slots | 28 проверок, без paid calls | [API](../evidence/student-api-acceptance.json) |
| HTTPS, вход, workspace, interactive iframe, hosting, Python, mobile dashboard | 9 проверок | [Первый UI](../evidence/portal-ui-first.json) |
| Folder/project modal, focus, directories/files, save/run/rename/delete, chats/settings/mobile editor | 9 проверок; fixtures удалены | [Editor UI](../evidence/student-ui-editor.json) |
| Cold resumes пяти engine, outage, logout SSE, password epochs, пустые кабинеты | 9 проверок, без paid calls | [Lifecycle](../evidence/student-lifecycle.json) |
| Настоящий чат → DeepSeek → write_file → durable ответ/файл → reload | 11 проверок; 2 запроса, 2175 новых токенов | [Live UI Harness](../evidence/student-live-harness.json) |
| Budget generation 2, parallel admission, settlement, uncertainty, restart, vault, wire | 20 offline tests | [Gateway TAP](../evidence/model-gateway-v2-tests.tap) |
| Реальные keys/passwords/capabilities в source, bundles, history, args/env и journal | Утечек не найдено | [Secret scan](../evidence/student-secret-scan.json) |
| Старые демосервисы остановлены, slots освобождены после empty cgroup ACK | Пройдено | [Services](../evidence/student-services.json) |

Снимки интерфейса находятся в `evidence/portal-ui/`. Проверки различного уровня пересекаются; количество не складывается в число независимых гарантий. Ранние диагностические файлы сохраняют исходные ошибки; окончательные passing suites перечислены здесь.

## Эксплуатация и следующие задачи

Рабочие units: vibe-os-portal-web, vibe-os-portal, vibe-os-workspace-broker, vibe-os-workspace-runner, vibe-os-model-gateway. Renewal timer включён. Runtime артефакты root-owned; исходники принадлежат vibe-build. Старые poc-app/console/runner/test-web отключены, исторические данные сохранены.

Начальные пароли не входят в Git, UI bundle, evidence или этот документ. Оператор читает root-only файл реквизитов и передаёт их владельцу платформы отдельно.

Это действующие кабинеты для просмотра и пробной работы пяти учеников. Для расширения нужны приглашения и classroom/teacher RBAC, staging/approval, постоянные backend runtimes, внешняя резервная копия и проверенный restore на чистый сервер. Один SSD и XFS loop не дают независимой отказоустойчивости; постоянный hosting state не является внешним backup. Нагрузочные гарантии класса из 30 учеников/90 backend apps пока не измерены.

План: [implementation-next](implementation-next.md). Текущая схема кабинетов имеет собственные две SQLite и не объявляется завершённой миграцией исходной prototype control schema в multi-classroom production.
