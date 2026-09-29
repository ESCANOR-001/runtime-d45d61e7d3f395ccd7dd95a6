---
title: CLI для агентов, маршрутизации и интеграций
description: Multi-agent, combo, observability, access, integration, system и config-команды.
---

Эти команды управляют политикой агентов и routing'ом, проверяют живой прокси и подключают
поддерживаемых клиентов к Remodex.

## Политика агентов

### `rmx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Управляйте headless-ростером multi-agent, effort cap'ами, prompt injection, fallback'ом и
настройками sidecar'ов. Для просмотра текущей политики используйте `status`. Как соотносятся
surface mode, delegation, effort и fallback, описано в
[Поверхности подагентов](/guides/sub-agent-surface/).

```bash
rmx agent subagents set ark/model-a,openai/gpt-5.5
```

### `rmx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

Управляйте feature flag'ом Codex `multi_agent_v2` и трёхсостоянием multi-agent surface mode.

| Подкоманда | Действие |
| --- | --- |
| `status` (default) | Показать текущий v2 flag, multi-agent mode и thread concurrency. |
| `on` | Включить feature `multi_agent_v2` и пересинхронизировать каталог. |
| `off` | Выключить `multi_agent_v2` и пересинхронизировать каталог. |
| `mode v1` | Принудительно перевести все модели на v1, отключить native v2 и сохранить текущий thread limit. |
| `mode default` | Уважать upstream pin'ы surface у моделей. |
| `mode v2` | Принудительно перевести все модели на v2, включить native v2 и сохранить текущий thread limit. |
| `threads <n>` | Задать активный v1/v2 thread limit как целое число не меньше 1. |

```bash
rmx v2 status
rmx v2 mode v1
rmx v2 mode default
rmx v2 on
rmx v2 threads 16
```

Подкоманда `mode` записывает `multiAgentMode` в конфиг Remodex и заново синхронизирует каталог
Codex. При переходах mode и feature flag текущий числовой thread limit переносится между
допустимыми ключами Codex для v1/v2; если переход не удался, исходный `config.toml`
восстанавливается. Изменения применяются к новым сессиям Codex, а уже запущенные сохраняют свою
закреплённую surface.

## Combo routing

### `rmx combo <list|show|set|remove> ...` · `rmx route combo ...`

Управляйте virtual-моделями combo с failover и round-robin. `rmx route combo` — это иерархический
alias; на данный момент combo — единственный поддерживаемый routing-resource. Цели используют
форму `provider/model[:weight],provider/model[:weight]`.

```bash
rmx combo list
rmx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

О поведении маршрутизации и рекомендациях по конфигурации см. [Combos](/guides/combos/).

## Observability и debug

### `rmx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Проверяйте proxy-request'ы, usage, storage, memory и debug-data. Прямые alias'ы:

| Алиас | Эквивалентный ресурс |
| --- | --- |
| `rmx logs [filters] [--follow] [--json|--jsonl]` | `rmx observe logs` |
| `rmx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]` | `rmx observe usage` |
| `rmx storage [--json]` | `rmx observe storage` |
| `rmx memory [--json]` | `rmx observe memory` |

```bash
rmx observe usage --range 30d --json
```

### `rmx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Прочитать или изменить runtime debug-override'ы через management API работающего прокси.

```bash
rmx debug provider on|off|status|reset
rmx debug provider logs [-f|--follow]
rmx debug usage on|off|status|reset
rmx debug usage logs [-f|--follow]
```

Без указания scope `rmx debug` печатает usage и, если прокси остановлен, environment-default'ы
для следующего запуска. Provider debug по умолчанию берётся из `OCX_DEBUG=1`
(legacy `OCX_DEBUG_FRAMES=1` тоже работает); usage debug — из `OPENCODEX_USAGE_DEBUG=1`.

## Доступ к API

### `rmx access <key|endpoints|models|test> ...`

Управляйте admission API-key'ами Remodex и проверяйте внешние endpoint'ы и модели.
`rmx api-key <list|create|remove> ...` — alias `rmx access key`.

```bash
rmx access key create deployment
```

## Интеграции клиентов

### `rmx integration <claude|grok> ...`

Управляйте поддерживаемыми интеграциями Claude и Grok. Прямые семейства команд ниже
предоставляют элементы управления, специфичные для каждого клиента.

### `rmx claude [claude args...]`

Убедиться, что прокси запущен, а затем запустить Claude Code с `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` и model slot'ами из
`config.claudeCode`. Маршрутизируемые модели появляются в native-picker'е `/model` через стабильные
slot-alias'ы, начиная с Claude Code 2.1.129. На более старых версиях модель выбирается через
`ANTHROPIC_MODEL` или `/model <id>`. Пользовательские `ANTHROPIC_*`, экспортированные в окружение,
всегда имеют приоритет.

Команды для профиля Claude Desktop:

```text
rmx claude desktop [apply]                         Save and apply the four-family profile
rmx claude desktop show [--json]                   Show routes, families, and defaults
rmx claude desktop move <route> <family> [--default]
rmx claude desktop default <family> <route|none>
rmx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
rmx claude desktop import <path> [--apply]         Validate and import JSON
```

Семейства — `opus`, `fable`, `sonnet` и `haiku`; новые маршруты по умолчанию попадают в `opus`.
`none` допустимо только когда соответствующее семейство пусто. Legacy-flags `--static`,
`--hybrid` и `--discovery-only` для apply по-прежнему поддерживаются. Для настроек Claude Code
используйте `rmx claude config <status|set> ...`.

### `rmx opencode [opencode args...]`

Убедиться, что прокси запущен, и затем запустить opencode со сгенерированным блоком
`provider.opencodex` в inline runtime layer OpenCode (`OPENCODE_CONFIG_CONTENT`). Существующая
inline-конфигурация сохраняется, а только `provider.opencodex` заменяется для этого запуска.
Глобальные или проектные `opencode.json` могут читаться, чтобы выдать warning о существующем
override, но файлы на диске никогда не меняются. Маршрутизируемые модели появляются как
`opencodex/<provider>/<model>`. Последующий запуск обычного `opencode` работает ровно как раньше.

### `rmx grok <status|exclude|include|set|clear|apply> ...`

Управляйте fence'ом моделей для Grok Build и применяйте его.

## Экспорт client config

### `rmx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae>`

Печатает client config, направленный на работающий прокси. Команда сериализует блок
провайдера `opencodex` в нативном формате выбранного клиента: base URL, список моделей и,
в зависимости от клиента, credential reference либо заглушку `opencodex-loopback`.

Прокси должен быть запущен; команда определяет его живой порт, читает `/api/models` и выводит
только те модели, которые сейчас видит Codex.

| Флаг | Действие |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae>` | Обязателен. Выбирает формат конфигурации клиента. |
| `--json` | Печатать только JSON-конфиг в stdout, чтобы redirect сохранял побайтно точный вывод. Вся диагностика, включая заметку о записи через `--out`, идёт в stderr. |
| `--out <path>` | Записать конфиг в `<path>`. Перезаписывать существующий файл не позволит. |
| `--force` | Разрешить `--out` заменить существующий файл. |

```bash
rmx export --client opencode                     # config plus destination, merge warning, and counts
rmx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
rmx export --client omp --out ./omp-models.yml    # native OMP YAML
rmx export --client opencode --out ~/opencodex-opencode.json
```

Без `--json` сначала идёт сгенерированная конфигурация в нативном формате выбранного клиента,
затем канонический путь назначения, предупреждение о merge, клиентская подсказка перед запуском
и количество моделей с указанием, сколько строк не имеют context limit'а (для них клиент применяет
собственные default'ы).

| Клиент | Канонический путь | Имя скачиваемого файла | Переменная окружения |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` имеет приоритет, если задан) | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` | `pi-models.json` | нет — блок несёт литерал `opencodex-loopback` |
| `omp` | `~/.omp/agent/models.yml` (по умолчанию; `OMP_PROFILE` имеет приоритет над `PI_PROFILE`, даже если пуст) | `omp-models.yaml` | нет — литерал `opencodex-loopback` |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | нет — loopback placeholder |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | `OPENCODEX_GAJAE_API_KEY` |

opencode интерполирует `{env:OPENCODEX_OPENCODE_API_KEY}`. Сгенерированный Remodex экспорт для
Pi не требует переменной окружения и несёт литеральную заглушку `opencodex-loopback`. Это значение
обязательно: Pi разрешает `apiKey`, когда строит список моделей, и прячет провайдера целиком, если
существующий конфиг содержит ссылку на незаданную переменную окружения. На loopback прокси не
проверяет сгенерированную заглушку.

:::caution[Сливать, а не заменять]
`rmx export` никогда не пишет в ваш реальный клиентский конфиг. Путь назначения лишь
печатается, чтобы вы вручную выполнили merge, а `--out` без `--force` отказывается перезаписать
существующий файл именно потому, что полная замена уничтожила бы остальные провайдеры, агенты и
MCP-записи.
:::

Никакой ключ никогда не сериализуется. Конфиги opencode, Hermes и OpenClaw несут только
env-reference, так что секрет остаётся в вашем окружении, а конфиги Pi, OMP, Kimi и Gajae несут
loopback-заглушку вместо учётных данных. Loopback-прокси (`127.0.0.1`, по умолчанию) вообще не
требует admission key. Если прокси слушает не на loopback, задайте соответствующую переменную
`OPENCODEX_OPENCODE_API_KEY`, `OPENCODEX_HERMES_API_KEY` или `OPENCODEX_OPENCLAW_API_KEY`.
Сгенерированные интеграции Pi, OMP, Kimi и Gajae работают только через loopback. Как выдаются
admission key, описано в [Удалённом доступе](/reference/configuration/#remote-access). Ключи
upstream-провайдеров — это совсем отдельная история и настраиваются в [Провайдерах](/guides/providers/).

Тот же payload отдаётся через `GET /api/client-config` и показывается на вкладке API в дашборде,
поэтому CLI, API и GUI используют в точности одни и те же байты.

## Runtime и configuration

### `rmx system <status|settings|startup|diagnostics|sync|update> ...`

Управляйте headless runtime-setting'ами, startup, sync, diagnostics и update.

```bash
rmx system settings --stream-mode eager-relay
```

### `rmx config <show|get|set|unset|validate|export|import> ...`

Проверяйте и безопасно меняйте валидированную конфигурацию Remodex. `show` и `get`
маскируют секреты. Импорт выполняет валидацию перед записью и требует `--yes`.
