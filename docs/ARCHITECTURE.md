# Architecture

## 목표

중앙 애플리케이션 서버나 외부 데이터베이스를 새로 두지 않고, 모든 직원 VM에 이미 연결된 프로젝트별 공유 드라이브를 지식 전달 매체로 사용합니다. Copilot 호출은 직원별 기존 Enterprise 계정과 VS Code 모델 선택을 그대로 따릅니다.

## 구성도

```text
+---------------- Employee VM A ----------------+
| VS Code + GitHub Copilot + @collaborare        |
|     | read before request     | atomic write   |
| Chrome <--- SSE --- local dashboard            |
+-------------------|----------------------------+
                    |
                    | shared SMB/mapped drive
                    v
Z:\ProjectName\knowledge-database\conversations\
                    ^
                    |
+-------------------|----------------------------+
| VS Code + GitHub Copilot + @collaborare        |
| Chrome <--- SSE --- local dashboard            |
+---------------- Employee VM B ----------------+
```

대시보드는 VM마다 로컬로 실행할 수 있습니다. HTTP 서버는 기본적으로 `127.0.0.1`에만 bind하며, VM 사이의 데이터 전달은 HTTP가 아니라 기존 공유 드라이브가 담당합니다.

## 대화 처리 순서

1. 사용자가 `@collaborare`에 질문하면 확장이 즉시 UTC `question_at`을 기록합니다.
2. 프로젝트 경로와 `knowledge-database` 경로가 프로젝트 내부인지 검증합니다.
3. GitHub 또는 GitHub Enterprise 계정을 확인합니다. 복수 계정이면 최초 한 번 사용자가 선택합니다.
4. Markdown 수·개별 크기 상한을 적용해 지식 폴더를 재귀 스캔합니다.
5. 영문·숫자 토큰과 한국어 2-gram 겹침, 파일 최신성을 조합해 관련 문서를 정렬합니다.
6. 문자 예산과 top K 안에서 관련 문서와 현재 participant 이력을 선택합니다.
7. 공유 Markdown을 신뢰하지 않는 데이터로 구분하고 prompt-injection 방어 지시와 함께 `request.model`에 전달합니다.
8. 모델 응답을 Chat에 스트리밍하면서 문자열로 수집합니다.
9. 완료·취소·오류 상태와 `response_at`을 포함한 새 UUID Markdown을 게시합니다.

## 동시성 모델

공유 파일 하나에 여러 VM이 append하지 않습니다. 모든 대화가 독립된 UUID 파일이므로 일반적인 파일 잠금 경쟁과 lost update를 피합니다.

저장은 같은 디렉터리에 임시 파일을 만들고 내용을 완전히 쓴 뒤 final 이름을 hard link create-if-absent로 생성합니다. 게시 검증이 끝난 후 임시 link를 제거하는 작업이 commit이며, 스캐너는 single-link Markdown만 읽으므로 다른 VM과 대시보드는 committed 기록만 봅니다.

## 대시보드 변경 감지

Windows mapped drive와 SMB 공유에서는 `fs.watch` 이벤트가 누락되거나 중복될 수 있습니다. 대시보드는 기본 2초마다 다음 작업을 수행합니다.

1. `.md` 파일 목록을 재귀 수집합니다.
2. `mtime + ctime + size + file id + link count` fingerprint가 바뀐 파일만 다시 읽습니다.
3. 이전 snapshot과 비교해 `upsert`와 `delete`를 계산합니다.
4. 연결된 Chrome에 Server-Sent Events로 변경만 전송합니다.
5. 브라우저가 revision gap을 발견하면 전체 snapshot을 다시 가져옵니다.

네트워크 공유가 일시 중단되면 직전 snapshot을 유지하고 다음 주기에 재시도합니다. 파일 수 상한을 넘긴 불완전한 scan도 폐기해 잘못된 대량 삭제 이벤트를 막습니다.

## 공개 API 경계

Chat Participant API는 해당 participant가 받은 요청과 응답만 소유합니다. 다른 participant나 기본 Copilot Chat 대화의 전체 입력·출력을 열람하는 API는 없습니다. 따라서 다음은 의도적인 제품 경계입니다.

- 감사·공유 대상 대화는 `@collaborare`를 사용합니다.
- 기본 Copilot Chat에서 이미 발생한 대화는 자동 수집하지 않습니다.
- 일반 Copilot 응답을 몰래 변경하거나 extension 내부 저장소를 역공학하지 않습니다.
- participant는 사용자가 Chat model picker에서 선택한 `request.model`을 존중하되 vendor가 `copilot`인 모델만 허용합니다.

## 보안 경계

- 계정 token과 인증 session은 저장하지 않습니다.
- 기록의 `account`는 VS Code 인증 계정 목록에서 선택하거나 사용자가 입력한 귀속 정보입니다. Copilot 모델 호출 주체와의 암호학적 서명은 아니므로 이 버전은 부인방지 감사 시스템이 아닙니다.
- 사용자 질문과 Copilot 응답에는 소스 코드, 비밀정보, 개인정보가 포함될 수 있으므로 `knowledge-database` ACL은 프로젝트 참여자에게만 부여해야 합니다.
- 공유 Markdown은 악의적인 prompt를 포함할 수 있어 모델 문맥에서 untrusted reference로 격리합니다.
- 대시보드는 사용자 Markdown을 `innerHTML`로 넣지 않고 DOM `textContent` 기반으로 렌더링합니다.
- 대시보드는 numeric loopback 전용, no CORS, no telemetry이며 절대 공유 경로를 API에 노출하지 않습니다.
- 보존 기간, 삭제 승인, 감사 열람 권한은 회사 정보보호 정책으로 별도 결정해야 합니다.
- 공유 게시 실패 시 canonical project/knowledge/conversations/UTC date identity를 모두 고정한 기록에만 활성화되는 로컬 spool은 VS Code extension storage에 질문과 응답을 평문으로 보관합니다. 정책상 허용되지 않으면 설정으로 비활성화해야 합니다. 기본적으로 500개와 전체 32 MiB 중 먼저 도달한 상한에서 추가 보관을 중단합니다.
- 완전 air-gap에서는 GitHub 인증과 Copilot 모델 호출이 불가능하므로 전체 기능을 지원하지 않습니다. 지원 배포는 GitHub.com/GHE.com 형태, Copilot plan, client version과 활성 기능별 공식 인증·Copilot·editor 필수 경로를 proxy/allowlist로 허용한 제한망입니다. Collaborare code는 자체 outbound client를 추가하지 않으며 VS Code Authentication/Language Model API에 위임합니다.
- 대시보드는 인증과 TLS가 없으므로 `127.0.0.1`과 `::1` 외 bind를 거부합니다.
- 게시 과정은 project root부터 write target까지 reparse point를 거부하고 write directory와 열린 temporary/final file identity를 반복 검증합니다. 완전히 쓴 temporary file을 create-if-absent hard link로 게시하고 검증이 끝날 때까지 두 링크를 유지하므로 `nlink=2`가 in-progress 표식이 됩니다. 검증 완료 뒤 temporary link 제거가 마지막 commit 연산이며, writer와 scanner는 single-link가 되기 전 final을 성공 또는 readable record로 인정하지 않습니다. Link count도 scanner fingerprint에 포함되므로 scan 중 commit 상태 전환은 해당 scan을 폐기합니다. 게시 후 검증 실패로 열린 inode를 scrub하면 해당 inode identity를 복구 증거로 보존하지만 in-place overwrite는 하지 않습니다. 같은 0-byte single-link tombstone 또는 동일 inode의 엄격한 내부 publication-temp link만 남은 tombstone pair를 재확인한 뒤 새 UUID로 no-clobber 재게시합니다. Recovery는 경로 교체 경쟁을 피하도록 남은 temp link를 삭제하지 않습니다. 정상 commit에는 publisher가 자신의 active temp link를 삭제할 권한이 필요하며, hard link 이름들은 security descriptor를 공유하므로 일반 ACL만으로 같은 writer에게 temp unlink를 허용하면서 final 변경을 완전히 차단할 수 없습니다. 기존 directory나 inode를 수정할 수 있는 악성 participant까지 방어해야 하면 직접 SMB writer 대신 권한이 분리된 중앙 writer 또는 서명 저장소를 사용해야 합니다.
- Local queue는 lexical 경로, canonical project/knowledge/conversations/UTC date filesystem identity, 필요할 때 scrubbed inode identity와 재게시 UUID를 함께 저장합니다. 경로가 다른 target으로 재매핑되면 자동 publish 대신 unmatched 상태로 유지하며, 안정적인 identity를 모두 고정할 수 없는 요청은 queue에 넣지 않습니다. Identity가 없던 0.1.0 legacy v1 항목은 자동 publish하지 않고, 사용자가 원래 경로임을 확인한 뒤 수동 `/sync` modal에서 승인한 정확한 레코드만 현재 identity를 포함한 v2로 원자 전환합니다.
- Local queue lock은 VM suspend나 clock 변화만으로 stale 판단해 탈취하지 않습니다. 비정상 종료 뒤 남은 lock은 모든 관련 process가 종료됐음을 확인한 관리자가 수동 복구합니다. 공유 publication-temp tombstone은 pending recovery가 해소되기 전에 삭제하지 않습니다.

## 확장 한계와 다음 단계

현재 검색은 외부 모델이나 벡터 데이터베이스가 필요 없는 lexical retrieval입니다. 수만 건 이상으로 증가하면 다음 순서로 확장하는 것이 안전합니다.

1. 프로젝트별 보존 기간과 archive 정책을 적용합니다.
2. 승인된 폐쇄망 서비스에 로컬 full-text index를 둡니다.
3. 회사가 승인한 embedding 모델이 있을 때만 semantic index를 추가합니다.
4. 중앙 대시보드가 필요하면 인증·TLS·권한 모델을 먼저 정의한 뒤 localhost 기본 구조를 대체합니다.

## API 근거

- VS Code Chat Participant API: https://code.visualstudio.com/api/extension-guides/chat
- VS Code Language Model API: https://code.visualstudio.com/api/extension-guides/language-model
- VS Code Authentication API: https://code.visualstudio.com/api/references/vscode-api#authentication

Chat Participant가 자신이 언급된 대화를 소유하고 `request.model`을 호출하는 안정 API만 사용합니다. GitHub Copilot 내부 저장소나 비공개 command에는 의존하지 않습니다.
