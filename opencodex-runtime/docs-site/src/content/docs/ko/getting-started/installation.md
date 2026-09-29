---
title: 설치
description: Remodex 프록시와 사전 요구 사항을 설치하고, 정상 실행되는지 확인합니다.
---

:::note
기본적으로 Remodex는 Codex의 config.toml, 모델 목록 또는 채팅 기록을 변경하지 않습니다. 휴대폰 연결, 시작 및 업데이트는 변경 권한을 부여하지 않습니다. 아래의 Codex 파일 동기화, 설정 삽입 및 복원 설명은 사용자가 rmx sync --allow-config-change로 명시적으로 허용한 경우에만 적용됩니다. rmx sync --revoke-config-access로 권한을 취소해도 기존 파일은 변경되지 않습니다.

[Codex configuration permission](/reference/cli/lifecycle/#codex-configuration-permission)
:::


Remodex를 설치하면 표준 명령 `rmx`가 제공됩니다. 호환성을 위해 `remodex`, `ocx`, `opencodex` 별칭도 유지되며,
네 명령 모두 같은 Bun 기반의 작은 로컬 HTTP 서버를 실행합니다. 모델 요청은 라우팅으로 선택된 프로바이더에
전달되며, 필요할 때 vision 및 웹 검색 sidecar가 ChatGPT 로그인을 사용할 수도 있습니다.

## 사전 요구 사항

| 요구 사항 | 이유 |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 20.9** | `rmx`는 Bun 런타임에서 실행되지만, 런타임이 `npm install` 시 자동으로 번들되므로 Bun을 직접 설치할 필요가 **없습니다**. |
| **[OpenAI Codex](https://openai.com/codex)**(CLI, App, 또는 SDK) | Remodex가 앞단에 위치하는 클라이언트입니다. Remodex는 `$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`)에 기록합니다. |
| 프로바이더 계정 또는 API 키 | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI API 키, OpenAI 호환 엔드포인트, 또는 ChatGPT 로그인. |

## 설치

```bash
npm install -g @remodex/rmx
```

:::note[npm이 bun postinstall을 차단했다면?]
최신 npm은 bun의 postinstall 스크립트를 차단할 수 있습니다(`npm warn
install-scripts ... blocked because they are not covered by allowScripts`).
이 경우 번들 Bun 런타임이 준비되지 않으므로 bun 스크립트를 허용해서
재설치하세요. npm 경고의 축약 명령에는 패키지 이름이 빠져 있어 현재
디렉터리를 재설치하게 되니, 항상 패키지 이름을 명시해야 합니다:

```bash
npm install -g --allow-scripts=bun @remodex/rmx

# 처음에 sudo로 설치했다면 sudo를 유지하세요:
sudo npm install -g --allow-scripts=bun @remodex/rmx
```
:::

표준 명령이 `PATH`에 잡히는지 확인합니다:

```bash
rmx --version
```

`remodex`, `ocx`, `opencodex`는 같은 동작을 하는 호환 별칭으로 유지됩니다.

설치 후 일반 설정은 다음 한 명령으로 완료됩니다:

```bash
rmx onboard
```

`rmx onboard`는 **컴퓨터 준비 → 백그라운드 서비스 시작 → QR 코드 준비**의 3단계로 진행되며 기다리는 동안 진행 메시지를 표시합니다. 대시보드를 사용할 수 있으면 페이지가 열리고, 같은 Wi-Fi 또는 검증된 원격 연결이 준비되면 QR 코드가 표시됩니다. 같은 신뢰할 수 있는 Wi-Fi에서 스캔한 뒤 새 휴대폰이 온라인 상태인지 확인하세요.

기존 공급자, 통합 선택, 사용자 지정 도메인은 유지됩니다. Codex 설정 변경, 업데이트 복구, Windows 트레이 설치는 페어링을 막지 않습니다. 선택 작업은 **Android Remote → 고급 설정**에 있습니다. Windows에서 백그라운드 작업을 처음 설치할 때는 관리자 승인이 필요할 수 있습니다. QR 코드는 5분 후 만료되며 다시 만들 수 있습니다.

### 배포 채널

안정화 채널인 `latest`에도 ChatGPT, OpenAI API 키, OpenRouter, 실험 단계의 Cursor 경로를 위한
GPT-5.6 Sol/Terra/Luna 카탈로그 정보가 이미 들어 있습니다. 다만 모델 사용 권한까지 생기는 것은
아닙니다. 아직 정식 배포되지 않은 Remodex 빌드를 시험할 때만 preview 채널을 사용하세요:

```bash
npm install -g @remodex/rmx@preview
rmx update --tag preview
```

## 소스에서 실행

Remodex 자체를 직접 수정하며 작업하려면:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # 개발 모드로 프록시 API 시작 (src/cli/index.ts start)
bun run dev:gui     # 대시보드 dev 서버 시작 (다른 터미널)
```

`bun run dev`는 `bun run dev:proxy`의 별칭으로 남아 있습니다. 프록시 API는 `/healthz`,
`/v1/responses`, `/api/*`를 노출하며, `GET /`는 `bun run build:gui`가 `gui/dist`를 생성한
뒤에만 패키징된 대시보드를 서빙합니다. 대시보드를 수정할 때는 `bun run dev:gui`로 프론트엔드를
별도로 실행하세요.

## 생성되는 항목

Remodex 상태 파일은 `$OPENCODEX_HOME`(기본값 `~/.remodex`) 아래에, Codex 연동 파일은
`$CODEX_HOME`(기본값 `~/.codex`) 아래에 저장됩니다.

| 경로 | 용도 |
| --- | --- |
| `$OPENCODEX_HOME/config.json` | 프로바이더, 기본 프로바이더, 포트, 옵션. |
| `$OPENCODEX_HOME/ocx.pid` | 실행 중인 프록시의 PID(단일 인스턴스 가드). |
| `$OPENCODEX_HOME/runtime-port.json` | 자동으로 고른 대체 포트를 포함한 현재 PID, 호스트명, 포트. |
| `$OPENCODEX_HOME/auth.json` | 저장된 OAuth 자격 증명(`rmx login` 시). |
| `$OPENCODEX_HOME/catalog-backup*.json` | Remodex가 수정하기 전에 만든 Codex 모델 카탈로그 백업. |
| `$CODEX_HOME/config.toml` | 로컬 전용 구성에서는 Remodex가 관리하는 루트 `openai_base_url`을 추가합니다. 로컬이 아닌 주소에 바인딩할 때는 Codex가 API 인증 헤더를 보낼 수 있도록 `model_provider = "opencodex"`와 `[model_providers.opencodex]`를 사용합니다. |
| `$CODEX_HOME/opencodex.config.toml` | 기본 Codex 설정과 함께 생성되는 참고용 fallback 프로필. |
| `$CODEX_HOME/opencodex-catalog.json` | Codex가 사용하는 네이티브 및 라우팅 모델 카탈로그. |

:::note
Remodex는 절대 Codex 설정을 삭제하지 않습니다. 모든 주입은 되돌릴 수 있습니다 — `rmx stop`, `rmx restore`,
또는 `rmx eject`는 Remodex가 추가한 줄만 정확히 제거하고 네이티브 Codex를 복원합니다.
:::

## 다음

[Quickstart](/ko/getting-started/quickstart/)로 이동해 첫 프로바이더를 설정하거나,
아키텍처를 알아보려면 [작동 방식](/ko/getting-started/how-it-works/)을 읽어 보세요.
