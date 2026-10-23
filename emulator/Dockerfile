# syntax=docker/dockerfile:1
#
# Pokémon Hub's emulator: unmodified mGBA (MPL-2.0) built to WebAssembly with
# our glue (src/hub.c) — ADR-011. Pinned to an mGBA release and commit, and to
# an Emscripten release, so every build is the same.
#
#   npm run emulator:build      → public/emulator/core/mgba-hub.{js,wasm}
#
# Linked play needs every browser to run bit-identical cores (ADR-012), so a
# session refuses to start between different builds (the page reports the
# build id below with its hash checks).

# Same Emscripten release on both architectures (the -arm64 tag is native on Apple silicon).
ARG EMSDK_TAG=4.0.10
FROM emscripten/emsdk:${EMSDK_TAG} AS build

ARG MGBA_REF=0.10.5
ARG MGBA_COMMIT=26b7884bc25a5933960f3cdcd98bac1ae14d42e2

RUN git clone --quiet --depth 1 --branch "${MGBA_REF}" https://github.com/mgba-emu/mgba.git /mgba \
 && test "$(git -C /mgba rev-parse HEAD)" = "${MGBA_COMMIT}"

# The core library only: GBA and GB, no frontends, no optional libraries, no threads.
WORKDIR /mgba/build
RUN emcmake cmake .. \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_STATIC=ON -DBUILD_SHARED=OFF -DDISABLE_FRONTENDS=ON \
      -DBUILD_QT=OFF -DBUILD_SDL=OFF -DBUILD_LIBRETRO=OFF -DBUILD_PERF=OFF -DBUILD_TEST=OFF -DBUILD_SUITE=OFF \
      -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF -DUSE_EPOXY=OFF \
      -DM_CORE_GB=ON -DM_CORE_GBA=ON \
      -DUSE_DEBUGGERS=OFF -DUSE_GDB_STUB=OFF -DUSE_EDITLINE=OFF -DENABLE_SCRIPTING=OFF -DUSE_LUA=OFF \
      -DUSE_FFMPEG=OFF -DUSE_ZLIB=OFF -DUSE_MINIZIP=OFF -DUSE_PNG=OFF -DUSE_LIBZIP=OFF -DUSE_SQLITE3=OFF \
      -DUSE_ELF=OFF -DUSE_LZMA=OFF -DUSE_DISCORD_RPC=OFF \
      -DCMAKE_C_FLAGS="-D_GNU_SOURCE -DDISABLE_THREADING" \
 && emmake make -j"$(nproc)" mgba

COPY src /hub
RUN mkdir /out && emcc -O3 /hub/hub.c /mgba/build/libmgba.a \
      -I/mgba/include -I/mgba/build/include -D_GNU_SOURCE -DDISABLE_THREADING \
      -sMODULARIZE=1 -sEXPORT_NAME=createMgbaHub -sENVIRONMENT=web,node \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB \
      -sEXPORTED_FUNCTIONS=_malloc,_free \
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAP16 \
      -o /out/mgba-hub.js \
 && printf '{"mgba":"%s","commit":"%s","emscripten":"4.0.10","sha256":"%s"}\n' \
      "${MGBA_REF}" "${MGBA_COMMIT}" "$(cat /out/mgba-hub.js /out/mgba-hub.wasm | sha256sum | cut -c1-16)" > /out/build.json

FROM scratch AS out
COPY --from=build /out/ /
