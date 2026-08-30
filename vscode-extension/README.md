# Collaborare

`@collaborare`는 GitHub Copilot Chat의 공개 VS Code Chat Participant API를 사용해 질문부터 응답까지 직접 소유하고, 프로젝트에 공유 가능한 Markdown 감사 로그를 남기는 확장입니다.

일반 Copilot Chat 대화를 감청하지 않습니다. 저장하려는 대화는 반드시 Chat 뷰에서 `@collaborare`로 시작해야 합니다.

## 요구 사항

- VS Code `1.95.0` 이상
- GitHub Copilot Chat 설치 및 사용 가능한 구독/모델
- Node 런타임 기반의 로컬 또는 Remote Extension Host 작업공간

매니페스트의 `extensionPack`은 `GitHub.copilot-chat`을 함께 권장하지만 hard extension dependency는 사용하지 않습니다. Copilot Chat이 없으면 participant가 설치 안내 오류를 표시합니다.

## 사용법

Chat 뷰에서 다음과 같이 질문합니다.

```text
@collaborare 이 프로젝트의 배포 절차를 정리해 주세요.
```

participant는 다음 순서로 처리합니다.

1. 질문 시각을 기록합니다.
2. 지식 폴더의 제한된 수/크기의 Markdown 파일을 재귀 검색합니다.
3. 영문 및 한국어 토큰 겹침과 파일 최신성으로 관련 문서를 선택합니다.
4. 제한된 현재 participant 대화 이력과 선택 문서를 `request.model`에 전달합니다.
5. 응답을 스트리밍하면서 완료, 취소, 오류 상태의 감사 로그를 원자적으로 게시합니다.

## 명령

Chat slash 명령과 Command Palette 명령을 모두 제공합니다.

| Chat | Command Palette | 동작 |
| --- | --- | --- |
| `@collaborare /init` | `Collaborare: Initialize Knowledge Database` | 지식 폴더와 `conversations` 폴더를 생성합니다. |
| `@collaborare /open` | `Collaborare: Open Knowledge Database Folder` | 운영체제 파일 탐색기에서 지식 폴더를 엽니다. |
| `@collaborare /status` | `Collaborare: Check Status` | 경로, 계정 출처, Copilot 설치 상태, 스캔 통계를 확인합니다. |
| `@collaborare /account` | `Collaborare: Configure Copilot Account Name` | 이 VM에서 감사 로그에 기록할 Copilot 계정을 선택하거나 입력합니다. |
| `@collaborare /sync` | `Collaborare: Sync Pending Conversation Logs` | 공유 드라이브 장애로 VM에 대기 중인 기록을 다시 게시합니다. |

관리 명령은 모델 대화가 아니므로 대화 감사 로그를 생성하지 않습니다.

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `collaborare.projectPath` | `""` | 비어 있으면 첫 workspace folder를 사용합니다. 상대 경로는 첫 workspace folder 기준입니다. |
| `collaborare.knowledgeDirectory` | `"knowledge-database"` | 프로젝트 아래 상대 경로만 허용합니다. 절대 경로와 `.`/`..` traversal segment는 거부합니다. |
| `collaborare.accountName` | `""` | VM 전용 사용자 설정입니다. 없으면 GitHub/GitHub Enterprise 계정을 탐지하고 복수 계정 또는 미탐지 시 한 번 선택·입력받습니다. |
| `collaborare.maxKnowledgeFiles` | `500` | 요청당 검사할 최대 Markdown 파일 수입니다. |
| `collaborare.maxContextChars` | `24000` | 검색 문맥과 participant 이력이 공유하는 문자 예산입니다. |
| `collaborare.maxFileBytes` | `262144` | 개별 Markdown 파일 최대 바이트 수입니다. |
| `collaborare.maxKnowledgeBytes` | `33554432` | 한 요청에서 읽는 전체 Markdown의 byte 상한입니다. 상한으로 scan이 불완전하면 모델 호출을 중단합니다. |
| `collaborare.topK` | `8` | 모델 요청에 넣는 최대 관련 문서 수입니다. |
| `collaborare.localSpoolEnabled` | `true` | 공유 폴더 게시 실패 시 VS Code 로컬 extension storage에 대기시킨 뒤 다음 요청이나 `/sync`에서 재시도합니다. |
| `collaborare.localSpoolMaxFiles` | `500` | VM 로컬 대기 기록의 최대 파일 수입니다. |
| `collaborare.localSpoolMaxBytes` | `33554432` | VM 로컬 대기 기록의 전체 byte 상한입니다. |

정확한 감사 주체가 필요하므로 배포 후 `Collaborare: Configure Copilot Account Name`을 한 번 실행하는 것을 권장합니다. 대화 요청 시 계정이 하나만 탐지되면 자동 사용하고, 복수 계정이거나 탐지되지 않으면 선택 창을 표시해 VM 사용자 설정에 저장합니다. 상태 확인처럼 비대화형 동작에서만 계정을 얻지 못하면 `local:<username>@<hostname>`을 표시합니다. 인증 token이나 session은 파일에 저장하지 않습니다.

저장되는 계정명은 VS Code가 알려 준 인증 계정 또는 사용자가 선택한 귀속 metadata이며, 실제 Copilot 모델 요청 주체와 암호학적으로 서명된 값은 아닙니다.

## 저장 형식

각 대화는 다음 경로에 UUID 파일 하나로 저장됩니다.

```text
<project>/knowledge-database/conversations/YYYY-MM-DD/<uuid>.md
```

같은 디렉터리에 임시 파일을 완전히 쓰고 동기화한 후 `rename`하여 게시합니다. Frontmatter 값은 모두 `JSON.stringify` 방식의 JSON 문자열로 quote됩니다.

```markdown
---
schema: "collaborare/conversation/v1"
id: "..."
project: "..."
account: "..."
account_source: "setting"
machine: "..."
question_at: "2026-08-30T10:00:00.000Z"
response_at: "2026-08-30T10:00:01.000Z"
model: "..."
status: "complete"
question_chars: "3"
response_chars: "3"
---

# Conversation

## User

...

## Copilot

...
```

공유 폴더 저장은 짧은 backoff로 세 번 재시도합니다. 계속 실패하면 기본적으로 해당 VM의 VS Code extension storage에 기록을 대기시키고 다음 요청 또는 `/sync`에서 같은 UUID로 멱등 재게시합니다. 로컬 queue에도 저장하지 못하면 이미 생성된 답변은 유지하되 Chat 응답과 VS Code 경고 알림으로 영구 미기록 가능성을 알립니다.

로컬 queue에는 아직 공유되지 못한 질문과 응답 원문이 평문으로 들어갑니다. 회사 정책이 로컬 임시 저장을 금지하면 `collaborare.localSpoolEnabled`를 끄고 공유 저장 실패 경고를 운영 절차로 처리해야 합니다.

## 보안 및 개인정보

- 과거 공유 Markdown은 신뢰하지 않는 데이터로 표시하며, 그 안의 명령이나 prompt override를 따르지 말라는 방어 지시를 모델 prompt에 포함합니다.
- 선택된 문서는 Chat 응답의 reference로 표시됩니다.
- 이 확장은 별도 telemetry나 네트워크 전송을 추가하지 않습니다.
- 선택 문맥, participant 이력, 현재 질문은 사용자가 선택한 Copilot 모델 요청에 포함되므로 Copilot의 데이터 처리 정책이 적용됩니다.
- 지식 경로의 기존 symlink가 프로젝트 밖을 가리키면 초기화와 저장을 거부합니다.
- 파일 scan은 심볼릭 링크 디렉터리를 따라가지 않으며 temp 파일, 크기 초과 파일, 설정된 수를 넘는 파일을 읽지 않습니다.

## 개발

외부 런타임 및 테스트 의존성이 없습니다.

```bash
npm test
```

테스트는 Node 내장 `node:test`로 직렬화, 경로 검증, 검색 순위/예산, 원자 저장을 검증합니다.
