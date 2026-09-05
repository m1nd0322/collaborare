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
3. [제한망 지원 범위](#제한망-지원-범위)
4. [구성요소](#구성요소)
5. [사전 요구사항](#사전-요구사항)
6. [설치](#설치)
7. [VS Code 설정](#vs-code-설정)
8. [사용법](#사용법)
9. [Chrome 대시보드](#chrome-대시보드)
10. [저장 형식](#저장-형식)
11. [다중 VM 운영](#다중-vm-운영)
12. [문제 해결](#문제-해결)
13. [보안 및 운영 주의사항](#보안-및-운영-주의사항)
14. [개발 및 검증](#개발-및-검증)

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

읽기·경로 오류, knowledge 경로 누락, 프로젝트 경계 이탈, 전체 byte 상한 초과, Markdown 파일 수 상한 초과가 발생하면 모델을 호출하지 않습니다. `maxFileBytes`를 초과한 개별 파일만 검색 대상에서 제외하고 나머지 문서로 요청을 계속합니다.

## 중요한 제품 경계

VS Code 공개 API는 다른 확장이 기본 GitHub Copilot Chat의 모든 질문과 응답을 감청하거나 응답 직전에 임의 문맥을 삽입하는 기능을 제공하지 않습니다. 따라서 공유·감사·선행 지식 조회가 필요한 대화에서는 반드시 `@collaborare`를 사용해야 합니다.

- 기본 Copilot Chat에서 이미 발생한 대화는 자동 수집하지 않습니다.
- `@collaborare`는 Chat model picker에서 사용자가 선택한 `request.model`을 호출합니다.
- participant는 sticky로 설정되어 같은 Chat 세션에서는 후속 질문마다 다시 입력하지 않아도 됩니다.
- Chrome 대시보드는 읽기 전용 대화 기록 프로그램입니다. 브라우저에서 Copilot에 질문을 보내지는 않습니다.
- 기록의 `account`는 VS Code에서 탐지하거나 사용자가 선택한 운영상 귀속 정보입니다. Copilot 모델 호출 주체와 암호학적으로 결합된 서명은 아닙니다.

법적 부인방지 수준의 감사가 필요하면 회사 인증서 기반 서명이나 승인된 중앙 감사 수집기를 별도로 구성해야 합니다.

## 제한망 지원 범위

Collaborare의 전체 기능은 완전 air-gap에서 동작하지 않습니다. `@collaborare`는 VS Code Language Model API로 GitHub Copilot 클라우드 모델을 호출하므로 GitHub.com 또는 GHE.com 배포 형태, Copilot plan, 승인 client version과 활성 기능에 대해 배포 시점 공식 문서가 요구하는 인증·Copilot·editor 경로에 HTTPS로 연결되어야 합니다.

| 환경 | 지원 범위 |
| --- | --- |
| 완전 air-gap | 기존 Markdown과 로컬 dashboard 열람만 가능. Copilot 질문·응답은 지원하지 않음 |
| Copilot 제한망 | 해당 배포 형태와 기능의 공식 GitHub/Copilot/VS Code 필수 경로를 회사 proxy/allowlist로 허용하면 전체 기능 지원 |
| 오프라인 설치 | Marketplace와 npm registry 없이 local installer와 VSIX로 설치 가능 |

Collaborare runtime은 자체 outbound HTTP client나 외부 endpoint를 추가하지 않고 VS Code Authentication/Language Model API에 위임합니다. Host application인 VS Code와 Copilot의 공식 필수 통신은 별도이며, Marketplace, npm registry, dashboard CDN은 runtime에 필요하지 않습니다. 정확한 반입 BOM, proxy/custom CA, hash와 서명 기준은 [`docs/OFFLINE_BOM.md`](docs/OFFLINE_BOM.md)를 따르십시오.

## 구성요소

| 구성요소 | 위치 | 역할 |
| --- | --- | --- |
| VS Code 확장 | `vscode-extension/` | 지식 검색, Copilot 모델 호출, 질문·응답 기록, pending queue 동기화 |
| Chrome 대시보드 | `dashboard/` | 공유 폴더 polling, Markdown 파싱, HTTP/SSE, 실시간 타임라인 |
| Windows 스크립트 | `scripts/` | 프로젝트 초기화, VSIX 패키징·설치, 대시보드·Chrome 실행 |
| 배포 산출물 | `dist/` | 설치 가능한 VSIX와 SHA-256 checksum |
| 설계 문서 | `docs/ARCHITECTURE.md` | 데이터 흐름, 동시성 모델, 공개 API와 보안 경계 |
| 배포 문서 | `docs/DEPLOYMENT.md` | 폐쇄망 반입, ACL, 수용시험, 운영 절차 |
| 오프라인 BOM | `docs/OFFLINE_BOM.md` | 승인 버전, 설치 매체, proxy/CA, hash·서명 검증 기준 |

## 사전 요구사항

### 각 직원 Windows VM

| 항목 | 요구사항 |
| --- | --- |
| 운영체제 | Windows PowerShell 5.1과 .NET Framework 4.7.2 이상을 사용할 수 있는 Windows VM |
| VS Code | 1.97 이상 |
| Copilot | 승인된 정확한 버전의 GitHub Copilot Chat과 dependency VSIX, Enterprise 계정 로그인 |
| 네트워크 | 승인한 GitHub.com/GHE.com 배포 형태, Copilot plan, client와 기능에 필요한 회사 proxy/allowlist/custom CA 구성 |
| 공유 저장소 | `Z:\ProjectName` 또는 UNC 프로젝트 경로에 대한 읽기·쓰기 권한 |
| 대시보드 | 지원 중인 Node.js 22 LTS 이상, 조직이 승인한 Chrome Enterprise |

VS Code 확장만 사용할 VM에는 Node.js가 필요하지 않습니다. Node.js는 Chrome 대시보드를 실행하는 VM에만 필요합니다.

### VSIX 빌드 PC

| 항목 | 요구사항 |
| --- | --- |
| Node.js | 지원 중인 22 LTS 이상 |
| npm | 인터넷 또는 사내 npm mirror에서 `@vscode/vsce@3.9.2`와 의존성을 받을 수 있어야 함 |
| PowerShell | Windows PowerShell 5.1 이상 |
| 소스 위치 | 로컬 경로 또는 drive-letter 경로. UNC 현재 디렉터리에서는 `npx.cmd`를 실행하지 않음 |

저장소의 `dist/collaborare-0.1.1.vsix`를 승인된 배포 산출물로 직접 사용하는 경우 별도 빌드는 필요하지 않습니다.

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
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Package-Extension.ps1 `
  -ExpectedNodeVersion "<approved-version>"
```

기본 산출물은 다음과 같습니다.

```text
dist\collaborare-0.1.1.vsix
dist\BUILD-INFO.json
dist\README.md
dist\SHA256SUMS.txt
dist\DEPLOYMENT-SHA256SUMS.txt
```

`BUILD-INFO.json`에는 사용한 Node.js, vsce mode/version, VSIX SHA-256이 기록됩니다.

스크립트는 `@vscode/vsce@3.9.2`를 정확히 사용합니다. 인터넷이 차단된 빌드 환경에서는 해당 버전과 전체 의존성을 사내 mirror에 준비하거나 검증된 `vsce` 실행 파일을 `-VsceCommand`로 지정합니다. 직원 VM에서는 패키징 스크립트를 실행하지 않습니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Package-Extension.ps1 `
  -ExpectedNodeVersion "<approved-version>" `
  -VsceCommand "C:\Tools\vsce.cmd"
```

### 3. 배포 bundle 준비

배포 bundle root는 다음 구조를 사용합니다. `<version>`과 모든 외부 binary는 조직 승인 BOM의 정확한 값으로 치환합니다.

```text
README.md
dist\collaborare-0.1.1.vsix
dist\BUILD-INFO.json
dist\README.md
dist\SHA256SUMS.txt
dist\DEPLOYMENT-SHA256SUMS.txt
dashboard\package.json
dashboard\README.md
dashboard\server.js
dashboard\lib\*.js
dashboard\public\index.html
dashboard\public\styles.css
dashboard\public\app.js
docs\DEPLOYMENT.md
docs\OFFLINE_BOM.md
scripts\Initialize-Project.ps1
scripts\Install-Collaborare.ps1
scripts\New-DeploymentManifest.ps1
scripts\Start-Dashboard.ps1
scripts\Test-VsixArtifact.ps1
scripts\Vsix-Validation.ps1
extensions\github.copilot-chat-<version>.vsix
extensions\<copilot-prerequisite>-<version>.vsix
installers\<approved VS Code, Node.js, Chrome installers>
certificates\<approved proxy CA>
manifest\<organization-signed outer manifest>
```

`SHA256SUMS.txt`는 VSIX 하나를, `DEPLOYMENT-SHA256SUMS.txt`는 script가 정의한 Collaborare payload 파일을 검증합니다. 전체 bundle의 미등재 파일 거부와 외부 installer, Copilot VSIX, CA, 두 manifest 자체 검증은 조직이 서명한 outer manifest의 책임입니다. 반입한 `New-DeploymentManifest.ps1`을 실행하기 전에 outer manifest 또는 Authenticode로 해당 script를 먼저 신뢰해야 합니다.

신뢰 확인 후 Collaborare payload 전체를 검증합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-DeploymentManifest.ps1 `
  -ExpectedCollaborareVersion "0.1.1" `
  -ExpectedNodeVersion "22.23.2" `
  -Verify
```

VSIX 내부 runtime이 승인 source와 byte 단위로 일치하는지는 빌드 PC에서 확인합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-VsixArtifact.ps1 `
  -VsixPath ".\dist\collaborare-0.1.1.vsix"
```

VSIX checksum 확인 예시:

```powershell
$expected = (Get-Content .\dist\SHA256SUMS.txt -Raw).Split()[0].ToLowerInvariant()
$actual = (Get-FileHash .\dist\collaborare-0.1.1.vsix -Algorithm SHA256).Hash.ToLowerInvariant()
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
3. 임시 하위 directory를 만들고 그 안에서 publication temp create, hard-link publish, read, temp unlink, final read, cleanup을 수행해 SMB 게시 전제조건을 확인합니다.

### 5. 각 VM에 VS Code 확장 설치

`-ProjectPath`를 함께 지정하면 설치 후 프로젝트 초기화도 실행됩니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Collaborare.ps1 `
  -VsixPath ".\dist\collaborare-0.1.1.vsix" `
  -CopilotChatVsixPath ".\extensions\github.copilot-chat-<version>.vsix" `
  -PrerequisiteVsixPath ".\extensions\github.copilot-<version>.vsix" `
  -ExpectedPrerequisiteExtension "GitHub.copilot@<version>" `
  -ExpectedCodeVersion "<approved-version>" `
  -ExpectedCopilotChatVersion "<approved-version>" `
  -ExpectedCollaborareVersion "0.1.1" `
  -ProjectPath "Z:\ProjectName" `
  -Force
```

승인된 Copilot Chat VSIX와 각 dependency VSIX는 이미 같은 버전이 설치되어 있어도 반드시 전달하십시오. Chat 및 선행 VSIX의 `extensionDependencies`와 `extensionPack` 전체 closure에 대해 `-PrerequisiteVsixPath`와 `-ExpectedPrerequisiteExtension "publisher.one@<version>","publisher.two@<version>"`를 정확히 대응시킵니다. 설치 스크립트는 모든 archive의 package/container identity와 재귀 dependency graph를 CLI 실행 전에 검증하고 leaf-first 순서로 local VSIX를 강제 설치합니다. 모든 CLI 설치에 `--do-not-include-pack-dependencies`와 `--do-not-sync`를 적용하고 설치 전후 inventory에서 승인되지 않은 extension 변경을 거부합니다. 누락·추가·중복·version 불일치·cycle은 Marketplace 조회 전에 실패합니다.

Windows PowerShell 5.1의 `powershell.exe -File`은 배열 인수를 바인딩하지 못합니다. prerequisite가 둘 이상이면 Windows PowerShell session을 연 뒤 splatting으로 script를 직접 호출합니다.

```powershell
$install = @{
  VsixPath = ".\dist\collaborare-0.1.1.vsix"
  CopilotChatVsixPath = ".\extensions\github.copilot-chat-<version>.vsix"
  PrerequisiteVsixPath = @(
    ".\extensions\publisher.one-<version>.vsix"
    ".\extensions\publisher.two-<version>.vsix"
  )
  ExpectedPrerequisiteExtension = @(
    "publisher.one@<version>"
    "publisher.two@<version>"
  )
  ExpectedCodeVersion = "<approved-version>"
  ExpectedCopilotChatVersion = "<approved-version>"
  ExpectedCollaborareVersion = "0.1.1"
  ProjectPath = "Z:\ProjectName"
  Force = $true
}
& .\scripts\Install-Collaborare.ps1 @install
```

Portable VS Code처럼 별도 CLI를 사용하면 직접 지정합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Collaborare.ps1 `
  -VsixPath ".\dist\collaborare-0.1.1.vsix" `
  -CopilotChatVsixPath ".\extensions\github.copilot-chat-<version>.vsix" `
  -ExpectedCodeVersion "<approved-version>" `
  -ExpectedCopilotChatVersion "<approved-version>" `
  -ExpectedCollaborareVersion "0.1.1" `
  -CodeCommand "D:\Apps\VSCode\bin\code.cmd" `
  -Force
```

CLI를 사용할 수 없으면 VS Code에서 `Extensions: Install from VSIX...`를 실행할 수 있지만 script의 ID·정확한 버전·선행 확장 검증을 우회합니다. 운영 배포에서는 승인된 별도 검증 증거가 없는 수동 설치를 사용하지 마십시오.

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
| `collaborare.maxKnowledgeFiles` | `500` | 한 요청의 Markdown 파일 수 상한입니다. 초과하면 불완전한 문맥 전송을 막기 위해 모델 요청을 차단합니다. |
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
2. 당시 canonical project/knowledge/conversations/UTC date identity를 모두 고정한 요청이면 실패 기록을 `globalStorageUri/pending-conversations` 아래 VM 로컬 queue에 평문 JSON으로 원자 저장합니다. Identity를 고정하지 못했다면 다른 target으로 오게시하지 않도록 queue하지 않고 경고합니다.
3. 다음 `@collaborare` 요청 또는 `/sync`에서 현재 프로젝트 항목을 다시 게시합니다.
4. 이미 게시된 같은 UUID와 내용이면 성공한 것으로 처리해 중복 파일을 만들지 않습니다.

자동 동기화와 `/sync`는 호출당 현재 프로젝트 기록을 최대 100개 처리합니다. 출력의 `remaining`이 0보다 크면 `/sync`를 반복하십시오. `legacy awaiting review`는 자동 게시되지 않습니다.

`Z:` 경로와 UNC 경로는 같은 share라도 local queue에서 서로 다른 configured path로 취급됩니다. Queue는 lexical 경로와 당시 canonical project/knowledge/conversations/UTC date filesystem identity를 함께 저장하며, 같은 lexical 경로가 다른 share나 directory로 재매핑되면 자동 게시하지 않고 `other configured paths`로 남깁니다. 경로 전환 전에 기존 경로로 `/sync`를 완료하십시오. 0.1.0의 legacy v1 항목은 identity가 없어 자동 동기화하지 않습니다. 기존 경로가 원래 target임을 관리자가 확인한 뒤 수동 `/sync`의 modal 경고에서 승인한 당시 레코드만 현재 identity를 포함한 v2로 원자 전환합니다.

기본 queue 상한은 500개 또는 전체 32 MiB입니다. 둘 중 하나에 먼저 도달하면 추가 local 보관을 중단하고 Chat에 경고합니다. 로컬 평문 저장이 회사 정책상 허용되지 않으면 다음 설정을 사용합니다.

```json
{
  "collaborare.localSpoolEnabled": false
}
```

## Chrome 대시보드

대시보드는 공유 Markdown을 읽기 전용 대화 타임라인으로 표시합니다. 계정·상태 필터, 본문 검색, 정렬, 연결 상태, 신규 항목 강조, 삭제 반영을 제공합니다.

### 권장 실행 방법

지원 중인 Node.js 22 LTS 이상이 설치된 VM에서 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

기본 주소는 `http://127.0.0.1:43110`이며 표준 설치 경로의 Chrome을 자동으로 엽니다.

다른 port와 polling 간격을 사용하려면 다음처럼 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -Port 43111 `
  -Interval 3000 `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

Chrome 경로를 직접 지정할 수 있습니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ChromePath "D:\Apps\Chrome\chrome.exe" `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

브라우저 자동 실행이 금지된 환경에서는 `-NoBrowser`를 추가하고 표시된 URL을 직접 엽니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ExpectedNodeVersion "<approved-version>" `
  -NoBrowser
```

`-NoBrowser`는 Chrome을 실행·검증하지 않습니다. 사용자가 여는 Chrome의 정확한 버전은 조직의 software inventory로 별도 확인하십시오.

서버를 종료할 때는 실행한 terminal에서 `Ctrl+C`를 누릅니다.

### Node 직접 실행

직접 실행은 `Start-Dashboard.ps1`의 정확한 Node.js/Chrome 버전 검증을 우회하므로 진단 용도로만 사용합니다.

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
| `--host <host>` | `127.0.0.1` | `127.0.0.1` 또는 `::1`만 허용합니다. |
| `--port <port>` | `43110` | HTTP port입니다. |
| `--interval <ms>` | `2000` | polling 간격입니다. |
| `--max-file-bytes <bytes>` | `262144` | 개별 Markdown 크기 상한입니다. |
| `--max-files <count>` | `2000` | 한 scan의 Markdown 수 상한입니다. |
| `--max-total-bytes <bytes>` | `33554432` | 한 scan의 전체 Markdown byte 상한입니다. |

동일한 값은 `DASHBOARD_PROJECT`, `DASHBOARD_KNOWLEDGE_PATH`, `DASHBOARD_HOST`, `DASHBOARD_PORT`, `DASHBOARD_INTERVAL`, `DASHBOARD_MAX_FILE_BYTES`, `DASHBOARD_MAX_FILES`, `DASHBOARD_MAX_TOTAL_BYTES` 환경변수로도 지정할 수 있습니다.

현재 버전은 인증과 TLS를 제공하지 않아 `127.0.0.1`과 `::1` 외 주소 bind를 거부합니다. 다른 VM에 공개하지 마십시오. loopback도 Windows 사용자·프로세스 격리를 제공하지 않으므로 다중 사용자 VM에서는 OS 계정·session 격리가 필요합니다.

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

각 VM은 기존 파일에 append하지 않고 새 UUID 파일을 만듭니다. 임시 파일을 완전히 쓰고 같은 디렉터리에서 hard link create-if-absent로 게시하므로 다른 writer가 먼저 만든 UUID를 덮어쓰지 않습니다. Extension과 dashboard scanner는 single-link Markdown만 committed 상태로 읽으며, 게시 검증이 끝나고 writer가 자신의 active temp link를 제거하기 전 `nlink=2` 파일은 scan 전체를 무효화합니다. 게시 후 검증 실패로 열린 inode를 scrub한 경우에도 그 inode를 다시 덮어쓰지 않고, identity가 그대로인 0-byte single-link tombstone 또는 같은 inode의 엄격한 내부 publication-temp link만 남은 tombstone pair임을 확인한 뒤 새 UUID로 재게시합니다. 남은 temp link는 경로 교체 경쟁을 피하기 위해 recovery 중 삭제하지 않습니다.

## 다중 VM 운영

VM A와 VM B가 같은 `Z:\ProjectName`을 사용하면 별도 애플리케이션 서버 없이 대화 지식을 공유합니다.

1. VM A가 `@collaborare`로 질문하고 UUID Markdown을 저장합니다.
2. VM B의 다음 `@collaborare` 요청은 관련성이 있으면 VM A의 기록을 문맥으로 선택합니다.
3. 각 VM의 대시보드는 같은 파일을 polling하므로 최대 polling 간격만큼 지난 뒤 동일한 타임라인을 표시합니다.

운영 권장사항:

- 게시된 conversation 파일은 immutable 운영 기록으로 취급하고 수정·삭제를 감시·감사합니다.
- Publisher 실행 identity에는 자신의 publication temp를 생성·쓰기하고 final hard link를 만든 뒤 active temp link를 삭제할 권한이 필요합니다. 이 정상 commit unlink를 거부하는 ACL은 지원하지 않습니다.
- 기존 날짜 directory의 rename·delete와 reparse point 생성 권한은 제한합니다. 다른 identity가 만든 temp나 tombstone은 pending recovery가 끝나기 전에 수정·삭제하지 않습니다.
- 프로젝트 참여자에게만 knowledge 폴더 ACL을 부여합니다.
- SMB 공유가 같은 디렉터리의 hard-link create-if-absent와 publication-temp unlink를 지원하는지 수용시험에서 확인합니다.
- 파일 수가 증가하면 보존 기간과 archive 정책을 먼저 적용합니다.
- 기본 polling 2초가 공유 스토리지에 부담을 주면 간격을 늘립니다.

## 문제 해결

### `@collaborare`가 표시되지 않음

1. VS Code가 1.97 이상인지 확인합니다.
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

대화 요청은 누락된 공유 폴더를 자동으로 다시 만들지 않습니다. 네트워크 단절을 빈 database로 오인하지 않기 위한 동작입니다. 요청 시작부터 database가 없어 knowledge identity를 고정하지 못한 error audit은 다른 target으로 오게시하지 않도록 local queue에도 넣지 않습니다. 공유 드라이브 연결을 확인한 뒤 프로젝트를 명시적으로 초기화합니다.

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
  -ProjectPath "\\fileserver\share\ProjectName" `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
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
  -Port 43111 `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

## 보안 및 운영 주의사항

- 질문과 응답에는 소스 코드, 비밀번호, token, 고객 개인정보가 포함될 수 있습니다.
- `knowledge-database` ACL은 프로젝트 참여자에게만 부여하십시오.
- Publisher 실행 identity에는 새 날짜 directory, publication temp, final hard link 생성과 자신의 active temp link 삭제 권한이 필요합니다. 실제 extension identity로 정상 게시 후 temp link가 남지 않는지 수용시험합니다.
- Hard link의 temp와 final 이름은 같은 security descriptor를 공유하므로 일반 파일 ACL만으로 동일 writer에게 temp unlink를 허용하면서 final 수정·삭제를 완전히 금지할 수는 없습니다. 악성 또는 탈취된 참여자 identity까지 방어해야 하면 직접 SMB writer 대신 권한이 분리된 중앙 writer와 서명·감사 저장소를 사용합니다.
- account token과 GitHub 인증 session은 저장하지 않습니다.
- 공유 Markdown은 prompt injection을 포함할 수 있으므로 모델 prompt에서 untrusted reference로 격리합니다.
- local spool은 질문과 응답을 VM 로컬 extension storage에 평문으로 저장합니다.
- 대시보드는 사용자 Markdown을 `innerHTML`로 삽입하지 않고 DOM `textContent` 기반으로 렌더링합니다.
- 대시보드는 numeric loopback 전용, no CORS, no telemetry이며 knowledge 원문 다운로드 endpoint를 제공하지 않습니다.
- 대시보드는 numeric loopback `Host`와 same-origin browser 요청만 허용해 DNS rebinding을 차단합니다.
- 보존 기간, 삭제 승인, 감사 열람 권한, 퇴사자 ACL 회수는 회사 정보보호 정책으로 결정해야 합니다.
- 한 VM의 대시보드를 네트워크에 공개하는 구성은 현재 버전에서 지원하지 않습니다.
- 기존 공유 directory를 rename하거나 reparse point로 교체하거나 자신의 writer 권한으로 기존 inode를 변경할 수 있는 악의적 참여자까지 방어하는 부인방지 저장소는 아닙니다. 이 위협에는 권한이 분리된 중앙 writer와 서명된 감사 저장소가 필요합니다.
- Project root부터 knowledge write target까지 기존 경로 요소에 symlink/junction이 있거나 filesystem이 안정적인 identity tuple을 제공하지 않으면 extension과 dashboard는 fail closed합니다.
- 비정상 종료 뒤 local `.enqueue-lock`이 남으면 모든 관련 VS Code instance를 종료한 뒤에만 관리자가 lock을 제거합니다. 실행 중인 instance의 오래된 lock을 자동 탈취하지 않습니다. 공유 폴더의 0-byte publication-temp tombstone은 recovery가 읽기 전용 증거로 사용하므로 queue가 해소되기 전에 수동 삭제하지 않습니다.

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
- local pending queue 내구성·동시성·멱등성·명시적 legacy migration
- dashboard scanner diff·SSE·HTTP 보안 header·DNS rebinding 방어
- runtime package·browser asset·script의 offline network invariant
- VSIX source byte·Windows-safe archive path·container identity·재귀 dependency closure·exact-version 설치·배포 manifest smoke

PowerShell 배포 smoke는 생성된 `0.1.1` VSIX가 있는 상태에서 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\test\powershell\deployment-smoke.ps1
```

`npm test`는 현재 Node.js runtime에서 JavaScript suite와 offline runtime invariant를 실행합니다. `.github/workflows/verify.yml`은 Node.js 22와 Windows PowerShell 5.1에서 committed artifact 검증, 배포 smoke, 재패키징을 반복합니다.

실제 배포 전에는 Windows PowerShell 5.1, 회사 VS Code/Copilot Enterprise, 실제 `Z:` SMB 공유, Chrome 정책 환경에서 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)의 수용시험을 수행하십시오.

## 라이선스

현재 소프트웨어는 [`vscode-extension/LICENSE.txt`](vscode-extension/LICENSE.txt)의 Collaborare Internal Use License에 따라 승인된 조직 내부 평가와 사용 목적으로 제공됩니다.
