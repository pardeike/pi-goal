#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${PI_GOAL_INSTALL_TARGET:-$PWD}"
skip_check=0
skip_smoke=0

usage() {
  cat <<'USAGE'
Usage:
  ./install.sh [--target DIR] [--skip-check] [--skip-smoke]

Installs this pi-goal checkout into a local Pi project configuration by running:

  pi install <this repo> -l

Options:
  --target DIR   Install into DIR/.pi/settings.json instead of the current directory.
  --skip-check   Skip npm install and npm run check before installing.
  --skip-smoke   Skip the extension smoke-load check.

Environment:
  PI_GOAL_INSTALL_TARGET  Default target directory.
  PI_GOAL_PI_BIN          Explicit pi binary path or command.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --target" >&2
        exit 2
      fi
      target_dir="$2"
      shift 2
      ;;
    --skip-check)
      skip_check=1
      shift
      ;;
    --skip-smoke)
      skip_smoke=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

target_dir="$(cd "$target_dir" && pwd)"

run_pi() {
  if [[ -n "${PI_GOAL_PI_BIN:-}" ]]; then
    "$PI_GOAL_PI_BIN" "$@"
  elif command -v pi >/dev/null 2>&1; then
    pi "$@"
  else
    npm exec --prefix "$repo_root" -- pi "$@"
  fi
}

echo "pi-goal repo: $repo_root"
echo "target project: $target_dir"

if [[ "$skip_check" -eq 0 ]]; then
  npm install --prefix "$repo_root"
  npm --prefix "$repo_root" run check
fi

if [[ "$skip_smoke" -eq 0 ]]; then
  run_pi --no-extensions -e "$repo_root/extensions/goal/index.ts" --no-session
fi

(
  cd "$target_dir"
  run_pi install "$repo_root" -l
)

echo "Installed pi-goal into $target_dir/.pi/settings.json"
