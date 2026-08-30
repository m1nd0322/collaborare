# Collaborare

Collaborare는 직원별 Windows VM의 GitHub Copilot 대화를 프로젝트 단위로 공유하는 파일 기반 지식 릴레이입니다. VS Code의 `@collaborare` Chat Participant가 프로젝트 공유 드라이브의 Markdown을 응답 전에 검색하고, 완료된 질문과 응답을 다시 공유 드라이브에 기록합니다. 로컬 Chrome 대시보드는 같은 기록을 읽기 전용 실시간 타임라인으로 표시합니다.

- 별도 중앙 서버나 외부 데이터베이스가 필요하지 않습니다.
- VS Code 확장과 대시보드 런타임에는 외부 npm 패키지가 필요하지 않습니다.
- 각 대화는 독립된 UUID Markdown 파일로 원자적으로 게시됩니다.
- 네트워크 드라이브가 일시적으로 중단되면 대화 기록을 VM 로컬 queue에 보관하고 재동기화할 수 있습니다.
- 대시보드는 기본적으로 `127.0.0.1`에만 열리며 CDN, telemetry, CORS를 사용하지 않습니다.

## 목차

1. [동작 방식](#동작-방식)
2. [중요한 제품 경계](#중요한-제품-경계)
3. [구성요소](#구성요소)
4. [사전 요구사항](#사전-요구사항)
5. [설치](#설치)
6. [VS Code 설정](#vs-code-설정)
7. [사용법](#사용법)
8. [Chrome 대시보드](#chrome-대시보드)
9. [저장 형식](#저장-형식)
10. [다중 VM 운영](#다중-vm-운영)
11. [문제 해결](#문제-해결)
12. [보안 및 운영 주의사항](#보안-및-운영-주의사항)
13. [개발 및 검증](#개발-및-검증)

## 동작 방식

```text
+---------------- Employee VM A ----------------+
| VS Code + GitHub Copilot + @collaborare        |
|      | knowledge read      | atomic log write  |
| Chrome <--- SSE --- local dashboard            |
+--------------------|---------------------------+
                     |
                     | shared SMB / mapped drive
                     v
Z:\ProjectName\knowledge-database\conversations\
                     ^
                     |
+--------------------|---------------------------+
| VS Code + GitHub Copilot + @collaborare        |
| Chrome <--- SSE --- local dashboard            |
+---------------- Employee VM B ----------------+
```

한 번의 대화 요청은 다음 순서로 처리됩니다.

1. 사용자가 VS Code Chat에서 `@collaborare`에 질문합니다.
2. 확장이 프로젝트와 knowledge 경로가 최초 canonical project 경계 안에 있는지 확인합니다.
3. 공유 Markdown에 파일 수, 파일별 크기, 전체 byte 상한을 적용해 재귀적으로 스캔합니다.
4. 영문·숫자 token, 한국어 2-gram 겹침, 최신성을 기준으로 관련 문서를 선택합니다.
5. 선택한 Markdown을 untrusted reference로 격리하고 현재 Chat 이력과 함께 사용자가 선택한 Copilot 모델에 전달합니다.
6. Copilot 응답을 Chat에 스트리밍합니다.
7. 질문, 응답, 계정 귀속 정보, VM 이름, 시각, 모델, 상태를 UUID Markdown으로 게시합니다.
8. 대시보드는 polling으로 변경을 감지하고 Chrome에 SSE `upsert` 또는 `delete` 이벤트를 전송합니다.

읽기·경로 오류, knowledge 경로 누락, 프로젝트 경계 이탈, 전체 byte 상한 초과가 발생하면 모델을 호출하지 않습니다. `maxKnowledgeFiles` 이후 파일과 `maxFileBytes`를 초과한 개별 파일은 검색 대상에서 제외하고 나머지 문서로 요청을 계속합니다.

## 중요한 제품 경계

VS Code 공개 API는 다른 확장이 기본 GitHub Copilot Chat의 모든 질문과 응답을 감청하거나 응답 직전에 임의 문맥을 삽입하는 기능을 제공하지 않습니다. 따라서 공유·감사·선행 지식 조회가 필요한 대화에서는 반드시 `@collaborare`를 사용해야 합니다.

- 기본 Copilot Chat에서 이미 발생한 대화는 자동 수집하지 않습니다.
- `@collaborare`는 Chat model picker에서 사용자가 선택한 `request.model`을 호출합니다.
- participant는 sticky로 설정되어 같은 Chat 세션에서는 후속 질문마다 다시 입력하지 않아도 됩니다.
- Chrome 대시보드는 읽기 전용 대화 기록 프로그램입니다. 브라우저에서 Copilot에 질문을 보내지는 않습니다.
- 기록의 `account`는 VS Code에서 탐지하거나 사용자가 선택한 운영상 귀속 정보입니다. Copilot 모델 호출 주체와 암호학적으로 결합된 서명은 아닙니다.

법적 부인방지 수준의 감사가 필요하면 회사 인증서 기반 서명이나 승인된 중앙 감사 수집기를 별도로 구성해야 합니다.

## 구성요소

| 구성요소 | 위치 | 역할 |
| --- | --- | --- |
| VS Code 확장 | `vscode-extension/` | 지식 검색, Copilot 모델 호출, 질문·응답 기록, pending queue 동기화 |
| Chrome 대시보드 | `dashboard/` | 공유 폴더 polling, Markdown 파싱, HTTP/SSE, 실시간 타임라인 |
| Windows 스크립트 | `scripts/` | 프로젝트 초기화, VSIX 패키징·설치, 대시보드·Chrome 실행 |
| 배포 산출물 | `dist/` | 설치 가능한 VSIX와 SHA-256 checksum |
| 설계 문서 | `docs/ARCHITECTURE.md` | 데이터 흐름, 동시성 모델, 공개 API와 보안 경계 |
| 배포 문서 | `docs/DEPLOYMENT.md` | 폐쇄망 반입, ACL, 수용시험, 운영 절차 |

## 사전 요구사항

### 각 직원 Windows VM

| 항목 | 요구사항 |
| --- | --- |
| 운영체제 | Windows PowerShell 5.1을 사용할 수 있는 Windows VM |
| VS Code | 1.95 이상 |
| Copilot | GitHub Copilot Chat 설치 및 Enterprise 계정 로그인 |
| 네트워크 | Copilot 자체 통신에 필요한 회사 proxy 또는 allowlist 구성 |
| 공유 저장소 | `Z:\ProjectName` 또는 UNC 프로젝트 경로에 대한 읽기·쓰기 권한 |
| 대시보드 | Node.js 18 이상, 최신 Chrome |

VS Code 확장만 사용할 VM에는 Node.js가 필요하지 않습니다. Node.js는 Chrome 대시보드를 실행하는 VM에만 필요합니다.

### VSIX 빌드 PC

| 항목 | 요구사항 |
| --- | --- |
| Node.js | 20 이상 |
| npm | 인터넷 또는 사내 npm mirror에서 `@vscode/vsce@3.9.2`와 의존성을 받을 수 있어야 함 |
| PowerShell | Windows PowerShell 5.1 이상 |
| 소스 위치 | 로컬 경로 또는 drive-letter 경로. UNC 현재 디렉터리에서는 `npx.cmd`를 실행하지 않음 |

저장소의 `dist/collaborare-0.1.0.vsix`를 승인된 배포 산출물로 직접 사용하는 경우 별도 빌드는 필요하지 않습니다.

## 설치

### 1. 소스 받기

```powershell
git clone https://github.com/m1nd0322/collaborare.git
Set-Location .\collaborare
```

폐쇄망 빌드 PC에서는 승인된 소스 bundle을 같은 디렉터리 구조로 반입합니다.

### 2. 선택 사항: 소스 검증 및 VSIX 재생성

전체 테스트를 먼저 실행합니다.

```powershell
npm test
```

VSIX를 생성합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Package-Extension.ps1
```

기본 산출물은 다음과 같습니다.

```text
dist\collaborare-0.1.0.vsix
dist\SHA256SUMS.txt
```

스크립트는 `@vscode/vsce@3.9.2`를 정확히 사용합니다. 완전한 폐쇄망 빌드 환경에서는 해당 버전과 전체 의존성을 사내 mirror에 준비하거나 검증된 `vsce` 실행 파일을 `-VsceCommand`로 지정합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Package-Extension.ps1 `
  -VsceCommand "C:\Tools\vsce.cmd"
```

### 3. 배포 bundle 준비

각 VM에 다음 파일과 폴더를 함께 전달합니다.

```text
dist\collaborare-0.1.0.vsix
dist\SHA256SUMS.txt
dashboard\
scripts\Initialize-Project.ps1
scripts\Install-Collaborare.ps1
scripts\Start-Dashboard.ps1
```

`SHA256SUMS.txt`는 VSIX만 검증합니다. dashboard와 PowerShell 스크립트는 조직의 서명된 배포 manifest나 승인된 배포 매체 hash로 별도 검증하십시오.

VSIX checksum 확인 예시:

```powershell
$expected = (Get-Content .\dist\SHA256SUMS.txt -Raw).Split()[0].ToLowerInvariant()
$actual = (Get-FileHash .\dist\collaborare-0.1.0.vsix -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "VSIX checksum mismatch" }
Write-Host "VSIX checksum verified: $actual"
```

### 4. 프로젝트 최초 초기화

프로젝트당 한 번 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Initialize-Project.ps1 `
  -ProjectPath "Z:\ProjectName"
```

프로젝트 폴더 자체도 만들어야 할 때만 `-CreateProject`를 사용합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Initialize-Project.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -CreateProject
```

초기화 스크립트는 다음 작업을 수행합니다.

1. `knowledge-database\conversations`를 생성합니다.
2. knowledge 경로가 symbolic link 또는 junction인지 검사합니다.
3. 임시 probe 파일을 생성·삭제해 실제 쓰기 권한을 확인합니다.

### 5. 각 VM에 VS Code 확장 설치

`-ProjectPath`를 함께 지정하면 설치 후 프로젝트 초기화도 실행됩니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Collaborare.ps1 `
  -VsixPath ".\dist\collaborare-0.1.0.vsix" `
  -ProjectPath "Z:\ProjectName" `
  -Force
```

설치 스크립트는 PATH와 표준 사용자·시스템 설치 경로에서 `code.cmd`를 찾고, 설치 후 `collaborare.collaborare@<version>`이 실제 목록에 나타나는지 확인합니다.

Portable VS Code처럼 별도 CLI를 사용하면 직접 지정합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Collaborare.ps1 `
  -VsixPath ".\dist\collaborare-0.1.0.vsix" `
  -CodeCommand "D:\Apps\VSCode\bin\code.cmd" `
  -Force
```

CLI를 사용할 수 없으면 VS Code에서 `Extensions: Install from VSIX...`를 실행해 `collaborare-0.1.0.vsix`를 선택합니다.

설치 후 VS Code를 다시 시작하고 `Z:\ProjectName`을 folder 또는 workspace로 엽니다.

### PowerShell 실행 정책

운영 배포에서는 스크립트를 회사 Authenticode 인증서로 서명하고 허용된 publisher 정책으로 실행하는 방식을 권장합니다. 문서의 `-ExecutionPolicy Bypass`는 서명 전 검증 또는 조직에서 명시적으로 승인한 설치 절차를 위한 process 단위 예시이며 Group Policy를 우회하지 않습니다.

승인된 파일의 상태는 다음처럼 확인할 수 있습니다.

```powershell
Get-ExecutionPolicy -List
Get-AuthenticodeSignature .\scripts\Install-Collaborare.ps1
```

## VS Code 설정

### 최초 설정 순서

1. `Z:\ProjectName`을 VS Code workspace로 엽니다.
2. GitHub Copilot Chat이 설치되고 Enterprise 계정으로 로그인되어 있는지 확인합니다.
3. Command Palette에서 `Collaborare: Configure Copilot Account Name`을 실행합니다.
4. 탐지된 GitHub 또는 GitHub Enterprise 계정을 선택합니다.
5. 계정이 탐지되지 않으면 감사 로그에 사용할 정확한 계정명을 입력합니다.
6. `Collaborare: Check Status`를 실행합니다.
7. knowledge 경로, Markdown 수, 읽기 실패 수, Copilot 설치 상태를 확인합니다.

계정명은 machine scope이며 Settings Sync 대상에서 제외됩니다. 공유 `.vscode/settings.json`에 직원별 `collaborare.accountName`을 저장하지 마십시오.

### 확장 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `collaborare.projectPath` | `""` | 프로젝트 root. 비어 있으면 첫 workspace folder를 사용합니다. 상대경로는 첫 workspace 기준입니다. |
| `collaborare.knowledgeDirectory` | `knowledge-database` | 프로젝트 내부의 knowledge 상대경로입니다. 절대경로와 `..`는 거부됩니다. |
| `collaborare.accountName` | `""` | 감사 로그에 기록할 계정명입니다. VM user setting에만 저장됩니다. |
| `collaborare.maxKnowledgeFiles` | `500` | 한 요청에서 고려할 Markdown 파일 수 상한입니다. |
| `collaborare.maxContextChars` | `24000` | 선택 지식과 participant history가 공유하는 문자 예산입니다. |
| `collaborare.maxFileBytes` | `262144` | 개별 Markdown 파일 byte 상한입니다. |
| `collaborare.maxKnowledgeBytes` | `33554432` | 한 scan에서 읽는 전체 Markdown byte 상한입니다. 초과 시 모델 요청을 차단합니다. |
| `collaborare.topK` | `8` | 모델 문맥에 포함할 최대 관련 문서 수입니다. |
| `collaborare.localSpoolEnabled` | `true` | 공유 게시 실패 시 VM 로컬 extension storage에 기록을 대기시킵니다. |
| `collaborare.localSpoolMaxFiles` | `500` | VM 로컬 pending 기록 수 상한입니다. |
| `collaborare.localSpoolMaxBytes` | `33554432` | VM 로컬 pending 기록의 전체 byte 상한입니다. |

프로젝트 공통 제한값 예시:

```json
{
  "collaborare.knowledgeDirectory": "knowledge-database",
  "collaborare.maxKnowledgeFiles": 500,
  "collaborare.maxKnowledgeBytes": 33554432,
  "collaborare.maxContextChars": 24000,
  "collaborare.topK": 8
}
```

`collaborare.projectPath`를 명시하려면 Windows JSON escaping을 적용합니다.

```json
{
  "collaborare.projectPath": "Z:\\ProjectName"
}
```

## 사용법

### 질문하기

VS Code Chat에서 다음처럼 질문합니다.

```text
@collaborare 현재 프로젝트의 배포 실패 복구 절차를 알려 주세요.
```

`@collaborare`가 선택된 Chat에서는 sticky participant가 유지되므로 후속 질문은 일반 문장으로 이어갈 수 있습니다. 새 Chat이나 다른 participant를 선택한 뒤에는 다시 `@collaborare`를 입력합니다.

응답에 사용된 공유 문서는 Chat reference로 표시됩니다. 관련 token 겹침이 없는 문서는 최신 파일이더라도 모델 문맥에 포함하지 않습니다.

### Chat 명령

| 명령 | 기능 |
| --- | --- |
| `@collaborare /init` | 프로젝트 knowledge database를 초기화합니다. |
| `@collaborare /open` | knowledge database 폴더를 Explorer에서 엽니다. |
| `@collaborare /status` | 경로, 계정, Copilot 설치, 파일·byte 제한 상태를 표시합니다. |
| `@collaborare /account` | 이 VM의 감사 로그 계정명을 선택하거나 변경합니다. |
| `@collaborare /sync` | VM 로컬 pending 대화 기록을 공유 드라이브에 다시 게시합니다. |

### Command Palette 명령

| 명령 | 기능 |
| --- | --- |
| `Collaborare: Initialize Knowledge Database` | knowledge 폴더를 생성하고 검증합니다. |
| `Collaborare: Open Knowledge Database Folder` | knowledge 폴더를 엽니다. |
| `Collaborare: Check Status` | 현재 프로젝트 상태를 검사합니다. |
| `Collaborare: Configure Copilot Account Name` | 계정 귀속 정보를 설정합니다. |
| `Collaborare: Sync Pending Conversation Logs` | pending 기록을 수동 동기화합니다. |

### 공유 드라이브 장애와 local spool

Copilot 응답을 생성했지만 공유 Markdown 게시가 실패하면 확장은 다음 순서로 처리합니다.

1. 같은 UUID로 공유 게시를 최대 3회 재시도합니다.
2. 실패하면 `globalStorageUri/pending-conversations` 아래 VM 로컬 queue에 평문 JSON을 원자적으로 기록합니다.
3. 다음 `@collaborare` 요청 또는 `/sync`에서 현재 프로젝트 항목을 다시 게시합니다.
4. 이미 게시된 같은 UUID와 내용이면 성공한 것으로 처리해 중복 파일을 만들지 않습니다.

자동 동기화와 `/sync`는 호출당 현재 프로젝트 기록을 최대 100개 처리합니다. 출력의 `remaining`이 0보다 크면 `/sync`를 반복하십시오.

기본 queue 상한은 500개 또는 전체 32 MiB입니다. 둘 중 하나에 먼저 도달하면 추가 local 보관을 중단하고 Chat에 경고합니다. 로컬 평문 저장이 회사 정책상 허용되지 않으면 다음 설정을 사용합니다.

```json
{
  "collaborare.localSpoolEnabled": false
}
```

## Chrome 대시보드

대시보드는 공유 Markdown을 읽기 전용 대화 타임라인으로 표시합니다. 계정·상태 필터, 본문 검색, 정렬, 연결 상태, 신규 항목 강조, 삭제 반영을 제공합니다.

### 권장 실행 방법

Node.js 18 이상이 설치된 VM에서 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName"
```

기본 주소는 `http://127.0.0.1:43110`이며 표준 설치 경로의 Chrome을 자동으로 엽니다.

다른 port와 polling 간격을 사용하려면 다음처럼 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -Port 43111 `
  -Interval 3000
```

Chrome 경로를 직접 지정할 수 있습니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ChromePath "D:\Apps\Chrome\chrome.exe"
```

브라우저 자동 실행이 금지된 환경에서는 `-NoBrowser`를 추가하고 표시된 URL을 직접 엽니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -NoBrowser
```

서버를 종료할 때는 실행한 terminal에서 `Ctrl+C`를 누릅니다.

### Node 직접 실행

```powershell
node .\dashboard\server.js --project "Z:\ProjectName"
```

UNC 경로도 사용할 수 있습니다.

```powershell
node .\dashboard\server.js --project "\\fileserver\share\ProjectName"
```

주요 옵션:

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--project <path>` | 없음 | `<path>/knowledge-database`를 감시합니다. |
| `--knowledge-path <path>` | 없음 | knowledge 경로를 직접 지정합니다. |
| `--host <host>` | `127.0.0.1` | HTTP bind 주소입니다. |
| `--port <port>` | `43110` | HTTP port입니다. |
| `--interval <ms>` | `2000` | polling 간격입니다. |
| `--max-file-bytes <bytes>` | `262144` | 개별 Markdown 크기 상한입니다. |
| `--max-files <count>` | `2000` | 한 scan의 Markdown 수 상한입니다. |
| `--max-total-bytes <bytes>` | `33554432` | 한 scan의 전체 Markdown byte 상한입니다. |

동일한 값은 `DASHBOARD_PROJECT`, `DASHBOARD_KNOWLEDGE_PATH`, `DASHBOARD_HOST`, `DASHBOARD_PORT`, `DASHBOARD_INTERVAL`, `DASHBOARD_MAX_FILE_BYTES`, `DASHBOARD_MAX_FILES`, `DASHBOARD_MAX_TOTAL_BYTES` 환경변수로도 지정할 수 있습니다.

대시보드를 다른 VM에 공개하려면 `--host` 변경뿐 아니라 Windows Firewall, 인증, TLS 정책이 필요합니다. 현재 버전에는 HTTP/API/SSE 사용자 인증이 없으므로 localhost 기본 운영을 권장합니다. `127.0.0.1`도 Windows 사용자·프로세스 격리를 제공하지 않으므로 다중 사용자 VM에서는 OS 격리나 인증 proxy가 필요합니다.

세부 CLI, API, scanner, UI 설명은 [`dashboard/README.md`](dashboard/README.md)를 참고하십시오.

## 저장 형식

기본 디렉터리 구조:

```text
Z:\ProjectName\
  knowledge-database\
    conversations\
      2026-08-30\
        550e8400-e29b-41d4-a716-446655440000.md
```

대화 파일 예시:

```markdown
---
schema: "collaborare/conversation/v1"
id: "550e8400-e29b-41d4-a716-446655440000"
project: "ProjectName"
account: "employee-github-id"
account_source: "github"
machine: "WIN-DEV-01"
question_at: "2026-08-30T09:10:11.000Z"
response_at: "2026-08-30T09:11:12.000Z"
model: "copilot/model"
status: "complete"
question_chars: "2"
response_chars: "2"
---

# Conversation

## User

질문

## Copilot

응답
```

`status`는 `complete`, `cancelled`, `error` 중 하나입니다. `question_chars`와 `response_chars`는 질문 안에 `## Copilot` 같은 구조용 heading이 들어 있어도 본문 경계를 정확히 복원하기 위해 사용합니다.

각 VM은 기존 파일에 append하지 않고 새 UUID 파일을 만듭니다. 임시 파일을 완전히 쓰고 같은 디렉터리 안에서 rename하므로 scanner는 완성된 기록만 읽습니다.

## 다중 VM 운영

VM A와 VM B가 같은 `Z:\ProjectName`을 사용하면 별도 애플리케이션 서버 없이 대화 지식을 공유합니다.

1. VM A가 `@collaborare`로 질문하고 UUID Markdown을 저장합니다.
2. VM B의 다음 `@collaborare` 요청은 관련성이 있으면 VM A의 기록을 문맥으로 선택합니다.
3. 각 VM의 대시보드는 같은 파일을 polling하므로 최대 polling 간격만큼 지난 뒤 동일한 타임라인을 표시합니다.

운영 권장사항:

- conversation 파일은 append-only로 취급하고 직접 수정은 최소화합니다.
- 프로젝트 참여자에게만 knowledge 폴더 ACL을 부여합니다.
- SMB 공유가 같은 디렉터리의 atomic rename을 지원하는지 수용시험에서 확인합니다.
- 파일 수가 증가하면 보존 기간과 archive 정책을 먼저 적용합니다.
- 기본 polling 2초가 공유 스토리지에 부담을 주면 간격을 늘립니다.

## 문제 해결

### `@collaborare`가 표시되지 않음

1. VS Code가 1.95 이상인지 확인합니다.
2. Extensions 화면에서 `Collaborare`가 enabled 상태인지 확인합니다.
3. GitHub Copilot Chat이 설치·활성화되어 있는지 확인합니다.
4. VS Code를 완전히 다시 시작합니다.
5. Chat에서 participant 선택 메뉴를 열어 `collaborare`를 찾습니다.

### `Shared knowledge scan was incomplete` 오류

확장은 읽기·경로 오류 또는 전체 byte 상한 때문에 완료하지 못한 scan으로 모델을 호출하지 않습니다. 다음을 확인하십시오.

```powershell
Test-Path "Z:\ProjectName\knowledge-database"
Get-ChildItem "Z:\ProjectName\knowledge-database" -Force
```

`Collaborare: Check Status`에서 read failure, 파일 수, 전체 byte를 확인합니다. 파일 수나 크기가 설정 상한을 넘었다면 오래된 기록을 archive하거나 승인된 범위에서 제한값을 높입니다.

### knowledge database가 없다는 오류

대화 요청은 누락된 공유 폴더를 자동으로 다시 만들지 않습니다. 네트워크 단절을 빈 database로 오인하지 않기 위한 동작입니다. 공유 드라이브 연결을 확인한 뒤 프로젝트를 명시적으로 초기화합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Initialize-Project.ps1 `
  -ProjectPath "Z:\ProjectName"
```

### 기본 Copilot 대화가 저장되지 않음

공개 API 제약에 따른 정상 동작입니다. 저장과 공유 문맥이 필요한 질문은 `@collaborare`로 보내야 합니다.

### 계정이 `local:` 값으로 기록됨

`Collaborare: Configure Copilot Account Name` 또는 `@collaborare /account`를 실행해 정확한 계정을 선택합니다. account는 귀속 metadata이며 인증 서명이 아니라는 점에 유의하십시오.

### 응답은 생성됐지만 저장 경고가 표시됨

공유 드라이브 게시 실패 후 local spool이 성공했는지 Chat 경고를 확인합니다. 공유 드라이브가 복구되면 다음을 실행합니다.

```text
@collaborare /sync
```

queue 상한까지 찼거나 local spool을 비활성화했다면 원본 대화가 자동 복구되지 않을 수 있으므로 운영 로그와 공유 드라이브 상태를 확인합니다.

### VS Code CLI를 찾지 못함

설치 스크립트는 표준 설치 경로를 자동 탐색합니다. Portable 또는 사내 패키징 경로라면 `-CodeCommand`를 지정하거나 VS Code의 `Extensions: Install from VSIX...`를 사용합니다.

### `Z:`가 PowerShell, Node 또는 VS Code에서 보이지 않음

Windows mapped drive는 사용자와 로그인 session별입니다. drive를 매핑한 동일 계정·session에서 VS Code와 대시보드를 실행하거나 UNC 경로를 사용합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "\\fileserver\share\ProjectName"
```

### 대시보드가 갱신되지 않음

1. `http://127.0.0.1:43110/api/health`가 응답하는지 확인합니다.
2. health의 `lastScanAt`, `conversationCount`, `status`를 확인합니다.
3. terminal에 scan 오류가 있는지 확인합니다.
4. Chrome 연결 상태가 재시도 중이면 페이지를 새로 고칩니다.
5. 네트워크 지연이 크면 polling 간격을 늘려 중첩 I/O를 피합니다.

### Port가 이미 사용 중임

다른 port를 지정합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -Port 43111
```

## 보안 및 운영 주의사항

- 질문과 응답에는 소스 코드, 비밀번호, token, 고객 개인정보가 포함될 수 있습니다.
- `knowledge-database` ACL은 프로젝트 참여자에게만 부여하십시오.
- account token과 GitHub 인증 session은 저장하지 않습니다.
- 공유 Markdown은 prompt injection을 포함할 수 있으므로 모델 prompt에서 untrusted reference로 격리합니다.
- local spool은 질문과 응답을 VM 로컬 extension storage에 평문으로 저장합니다.
- 대시보드는 사용자 Markdown을 `innerHTML`로 삽입하지 않고 DOM `textContent` 기반으로 렌더링합니다.
- 대시보드는 기본 localhost, no CORS, no telemetry이며 knowledge 원문 다운로드 endpoint를 제공하지 않습니다.
- 보존 기간, 삭제 승인, 감사 열람 권한, 퇴사자 ACL 회수는 회사 정보보호 정책으로 결정해야 합니다.
- 한 VM의 대시보드를 네트워크에 공개하려면 현재 버전에 없는 인증과 TLS를 먼저 추가해야 합니다.

## 개발 및 검증

외부 runtime 의존성 설치 없이 Node 내장 test runner로 전체 suite를 실행합니다.

```powershell
npm test
```

개별 suite:

```powershell
npm run test:extension
npm run test:dashboard
npm run test:integration
```

현재 검증 범위:

- VS Code 확장 unit/integration test
- Markdown 직렬화·파싱 round-trip
- knowledge 검색·크기 제한·경로 경계 검증
- local pending queue 내구성·동시성·멱등성
- dashboard scanner diff·SSE·HTTP 보안 header

`npm test`는 현재 Node.js runtime에서 JavaScript suite를 실행합니다. 릴리스 시에는 Node.js 18 직접 실행, VSIX 압축·source byte 비교, PowerShell parser 검사를 별도로 수행합니다.

실제 배포 전에는 Windows PowerShell 5.1, 회사 VS Code/Copilot Enterprise, 실제 `Z:` SMB 공유, Chrome 정책 환경에서 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)의 수용시험을 수행하십시오.

## 라이선스

현재 소프트웨어는 [`vscode-extension/LICENSE.txt`](vscode-extension/LICENSE.txt)의 Collaborare Internal Use License에 따라 승인된 조직 내부 평가와 사용 목적으로 제공됩니다.
