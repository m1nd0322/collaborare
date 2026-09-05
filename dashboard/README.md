# Knowledge Relay Dashboard

Windows VM의 Chrome에서 네트워크 프로젝트 폴더에 쌓이는 Copilot 대화 Markdown을 실시간 타임라인으로 보여 주는 폐쇄망용 대시보드입니다. `fs.watch` 대신 주기적인 재귀 scan과 Server-Sent Events(SSE)를 사용합니다.

- Node.js built-in 모듈만 사용합니다.
- 패키지 설치, CDN, 외부 폰트, telemetry가 없습니다.
- bind 주소는 numeric loopback인 `127.0.0.1` 또는 `::1`만 허용하며 CORS를 열지 않습니다.
- Markdown 파싱에 실패한 파일도 파일명과 원문으로 표시합니다.

## Requirements

- 지원 중인 Node.js 22 LTS 이상
- 조직이 승인한 Windows VM용 Chrome Enterprise
- 실행 계정에서 접근 가능한 프로젝트 폴더 또는 네트워크 드라이브

`npm install`은 필요하지 않습니다.

## Quick Start

제한망 운영에서는 저장소 root의 script로 승인 버전을 검증해 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

서버가 다음 폴더를 감시합니다. 폴더가 없으면 생성하지 않고 startup에 실패하므로 먼저 `Initialize-Project.ps1` 또는 `@collaborare /init`으로 초기화해야 합니다.

```text
Z:\ProjectName\knowledge-database
```

Chrome에서 다음 주소를 엽니다.

```text
http://127.0.0.1:43110
```

`Start-Dashboard.ps1`은 표준 설치 경로의 Chrome을 자동 실행하며, `-ChromePath`로 실행 파일을 직접 지정할 수도 있습니다. 이후의 `node server.js` 예시는 version pin을 우회하므로 진단 용도입니다.

명시적인 knowledge 경로를 사용하려면 다음처럼 실행합니다. `--knowledge-path`가 지정되면 project에서 파생한 기본 경로보다 우선합니다.

```powershell
node server.js --knowledge-path "Z:\ProjectName\knowledge-database"
```

명시한 폴더명이 `knowledge-database`이면 상위 project도 보안 경계로 추론해 두 directory identity를 모두 고정합니다. 다른 이름의 standalone 폴더는 해당 knowledge root identity만 고정합니다.

## CLI Options

| Option | Default | Description |
| --- | --- | --- |
| `--project <path>` | 없음 | 프로젝트 루트. `<path>/knowledge-database`를 감시합니다. |
| `--knowledge-path <path>` | 없음 | 감시할 knowledge 폴더를 직접 지정합니다. |
| `--host <host>` | `127.0.0.1` | `127.0.0.1` 또는 `::1`만 허용합니다. |
| `--port <port>` | `43110` | HTTP port입니다. |
| `--interval <ms>` | `2000` | polling scan 주기입니다. |
| `--max-file-bytes <bytes>` | `262144` | 개별 Markdown 크기 상한입니다. |
| `--max-files <count>` | `2000` | 한 scan의 Markdown 수 상한입니다. |
| `--max-total-bytes <bytes>` | `33554432` | 한 scan의 전체 Markdown byte 상한입니다. |
| `--help` | | 도움말을 출력합니다. |

각 옵션은 환경변수로도 설정할 수 있습니다. 명령행 옵션이 환경변수보다 우선합니다.

| Environment variable | Purpose |
| --- | --- |
| `DASHBOARD_PROJECT` | project 경로 |
| `DASHBOARD_KNOWLEDGE_PATH` | knowledge 경로 |
| `DASHBOARD_HOST` | bind 주소 |
| `DASHBOARD_PORT` | bind port |
| `DASHBOARD_INTERVAL` | scan 주기(ms) |
| `DASHBOARD_MAX_FILE_BYTES` | 파일별 최대 byte. 기본 `262144`(256 KiB) |
| `DASHBOARD_MAX_FILES` | scan당 최대 Markdown 수. 기본 `2000` |
| `DASHBOARD_MAX_TOTAL_BYTES` | scan 전체 Markdown byte 상한. 기본 `33554432`(32 MiB) |

예시:

```powershell
$env:DASHBOARD_PROJECT = "Z:\ProjectName"
$env:DASHBOARD_INTERVAL = "3000"
node server.js
```

## Storage Format

기본 저장 위치는 다음과 같습니다.

```text
knowledge-database/
  conversations/
    YYYY-MM-DD/
      *.md
```

권장 Markdown 형식:

````markdown
---
schema: "collaborare/conversation/v1"
id: "conv-20260830-001"
project: "ProjectName"
account: "developer@example.local"
account_source: "github"
machine: "WIN-DEV-01"
question_at: "2026-08-30T09:10:11+09:00"
response_at: "2026-08-30T09:11:12+09:00"
model: "Copilot model"
status: "complete"
question_chars: "9"
response_chars: "9"
---
# Conversation

## User

질문 본문입니다.

## Copilot

응답 본문입니다.

```js
console.log("code fence도 안전하게 표시됩니다");
```
````

간단한 single/double quoted frontmatter를 지원합니다. 형식이 손상되거나 수동으로 작성된 Markdown도 scan 전체를 실패시키지 않으며, UI의 raw fallback 영역에서 원문과 경고를 확인할 수 있습니다.

## Scanner Behavior

각 scan은 knowledge 폴더 아래 `.md` 파일을 재귀적으로 찾습니다.

- 이전 scan의 `mtime + ctime + size + file id + link count` fingerprint가 같으면 다시 읽거나 파싱하지 않습니다.
- 새 파일과 변경 파일은 `upsert`, 사라진 파일은 `delete`로 전송합니다.
- 숨김 파일, `~`/`#` 임시 파일, `.tmp.md`, `.temp.md`, `.swp.md`, `.part.md` 등을 무시합니다.
- Hard-link 게시 중인 multi-link Markdown은 읽지 않고 scan을 폐기하며, temp link 제거로 single-link commit된 다음 polling에서만 표시합니다.
- 심볼릭 링크를 따라가지 않으며 실제 경로가 knowledge 폴더 밖으로 벗어나면 읽지 않습니다.
- Startup에 확인한 project와 knowledge root의 canonical identity를 고정하며 어느 root든 다른 directory나 symlink/junction으로 교체되면 직전 snapshot을 유지하고 scan 오류를 표시합니다. Project 내부를 향하더라도 중간 symlink/junction을 거부하며 안정적인 filesystem identity tuple이 없으면 시작하지 않습니다.
- 파일 크기 제한을 넘은 항목은 건너뛰고 SSE `error` 경고를 보냅니다.
- 파일 수 제한을 넘은 scan은 폐기하고 직전 snapshot을 유지합니다. 따라서 부분 scan 때문에 정상 항목이 `delete` 처리되지 않습니다.
- 전체 Markdown byte 상한을 넘은 scan도 폐기해 서버와 Chrome의 과도한 메모리 사용을 막습니다.
- 한 파일의 읽기 오류는 다른 파일 처리를 중단하지 않습니다. 이전에 읽었던 파일이면 직전 항목을 유지합니다.

네트워크 드라이브가 일시적으로 끊기면 서버는 직전 snapshot으로 계속 응답하고 다음 polling 주기에 재시도합니다.

## HTTP API

| Endpoint | Content type | Description |
| --- | --- | --- |
| `GET /api/health` | `application/json` | 상태, 항목 수, scan 시각, 공개용 project label |
| `GET /api/conversations` | `application/json` | 최신순 초기 snapshot과 revision |
| `GET /api/events` | `text/event-stream` | `ready`, `upsert`, `delete`, `error`, `heartbeat` 이벤트 |

API와 SSE에는 knowledge 폴더의 절대 경로를 넣지 않습니다. 파일 식별자는 knowledge 폴더 기준 `/` 구분 상대경로입니다.

## UI Behavior

- 연결 상태와 자동 지수 backoff 재연결
- project/knowledge label, 전체/필터 건수, 마지막 갱신 시각
- 계정/상태 필터, 본문 검색, 최신순/오래된순 정렬
- 실시간 신규 항목 강조와 delete 반영
- 질문/응답 시각, 계정, host, model, status 표시
- heading, list, quote, inline code, bold, code fence의 최소 Markdown 표시
- desktop/mobile 반응형 이중 채널 타임라인

사용자 Markdown은 HTML 문자열로 삽입하지 않습니다. UI는 DOM node를 만들고 `textContent`를 사용하므로 `<script>` 같은 입력도 문자 그대로 표시됩니다. 서버는 CSP와 `nosniff`, frame 차단 헤더를 함께 보냅니다.

## Security Notes

- `127.0.0.1` 또는 `::1`만 허용하므로 Windows VM 외부에서 접근할 수 없습니다.
- 현재 버전에는 사용자 인증과 TLS가 없어 원격 bind를 지원하지 않습니다.
- CORS 허용 헤더와 telemetry가 없습니다.
- 정적 파일은 `index.html`, `styles.css`, `app.js`만 제공합니다.
- URL의 encoded traversal과 Windows backslash traversal을 모두 거부합니다.
- knowledge 원문 파일을 직접 내려받는 HTTP endpoint는 없습니다.
- Dashboard는 multi-link publication을 숨기지만 SMB writer 권한 자체를 통제하지 않습니다. Publisher의 active temp unlink 권한과 hard-link ACL 한계는 [`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)의 배포 경계를 따릅니다.

## Test

의존성 설치 없이 Node 내장 test runner를 실행합니다.

```powershell
npm test
```

개별 suite 실행 예시:

```powershell
node --test test/scanner.test.js
```

테스트용 파일은 `test/.tmp/` 아래에서 만들고 각 테스트 종료 시 제거합니다. HTTP/SSE 테스트는 임의 port를 사용하고 server, timer, SSE client를 명시적으로 닫습니다.

## Troubleshooting

### `Z:` 드라이브를 찾지 못하는 경우

Windows mapped drive는 사용자와 로그인 session별로 다를 수 있습니다. Node를 실행하는 같은 계정/session에서 `Z:`가 보이는지 확인하십시오. 작업 스케줄러나 서비스에서 실행할 때는 UNC 경로를 직접 지정하는 편이 안전합니다.

```powershell
node server.js --project "\\fileserver\share\ProjectName"
```

### 변경 반영이 늦는 경우

기본 polling 간격은 2초입니다. 네트워크 share의 파일 수와 지연을 고려해 값을 조정하십시오.

```powershell
node server.js --project "Z:\ProjectName" --interval 1000
```

너무 짧은 간격은 네트워크 share와 VM에 불필요한 I/O를 만들 수 있습니다.

### Port가 이미 사용 중인 경우

```powershell
node server.js --project "Z:\ProjectName" --port 43111
```

종료할 때는 `Ctrl+C`를 사용합니다. 서버는 polling timer와 모든 SSE client를 정리한 뒤 HTTP listener를 닫습니다.
