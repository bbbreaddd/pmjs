FROM debian:13-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 cmake ninja-build git pkg-config make dpkg-dev binutils llvm-19 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

ARG PMJS_JOBS=4
RUN --mount=type=cache,target=/src/.cache,sharing=locked \
    --mount=type=cache,target=/src/build,sharing=locked \
    ./build.sh --target arm64 --jobs "$PMJS_JOBS"

FROM scratch AS runtime
COPY --from=build /src/dist/pmjs-arm64/ /
