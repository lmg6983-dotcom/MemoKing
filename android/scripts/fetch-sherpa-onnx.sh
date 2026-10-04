#!/usr/bin/env bash
# 받아쓰기 다시 하기(Whisper)·말한 사람 구분에 쓰는 오픈소스 sherpa-onnx (k2-fsa/sherpa-onnx, Apache-2.0)
# 안드로이드 라이브러리(AAR)를 GitHub 릴리스에서 받아 android/app/libs/ 에 둔다. (CI 가 빌드 전에 실행, 손으로도 가능)
#   SHERPA_ONNX_VERSION=v1.x.y 로 버전을 고정할 수 있다. 비우면 .aar 이 있는 가장 최근 릴리스.
#   gh(GitHub CLI) 필요. 저장소에는 올리지 않는다 (.gitignore).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p app/libs
out=app/libs/sherpa-onnx.aar
version="${SHERPA_ONNX_VERSION:-}"
if [ -z "$version" ]; then
  version=$(gh api 'repos/k2-fsa/sherpa-onnx/releases?per_page=30' --jq '[.[] | select(any(.assets[]; .name | test("^sherpa-onnx-[0-9.]+\\.aar$")))][0].tag_name')
fi
# 일반판 sherpa-onnx-<버전>.aar (-rknn 등 특정 칩용은 빼고)
url=$(gh api "repos/k2-fsa/sherpa-onnx/releases/tags/$version" --jq '[.assets[] | select(.name | test("^sherpa-onnx-[0-9.]+\\.aar$")) | .browser_download_url][0]')
echo "sherpa-onnx $version ← $url"
curl -fsSL --retry 3 -o "$out" "$url"
echo "$version" > app/libs/sherpa-onnx.version
ls -la "$out"
