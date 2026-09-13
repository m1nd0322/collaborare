# Windows Offline Bundle

## 범위

`dist/collaborare-0.1.1-offline-payload.zip`은 Collaborare가 소유한 실행 payload를 한 개의 반입 파일로 묶은 것입니다. ZIP과 함께 `dist/OFFLINE-BUNDLE-SHA256SUMS.txt`를 사용해 전송 중 무결성을 확인할 수 있습니다.

이 payload는 완전한 Windows VM 설치 매체가 아닙니다. VS Code, GitHub Copilot Chat과 전체 dependency VSIX, Node.js, Chrome Enterprise, 회사 CA는 조직별 승인 버전·라이선스·서명 정책이 다르므로 저장소에 임의로 포함하지 않습니다. 해당 파일은 조직의 승인 배포 채널에서 별도로 반입해야 합니다.

또한 완전 air-gap에서는 Copilot 클라우드 모델을 호출할 수 없습니다. 이 문서의 전체 기능 설치는 Copilot의 공식 필수 HTTPS 경로가 회사 proxy/allowlist로 허용된 제한망을 뜻합니다. 완전 air-gap에서는 기존 Markdown과 로컬 dashboard 열람만 가능합니다.

## 포함 파일

현재 payload ZIP에는 외부에서 신뢰를 확인한 `dist/DEPLOYMENT-SHA256SUMS.txt`에 기록된 Collaborare 파일이 정확히 들어 있습니다. 이 payload manifest 자체는 ZIP 안에 넣지 않아 ZIP이 자기 자신을 검증하는 순환을 만들지 않습니다. payload manifest와 sidecar는 ZIP과 별도 파일로 전달하고 조직 outer manifest에서 함께 서명하십시오.

- `README.md`
- `dist/collaborare-0.1.1.vsix`
- `dist/BUILD-INFO.json`
- `dist/SHA256SUMS.txt`
- `dashboard/` runtime files
- `docs/DEPLOYMENT.md`
- `docs/OFFLINE_BOM.md`
- `docs/OFFLINE_BUNDLE.md`
- `scripts/Install-Collaborare.ps1`
- `scripts/Initialize-Project.ps1`
- `scripts/New-DeploymentManifest.ps1`
- `scripts/New-OfflineBundle.ps1`
- `scripts/Start-Dashboard.ps1`
- `scripts/Test-OfflineBundle.ps1`
- `scripts/Test-VsixArtifact.ps1`
- `scripts/Vsix-Validation.ps1`

Source tree와 test 파일은 직원 VM 설치에 필요하지 않으므로 payload에 넣지 않습니다. VSIX source byte 검증은 build PC 또는 승인된 CI에서 완료합니다.

## Payload 생성

연결 가능한 build PC 또는 승인된 source bundle에서 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-OfflineBundle.ps1 `
  -ExpectedCollaborareVersion "0.1.1" `
  -ExpectedNodeVersion "22.23.2"
```

스크립트는 다음을 수행합니다.

1. `DEPLOYMENT-SHA256SUMS.txt`를 먼저 검증합니다.
2. Collaborare payload만 임시 staging directory에 복사합니다.
3. canonical `/` archive path, sorted file order, fixed timestamp와 no-compression ZIP을 생성합니다.
4. ZIP 외부의 `OFFLINE-BUNDLE-SHA256SUMS.txt`를 갱신합니다.
5. ZIP entry와 payload hash를 다시 검증합니다.

동일한 source와 같은 PowerShell/.NET implementation으로 생성한 ZIP은 bundle metadata가 고정되므로 byte 비교가 가능합니다. 다른 OS 또는 .NET implementation 사이의 ZIP byte 동일성은 보장하지 않으며, 최종 반입 파일은 생성 후 조직 outer manifest에 다시 기록하고 서명하십시오.

## 반입 전 검증

SHA-256 sidecar만 같은 매체에 함께 두는 것은 출처를 증명하지 않습니다. 먼저 조직이 서명한 outer manifest 또는 별도 신뢰 채널로 파일 출처를 확인한 뒤 다음 검증을 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-OfflineBundle.ps1 `
  -BundlePath ".\dist\collaborare-0.1.1-offline-payload.zip" `
  -TrustedPayloadManifestPath ".\dist\DEPLOYMENT-SHA256SUMS.txt" `
  -ExpectedCollaborareVersion "0.1.1" `
  -ExpectedNodeVersion "22.23.2" `
  -ChecksumPath ".\dist\OFFLINE-BUNDLE-SHA256SUMS.txt"
```

`TrustedPayloadManifestPath`는 ZIP에 포함되지 않은 별도 파일이며, ZIP에서 추출한 검증되지 않은 파일이 아니라 outer manifest로 신뢰를 확인한 payload manifest를 가리켜야 합니다. 검증기는 ZIP을 실행하거나 추출하지 않고 entry path, exact file set, size limit, payload hash와 `BUILD-INFO.json`을 검사합니다.

검증기 상한은 archive 8 MiB, entry 1000개, 개별 uncompressed entry 16 MiB, 전체 uncompressed payload 64 MiB입니다.

## Windows VM 설치

1. 승인된 outer manifest 또는 별도 신뢰 채널로 payload ZIP, payload manifest와 sidecar의 hash/서명을 확인합니다.
2. 로컬 임시 폴더에 payload ZIP을 `Expand-Archive`로 추출합니다.
3. 승인된 VS Code, Copilot Chat dependency closure, 그리고 필요한 경우 Node.js와 Chrome Enterprise를 설치합니다.
4. 추출된 `scripts`로 Collaborare VSIX와 승인된 Copilot VSIX를 설치합니다.
5. 프로젝트 SMB 경로를 초기화합니다.
6. 직원 계정으로 VS Code에서 계정 귀속과 status를 확인합니다.
7. dashboard가 필요하면 승인된 Node.js로 실행합니다.

예시입니다. `<...>` 값은 승인 BOM의 정확한 값으로 바꿉니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Collaborare.ps1 `
  -VsixPath ".\dist\collaborare-0.1.1.vsix" `
  -CopilotChatVsixPath ".\extensions\github.copilot-chat-<version>.vsix" `
  -PrerequisiteVsixPath ".\extensions\github.copilot-<version>.vsix" `
  -ExpectedPrerequisiteExtension "GitHub.copilot@<version>" `
  -ExpectedCodeVersion "<approved-vscode-version>" `
  -ExpectedCopilotChatVersion "<approved-copilot-chat-version>" `
  -ExpectedCollaborareVersion "0.1.1" `
  -ProjectPath "Z:\ProjectName" `
  -Force

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Initialize-Project.ps1 `
  -ProjectPath "Z:\ProjectName"
```

dependency가 둘 이상이면 Windows PowerShell 5.1 session에서 splatting으로 배열을 전달하십시오. 자세한 dependency closure 검증은 [`DEPLOYMENT.md`](DEPLOYMENT.md)를 따릅니다.

dashboard를 사용할 VM에서만 다음을 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Start-Dashboard.ps1 `
  -ProjectPath "Z:\ProjectName" `
  -ExpectedNodeVersion "<approved-node-version>" `
  -ExpectedChromeVersion "<approved-chrome-version>"
```

브라우저는 `http://127.0.0.1:43110`에서 열립니다. dashboard는 질문을 입력하는 Copilot client가 아니며, 공유 Markdown 감사 기록을 읽기 전용 타임라인으로 표시합니다.

## 운영 경계

- `@collaborare` 모델 요청은 GitHub Copilot의 공식 네트워크·인증 경로가 필요합니다.
- 기본 Copilot Chat에서 발생한 대화는 자동 수집하지 않습니다.
- 공유 기록은 `knowledge-database\conversations`에 UUID Markdown으로 저장됩니다.
- dashboard는 동일 프로젝트의 기록을 polling 후 SSE로 표시하지만 Copilot 내부 reasoning이나 중간 tool call을 기록하지 않습니다.
- SMB hard-link, ACL, temp unlink와 VM A/B 동시 쓰기는 실제 대상 share에서 수용시험해야 합니다.
- 최종 bundle의 외부 installer, Copilot VSIX, CA, 조직 서명 manifest는 [`OFFLINE_BOM.md`](OFFLINE_BOM.md)의 승인 절차로 관리합니다.
