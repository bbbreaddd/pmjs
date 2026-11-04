# syntax=docker/dockerfile:1
FROM debian:13-slim AS build-environment

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 cmake ninja-build git pkg-config make dpkg-dev binutils llvm-19 ca-certificates squashfs-tools \
    && rm -rf /var/lib/apt/lists/*

FROM build-environment AS build
WORKDIR /src
COPY --exclude=.git . .

ARG PMJS_JOBS=4
RUN --mount=type=cache,target=/src/.cache,sharing=locked \
    --mount=type=cache,target=/src/build,sharing=locked \
    ./build.sh --target arm64 --jobs "$PMJS_JOBS"

FROM build AS package
ARG PMJS_BUILD_ID
ARG PMJS_SOURCES_URL
ARG PMJS_PACKAGE_FORMAT=tar.gz
RUN --mount=type=cache,target=/src/.cache,sharing=locked \
    --mount=type=cache,target=/src/build,sharing=locked \
    --mount=type=bind,source=.git,target=/src/.git,ro \
    GIT_OPTIONAL_LOCKS=0 PMJS_BUILD_ID="$PMJS_BUILD_ID" PMJS_SOURCES_URL="$PMJS_SOURCES_URL" \
    PMJS_PACKAGE_FORMAT="$PMJS_PACKAGE_FORMAT" \
    python3 tools/release.py package

FROM scratch AS artifacts
COPY --from=package /src/dist/pmjs-linux-arm64-* /
COPY --from=package /src/dist/pmjs-ffmpeg-sources-* /
COPY --from=package /src/dist/static-arm64.json /

FROM scratch AS runtime
COPY --from=build /src/dist/pmjs-arm64/ /
