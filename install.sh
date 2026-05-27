#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_scope="${PI_GOAL_INSTALL_SCOPE:-global}"
target_dir="${PI_GOAL_INSTALL_TARGET:-}"
skip_check=0
skip_smoke=0
skip_config=0

usage() {
  cat <<'USAGE'
Usage:
  ./install.sh [--global] [--skip-check] [--skip-smoke] [--skip-config]
  ./install.sh --local [DIR] [--skip-check] [--skip-smoke]
  ./install.sh --target DIR [--skip-check] [--skip-smoke]

Installs this pi-goal checkout into Pi's user-global configuration by default:

  pi install <this repo>

Use --local or --target to install into one project's .pi/settings.json instead:

  pi install <this repo> -l

Options:
  --global       Install into user-global Pi settings. This is the default.
  --local [DIR]  Install into DIR/.pi/settings.json. Defaults to the current directory.
  --target DIR   Compatibility alias for --local DIR.
  --skip-check   Skip npm install and npm run check before installing.
  --skip-smoke   Skip the extension smoke-load check.
  --skip-config  Skip creating the global pi-goal.config.json template.

Environment:
  PI_GOAL_INSTALL_SCOPE   Default install scope: global or local.
  PI_GOAL_INSTALL_TARGET  Default local target directory for --local.
  PI_GOAL_GLOBAL_CONFIG   Explicit global goal config path.
  PI_GOAL_PI_BIN          Explicit pi binary path or command.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --global)
      install_scope="global"
      shift
      ;;
    --local|--project|--project-local)
      install_scope="local"
      if [[ $# -ge 2 && "$2" != --* ]]; then
        target_dir="$2"
        shift 2
      else
        shift
      fi
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --target" >&2
        exit 2
      fi
      install_scope="local"
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
    --skip-config)
      skip_config=1
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

case "$install_scope" in
  global|user-global)
    install_scope="global"
    target_dir=""
    ;;
  local|project|project-local)
    install_scope="local"
    target_dir="${target_dir:-$PWD}"
    target_dir="$(cd "$target_dir" && pwd)"
    ;;
  *)
    echo "Invalid PI_GOAL_INSTALL_SCOPE: $install_scope (expected global or local)" >&2
    exit 2
    ;;
esac

run_pi() {
  if [[ -n "${PI_GOAL_PI_BIN:-}" ]]; then
    "$PI_GOAL_PI_BIN" "$@"
  elif command -v pi >/dev/null 2>&1; then
    pi "$@"
  else
    npm exec --prefix "$repo_root" -- pi "$@"
  fi
}

expand_path() {
  case "$1" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s\n' "$HOME" "${1#~/}"
      ;;
    /*)
      printf '%s\n' "$1"
      ;;
    *)
      printf '%s/%s\n' "$PWD" "$1"
      ;;
  esac
}

global_config_path() {
  if [[ -n "${PI_GOAL_GLOBAL_CONFIG:-}" ]]; then
    expand_path "$PI_GOAL_GLOBAL_CONFIG"
  else
    local agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
    printf '%s/pi-goal.config.json\n' "$(expand_path "$agent_dir")"
  fi
}

create_global_config_template() {
  local config_path
  config_path="$(global_config_path)"

  if [[ -e "$config_path" ]]; then
    echo "Global pi-goal config already exists: $config_path"
    return
  fi

  mkdir -p "$(dirname "$config_path")"
  cat > "$config_path" <<'JSON'
{
  "_comment": "Global defaults for pi-goal. Project config can override any of these fields.",
  "_paths": {
    "global": "~/.pi/agent/pi-goal.config.json",
    "project": [
      "pi-goal.config.json",
      ".pi-goal.json",
      ".pi/goal.config.json"
    ]
  },
  "maxAttempts": 10000,
  "observer": {
    "_comment": "Set model to a stable verifier model, for example openai/gpt-4.1-mini. Leave model empty to reuse the current main-session model. Set thinking to off, minimal, low, medium, high, or xhigh.",
    "model": "",
    "thinking": "",
    "tools": ["read", "bash", "grep", "find", "ls"]
  },
  "summarizer": {
    "_comment": "Set model to a cheaper/faster summarizer model, for example openai/gpt-4.1-nano. Leave model empty to reuse the observer model. Set thinking to off, minimal, low, medium, high, or xhigh.",
    "model": "",
    "thinking": "",
    "tools": []
  },
  "evidence": {
    "_comment": "Keep validationCommands project-local unless the same commands make sense everywhere.",
    "extraValidationCommands": [],
    "validationCommandLimit": 3,
    "validationTimeoutMs": 120000
  },
  "attemptGuard": {
    "enabled": true,
    "maxSingleDeltaChars": 64000,
    "maxAssistantDeltaChars": 512000,
    "maxWhitespaceDeltaChars": 32000
  },
  "loopSafety": {
    "enabled": true,
    "maxRuntimeMs": 0,
    "minAttemptsBeforeStallCheck": 20,
    "maxStalledAttempts": 12,
    "minStalledRuntimeMs": 43200000
  },
  "httpIdleTimeout": {
    "_comment": "Temporarily override Pi's HTTP idle timeout while /goal is active. timeoutMs 0 disables the idle timeout; the previous Pi setting is restored when the goal passes, fails, or is cancelled.",
    "enabled": true,
    "timeoutMs": 0
  },
  "mainToolIdleTimeout": {
    "_comment": "Abort and retry a visible main-session attempt when a tool goes quiet for too long. timeoutMs 0 disables this guard.",
    "enabled": true,
    "timeoutMs": 300000
  }
}
JSON
  echo "Created global pi-goal config template: $config_path"
}

echo "pi-goal repo: $repo_root"
if [[ "$install_scope" == "local" ]]; then
  echo "install scope: local project"
  echo "target project: $target_dir"
else
  echo "install scope: user-global"
fi

if [[ "$skip_check" -eq 0 ]]; then
  npm install --prefix "$repo_root"
  npm --prefix "$repo_root" run check
fi

if [[ "$skip_smoke" -eq 0 ]]; then
  run_pi --no-extensions -e "$repo_root/extensions/goal/index.ts" --no-session
fi

if [[ "$install_scope" == "local" ]]; then
  (
    cd "$target_dir"
    run_pi install "$repo_root" -l
  )
  echo "Installed pi-goal into $target_dir/.pi/settings.json"
else
  run_pi install "$repo_root"
  echo "Installed pi-goal into user-global Pi settings"
  if [[ "$skip_config" -eq 0 ]]; then
    create_global_config_template
  fi
fi
