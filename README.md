# EAS Cloudflare Worker v1.0.2

EAS GitHub Pages와 Gemini API 사이의 중계 Worker입니다.

## 업로드 파일
이 폴더의 파일 3개를 `EAS-Worker` 저장소 최상단에 업로드합니다.

- `worker.js`
- `wrangler.jsonc`
- `README.md`

## Cloudflare Secret
기존 Worker `black-snow-e236`에 다음 Secret이 있어야 합니다.

- 이름: `GEMINI_API_KEY`
- 값: Google AI Studio API 키

API 키는 GitHub에 올리지 마세요.

## Cloudflare GitHub 연결
기존 Worker → Settings → Builds → Connect → GitHub → `EAS-Worker` → `main`

수동 Build command가 필요할 때만 다음을 사용합니다.

```text
npx wrangler deploy
```

## 배포 확인
브라우저에서 아래 주소를 열었을 때 `"ok":true`와 `"version":"1.0.2"`가 보이면 Worker 배포가 된 것입니다.

```text
https://black-snow-e236.wlstjd88.workers.dev/
```

그 뒤 EAS에서 사진을 촬영하고 `AI 사진 분석`을 눌러 실제 Gemini 호출을 확인합니다.
