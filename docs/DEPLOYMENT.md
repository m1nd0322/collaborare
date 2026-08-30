# Closed-Network Deployment

## 사전 조건

각 Windows VM에서 다음을 확인합니다.

- VS Code 1.95 이상
- GitHub Copilot Chat 설치 및 Enterprise 계정 로그인
- 해당 환경에서 Copilot 모델 요청이 정상 동작하도록 구성된 사내 proxy/allowlist
- `Z:\<ProjectName>` 읽기·쓰기 권한
- 대시보드 실행 VM의 Node.js 18 이상
- 최신 Chrome

Collaborare는 별도 외부 통신을 추가하지 않지만 Copilot 자체 통신 조건을 대신 해결하지는 않습니다.

배포용 PowerShell은 운영 환경에서 회사 Authenticode 인증서로 서명하고 허용된 publisher 정책으로 실행하는 방식을 권장합니다. 아래 `-ExecutionPolicy Bypass` 예시는 서명 전 검증 또는 조직이 명시적으로 승인한 설치 절차에만 사용하며 Group Policy를 우회하지 않습니다. 인터넷에서 내려받은 파일을 승인한 경우에는 관리자가 `Unblock-File`을 수행하고 `Get-AuthenticodeSignature`로 서명을 확인합니다.

## 1. 연결 가능한 빌드 환경

소스 검증:

```powershell
npm test
```

VSIX 생성:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Package-Extension.ps1
```

기본 패키징에는 Node.js 20 이상과 정확히 `@vscode/vsce@3.9.2`가 사용됩니다. 완전한 폐쇄망 빌드 PC에서는 해당 버전과 전체 의존성을 사내 미러에 준비하거나 `-VsceCommand`에 사전 반입한 검증된 실행 파일을 지정합니다. 소스가 UNC 경로라면 먼저 로컬 경로나 매핑된 drive로 복사합니다.

배포 묶음에 최소한 다음을 포함합니다.

```text
dist\collaborare-0.1.0.vsix
dist\SHA256SUMS.txt
dashboard\
scripts\Install-Collaborare.ps1
scripts\Initialize-Project.ps1
scripts\Start-Dashboard.ps1
```

폐쇄망 반입 후 VSIX의 `Get-FileHash -Algorithm SHA256` 결과를 `SHA256SUMS.txt`와 비교합니다. dashboard와 PowerShell 파일은 조직의 서명된 배포 manifest 또는 승인된 매체 hash로 별도 검증합니다.

## 2. 프로젝트 최초 1회 초기화

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Initialize-Project.ps1 -ProjectPath "Z:\ProjectName"
```

생성 경로:

```text
Z:\ProjectName\knowledge-database\conversations
```

권장 ACL:

- 프로젝트 참여자: 읽기·파일 생성·자신의 업무에 필요한 수정 권한
- 프로젝트 관리자: 삭제·보존 정책 수행 권한
- 비참여자: 접근 거부
- 일반 직원 전체에 광범위한 쓰기 권한을 부여하지 않음

SMB 공유에서 원자적 같은 디렉터리 rename을 지원하는지 사전 검증하는 것을 권장합니다.

## 3. 각 직원 VM 설치

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Collaborare.ps1 `
  -VsixPath ".\dist\collaborare-0.1.0.vsix" `
  -ProjectPath "Z:\ProjectName" `
  -Force
```

VS Code에서 다음 순서로 확인합니다.

1. `Z:\ProjectName`을 folder 또는 workspace로 엽니다.
2. `Collaborare: Configure Copilot Account Name`을 실행합니다.
3. 현재 Copilot Enterprise 계정을 선택하거나 정확한 계정명을 입력합니다.
4. `Collaborare: Check Status`를 실행합니다.
5. knowledge 경로가 예상 위치이고 읽기·쓰기가 가능하며 Copilot Chat이 installed인지 확인합니다.
6. `@collaborare /init`을 실행해도 같은 위치가 표시되는지 확인합니다.

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
  -Interval 2000
```

Chrome이 자동으로 열리지 않는 정책 환경에서는 `-NoBrowser`를 추가하고 `http://127.0.0.1:43110`을 직접 엽니다.

스크립트는 표준 설치 경로의 Chrome을 우선 실행합니다. 별도 설치 위치라면 `-ChromePath "D:\Apps\Chrome\chrome.exe"`를 지정합니다. Chrome을 찾지 못하면 Windows 기본 브라우저로 fallback합니다.

모든 VM이 로컬 대시보드를 실행할 필요는 없습니다. 조회가 필요한 VM에서만 실행하면 됩니다. 한 VM의 대시보드를 다른 VM에 공개하려면 localhost가 아닌 host bind, Windows Firewall, 인증, TLS 정책이 필요하므로 현재 기본 운영 방식으로 권장하지 않습니다.

## 6. 운영 기준

- 기본 polling 2초를 유지하고 파일 수가 많을 때 간격을 늘립니다.
- `DASHBOARD_MAX_FILES`, `DASHBOARD_MAX_FILE_BYTES`를 프로젝트 규모와 정책에 맞춰 설정합니다.
- conversation 파일은 append-only로 운영하고 직접 수정은 최소화합니다.
- 삭제·보존 정책 실행 전 대시보드를 중지할 필요는 없지만, 변경은 delete 이벤트로 즉시 반영됩니다.
- 직원 퇴사·프로젝트 이동 시 `Z:` ACL을 회수하고 VM의 `collaborare.accountName` 설정을 초기화합니다.
- 대화에 비밀번호, token, 고객 개인정보를 입력하지 않도록 별도 사용자 정책을 적용합니다.
- `collaborare.localSpoolEnabled` 기본값은 `true`입니다. VM 로컬 extension storage의 평문 임시 보관이 정책상 허용되는지 배포 전에 결정합니다. 기본 보존 상한은 `collaborare.localSpoolMaxFiles=500`, `collaborare.localSpoolMaxBytes=33554432`이며 상한에 도달하면 새 로컬 대기 기록을 만들지 않고 경고합니다.

## 장애 점검

### account가 local fallback으로 보임

`Collaborare: Configure Copilot Account Name`을 실행해 계정을 명시합니다. 상태 화면의 local fallback은 비대화형 자동 탐지에 실패했다는 뜻입니다.

### `Z:`가 Node 또는 VS Code에서 보이지 않음

mapped drive는 Windows 로그인 session별입니다. VS Code와 PowerShell을 드라이브를 매핑한 동일 계정으로 실행하거나 UNC 경로를 사용합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 -ProjectPath "\\fileserver\share\ProjectName"
```

### 대화는 보이지만 새 내용 반영이 늦음

대시보드 상태의 last scan 시각을 확인하고 polling 값을 일시적으로 낮춥니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 -ProjectPath "Z:\ProjectName" -Interval 1000
```

### 기본 Copilot 대화가 저장되지 않음

공개 API 제약에 따른 정상 동작입니다. 감사 대상 대화는 `@collaborare`를 사용해야 합니다.
