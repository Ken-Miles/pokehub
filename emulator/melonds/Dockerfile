# syntax=docker/dockerfile:1
#
# Pokémon Hub's DS emulator: unmodified melonDS (GPL-3.0) built to WebAssembly with our
# glue (hub.cpp) — ADR-011, Phase 4 spike. Pinned to a melonDS release and commit and to
# the same Emscripten release as the mGBA build.
#
#   npm run emulator:build:ds   → public/emulator/ds/melonds-hub.{js,wasm}
#
# GPL-3.0: the build is sent to browsers, so hub.cpp and this file are published with it.

ARG EMSDK_TAG=4.0.10
FROM emscripten/emsdk:${EMSDK_TAG} AS build

ARG MELONDS_REF=1.1
ARG MELONDS_COMMIT=b86390e4428bf38ce4c1ce0e9ca446d6d25955e8

RUN git clone --quiet --depth 1 --branch "${MELONDS_REF}" https://github.com/melonDS-emu/melonDS.git /melonds \
 && test "$(git -C /melonds rev-parse HEAD)" = "${MELONDS_COMMIT}"

# The core library only: no Qt/SDL frontend, no JIT, no OpenGL, no GDB stub.
WORKDIR /melonds/build
RUN emcmake cmake .. \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_QT_SDL=OFF -DENABLE_JIT=OFF -DENABLE_OGLRENDERER=OFF -DENABLE_GDBSTUB=OFF \
      -DENABLE_LTO_RELEASE=OFF \
 && emmake make -j"$(nproc)" core

COPY hub.cpp /hub/hub.cpp
RUN mkdir /out && em++ -O3 -std=c++17 /hub/hub.cpp \
      /melonds/build/src/libcore.a /melonds/build/src/teakra/src/libteakra.a \
      -I/melonds/src -I/melonds/build/src \
      -sMODULARIZE=1 -sEXPORT_NAME=createMelonHub -sENVIRONMENT=web,node \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB \
      -sEXPORTED_FUNCTIONS=_malloc,_free \
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAP16 -sMAXIMUM_MEMORY=4GB \
      -o /out/melonds-hub.js \
 && cp /hub/hub.cpp /out/hub.cpp \
 && printf '{"melonds":"%s","commit":"%s","emscripten":"4.0.10","sha256":"%s"}\n' \
      "${MELONDS_REF}" "${MELONDS_COMMIT}" "$(cat /out/melonds-hub.js /out/melonds-hub.wasm | sha256sum | cut -c1-16)" > /out/build.json

FROM scratch AS out
COPY --from=build /out/ /
