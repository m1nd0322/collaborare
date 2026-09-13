# Restricted-Network Offline BOM

이 문서는 일반 인터넷, Visual Studio Marketplace, npm registry는 차단되고 승인된 GitHub/Copilot/VS Code 필수 경로만 예외 허용된 Windows VM에 오프라인 매체로 Collaborare를 설치하기 위한 반입 목록과 검증 기준입니다.

이 파일은 조직 승인용 template입니다. `<...>` placeholder가 하나라도 남은 bundle은 배포 승인 상태가 아니며, 배포 담당자가 실제 버전·hash·signer·문서 승인일로 모두 치환해야 합니다.

## 지원 네트워크 모델

Collaborare의 전체 기능은 완전 단절망에서 동작하지 않습니다. GitHub Copilot 모델과 인증은 GitHub 또는 GHE.com의 승인된 서비스에 연결되어야 합니다.

| 네트워크 모델 | 판정 |
| --- | --- |
| 완전 air-gap | 대시보드와 SMB 파일 열람만 가능. Copilot 질문·응답은 지원하지 않음 |
| Copilot 제한망 | 배포 형태, plan, client version과 기능별 공식 GitHub/Copilot/VS Code 필수 경로를 proxy/allowlist로 허용하면 지원 |
| 일반 인터넷망 | 동작 가능하지만 이 문서의 오프라인 설치 통제 대상은 아님 |

VM 런타임에는 Marketplace와 npm registry 접근이 필요하지 않습니다. 빌드 PC에서만 승인된 npm mirror 또는 사전 반입한 `vsce`를 사용할 수 있습니다.

## 승인 BOM

배포 담당자는 아래 모든 `<...>` 값을 고정하고 SHA-256 및 signer를 조직의 서명된 배포 manifest에 기록해야 합니다.

| 항목 | 승인 버전 | 아키텍처 | 필수 검증 |
| --- | --- | --- | --- |
| Windows | `<approved build>` | x64/arm64 | 회사 base image ID |
| .NET Framework | `>=4.7.2` | VM과 일치 | 회사 base image ID 또는 Microsoft installer hash |
| VS Code | `>=1.97.0`, 정확한 `<version>` | VM과 일치 | installer hash, Microsoft signer |
| GitHub Copilot Chat VSIX | 정확한 `<version>` | universal | VSIX hash, GitHub/Microsoft 승인 출처 |
| Copilot VSIX dependency | manifest별 정확한 `<version>` | universal | 각 VSIX hash와 설치 순서 |
| Collaborare VSIX | `0.1.1` | universal | `dist/SHA256SUMS.txt`와 비교 |
| Node.js | 지원 중인 22 LTS 이상 `<version>` | VM과 일치 | installer/archive hash, OpenJS signer |
| Google Chrome Enterprise | 정확한 `<version>` | VM과 일치 | installer hash, Google signer |
| Collaborare dashboard/scripts | 배포 commit `<sha>` | n/a | 조직이 서명한 전체 파일 manifest |
| 회사 proxy root CA | `<certificate subject/serial>` | n/a | Windows store SHA-1 identifier와 `.cer` SHA-256을 별도 검증 |
| GitHub network 문서 snapshot | 승인일 `<date>` | n/a | 보안팀이 승인한 allowlist/proxy 문서 hash |

Node.js와 Chrome은 배포 시점에 보안 지원 중인 조직 승인 버전을 사용합니다. `22 이상`은 최소 runtime 기준이며 특정 patch를 대신하지 않습니다.

`dist/BUILD-INFO.json`은 Collaborare VSIX를 만든 Node.js, vsce, artifact hash를 기록합니다. `npx` mode의 transitive build dependency까지 증명하지는 않으므로 고보증 빌드는 조직이 hash로 승인한 사전 반입 `vsce` 도구 체인을 사용합니다.

## 반입 디렉터리 예시

GitHub Copilot Chat과 관련 dependency는 라이선스가 허용된 회사 배포 채널에서 별도로 확보합니다. 이 저장소에는 해당 제3자 바이너리를 포함하지 않습니다.

```text
collaborare-offline-bundle\
  README.md
  dist\
    collaborare-0.1.1.vsix
    BUILD-INFO.json
    README.md
    SHA256SUMS.txt
    DEPLOYMENT-SHA256SUMS.txt
  dashboard\
    package.json
    README.md
    server.js
    lib\<runtime .js files>
    public\index.html
    public\styles.css
    public\app.js
  docs\
    DEPLOYMENT.md
    OFFLINE_BOM.md
    OFFLINE_BUNDLE.md
    vendor\<approved GitHub allowlist and proxy snapshots>
  scripts\
    Initialize-Project.ps1
    Install-Collaborare.ps1
    New-DeploymentManifest.ps1
    New-OfflineBundle.ps1
    Start-Dashboard.ps1
    Test-OfflineBundle.ps1
    Test-VsixArtifact.ps1
    Vsix-Validation.ps1
  manifest\
    ORGANIZATION-SHA256SUMS.txt
    ORGANIZATION-SHA256SUMS.txt.sig
  installers\
    VSCodeUserSetup-<version>-x64.exe
    node-v<version>-x64.msi
    GoogleChromeStandaloneEnterprise64.msi
  extensions\
    github.copilot-<version>.vsix
    github.copilot-chat-<version>.vsix
  certificates\
    corporate-proxy-root-ca.cer
```

실제 Copilot dependency 이름은 승인한 Copilot Chat VSIX manifest를 기준으로 기록합니다. 예시 파일명이 현재 버전의 dependency를 보장하지 않습니다.

## 설치 전 검증

1. 조직이 서명한 outer manifest를 회사 trust anchor 또는 별도 신뢰 채널로 검증합니다.
2. 신뢰된 도구로 outer manifest의 모든 파일 SHA-256을 비교한 뒤에만 bundle의 PowerShell script를 실행합니다.
3. `New-DeploymentManifest.ps1`의 hash 또는 Authenticode signer를 먼저 확인하고 `-Verify`로 script가 정의한 Collaborare payload의 필수 파일과 hash를 검사합니다.
4. Authenticode 대상 installer와 PowerShell script의 signer가 승인 목록과 일치하는지 확인합니다.
5. VM 아키텍처와 installer 아키텍처가 일치하는지 확인합니다.
6. 설치는 `Z:`가 매핑된 실제 직원의 비관리자 로그인 session에서 수행합니다.
7. 관리자 설치가 필요한 binary는 먼저 설치하고, VSIX와 Collaborare 계정 설정은 직원 session에서 수행합니다.

해시만 있는 manifest를 같은 매체에서 함께 받는 것으로는 출처를 증명할 수 없습니다. manifest 자체를 조직 인증서로 서명하거나 별도 신뢰 채널로 전달해야 합니다.

## Proxy와 custom CA profile

Release BOM에는 proxy URL, 인증 방식, GitHub.com/GHE.com 대상, CA store scope, Windows certificate-store thumbprint, `.cer` SHA-256, loopback bypass 정책을 구체적으로 기록합니다. `http.proxyStrictSSL`을 `false`로 설정하거나 인증서 오류를 무시해서는 안 됩니다.

GitHub Copilot의 공식 지원 baseline은 `http://` proxy URL과 Basic 또는 Kerberos 인증입니다. `https://` proxy URL은 지원 대상으로 가정하지 않습니다. PAC나 다른 SSO 방식은 승인한 VS Code/Copilot version에서 별도 smoke-test 증거가 있을 때만 사용합니다. Basic credential을 URL에 넣으면 공식 문서상 평문으로 저장될 수 있으므로 보안팀이 명시적으로 승인하지 않으면 사용하지 않습니다.

조직에서 VS Code의 명시적 proxy 설정을 사용하는 예시는 다음과 같습니다. 실제 값과 지원 여부는 승인한 VS Code/Copilot 버전 및 vendor 문서 snapshot으로 확인합니다.

```json
{
  "http.proxy": "http://proxy.corp.example:8080",
  "http.proxyStrictSSL": true
}
```

CA 설치 후 Windows store identifier와 반입 파일 SHA-256을 서로 다른 값으로 확인합니다. `X509Certificate2.Thumbprint`는 Windows에서 사용하는 SHA-1 identifier이며 SHA-256이 아닙니다.

```powershell
$certificatePath = ".\certificates\corporate-proxy-root-ca.cer"
$expectedFileSha256 = "<approved-cer-sha256>".ToLowerInvariant()
$actualFileSha256 = (Get-FileHash -LiteralPath $certificatePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualFileSha256 -ne $expectedFileSha256) { throw "Proxy root CA file SHA-256 mismatch" }

$expectedStoreThumbprint = "<approved-windows-store-thumbprint>".Replace(" ", "").ToUpperInvariant()
$certificate = Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root |
  Where-Object { $_.Thumbprint -eq $expectedStoreThumbprint }
if (-not $certificate) { throw "Approved proxy root CA was not found" }
if ($certificate.NotAfter -le (Get-Date)) { throw "Approved proxy root CA is expired" }
```

Chrome/Windows proxy 정책은 `127.0.0.1`과 `::1` dashboard traffic을 proxy로 보내지 않도록 구성합니다. Proxy 인증은 승인한 Basic/Kerberos 방식과 client version으로 검증하고 비밀번호를 repository 설정에 저장하지 않습니다. 회사 root CA 설치는 해당 CA가 서명한 TLS interception을 신뢰하게 만드는 보안 결정이므로 보안팀 승인과 최소 scope가 필요합니다.

## 오프라인 설치 순서

1. 회사 proxy root CA를 Windows의 승인된 trust store에 설치합니다.
2. 조직 정책에 따라 VS Code, Node.js 22 LTS 이상, Chrome Enterprise를 설치합니다.
3. VS Code 자동 update와 Marketplace 사용 정책을 조직 기준으로 적용합니다.
4. Copilot Chat과 전체 dependency closure의 승인 VSIX 및 정확한 `id@version` 목록을 준비합니다.
5. `Install-Collaborare.ps1`에 모든 VSIX와 예상 버전을 전달합니다. Script가 graph를 검증하고 dependency leaf부터 Copilot Chat, Collaborare 순서로 dependency 자동 포함과 Settings Sync 없이 강제 local 설치합니다.
6. 설치 결과의 전체 extension version inventory를 보관합니다.
7. `Initialize-Project.ps1`로 SMB publication temp create→hard-link publish→read→temp unlink→final read→cleanup probe를 통과시킵니다.
8. VS Code에서 Enterprise 계정 로그인과 Language Model consent를 완료합니다.
9. `Start-Dashboard.ps1`에 승인된 Node.js와 Chrome의 정확한 버전을 전달합니다.
10. `@collaborare` smoke test와 VM A/B 수용시험을 수행합니다.

Publisher 실행 identity는 자신의 publication temp를 생성·쓰기하고 final hard link를 만든 뒤 active temp link를 삭제할 수 있어야 합니다. Hard link 이름은 security descriptor를 공유하므로 일반 ACL만으로 같은 writer의 temp unlink와 final immutability를 동시에 강제할 수 없습니다. 악성 writer까지 격리해야 하는 배포는 [`DEPLOYMENT.md`](DEPLOYMENT.md)의 중앙 writer 요구사항을 적용합니다.

설치 명령 예시:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Collaborare.ps1 `
  -VsixPath ".\dist\collaborare-0.1.1.vsix" `
  -CopilotChatVsixPath ".\extensions\github.copilot-chat-<version>.vsix" `
  -PrerequisiteVsixPath ".\extensions\github.copilot-<version>.vsix" `
  -ExpectedPrerequisiteExtension "GitHub.copilot@<version>" `
  -ExpectedCodeVersion "<version>" `
  -ExpectedCopilotChatVersion "<version>" `
  -ExpectedCollaborareVersion "0.1.1" `
  -ProjectPath "Z:\ProjectName" `
  -Force
```

승인된 Copilot Chat과 dependency VSIX는 이미 같은 버전이 설치되어 있어도 모두 local path로 전달해야 합니다. 설치 스크립트는 모든 archive identity와 재귀 closure를 검사하고, `-Force`와 `--do-not-include-pack-dependencies`로 승인 bytes만 재설치하며, 설치 전후 inventory의 미승인 변경이나 closure 누락은 Marketplace에 접속하기 전에 실패합니다.

승인한 Copilot Chat 또는 선행 VSIX가 `extensionDependencies`나 `extensionPack`을 선언하면 모든 archive path와 pin을 배열로 전달합니다. Windows PowerShell 5.1의 `powershell.exe -File`은 배열 인수를 바인딩하지 못하므로, prerequisite가 둘 이상이면 Windows PowerShell session에서 splatting으로 script를 직접 호출합니다.

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
  ExpectedCodeVersion = "<version>"
  ExpectedCopilotChatVersion = "<version>"
  ExpectedCollaborareVersion = "0.1.1"
  ProjectPath = "Z:\ProjectName"
  Force = $true
}
& .\scripts\Install-Collaborare.ps1 @install
```

Dashboard 실행 예시:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ExpectedNodeVersion "<version>" `
  -ExpectedChromeVersion "<version>"
```

`New-DeploymentManifest.ps1`은 script가 명시한 Collaborare payload의 `dist\DEPLOYMENT-SHA256SUMS.txt`를 생성하고 `-Verify`에서 필수 entry, hash, VSIX checksum, `BUILD-INFO.json`의 release/toolchain 관계를 검사합니다. 전체 bundle의 미등재 파일 거부와 외부 installer, Copilot VSIX, CA, payload manifest 자체는 조직이 서명한 outer manifest로 검증합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-DeploymentManifest.ps1 `
  -ExpectedCollaborareVersion "0.1.1" `
  -ExpectedNodeVersion "22.23.2" `
  -Verify
```

## 필수 네트워크 경로

| 출발지 | 목적지 | 용도 |
| --- | --- | --- |
| 직원 VM | 프로젝트 SMB server TCP 445 | knowledge 읽기·원자 게시 |
| 직원 VM | 사내 DNS/Kerberos/AD | SMB 이름 확인과 인증 |
| VS Code/Copilot | 회사 proxy | 배포 형태·plan·client·활성 기능별 공식 인증, Copilot routing/API, editor 필수 HTTPS |
| Chrome | `127.0.0.1:43110` 또는 `[::1]:43110` | 로컬 dashboard HTTP/SSE |

방화벽과 proxy allowlist는 배포 시점의 공식 GitHub 문서를 snapshot으로 승인해야 합니다. GitHub.com과 GHE.com, Copilot plan, client와 기능 조합마다 필요한 host가 다르며 공식 목록을 고정된 단일 host set으로 축약하지 않습니다.

- Copilot allowlist: https://docs.github.com/en/copilot/reference/copilot-allowlist-reference
- VS Code Copilot proxy/CA: https://docs.github.com/en/copilot/how-tos/configure-personal-settings/configure-network-settings

Marketplace, npm registry, dashboard CDN은 VM runtime allowlist에 추가하지 않습니다. Collaborare code는 자체 outbound client를 만들지 않지만 host application인 VS Code와 Copilot은 위 공식 필수 경로를 사용합니다.

## 수용 기준

다음 항목을 모두 통과해야 제한망 배포를 승인합니다.

1. Marketplace와 npm registry가 차단된 상태에서 모든 local installer와 VSIX가 설치됩니다.
2. 설치 script가 승인하지 않은 VS Code/Copilot 버전을 거부합니다.
3. 비-Copilot model vendor를 선택하면 공유 Markdown을 읽기 전에 요청이 거부됩니다.
4. VM A의 질문·응답 파일이 VM B의 관련 질문 reference에 선택됩니다.
5. 두 VM이 동시에 질문해도 서로 다른 UUID 파일이 완전한 Markdown으로 게시됩니다. `nlink=2`인 commit 전·실패 후 파일은 extension과 dashboard에 노출되지 않고, active temp unlink로 single-link가 된 성공 기록만 다음 scan에서 보입니다.
6. 모델 호출 직전 SMB 단절은 readiness 재검사에서 차단됩니다. UTC date identity까지 고정하지 못한 이 단계의 error audit은 다른 target으로 오게시하지 않도록 local spool에도 넣지 않습니다. 재검사 완료 직후 발생한 단절은 최종 게시 실패로 감지되어 고정한 identity와 함께 local spool에 남습니다.
7. 응답 streaming 후 SMB 게시 실패도 local spool에 남고 `/sync` 후 같은 UUID 하나만 생성됩니다.
8. dashboard는 누락된 폴더를 만들지 않고, `127.0.0.1` 또는 `::1` 외 bind를 거부합니다.
9. Markdown 생성·수정·삭제가 양쪽 dashboard에 반영되고 SSE 재연결 후 snapshot이 일치합니다.
10. Process별 packet capture 또는 firewall log에서 Collaborare extension/dashboard가 고유 outbound DNS/HTTP 요청을 만들지 않음을 확인합니다. 내부 DNS/Kerberos/AD/SMB와 정책상 허용된 VS Code·Copilot·Chrome traffic은 별도로 귀속하고, 승인되지 않은 외부 목적지가 없음을 확인합니다.

## 현장 증거 보관

배포 승인 기록에 다음을 첨부합니다.

- 고정 BOM과 서명된 전체 파일 manifest
- 설치 명령과 version 출력
- VS Code `--list-extensions --show-versions` 출력
- proxy/allowlist change request 번호와 CA thumbprint
- VM A/B SMB hard-link 게시·temp unlink·동시 쓰기 시험 결과
- `@collaborare` 정상/단절/recovery 시험의 UUID 목록
- dashboard health와 Chrome 화면 확인 결과
- packet capture 또는 firewall log 요약
