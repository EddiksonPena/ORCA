#!/usr/bin/env sh
set -eu

REPO_URL="${ORCA_REPO_URL:-https://github.com/EddiksonPena/ORCA.git}"
INSTALL_DIR="${ORCA_INSTALL_DIR:-orca}"
BRANCH="${ORCA_BRANCH:-main}"
PROFILE="${ORCA_COMPOSE_PROFILE:-app}"
START_STACK="${ORCA_START_STACK:-true}"
GENERATE_KEY="${ORCA_GENERATE_API_KEY:-true}"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

fail() {
  printf '%s\n' "ORCA install failed: $*" >&2
  exit 1
}

generate_api_key() {
  if command_exists openssl; then
    openssl rand -hex 32
    return
  fi

  if command_exists node; then
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    return
  fi

  fail "openssl or node is required to generate ORCA_API_KEY"
}

require_command() {
  command_exists "$1" || fail "$1 is required"
}

env_value() {
  awk -F= -v key="$1" '$1 == key {print substr($0, length(key) + 2); exit}' ".env"
}

set_env_value() {
  KEY_NAME="$1"
  KEY_VALUE="$2"
  TMP_FILE=".env.tmp.$$"
  if grep -q "^$KEY_NAME=" ".env"; then
    sed "s|^$KEY_NAME=.*|$KEY_NAME=$KEY_VALUE|" ".env" > "$TMP_FILE"
  else
    cp ".env" "$TMP_FILE"
    printf '%s=%s\n' "$KEY_NAME" "$KEY_VALUE" >> "$TMP_FILE"
  fi
  mv "$TMP_FILE" ".env"
}

set_env_if_placeholder() {
  KEY_NAME="$1"
  KEY_VALUE="$2"
  CURRENT_VALUE="$(env_value "$KEY_NAME")"
  if [ -z "$CURRENT_VALUE" ] || [ "$CURRENT_VALUE" = "replace-me" ]; then
    set_env_value "$KEY_NAME" "$KEY_VALUE"
  fi
}

require_command git
require_command docker

docker compose version >/dev/null 2>&1 || fail "docker compose is required"

if [ -d ".git" ] && [ -f "package.json" ] && grep -q '"name": "orca"' package.json; then
  PROJECT_DIR="$(pwd)"
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    PROJECT_DIR="$INSTALL_DIR"
    git -C "$PROJECT_DIR" fetch --quiet origin "$BRANCH"
    git -C "$PROJECT_DIR" checkout --quiet "$BRANCH"
    git -C "$PROJECT_DIR" pull --ff-only --quiet origin "$BRANCH"
  else
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    PROJECT_DIR="$INSTALL_DIR"
  fi
fi

cd "$PROJECT_DIR"

if [ ! -f ".env" ]; then
  if [ -f ".env.production.example" ]; then
    cp ".env.production.example" ".env"
  elif [ -f ".env.example" ]; then
    cp ".env.example" ".env"
  else
    fail "no environment example file found"
  fi
fi

set_env_if_placeholder "NEO4J_PASSWORD" "orca-memory"
set_env_if_placeholder "APP_NEO4J_PASSWORD" "orca-memory"
set_env_value "ORCA_AUTH_MODE" "api-key"

if [ "$GENERATE_KEY" = "true" ]; then
  CURRENT_ORCA_KEY="$(env_value "ORCA_API_KEY")"
  if [ -z "$CURRENT_ORCA_KEY" ] || [ "$CURRENT_ORCA_KEY" = "replace-me" ]; then
    set_env_value "ORCA_API_KEY" "$(generate_api_key)"
  fi
fi

if [ "$START_STACK" = "true" ]; then
  docker compose --profile "$PROFILE" up -d --build
fi

printf '\n%s\n' "ORCA is installed in: $(pwd)"
printf '%s\n' "Memory API: http://127.0.0.1:4000"
printf '%s\n' "Onboarding UI: http://127.0.0.1:4020"
printf '%s\n' "OpenAI-compatible proxy: http://127.0.0.1:4030"
printf '\n%s\n' "Next steps:"
printf '%s\n' "  1. Run: docker compose ps"
printf '%s\n' "  2. Run: curl http://127.0.0.1:4000/health"
printf '%s\n' "  3. Generate an agent bundle:"
printf '%s\n' "     node scripts/orca-cli.mjs install universal --enforce --destination ./orca-agent-install"
