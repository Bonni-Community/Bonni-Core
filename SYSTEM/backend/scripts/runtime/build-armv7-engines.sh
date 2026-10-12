#!/bin/sh
set -eu
OUT="${BONNI_ENGINE_OUTPUT:-/opt/bonni-engines}"
mkdir -p "$OUT"
printf '#!/bin/sh\nset -eu\n. /opt/bonni-engines/environment.sh\nexec /usr/local/bin/docker-entrypoint.sh "$@"\n' > "$OUT/entrypoint.sh"
chmod 755 "$OUT/entrypoint.sh"
printf '# Engine environment selected at image build time.\n' > "$OUT/environment.sh"
if [ "${TARGETARCH:-}" != arm ]; then exit 0; fi
test "${TARGETVARIANT:-}" = v7

# Compile on the build host, not in slow ARM emulation. Both crates and all
# transitive Rust dependencies come from this exact locked engine revision.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git build-essential pkg-config perl cmake libstdc++6 libatomic1 \
  gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf libc6-dev-armhf-cross
LOCK="${BONNI_ENGINE_LOCK:-/work/package-lock.json}"
REVISION=$(node -e 'const p=require(process.argv[1]).packages["node_modules/@prisma/engines-version"]; const m=/\.([a-f0-9]{40})$/.exec(p?.version||""); if(!m) throw Error("PRISMA_ENGINE_LOCK_INVALID"); process.stdout.write(m[1]);' "$LOCK")
WORK="${BONNI_ENGINE_WORK:-/work/prisma-engines}"
git init "$WORK"
git -C "$WORK" remote add origin https://github.com/prisma/prisma-engines.git
git -C "$WORK" fetch --depth=1 origin "$REVISION"
git -C "$WORK" checkout --detach FETCH_HEAD
test "$(git -C "$WORK" rev-parse HEAD)" = "$REVISION"
cd "$WORK"
TOOLCHAIN=$(node -e 'const s=require("fs").readFileSync("rust-toolchain.toml","utf8"); const m=/^channel\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/m.exec(s); if(!m) throw Error("PRISMA_RUST_TOOLCHAIN_INVALID"); process.stdout.write(m[1]);')
export RUSTUP_HOME="${BONNI_RUSTUP_ROOT:-/opt/bonni-rustup}"
export CARGO_HOME="${BONNI_CARGO_ROOT:-/opt/bonni-cargo}"
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 https://sh.rustup.rs -o /tmp/bonni-rustup.sh
sh /tmp/bonni-rustup.sh -y --no-modify-path --profile minimal --default-toolchain none
export PATH="$CARGO_HOME/bin:$PATH"
rustup toolchain install "$TOOLCHAIN" --profile minimal --no-self-update
rustup target add --toolchain "$TOOLCHAIN" armv7-unknown-linux-gnueabihf
export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc
export CC_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-gcc
export CXX_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-g++
export AR_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-ar
export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=65536 -C link-arg=-Wl,-z,common-page-size=65536'
export OPENSSL_STATIC=1
cargo +"$TOOLCHAIN" build --locked --release --jobs 2 --target armv7-unknown-linux-gnueabihf \
  -p query-engine-node-api -p schema-engine-cli \
  --features query-engine-node-api/vendored-openssl,schema-engine-cli/vendored-openssl
cp target/armv7-unknown-linux-gnueabihf/release/libquery_engine.so "$OUT/libquery_engine-linux-arm-openssl-3.0.x.so.node"
cp target/armv7-unknown-linux-gnueabihf/release/schema-engine "$OUT/schema-engine-linux-arm-openssl-3.0.x"
chmod 755 "$OUT/schema-engine-linux-arm-openssl-3.0.x"
printf '%s\n' "$REVISION" > "$OUT/revision"
cp LICENSE "$OUT/LICENSE-Prisma-Engines"
cat >> "$OUT/environment.sh" <<'BONNI_ENV'
export PRISMA_QUERY_ENGINE_LIBRARY=/opt/bonni-engines/libquery_engine-linux-arm-openssl-3.0.x.so.node
export PRISMA_SCHEMA_ENGINE_BINARY=/opt/bonni-engines/schema-engine-linux-arm-openssl-3.0.x
BONNI_ENV
