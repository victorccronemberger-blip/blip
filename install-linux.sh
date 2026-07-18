#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="${MIMOCODE_REPOSITORY_URL:-https://github.com/victorccronemberger-blip/blip.git}"
BRANCH="${MIMOCODE_BRANCH:-agent/platform-mcps}"
REPOSITORY_DIR="${MIMOCODE_SOURCE_DIR:-$HOME/blip}"
PRESERVE_CONFIG=false
INSTALL_SYSTEM_PACKAGES=true

info() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
MiMoCode + PentesterCode source installer for Linux

Usage: ./install-linux.sh [options]

Options:
  --branch <name>          Git branch to install (default: agent/platform-mcps)
  --repo-dir <path>        Source checkout (default: ~/blip)
  --preserve-config        Do not replace an existing ~/.mimocode/mimocode.jsonc
  --skip-system-packages   Do not invoke apt/dnf/pacman/apk
  -h, --help               Show this help

Environment alternatives:
  MIMOCODE_BRANCH, MIMOCODE_SOURCE_DIR, MIMOCODE_REPOSITORY_URL
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ -n "${2:-}" ]] || die "--branch requires a value"
      BRANCH="$2"
      shift 2
      ;;
    --repo-dir)
      [[ -n "${2:-}" ]] || die "--repo-dir requires a value"
      REPOSITORY_DIR="$2"
      shift 2
      ;;
    --preserve-config)
      PRESERVE_CONFIG=true
      shift
      ;;
    --skip-system-packages)
      INSTALL_SYSTEM_PACKAGES=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

trap 'code=$?; printf "\033[1;31merror:\033[0m installation stopped at line %s (exit %s)\n" "$LINENO" "$code" >&2; exit "$code"' ERR

run_as_root() {
  if [[ ${EUID:-$(id -u)} -eq 0 ]]; then
    "$@"
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "sudo is required to install system packages"
  sudo "$@"
}

install_system_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
      build-essential ca-certificates curl g++ gcc git make pkg-config python3 python3-dev tar unzip
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y \
      ca-certificates curl gcc gcc-c++ git make pkgconf-pkg-config python3 python3-devel tar unzip
    return
  fi
  if command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -Sy --needed --noconfirm base-devel ca-certificates curl git pkgconf python tar unzip
    return
  fi
  if command -v apk >/dev/null 2>&1; then
    run_as_root apk add --no-cache \
      build-base ca-certificates curl git pkgconf python3 python3-dev tar unzip
    return
  fi
  die "unsupported package manager; install git, curl, Python 3, make and a C/C++ compiler, then rerun with --skip-system-packages"
}

if [[ "$INSTALL_SYSTEM_PACKAGES" == true ]]; then
  info "Installing the Linux native-build toolchain"
  install_system_packages
fi

if ! command -v bun >/dev/null 2>&1; then
  info "Installing Bun"
  command -v unzip >/dev/null 2>&1 || die "unzip is required to install Bun"
  curl -fsSL https://bun.com/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || die "Bun is not available after installation"

info "Installing node-gyp for native Tree-sitter modules"
bun add --global node-gyp@12.3.0
command -v node-gyp >/dev/null 2>&1 || die "node-gyp is not on PATH"

REPOSITORY_DIR="$(realpath -m "$REPOSITORY_DIR")"
if [[ ! -e "$REPOSITORY_DIR" ]]; then
  info "Cloning $REPOSITORY_URL ($BRANCH)"
  git clone --branch "$BRANCH" --single-branch "$REPOSITORY_URL" "$REPOSITORY_DIR"
elif [[ ! -d "$REPOSITORY_DIR/.git" ]]; then
  die "$REPOSITORY_DIR exists but is not a Git checkout"
else
  [[ -z "$(git -C "$REPOSITORY_DIR" status --porcelain)" ]] ||
    die "$REPOSITORY_DIR has local changes; commit or move them before installing"
  [[ "$(git -C "$REPOSITORY_DIR" remote get-url origin)" == "$REPOSITORY_URL" ]] ||
    die "$REPOSITORY_DIR points to a different Git repository; set MIMOCODE_REPOSITORY_URL if intentional"
  info "Updating $REPOSITORY_DIR to origin/$BRANCH"
  git -C "$REPOSITORY_DIR" fetch origin "$BRANCH"
  git -C "$REPOSITORY_DIR" switch "$BRANCH"
  git -C "$REPOSITORY_DIR" merge --ff-only "origin/$BRANCH"
fi

[[ "$(realpath "$(git -C "$REPOSITORY_DIR" rev-parse --show-toplevel)")" == "$REPOSITORY_DIR" ]] ||
  die "refusing to clean dependencies outside the resolved repository root"

if [[ -d "$REPOSITORY_DIR/node_modules" ]]; then
  info "Removing the incomplete/rebuildable node_modules directory"
  rm -rf -- "$REPOSITORY_DIR/node_modules"
fi

info "Installing project dependencies"
(
  cd "$REPOSITORY_DIR"
  bun install --frozen-lockfile
)

machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) architecture="x64" ;;
  aarch64|arm64) architecture="arm64" ;;
  *) die "unsupported Linux architecture: $machine" ;;
esac

baseline=false
if [[ "$architecture" == x64 ]] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
  baseline=true
fi

musl=false
if [[ -f /etc/alpine-release ]] || (command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl); then
  musl=true
fi

build_args=(script/build.ts --package --skip-install)
if [[ "$musl" == false ]]; then
  build_args+=(--single)
  [[ "$baseline" == true ]] && build_args+=(--baseline)
fi

info "Building the native Linux installer"
(
  cd "$REPOSITORY_DIR"
  bun run --cwd packages/opencode "${build_args[@]}"
)

target="mimocode-linux-$architecture"
[[ "$baseline" == true ]] && target="$target-baseline"
[[ "$musl" == true ]] && target="$target-musl"
dist="$REPOSITORY_DIR/packages/opencode/dist"
archive="$dist/$target.tar.gz"
[[ -f "$archive" ]] || die "expected installer was not produced: $archive"

info "Verifying SHA-256"
(
  cd "$dist"
  grep -F "  $(basename "$archive")" SHA256SUMS-linux.txt | sha256sum -c -
)

config="$HOME/.mimocode/mimocode.jsonc"
backup=""
if [[ -f "$config" && "$PRESERVE_CONFIG" == false ]]; then
  backup="$config.backup-$(date +%Y%m%d-%H%M%S)"
  cp -p "$config" "$backup"
  info "Backed up the existing config to $backup"
fi

info "Installing MiMoCode and seeding PentesterCode"
(
  cd "$dist"
  tar -xzf "$archive"
  ./install --binary ./mimo
)

if [[ -n "$backup" ]]; then
  info "Applying the new portable MCP defaults"
  bun "$REPOSITORY_DIR/packages/pentestercode/script/seed-home.ts" --force
fi

export PATH="$HOME/.mimocode/bin:$PATH"
info "Installation complete"
"$HOME/.mimocode/bin/mimo" --version

cat <<EOF

Open a new terminal, or run:
  export PATH="\$HOME/.mimocode/bin:\$PATH"

Platform MCP credentials are intentionally not stored by this installer:
  export INTIGRITI_TOKEN="..."
  export HACKERONE_API_USERNAME="..."
  export HACKERONE_API_TOKEN="..."

Then verify:
  mimo mcp list

Source checkout: $REPOSITORY_DIR
Installer archive: $archive
${backup:+Previous config backup: $backup}
EOF
