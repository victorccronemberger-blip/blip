#!/usr/bin/env bash
# MiMoCode / PentesterCode lifecycle manager — install, update, uninstall, status.
#
#   ./mimocode.sh install      # fresh install (deps, build, seed)
#   ./mimocode.sh update       # pull latest main, rebuild, keep config + credentials
#   ./mimocode.sh uninstall    # remove binary + source (keeps ~/.mimocode config/creds)
#   ./mimocode.sh uninstall --purge   # also delete ~/.mimocode (config, auth, data)
#   ./mimocode.sh status       # show version, paths, and whether an update is available
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/victorccronemberger-blip/blip/main/mimocode.sh | bash -s install
#
# Overridable via env: MIMOCODE_REPOSITORY_URL, MIMOCODE_BRANCH, MIMOCODE_SOURCE_DIR, MIMOCODE_HOME
set -Eeuo pipefail

REPO_URL="${MIMOCODE_REPOSITORY_URL:-https://github.com/victorccronemberger-blip/blip.git}"
BRANCH="${MIMOCODE_BRANCH:-main}"
SOURCE_DIR="${MIMOCODE_SOURCE_DIR:-$HOME/blip}"
HOME_DIR="${MIMOCODE_HOME:-$HOME/.mimocode}"
BIN="$HOME_DIR/bin/mimo"
INSTALLER_URL="https://raw.githubusercontent.com/victorccronemberger-blip/blip/${BRANCH}/install-linux.sh"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Run the proven build/seed engine (install-linux.sh). Prefer a local checkout;
# otherwise fetch it from the pinned branch. Extra args are forwarded.
run_installer() {
  command -v curl >/dev/null 2>&1 || command -v git >/dev/null 2>&1 || die "need curl or git"
  if [[ -f "$SOURCE_DIR/install-linux.sh" ]]; then
    info "Using local installer at $SOURCE_DIR/install-linux.sh"
    MIMOCODE_REPOSITORY_URL="$REPO_URL" MIMOCODE_BRANCH="$BRANCH" MIMOCODE_SOURCE_DIR="$SOURCE_DIR" \
      bash "$SOURCE_DIR/install-linux.sh" "$@"
  else
    info "Fetching installer from $INSTALLER_URL"
    curl -fsSL "$INSTALLER_URL" | MIMOCODE_REPOSITORY_URL="$REPO_URL" MIMOCODE_BRANCH="$BRANCH" \
      MIMOCODE_SOURCE_DIR="$SOURCE_DIR" bash -s -- "$@"
  fi
}

cmd_install() {
  info "Installing MiMoCode/PentesterCode (branch: $BRANCH)"
  run_installer "$@"
  ok "Install complete. Open a new terminal or: export PATH=\"$HOME_DIR/bin:\$PATH\""
}

cmd_update() {
  info "Updating MiMoCode/PentesterCode — pulls latest $BRANCH, rebuilds, keeps your config + credentials"
  # Each build rewrites a TRACKED file (packages/opencode/bin/mimo), so the managed
  # checkout is always "dirty" and a plain pull aborts. Reset it to a clean state
  # first — deterministic, no stash pile-up — since nobody should hand-edit ~/blip.
  # This only touches the source checkout; ~/.mimocode (config + auth) is untouched.
  if [[ -d "$SOURCE_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
    info "Resetting managed source checkout to a clean state"
    git -C "$SOURCE_DIR" reset --hard HEAD >/dev/null 2>&1 || true
    git -C "$SOURCE_DIR" clean -fd -e node_modules >/dev/null 2>&1 || true
  fi
  # --preserve-config never overwrites config/auth; --stash-local-changes is a
  # belt-and-suspenders net for any leftover untracked file.
  run_installer --preserve-config --stash-local-changes "$@"
  ok "Update complete."
}

# Strip PATH lines that reference the install's bin dir from common shell rc files.
clean_path_entries() {
  local rc
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.config/fish/config.fish"; do
    [[ -f "$rc" ]] || continue
    if grep -q "\.mimocode/bin" "$rc" 2>/dev/null; then
      local tmp; tmp="$(mktemp)"
      grep -v "\.mimocode/bin" "$rc" > "$tmp" && cat "$tmp" > "$rc" && rm -f "$tmp"
      ok "Removed PATH entry from $rc"
    fi
  done
}

cmd_uninstall() {
  local purge=false
  for a in "$@"; do [[ "$a" == "--purge" ]] && purge=true; done

  info "Uninstalling MiMoCode/PentesterCode"
  [[ -f "$BIN" ]] && { rm -f "$BIN"; ok "Removed binary $BIN"; } || warn "No binary at $BIN"
  # Remove an empty bin dir, but never the whole home here.
  rmdir "$HOME_DIR/bin" 2>/dev/null || true
  if [[ -d "$SOURCE_DIR" && -e "$SOURCE_DIR/install-linux.sh" ]]; then
    rm -rf -- "$SOURCE_DIR"; ok "Removed source checkout $SOURCE_DIR"
  else
    warn "Source checkout not found at $SOURCE_DIR (skipped)"
  fi
  clean_path_entries

  if [[ "$purge" == true ]]; then
    warn "--purge: deleting $HOME_DIR (config, credentials in auth.json, data)"
    rm -rf -- "$HOME_DIR"; ok "Removed $HOME_DIR"
  else
    ok "Kept $HOME_DIR (config + credentials). Re-run with --purge to remove them too."
  fi
  info "Uninstall complete. Open a new terminal so PATH changes take effect."
}

cmd_status() {
  info "MiMoCode/PentesterCode status"
  printf '  binary:  %s\n' "$([[ -x "$BIN" ]] && echo "$BIN" || echo 'not installed')"
  printf '  home:    %s\n' "$([[ -d "$HOME_DIR" ]] && echo "$HOME_DIR" || echo 'absent')"
  printf '  source:  %s\n' "$([[ -d "$SOURCE_DIR" ]] && echo "$SOURCE_DIR" || echo 'absent')"
  printf '  branch:  %s\n' "$BRANCH"
  if [[ -x "$BIN" ]]; then printf '  version: '; "$BIN" --version 2>/dev/null || echo '(unknown)'; fi
  # Update availability: compare local checkout HEAD vs remote branch tip.
  if [[ -d "$SOURCE_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
    local local_head remote_head
    local_head="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
    remote_head="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" 2>/dev/null | cut -c1-7)"
    printf '  local:   %s\n  remote:  %s\n' "$local_head" "${remote_head:-?}"
    if [[ -n "${remote_head:-}" && "$local_head" != "${remote_head:0:7}" ]]; then
      warn "Update available — run: $0 update"
    else
      ok "Up to date."
    fi
  fi
}

usage() {
  cat <<EOF
MiMoCode / PentesterCode lifecycle manager

Usage: $0 <command> [options]

Commands:
  install              Fresh install (system deps, build from source, seed ~/.mimocode)
  update               Pull latest $BRANCH, rebuild, keep config + credentials
  uninstall            Remove binary + source checkout (keeps ~/.mimocode)
  uninstall --purge    Also delete ~/.mimocode (config, auth.json credentials, data)
  status               Show install paths, version, and update availability

Env overrides: MIMOCODE_BRANCH, MIMOCODE_SOURCE_DIR, MIMOCODE_HOME, MIMOCODE_REPOSITORY_URL
EOF
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    install)   cmd_install "$@" ;;
    update|upgrade) cmd_update "$@" ;;
    uninstall|remove) cmd_uninstall "$@" ;;
    status)    cmd_status "$@" ;;
    ""|-h|--help|help) usage ;;
    *) die "unknown command: $cmd (try: $0 --help)" ;;
  esac
}

main "$@"
