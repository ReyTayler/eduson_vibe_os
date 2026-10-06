# Vibe OS — server prototype

Вся текущая разработка ведётся на `80.249.145.94`. Исходники: `/opt/vibe-os/platform`. Локальные исходники на ПК не используются для сборки и проверок.

[Результаты и ограничения](docs/build-report.md) · [Переход к учебному MVP](docs/implementation-next.md)

Собраны DeepSeek Harness, собственный school profile, ограниченный root Runner, SQL-инварианты и четыре тестовых кандидата, из которых одновременно хостятся три. Учебный интерфейс и реальный model gateway — следующие этапы.

Операторская консоль: `127.0.0.1:8810` на сервере. Для просмотра со своего ПК:

```powershell
ssh -N -L 8810:127.0.0.1:8810 root@80.249.145.94
```

Затем открыть `http://127.0.0.1:8810`. В консоли нет student login и command API.

## Проверки

- `node --test tests/control.test.mjs` — синтетическая схема; включает WAL reopen.
- `python3 tests/harness_composition.py` — реальный профиль с fake model, новые/восстановленные protected sessions.
- `python3 tests/harness_denials.py` — изоляция engine и отказы протокола.
- `tests/isolation.py` запускается под `vibe-poc-engine` с тестовым закрытым Unix API.
- `tests/hosting_lifecycle.py` и `tests/runner_recovery.py` изменяют состояние тестовых сервисов. Не запускать их как read-only аудит.

Актуальные результаты находятся в `evidence/`. В `infra/` сохранены настройки и bootstrap этапы. Последовательность bootstrap ещё не является одним полностью переносимым production installer; текущие пути и canary fixtures закреплены для этого сервера.
