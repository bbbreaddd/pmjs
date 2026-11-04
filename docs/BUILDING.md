### Prerequisites

On Debian:

```bash
sudo apt install build-essential cmake ninja-build pkg-config python3 git binutils dpkg-dev llvm-19 ca-certificates
```

### Build

```bash
./build.sh --target arm64
```

The first build downloads and prepares the target compiler, libraries, and Node.js. Binary will by default be placed in `dist/pmjs-arm64/`.

Use `--jobs N` to set the number of parallel jobs or `--output PATH` to choose another output directory.

### Docker

With Docker Buildx, export the runtime to an empty directory:

```bash
docker buildx build --output type=local,dest=dist/pmjs-docker-arm64 .
```
