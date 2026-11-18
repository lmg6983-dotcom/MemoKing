#!/usr/bin/env bash
# HEVC 동영상을 이 PC 에서 재생하도록 H.264 로 바꾸는 작은 ffmpeg.exe (win64, LGPL) 를 만든다.
#   bash desktop-rs/scripts/build-ffmpeg-min.sh [나올 폴더]   (기본 desktop/vendor/ffmpeg)
#   Linux(Ubuntu) 에서 mingw-w64 로 크로스 빌드: apt-get install -y mingw-w64 nasm
#   담는 것: mov/mp4 읽기 · mp4 쓰기 · hevc/h264 풀기 · Windows 에 든 H.264 인코더(h264_mf) · 크기/화소 형식/회전 필터
#   GPL · nonfree 부품(x264, x265 등)은 넣지 않는다 (app/vendor/LICENSES.md)
set -euo pipefail

VER=8.0.1
SHA256=05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41
TARBALL=ffmpeg-$VER.tar.xz
# ffmpeg.org 를 못 받는 곳에서는 Ubuntu 보관소의 원본(orig = 같은 서명 파일)
URLS=("https://ffmpeg.org/releases/$TARBALL" "http://archive.ubuntu.com/ubuntu/pool/universe/f/ffmpeg/ffmpeg_$VER.orig.tar.xz")

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(mkdir -p "${1:-$ROOT/desktop/vendor/ffmpeg}" && cd "${1:-$ROOT/desktop/vendor/ffmpeg}" && pwd)
# 이 스크립트(설정)가 바뀌어도 다시 빌드하게 스크립트 해시까지 적어 둔다
STAMP="ffmpeg $VER $(sha256sum "$0" | cut -c1-16)"
if [ -f "$OUT/ffmpeg.exe" ] && grep -qxF "$STAMP" "$OUT/VERSION" 2>/dev/null; then
  echo "ffmpeg $VER: 이미 있음 ($OUT)"
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
for u in "${URLS[@]}"; do curl -fsSL -o "$WORK/$TARBALL" "$u" && break || echo "받기 실패: $u"; done
echo "$SHA256  $WORK/$TARBALL" | sha256sum -c -
tar -xf "$WORK/$TARBALL" -C "$WORK"
cd "$WORK/ffmpeg-$VER"

# --disable-autodetect: 빌드 PC 에 우연히 있는 라이브러리가 끼지 않게, 필요한 것만 켠다
# d3d11va: 8.0 의 h264_mf 는 D3D11 화면을 받는 코드가 있어 이것 없이는 컴파일되지 않는다
# transpose · hflip · vflip: 휴대폰 세로 영상의 회전 정보(autorotate)를 풀 때 ffmpeg 가 끼워 넣는다
./configure \
  --target-os=mingw32 --arch=x86_64 --cross-prefix=x86_64-w64-mingw32- \
  --pkg-config=false --enable-static --disable-shared --extra-ldflags=-static \
  --disable-gpl --disable-nonfree --disable-autodetect --disable-debug --disable-doc --enable-small \
  --disable-everything --disable-network --disable-avdevice --disable-ffplay --disable-ffprobe \
  --enable-w32threads --enable-mediafoundation --enable-d3d11va \
  --enable-protocol=file \
  --enable-demuxer=mov --enable-muxer=mp4 \
  --enable-parser=hevc,h264,aac \
  --enable-decoder=hevc,h264 \
  --enable-encoder=h264_mf \
  --enable-filter=buffer,buffersink,abuffer,abuffersink,null,anull,format,scale,transpose,hflip,vflip
make -j"$(nproc)" ffmpeg.exe
x86_64-w64-mingw32-strip ffmpeg.exe
cp ffmpeg.exe "$OUT/ffmpeg.exe"
cp COPYING.LGPLv2.1 "$OUT/" # LGPL: 설치 파일에 사용 허락 글도 함께
echo "$STAMP" > "$OUT/VERSION"
ls -l "$OUT/ffmpeg.exe"
