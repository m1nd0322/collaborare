# Closed-Network Deployment

## 지원 범위

이 문서에서 폐쇄망은 Marketplace와 npm registry가 차단되어 있지만 승인한 GitHub.com/GHE.com 배포 형태, Copilot plan, client version과 활성 기능에 대해 공식 문서가 요구하는 인증·Copilot·editor 경로는 회사 proxy/allowlist로 허용된 **Copilot 제한망**을 뜻합니다. 해당 HTTPS까지 차단된 완전 air-gap에서는 기존 Markdown dashboard 열람만 가능하고 `@collaborare` 모델 응답은 지원하지 않습니다.

Collaborare runtime은 자체 outbound HTTP client나 외부 endpoint를 추가하지 않고 VS Code Authentication/Language Model API에 위임합니다. VS Code와 Copilot host 통신은 별도입니다. 승인 버전, 반입 파일, proxy/custom CA, hash·서명 기준은 [`OFFLINE_BOM.md`](OFFLINE_BOM.md)에 고정합니다.

## 사전 조건

각 Windows VM에서 다음을 확인합니다.

- VS Code 1.97 이상
- Windows PowerShell 5.1 및 .NET Framework 4.7.2 이상
- 정확한 승인 버전의 GitHub Copilot Chat과 해당 manifest의 dependency VSIX 설치
- GitHub Copilot Enterprise 계정 로그인과 Language Model consent
- 해당 환경에서 Copilot 모델 요청이 정상 동작하도록 구성된 사내 proxy/allowlist
- `Z:\<ProjectName>` 읽기·쓰기 권한
- 대시보드 실행 VM의 지원 중인 Node.js 22 LTS 이상
- 조직이 승인한 Chrome Enterprise

Collaborare는 별도 외부 통신을 추가하지 않지만 Copilot 자체 통신 조건을 대신 해결하지는 않습니다.

배포용 PowerShell은 운영 환경에서 회사 Authenticode 인증서로 서명하고 허용된 publisher 정책으로 실행하는 방식을 권장합니다. 아래 `-ExecutionPolicy Bypass` 예시는 서명 전 검증 또는 조직이 명시적으로 승인한 설치 절차에만 사용하며 Group Policy를 우회하지 않습니다. 인터넷에서 내려받은 파일을 승인한 경우에는 관리자가 `Unblock-File`을 수행하고 `Get-AuthenticodeSignature`로 서명을 확인합니다.

## 1. 연결 가능한 빌드 환경

소스 검증:

```powershell
npm test
```

VSIX 생성:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Package-Extension.ps1 `
  -ExpectedNodeVersion "<approved-version>"
```

기본 패키징에는 지원 중인 Node.js 22 LTS 이상과 정확히 `@vscode/vsce@3.9.2`가 사용됩니다. 인터넷이 차단된 빌드 PC에서는 해당 버전과 전체 의존성을 사내 미러에 준비하거나 `-VsceCommand`에 사전 반입한 검증된 실행 파일을 지정합니다. 소스가 UNC 경로라면 먼저 로컬 경로나 매핑된 drive로 복사합니다.

배포 묶음에 최소한 다음을 포함합니다.

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
docs\OFFLINE_BUNDLE.md
scripts\Install-Collaborare.ps1
scripts\Initialize-Project.ps1
scripts\New-DeploymentManifest.ps1
scripts\New-OfflineBundle.ps1
scripts\Start-Dashboard.ps1
scripts\Test-OfflineBundle.ps1
scripts\Test-VsixArtifact.ps1
scripts\Vsix-Validation.ps1
extensions\<approved Copilot Chat and prerequisite VSIX files>
installers\<approved VS Code, Node.js, and Chrome installers>
certificates\<approved proxy CA>
manifest\<organization-signed outer manifest>
```

`Package-Extension.ps1`은 VSIX checksum과 build info를 만든 뒤 script가 정의한 dashboard·문서·운영 스크립트 payload의 `DEPLOYMENT-SHA256SUMS.txt`도 생성합니다. 기존 release artifact를 포함한 bundle을 다시 준비할 때는 다음 명령으로 재생성합니다.

저장소에는 Collaborare 소유 파일만 포함한 `dist\collaborare-0.1.1-offline-payload.zip`도 제공합니다. 이 ZIP은 직원 VM으로 바로 반입할 수 있는 payload이며 외부 승인 installer와 Copilot VSIX를 포함하지 않습니다. 생성·검증은 [`OFFLINE_BUNDLE.md`](OFFLINE_BUNDLE.md)의 절차를 사용합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-DeploymentManifest.ps1 `
  -ExpectedCollaborareVersion "0.1.1" `
  -ExpectedNodeVersion "22.23.2"
```

이 script가 만드는 manifest는 명시된 Collaborare payload만 포함하며 source tree나 전체 bundle의 임의 추가 파일을 판정하지 않습니다. 외부 installer, Copilot VSIX, CA, payload manifest와 verifier script를 포함한 전체 bundle은 모든 파일을 열거하고 미등재 파일을 거부하는 조직 서명 outer manifest로 검증합니다. VM에서는 outer manifest와 `New-DeploymentManifest.ps1`의 신뢰를 먼저 확인한 뒤 payload를 검증합니다. 같은 매체의 검증되지 않은 script로 그 script 자신의 hash를 신뢰해서는 안 됩니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-DeploymentManifest.ps1 `
  -ExpectedCollaborareVersion "0.1.1" `
  -ExpectedNodeVersion "22.23.2" `
  -Verify
```

## 2. 프로젝트 최초 1회 초기화

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Initialize-Project.ps1 -ProjectPath "Z:\ProjectName"
```

생성 경로:

```text
Z:\ProjectName\knowledge-database\conversations
```

권장 ACL:

- 프로젝트 참여자 실행 identity: 읽기, 날짜 directory 생성, 자신의 publication temp 생성·쓰기, final hard link 생성, 정상 commit 시 자신의 active temp link 삭제 권한
- 프로젝트 관리자: 삭제·보존 정책 수행 권한
- 비참여자: 접근 거부
- 일반 직원 전체에 광범위한 쓰기 권한을 부여하지 않음
- 프로젝트 참여자에게 기존 날짜 directory 삭제·rename 또는 reparse point 생성 권한을 부여하지 않음
- 다른 identity가 만든 publication temp와 recovery tombstone을 변경·rename·삭제하지 않도록 provider가 지원하는 owner 단위 제한 적용

정상 게시의 마지막 commit 연산은 publisher가 자신의 active temp link를 삭제하는 `unlink`입니다. 이 권한을 거부하면 extension은 final hard link를 committed로 인정하지 않고 fail closed하므로, ACL 적용 뒤 실제 extension 실행 identity로 게시해 final이 single-link가 되고 publication temp가 남지 않는지 확인해야 합니다.

Hard link의 temp와 final 이름은 같은 inode 및 security descriptor를 공유합니다. 따라서 일반 NTFS/SMB ACL만으로 동일 writer identity에 temp unlink를 허용하면서 final 이름의 수정·삭제를 완전히 금지할 수는 없습니다. 이 직접-writer 배포는 cooperative participant를 전제로 하며 conversation immutability는 운영 정책, monitoring, backup으로 관리합니다. 악성 또는 탈취된 participant identity까지 격리해야 하는 환경은 공유 폴더에 직접 쓰기 권한을 주지 말고 권한이 분리된 중앙 writer와 서명된 감사 저장소를 사용해야 합니다.

초기화 스크립트는 임시 하위 directory에서 publication temp create→hard-link publish→read→temp unlink→final read→cleanup probe를 수행합니다. 이 probe와 별도로 VM A/B 동시 쓰기, single-link 전환, commit 전 scanner 미노출을 실제 SMB share 수용시험에서 확인합니다.

## 3. 각 직원 VM 설치

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

승인한 Copilot Chat manifest와 각 선행 VSIX가 요구하는 전체 dependency closure를 `-PrerequisiteVsixPath`와 `-ExpectedPrerequisiteExtension` 배열로 전달합니다. 설치 스크립트는 모든 archive의 package/container identity를 검사하고 dependency graph를 leaf-first 순서로 강제 local 설치합니다. VS Code 1.97 이상의 `--do-not-include-pack-dependencies`와 `--do-not-sync`를 모든 설치에 적용하며, 설치 전후 inventory에서 미승인 extension 추가·변경·삭제가 발생하면 실패합니다. 누락·추가·중복·version 불일치·cycle은 Marketplace를 조회하기 전에 실패합니다.

Windows PowerShell 5.1의 `powershell.exe -File`은 배열 인수를 바인딩하지 못합니다. prerequisite가 둘 이상이면 Windows PowerShell session 안에서 다음처럼 splatting을 사용합니다.

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

VS Code에서 다음 순서로 확인합니다.

1. `Z:\ProjectName`을 folder 또는 workspace로 엽니다.
2. `Collaborare: Configure Copilot Account Name`을 실행합니다.
3. 현재 Copilot Enterprise 계정을 선택하거나 정확한 계정명을 입력합니다.
4. `Collaborare: Check Status`를 실행합니다.
5. knowledge 경로가 예상 위치이고 읽기·쓰기가 가능하며 Copilot Chat이 installed인지 확인합니다.
6. `@collaborare /init`을 실행해도 같은 위치가 표시되는지 확인합니다.
7. 일반 Copilot Chat에서 모델 요청 하나를 보내 proxy, CA, 인증, consent가 정상인지 확인합니다.

`collaborare.accountName`은 `machine` scope이며 Settings Sync 대상에서 제외됩니다. 공유 `.vscode/settings.json`에 직원 계정명을 넣지 마십시오.

이 계정명은 운영상 귀속을 위한 metadata입니다. 법적 부인방지가 수용 기준이면 현재 파일 기반 버전만 배포하지 말고, 회사 인증서로 각 기록에 서명하거나 승인된 중앙 감사 수집기를 추가해야 합니다.

## 4. 기능 확인

VM A에서:

```text
@collaborare 배포 전 확인 항목을 세 가지로 정리해 주세요.
```

다음을 확인합니다.

1. Chat 응답이 스트리밍됩니다.
2. `knowledge-database\conversations\YYYY-MM-DD`에 새 `.md`가 생성됩니다.
3. Markdown frontmatter의 account, machine, question_at, response_at, status가 정확합니다.

VM B에서 같은 주제의 질문을 하고, Chat 응답 reference에 VM A의 기록이 선택되는지 확인합니다.

## 5. 대시보드 실행

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -Port 43110 `
  -Interval 2000 `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

Chrome이 자동으로 열리지 않는 정책 환경에서는 Chrome version 검증 인수 대신 `-NoBrowser`를 사용하고 `http://127.0.0.1:43110`을 직접 엽니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ExpectedNodeVersion "<approved-version>" `
  -NoBrowser
```

이 모드에서는 실제로 여는 Chrome의 정확한 버전을 조직 software inventory로 별도 확인합니다.

스크립트는 표준 설치 경로의 Chrome을 우선 실행합니다. 별도 설치 위치라면 `-ChromePath "D:\Apps\Chrome\chrome.exe"`를 지정합니다. Chrome을 찾지 못하면 승인되지 않은 기본 브라우저로 fallback하지 않고 실패합니다. 브라우저를 자동 실행하지 않을 때만 `-NoBrowser`를 사용합니다.

모든 VM이 로컬 대시보드를 실행할 필요는 없습니다. 조회가 필요한 VM에서만 실행하면 됩니다. 현재 dashboard에는 인증과 TLS가 없으므로 `127.0.0.1`과 `::1` 외 bind를 거부하며 다른 VM에 공개하는 구성은 지원하지 않습니다.

## 6. 운영 기준

- 기본 polling 2초를 유지하고 파일 수가 많을 때 간격을 늘립니다.
- `DASHBOARD_MAX_FILES`, `DASHBOARD_MAX_FILE_BYTES`를 프로젝트 규모와 정책에 맞춰 설정합니다.
- conversation 파일은 immutable 운영 기록으로 취급하고 수정·삭제를 monitoring, backup, 감사 정책으로 통제합니다. 직접 writer에게 부여한 권한 자체를 악용하는 공격까지 막아야 하면 중앙 writer가 필요합니다.
- 삭제·보존 정책 실행 전 대시보드를 중지할 필요는 없지만, 변경은 delete 이벤트로 즉시 반영됩니다.
- 직원 퇴사·프로젝트 이동 시 `Z:` ACL을 회수하고 VM의 `collaborare.accountName` 설정을 초기화합니다.
- 대화에 비밀번호, token, 고객 개인정보를 입력하지 않도록 별도 사용자 정책을 적용합니다.
- `collaborare.localSpoolEnabled` 기본값은 `true`입니다. VM 로컬 extension storage의 평문 임시 보관이 정책상 허용되는지 배포 전에 결정합니다. 기본 보존 상한은 `collaborare.localSpoolMaxFiles=500`, `collaborare.localSpoolMaxBytes=33554432`이며 상한에 도달하면 새 로컬 대기 기록을 만들지 않고 경고합니다.
- mapped drive와 UNC는 같은 share라도 서로 다른 queue identity입니다. Queue는 lexical 경로와 canonical project/knowledge/conversations/UTC date filesystem identity를 함께 비교하므로 같은 경로가 다른 target으로 재매핑되면 자동 게시하지 않습니다. 경로를 변경하기 전에 기존 경로에서 `/sync`의 `remaining for this path`가 0인지 확인합니다. `other configured paths`가 0보다 크면 이전 `collaborare.projectPath`로 되돌려 동기화한 뒤 전환합니다. 0.1.0의 identity 없는 legacy v1 항목은 자동 게시되지 않습니다. 원래 경로와 target임을 확인한 관리자가 수동 `/sync`의 modal 경고를 승인해야 하며, 경로가 불확실하면 승인하지 말고 원본 VM·share를 복구합니다.
- Extension과 dashboard가 `stable filesystem identity is unavailable`로 실패하거나 초기화의 hard-link probe가 실패하면 해당 SMB provider가 안전한 remap/no-clobber 게시에 필요한 기능을 제공하지 않는 것입니다. 다른 지원 경로/provider를 사용하고 fail-closed 검사를 우회하지 않습니다.
- 비정상 종료로 local `.enqueue-lock`이 남으면 모든 관련 VS Code instance가 종료됐음을 확인한 관리자만 제거합니다. Suspended VM의 lock을 다른 process가 시간만 보고 탈취하지 않습니다. 공유 폴더의 0-byte publication-temp tombstone은 pending queue가 해소되기 전에 수동 삭제하지 않습니다.
- VS Code, Copilot Chat, Node.js, Chrome 자동 update를 허용할지는 조직 change control로 결정합니다. 차단한다면 security patch 배포 절차와 승인 BOM 갱신 주기를 별도로 운영합니다.

## 장애 점검

### account가 local fallback으로 보임

`Collaborare: Configure Copilot Account Name`을 실행해 계정을 명시합니다. 상태 화면의 local fallback은 비대화형 자동 탐지에 실패했다는 뜻입니다.

### `Z:`가 Node 또는 VS Code에서 보이지 않음

mapped drive는 Windows 로그인 session별입니다. VS Code와 PowerShell을 드라이브를 매핑한 동일 계정으로 실행하거나 UNC 경로를 사용합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "\\fileserver\share\ProjectName" `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

### 대화는 보이지만 새 내용 반영이 늦음

대시보드 상태의 last scan 시각을 확인하고 polling 값을 일시적으로 낮춥니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -Interval 1000 `
  -ExpectedNodeVersion "<approved-version>" `
  -ExpectedChromeVersion "<approved-version>"
```

### 기본 Copilot 대화가 저장되지 않음

공개 API 제약에 따른 정상 동작입니다. 감사 대상 대화는 `@collaborare`를 사용해야 합니다.

### 완전 air-gap에서 모델 응답이 없음

정상적인 제품 경계입니다. `@collaborare`는 GitHub Copilot 클라우드 모델을 사용하므로 해당 GitHub.com/GHE.com 배포 형태와 client 기능에 대해 공식 문서가 요구하는 인증·Copilot·editor 경로 연결이 필요합니다. 완전 단절망 모델이 필요하면 현재 구현과 별도의 local model provider 설계가 필요합니다.
