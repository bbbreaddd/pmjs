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

To package the default ARM64 build, run `python3 tools/release.py package`. Use `--format squashfs` or `--format all` to include SquashFS

Game ZIP packaging with `tools/portmaster.py --submission` requires Pillow
(`sudo apt install python3-pil` or `python3 -m pip install Pillow`). Packaging
requires screenshots to be exactly 640×480, compresses PNG artwork, and fits
supplied covers onto a black 640×480 canvas without cropping. Source files stay
unchanged.

Artwork compression reduces images to a palette of up to 157 colours, with
dithering for opaque artwork. Transparent artwork uses alpha-aware octree
quantization. Use `--no-image-compression` to preserve screenshot bytes and skip
palette reduction and optimized PNG encoding. Cover fitting still applies.

### Docker

With Docker Buildx, export the runtime to an empty directory:

```bash
docker buildx build --output type=local,dest=dist/pmjs-docker-arm64 .
```

To build a tarball and matching source archive into an empty directory:

```bash
docker buildx build --output type=local,dest=dist/pmjs-bin/
```

To build a SquashFS image instead, add `--build-arg PMJS_PACKAGE_FORMAT=squashfs`. To build both formats, use `--build-arg PMJS_PACKAGE_FORMAT=all`.
