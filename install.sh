#!/bin/sh
# Wirebot installer — https://github.com/nocell/wirebot-agent
#
#   curl -fsSL https://raw.githubusercontent.com/nocell/wirebot-agent/main/install.sh | sudo sh
#
# Interactive by default. Pass --yes plus flags (or the matching environment
# variables) for an unattended install: see --help. Safe to re-run; it keeps
# what is already in the install directory's .env.
set -eu

IMAGE=${WIREBOT_IMAGE:-ghcr.io/nocell/wirebot-agent:latest}
DIR=${WIREBOT_DIR:-/opt/wirebot}
TG_API=${TELEGRAM_API_BASE:-https://api.telegram.org}

# Settings the installer owns in .env. Every other line of an existing .env is
# preserved. Each can also arrive through the environment or a flag.
MANAGED="TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USER_IDS SLACK_BOT_TOKEN SLACK_APP_TOKEN
SLACK_ALLOWED_USER_IDS DISCORD_BOT_TOKEN DISCORD_ALLOWED_USER_IDS PUBLIC_URL ANTHROPIC_API_KEY
CLAUDE_CODE_USE_BEDROCK AWS_REGION CLAUDE_CODE_OAUTH_TOKEN"
for key in $MANAGED; do eval "$key=\${$key:-}"; done

AUTO=0 CREDENTIAL=1 AUTO_UPDATE=1 CADDY='' SELF_TEST=0
STEP=0 STEPS=7 DOMAIN='' CLAUDE_VIA='' CLAUDE_CHOICE='' PROXIED=0 TG_BOT='' SLACK_TEAM='' DISCORD_APP='' DISCORD_APP_ID=''
HTTP_CODE='' HTTP_BODY='' REPLY='' ERR='' SPIN_HINT='' SPIN_QUIET=0
BOLD='' DIM='' RED='' GREEN='' YELLOW='' CYAN='' RESET='' FANCY=0 G_FAIL=x
NL='
'

SLACK_MANIFEST_URL='https://api.slack.com/apps?new_app=1&manifest_json=%7B%22display_information%22%3A%7B%22name%22%3A%22Wirebot%22%2C%22description%22%3A%22An%20AI%20agent%20in%20your%20Slack%22%2C%22background_color%22%3A%22%231a1d21%22%7D%2C%22features%22%3A%7B%22app_home%22%3A%7B%22messages_tab_enabled%22%3Atrue%2C%22messages_tab_read_only_enabled%22%3Afalse%7D%2C%22bot_user%22%3A%7B%22display_name%22%3A%22Wirebot%22%2C%22always_online%22%3Atrue%7D%2C%22slash_commands%22%3A%5B%7B%22command%22%3A%22%2Fwirebot%22%2C%22description%22%3A%22Control%20Wirebot%20%28new%2C%20stop%2C%20status%2C%20help%E2%80%A6%29%22%2C%22usage_hint%22%3A%22new%20%7C%20back%20%7C%20stop%20%7C%20compact%20%7C%20schedules%20%7C%20status%20%7C%20help%22%2C%22should_escape%22%3Afalse%7D%5D%7D%2C%22oauth_config%22%3A%7B%22scopes%22%3A%7B%22bot%22%3A%5B%22chat%3Awrite%22%2C%22reactions%3Awrite%22%2C%22im%3Ahistory%22%2C%22channels%3Ahistory%22%2C%22groups%3Ahistory%22%2C%22mpim%3Ahistory%22%2C%22files%3Aread%22%2C%22files%3Awrite%22%2C%22users%3Aread%22%2C%22commands%22%5D%7D%7D%2C%22settings%22%3A%7B%22event_subscriptions%22%3A%7B%22bot_events%22%3A%5B%22message.channels%22%2C%22message.groups%22%2C%22message.im%22%2C%22message.mpim%22%5D%7D%2C%22interactivity%22%3A%7B%22is_enabled%22%3Atrue%7D%2C%22org_deploy_enabled%22%3Afalse%2C%22socket_mode_enabled%22%3Atrue%2C%22token_rotation_enabled%22%3Afalse%7D%7D'
# View Channels, Send Messages, Read Message History, Create Public Threads,
# Send Messages in Threads: the set docs/discord.md asks for.
DISCORD_PERMISSIONS=309237713920

usage() {
  cat <<'EOF'
Wirebot installer

Usage: install.sh [options]

  -y, --yes                     Unattended: never prompt, take everything from flags/env
      --dir DIR                 Install directory (default /opt/wirebot)
      --image IMAGE             Image to run (default ghcr.io/nocell/wirebot-agent:latest)

Messengers: at least one with --yes. Every flag also reads the environment
variable shown, which keeps secrets out of the process list.
      --telegram-token T        TELEGRAM_BOT_TOKEN
      --telegram-user-ids IDS   TELEGRAM_ALLOWED_USER_IDS  (comma-separated numeric IDs)
      --slack-bot-token T       SLACK_BOT_TOKEN            (xoxb-…)
      --slack-app-token T       SLACK_APP_TOKEN            (xapp-…)
      --slack-user-ids IDS      SLACK_ALLOWED_USER_IDS     (member IDs, or * for the workspace)
      --discord-token T         DISCORD_BOT_TOKEN
      --discord-user-ids IDS    DISCORD_ALLOWED_USER_IDS   (comma-separated snowflakes)

Claude credential: exactly one. There is no sign-in from the chat; without a
credential the bot answers every message with setup instructions.
      --anthropic-api-key KEY   ANTHROPIC_API_KEY  (Claude Console; required when
                                several people use the bot)
      --bedrock                 CLAUDE_CODE_USE_BEDROCK=1: Amazon Bedrock, with AWS
                                credentials from an instance role or lines you
                                add to .env yourself
      --aws-region REGION       AWS_REGION for Bedrock (default us-east-1)
      --claude-oauth-token T    CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.
                                Personal Pro/Max plan: Anthropic's terms allow it
                                only for your own single-user bot
      --no-credential           Skip this step

Web app:
      --public-url URL          PUBLIC_URL, e.g. https://bot.example.com
      --caddy, --no-caddy       Run Caddy next to Wirebot for automatic HTTPS
                                (asked interactively; off by default with --yes)

      --no-auto-update          Do not install the systemd auto-updater
  -h, --help                    Show this help
EOF
}

# ── Output ───────────────────────────────────────────────────────────────────

setup_ui() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
    BOLD=$(printf '\033[1m') DIM=$(printf '\033[2m') RED=$(printf '\033[31m')
    GREEN=$(printf '\033[32m') YELLOW=$(printf '\033[33m') CYAN=$(printf '\033[36m')
    RESET=$(printf '\033[0m') FANCY=1
  fi
  case ${LC_ALL:-${LC_CTYPE:-${LANG:-}}} in
    *[Uu][Tt][Ff]8* | *[Uu][Tt][Ff]-8*)
      G_OK='✔' G_FAIL='✖' G_WARN='▲' G_INFO='›' G_FULL='━' G_EMPTY='─'
      FRAMES='⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏'
      ;;
    *)
      G_OK='ok' G_FAIL='x' G_WARN='!' G_INFO='>' G_FULL='#' G_EMPTY='-'
      FRAMES='| / - \'
      ;;
  esac
}

say() { printf '  %s\n' "$*"; }
info() { printf '  %s%s%s %s\n' "$DIM" "$G_INFO" "$RESET" "$*"; }
ok() { printf '  %s%s%s %s\n' "$GREEN" "$G_OK" "$RESET" "$*"; }
warn() { printf '  %s%s %s%s\n' "$YELLOW" "$G_WARN" "$*" "$RESET"; }
link() { printf '    %s%s%s\n' "$CYAN" "$*" "$RESET"; }
die() {
  printf '\n  %s%s %s%s\n\n' "$RED" "$G_FAIL" "$*" "$RESET" >&2
  exit 1
}

# bar DONE TOTAL WIDTH
bar() {
  bar_fill=$(($1 * $3 / $2)) bar_i=0 bar_out=$GREEN
  while [ "$bar_i" -lt "$3" ]; do
    [ "$bar_i" -ne "$bar_fill" ] || bar_out=$bar_out$RESET$DIM
    if [ "$bar_i" -lt "$bar_fill" ]; then bar_out=$bar_out$G_FULL; else bar_out=$bar_out$G_EMPTY; fi
    bar_i=$((bar_i + 1))
  done
  printf '%s%s' "$bar_out" "$RESET"
}

step() {
  STEP=$((STEP + 1))
  printf '\n  %s  %s%s/%s%s  %s%s%s\n\n' "$(bar "$STEP" "$STEPS" 21)" "$DIM" "$STEP" "$STEPS" "$RESET" \
    "$BOLD" "$1" "$RESET"
}

banner() {
  printf '\n  %s%sWirebot%s  an agent powered by Claude, in your messenger\n' "$BOLD" "$CYAN" "$RESET"
  printf '  %sThis wizard installs Wirebot into %s and takes about five minutes.%s\n' "$DIM" "$DIR" "$RESET"
}

# spin LABEL CMD… runs CMD behind a spinner. Its output lands in $LOG and is
# shown only when it fails. SPIN_HINT names a function that renders extra
# progress from $LOG; SPIN_QUIET=1 leaves no line behind.
spin() {
  spin_label=$1
  shift
  : >"$LOG"
  if [ "$FANCY" != 1 ]; then
    [ "$SPIN_QUIET" = 1 ] || info "$spin_label…"
    "$@" >"$LOG" 2>&1 || {
      sed 's/^/    /' "$LOG" >&2
      return 1
    }
    return 0
  fi
  "$@" >"$LOG" 2>&1 &
  spin_pid=$!
  # shellcheck disable=SC2086
  set -- $FRAMES
  spin_ticks=0
  printf '\033[?25l'
  while kill -0 "$spin_pid" 2>/dev/null; do
    spin_frame=$1
    shift
    set -- "$@" "$spin_frame"
    spin_hint=''
    [ -z "$SPIN_HINT" ] || spin_hint=$($SPIN_HINT)
    printf '\r\033[K  %s%s%s %s %s %s%ss%s' "$CYAN" "$spin_frame" "$RESET" "$spin_label" "$spin_hint" \
      "$DIM" "$((spin_ticks / 10))" "$RESET"
    sleep 0.1 2>/dev/null || sleep 1
    spin_ticks=$((spin_ticks + 1))
  done
  spin_rc=0
  wait "$spin_pid" || spin_rc=$?
  spin_pid=''
  printf '\r\033[K\033[?25h'
  if [ "$spin_rc" -ne 0 ]; then
    printf '  %s%s %s%s\n' "$RED" "$G_FAIL" "$spin_label" "$RESET"
    tail -n 25 "$LOG" | sed 's/^/    /' >&2
    return "$spin_rc"
  fi
  [ "$SPIN_QUIET" = 1 ] || ok "$spin_label"
}

pull_hint() {
  pull_total=$(grep -c -E ': (Pulling fs layer|Already exists)' "$LOG" || true)
  pull_done=$(grep -c -E ': (Pull complete|Already exists)' "$LOG" || true)
  [ "${pull_total:-0}" -gt 0 ] || return 0
  printf '%s %s/%s layers' "$(bar "$pull_done" "$pull_total" 16)" "$pull_done" "$pull_total"
}

cleanup() {
  [ -z "${spin_pid:-}" ] || kill "$spin_pid" 2>/dev/null || true
  [ "${FANCY:-0}" != 1 ] || printf '\033[?25h'
  { stty echo </dev/tty; } 2>/dev/null || true
  [ -z "${TMP:-}" ] || rm -rf "$TMP"
}

# ── Prompts (always on /dev/tty: stdin is the script when piped from curl) ───

ask() { # ask QUESTION [DEFAULT] → REPLY
  printf '  %s?%s %s%s ' "$CYAN" "$RESET" "$1" "${2:+ ${DIM}[$2]$RESET}"
  IFS='' read -r REPLY </dev/tty || die "No terminal to ask on. Use --yes with flags; see --help."
  REPLY=$(printf '%s' "$REPLY" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [ -n "$REPLY" ] || REPLY=${2:-}
}

ask_secret() { # input stays hidden; validation against the API is the feedback
  printf '  %s?%s %s %s(hidden)%s ' "$CYAN" "$RESET" "$1" "$DIM" "$RESET"
  { stty -echo </dev/tty; } 2>/dev/null || true
  IFS='' read -r REPLY </dev/tty || REPLY=''
  { stty echo </dev/tty; } 2>/dev/null || true
  printf '\n'
  REPLY=$(printf '%s' "$REPLY" | tr -d '[:space:]')
}

confirm() { # confirm QUESTION Y|N. With --yes the default answers.
  if [ "$AUTO" = 1 ]; then
    [ "$2" = Y ]
    return
  fi
  if [ "$2" = Y ]; then ask "$1 ${DIM}[Y/n]$RESET"; else ask "$1 ${DIM}[y/N]$RESET"; fi
  case ${REPLY:-$2} in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# A problem with a supplied value: fatal when unattended, otherwise ask again.
retry() {
  [ "$AUTO" != 1 ] || die "$1"
  warn "$1"
}

# ── HTTP + the little JSON we need ───────────────────────────────────────────

# call URL [HEADERS] [POST-DATA] → HTTP_CODE, HTTP_BODY. HEADERS holds one per line. The URL and header go
# through a curl config on stdin so tokens never appear in the process list.
http() {
  {
    printf 'url = "%s"\n' "$1"
    [ -z "${2:-}" ] || printf '%s\n' "$2" | while IFS= read -r http_header; do
      printf 'header = "%s"\n' "$http_header"
    done
    [ "$#" -lt 3 ] || printf 'data = "%s"\n' "$3"
  } | curl -sS -K - --max-time 25 -w '\n%{http_code}' 2>/dev/null || printf '\n000'
}
parse_response() {
  HTTP_CODE=${1##*"$NL"}
  HTTP_BODY=${1%"$NL"*}
}
call() { parse_response "$(http "$@")"; }

# ponytail: regex scraping, not a JSON parser. Enough for the flat, known API
# replies read here (first occurrence of a scalar key). Reach for jq if this
# ever needs nested lookups.
json_str() { printf '%s' "${2-$HTTP_BODY}" | grep -o "\"$1\" *: *\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*: *"//; s/"$//'; }
json_num() { printf '%s' "${2-$HTTP_BODY}" | grep -o "\"$1\" *: *[0-9][0-9]*" | head -n 1 | sed 's/.*: *//'; }
json_true() { printf '%s' "${2-$HTTP_BODY}" | grep -q "\"$1\" *: *true"; }

# Tokens end up in a curl config and in .env, so refuse anything a real token
# never contains.
token_shaped() {
  case $1 in
    '' | *[!A-Za-z0-9._:-]*) return 1 ;;
  esac
}
matches() { printf '%s' "$1" | grep -Eq "$2"; }
strip_spaces() { printf '%s' "$1" | tr -d '[:space:]'; }

# ── Steps ────────────────────────────────────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --*=*)
        arg_name=${1%%=*} arg_value=${1#*=}
        shift
        set -- "$arg_name" "$arg_value" "$@"
        ;;
    esac
    case $1 in
      -y | --yes | --non-interactive) AUTO=1 ;;
      --no-credential) CREDENTIAL=0 ;;
      --bedrock) CLAUDE_CODE_USE_BEDROCK=1 ;;
      --no-auto-update) AUTO_UPDATE=0 ;;
      --caddy) CADDY=1 ;;
      --no-caddy) CADDY=0 ;;
      --self-test) SELF_TEST=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      --dir | --image | --public-url | --anthropic-api-key | --aws-region | --claude-oauth-token | \
        --telegram-token | --telegram-user-ids | --slack-bot-token | --slack-app-token | --slack-user-ids | \
        --discord-token | --discord-user-ids)
        [ $# -ge 2 ] || die "$1 needs a value."
        case $1 in
          --dir) DIR=$2 ;;
          --image) IMAGE=$2 ;;
          --public-url) PUBLIC_URL=$2 ;;
          --anthropic-api-key) ANTHROPIC_API_KEY=$2 ;;
          --aws-region) AWS_REGION=$2 ;;
          --claude-oauth-token) CLAUDE_CODE_OAUTH_TOKEN=$2 ;;
          --telegram-token) TELEGRAM_BOT_TOKEN=$2 ;;
          --telegram-user-ids) TELEGRAM_ALLOWED_USER_IDS=$2 ;;
          --slack-bot-token) SLACK_BOT_TOKEN=$2 ;;
          --slack-app-token) SLACK_APP_TOKEN=$2 ;;
          --slack-user-ids) SLACK_ALLOWED_USER_IDS=$2 ;;
          --discord-token) DISCORD_BOT_TOKEN=$2 ;;
          --discord-user-ids) DISCORD_ALLOWED_USER_IDS=$2 ;;
        esac
        shift
        ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
    shift
  done
}

preflight() {
  [ "$(uname -s)" = Linux ] ||
    die "This installer targets Linux servers. Elsewhere, follow \"Run with Docker manually\" in the README."
  case $(uname -m) in
    x86_64 | amd64 | aarch64 | arm64) ;;
    *) die "Wirebot images are built for x86_64 and arm64; this machine is $(uname -m)." ;;
  esac
  [ "$(id -u)" = 0 ] || die "Run as root, for example: curl -fsSL … | sudo sh"
  command -v curl >/dev/null 2>&1 || die "curl is required. Install it and run again."
  [ "$AUTO" = 1 ] || (: </dev/tty) 2>/dev/null ||
    die "No terminal to ask questions on. Use --yes with flags; see --help."
  credentials=0
  for credential in "$ANTHROPIC_API_KEY" "$CLAUDE_CODE_USE_BEDROCK" "$CLAUDE_CODE_OAUTH_TOKEN"; do
    [ -z "$credential" ] || credentials=$((credentials + 1))
  done
  [ "$credentials" -le 1 ] ||
    die "Give one Claude credential: an API key, --bedrock, or a subscription token."
  # A credential given now wins over a different one in an existing .env.
  if [ -n "$ANTHROPIC_API_KEY" ]; then CLAUDE_CHOICE=api; fi
  if [ -n "$CLAUDE_CODE_USE_BEDROCK" ]; then CLAUDE_CHOICE=bedrock; fi
  if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then CLAUDE_CHOICE=plan; fi
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    info "Docker is not installed."
    confirm "Install the latest Docker Engine with Docker's official script (get.docker.com)?" Y ||
      die "Docker is required. Install it and run again."
    curl -fsSL https://get.docker.com -o "$TMP/get-docker.sh" || die "Could not download get.docker.com."
    spin "Installing Docker" sh "$TMP/get-docker.sh" || die "Docker installation failed."
  fi
  if ! docker info >/dev/null 2>&1; then
    [ ! -d /run/systemd/system ] || spin "Starting Docker" systemctl enable --now docker || true
    docker info >/dev/null 2>&1 || die "Docker is installed but its daemon is not reachable. Start it and run again."
  fi
  if ! docker compose version >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 ||
      die "The Docker Compose plugin is missing. Install docker-compose-plugin and run again."
    spin "Installing the Docker Compose plugin" sh -c \
      'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && { apt-get install -y -qq docker-compose-plugin || apt-get install -y -qq docker-compose-v2; }' ||
      die "Could not install the Docker Compose plugin. Install docker-compose-plugin and run again."
  fi
  ok "Docker $(docker version -f '{{.Server.Version}}') with Compose $(docker compose version --short)"
}

load_env() {
  [ -s .env ] || return 0
  while IFS='=' read -r env_key env_value || [ -n "$env_key" ]; do
    case " $(echo $MANAGED) " in
      *" $env_key "*)
        eval "env_current=\$$env_key"
        [ -n "$env_current" ] || eval "$env_key=\$env_value"
        ;;
    esac
  done <.env
  info "Found an existing .env; keeping its settings unless you change them."
}

write_env() {
  (
    umask 077
    {
      [ ! -f .env ] || grep -v -E "^($(echo $MANAGED | tr ' ' '|'))=" .env || true
      for key in $MANAGED; do
        eval "env_value=\$$key"
        [ -z "$env_value" ] || printf '%s=%s\n' "$key" "$env_value"
      done
    } >.env.new
  )
  mv .env.new .env
}

write_compose() {
  {
    cat <<EOF
# Managed by the Wirebot installer: re-running it rewrites this file.
name: wirebot
services:
  wirebot:
    image: $IMAGE
    restart: unless-stopped
    env_file: .env
    volumes:
      - wirebot-data:/data
    ports:
      # Local only: for a reverse proxy or tunnel on this host.
      - "127.0.0.1:8787:8787"
EOF
    [ "$CADDY" != 1 ] || cat <<EOF
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
EOF
    printf 'volumes:\n  wirebot-data:\n'
    [ "$CADDY" != 1 ] || printf '  caddy-data:\n'
  } >docker-compose.yml
}

prepare_dir() {
  mkdir -p "$DIR"
  cd "$DIR"
  load_env
  if [ -f docker-compose.yml ]; then
    if grep -q '^# Managed by the Wirebot installer' docker-compose.yml; then
      # Remember a previous Caddy choice so a re-run does not ask again.
      [ -n "$CADDY" ] || ! grep -q '^  caddy:' docker-compose.yml || CADDY=1
    else
      cp -p docker-compose.yml docker-compose.yml.bak
      warn "Your own docker-compose.yml was saved as docker-compose.yml.bak."
    fi
  fi
  [ -f .env ] || (umask 077 && : >.env)
  # The first compose file has no Caddy: the domain is not known until step 5.
  caddy_choice=$CADDY
  CADDY=0
  write_compose
  CADDY=$caddy_choice
}

pull_image() {
  SPIN_HINT=pull_hint
  spin "Downloading the Wirebot image" docker pull "$IMAGE" ||
    docker image inspect "$IMAGE" >/dev/null 2>&1 || die "Could not pull $IMAGE."
  SPIN_HINT=''
}

# ── Claude credential ────────────────────────────────────────────────────────

# Credentials the installer does not manage but Claude Code also accepts.
other_credential() {
  [ -f .env ] && grep -Eq '^(CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|ANTHROPIC_AUTH_TOKEN)=.' .env
}

# How many people may talk to the bot: 0 one person, 1 maybe several (one ID on
# each of several messengers, which may all be the same person), 2 several.
sharing() {
  sharing_level=0 sharing_messengers=0
  for sharing_ids in "$TELEGRAM_ALLOWED_USER_IDS" "$SLACK_ALLOWED_USER_IDS" "$DISCORD_ALLOWED_USER_IDS"; do
    [ -n "$sharing_ids" ] || continue
    sharing_messengers=$((sharing_messengers + 1))
    case $sharing_ids in
      *'*'* | *,*) sharing_level=2 ;;
    esac
  done
  [ "$sharing_level" = 2 ] || [ "$sharing_messengers" -le 1 ] || sharing_level=1
  echo "$sharing_level"
}

check_anthropic() {
  token_shaped "$ANTHROPIC_API_KEY" || {
    ERR="That does not look like an API key. Copy it exactly from the Claude Console."
    return 1
  }
  call https://api.anthropic.com/v1/models "x-api-key: $ANTHROPIC_API_KEY${NL}anthropic-version: 2023-06-01"
  case $HTTP_CODE in
    200) ;;
    401 | 403)
      ERR="Anthropic rejected this API key. Copy it exactly from the Claude Console."
      return 1
      ;;
    *)
      ERR="The Anthropic API is unreachable (HTTP $HTTP_CODE). Try again."
      return 1
      ;;
  esac
}

setup_api_key() {
  if [ -z "$ANTHROPIC_API_KEY" ]; then
    say "Create a key in the Claude Console (usage is billed to its organization):"
    link "https://platform.claude.com/settings/keys"
    printf '\n'
  fi
  while :; do
    if [ -z "$ANTHROPIC_API_KEY" ]; then
      ask_secret "Claude API key"
      ANTHROPIC_API_KEY=$REPLY
    fi
    ! check_anthropic || break
    retry "$ERR"
    ANTHROPIC_API_KEY=''
  done
  CLAUDE_VIA='a Claude API key' CLAUDE_CODE_USE_BEDROCK='' CLAUDE_CODE_OAUTH_TOKEN=''
  ok "The API key works."
}

setup_bedrock() {
  CLAUDE_CODE_USE_BEDROCK=1
  while :; do
    if [ -z "$AWS_REGION" ]; then
      if [ "$AUTO" = 1 ]; then AWS_REGION=us-east-1; else
        ask "AWS region with Claude enabled in Bedrock" us-east-1
        AWS_REGION=$REPLY
      fi
    fi
    ! matches "$AWS_REGION" '^[a-z]{2}(-[a-z]+)+-[0-9]+$' || break
    retry "\"$AWS_REGION\" is not an AWS region like us-east-1."
    AWS_REGION=''
  done
  CLAUDE_VIA="Amazon Bedrock ($AWS_REGION)" ANTHROPIC_API_KEY='' CLAUDE_CODE_OAUTH_TOKEN=''
  ok "Claude runs through Amazon Bedrock in $AWS_REGION."
  if [ -f .env ] && grep -Eq '^(AWS_ACCESS_KEY_ID|AWS_PROFILE|AWS_BEARER_TOKEN_BEDROCK)=.' .env; then
    info "Using the AWS credentials already in $DIR/.env."
  else
    say "AWS credentials come from this server: an instance role (on EC2 with IMDSv2, set"
    say "the metadata hop limit to 2 so the container can reach it), or AWS_ACCESS_KEY_ID and"
    say "AWS_SECRET_ACCESS_KEY lines you add to $DIR/.env yourself; the installer keeps them."
  fi
}

subscription_warning() {
  warn "A personal Claude plan is for your own use only."
  say "Anthropic's terms allow a Free, Pro or Max subscription only for you, on a bot"
  say "nobody else talks to. Use an API key or Amazon Bedrock for a bot others can use."
}

setup_subscription() {
  case $(sharing) in
    2)
      ERR="Several people may use this bot, so a personal Claude plan is not allowed. Use an API key or Amazon Bedrock."
      CLAUDE_CODE_OAUTH_TOKEN=''
      [ "$AUTO" != 1 ] || die "$ERR"
      warn "$ERR"
      return 1
      ;;
    1)
      subscription_warning
      [ "$AUTO" != 1 ] || warn "Several messengers are connected; each must be you."
      if [ "$AUTO" != 1 ] && ! confirm "Every allowed account on every messenger is you?" N; then
        CLAUDE_CODE_OAUTH_TOKEN=''
        return 1
      fi
      ;;
    *)
      subscription_warning
      if [ "$AUTO" != 1 ] && ! confirm "Only you will use this bot?" N; then
        CLAUDE_CODE_OAUTH_TOKEN=''
        return 1
      fi
      ;;
  esac
  if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    printf '\n'
    say "On any computer with Claude Code installed, run ${BOLD}claude setup-token$RESET, sign in"
    say "in the browser, and copy the token it prints. It is valid for a year."
  fi
  while :; do
    if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
      ask_secret "Token from claude setup-token"
      CLAUDE_CODE_OAUTH_TOKEN=$REPLY
    fi
    ! token_shaped "$CLAUDE_CODE_OAUTH_TOKEN" || break
    retry "That does not look like a token. Copy it exactly as claude setup-token printed it."
    CLAUDE_CODE_OAUTH_TOKEN=''
  done
  CLAUDE_VIA='your Claude subscription' ANTHROPIC_API_KEY='' CLAUDE_CODE_USE_BEDROCK=''
  ok "Claude runs on your subscription. The token expires in a year; run this installer again then."
}

setup_claude() {
  # Whatever came from flags, the environment or an earlier .env gets verified;
  # one given to this run takes precedence over the .env.
  if [ -z "$CLAUDE_CHOICE" ]; then
    if [ -n "$ANTHROPIC_API_KEY" ]; then CLAUDE_CHOICE=api
    elif [ -n "$CLAUDE_CODE_USE_BEDROCK" ]; then CLAUDE_CHOICE=bedrock
    elif [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then CLAUDE_CHOICE=plan
    fi
  fi
  if [ "$CLAUDE_CHOICE" = api ]; then
    setup_api_key
    return
  elif [ "$CLAUDE_CHOICE" = bedrock ]; then
    setup_bedrock
    return
  elif [ "$CLAUDE_CHOICE" = plan ]; then
    ! setup_subscription || return 0
  elif other_credential; then
    CLAUDE_VIA='the credential in .env'
    ok "Using the Claude credential already in $DIR/.env."
    return
  fi
  if [ "$CREDENTIAL" = 0 ] || [ "$AUTO" = 1 ]; then
    info "Skipped. Until $DIR/.env has a credential, the bot answers with setup instructions."
    return
  fi
  while :; do
    say "How should Wirebot reach Claude?"
    say "  ${BOLD}1$RESET  Claude API key    ${DIM}recommended; required when several people use the bot$RESET"
    say "  ${BOLD}2$RESET  Amazon Bedrock    ${DIM}AWS credentials from this server$RESET"
    say "  ${BOLD}3$RESET  My Claude plan    ${DIM}personal Pro/Max subscription; only you may use the bot$RESET"
    say "  ${BOLD}4$RESET  Later             ${DIM}add a credential to .env yourself$RESET"
    ask "Pick one" 1
    printf '\n'
    case $REPLY in
      1) setup_api_key && return ;;
      2) setup_bedrock && return ;;
      3) ! setup_subscription || return 0 ;;
      4)
        info "Skipped. Until $DIR/.env has a credential, the bot answers with setup instructions."
        return
        ;;
      *) warn "Type 1, 2, 3 or 4." ;;
    esac
    printf '\n'
  done
}

# ── Messengers ───────────────────────────────────────────────────────────────

check_telegram() {
  token_shaped "$TELEGRAM_BOT_TOKEN" || {
    ERR="That does not look like a bot token. Copy it exactly from BotFather."
    return 1
  }
  call "$TG_API/bot$TELEGRAM_BOT_TOKEN/getMe"
  case $HTTP_CODE in
    200) ;;
    401 | 404) # 401 for revoked tokens, 404 for malformed ones
      ERR="Telegram rejected this token. Copy it exactly from BotFather."
      return 1
      ;;
    *)
      ERR="Telegram is unreachable (HTTP $HTTP_CODE). Try again."
      return 1
      ;;
  esac
  TG_BOT=$(json_str username)
  [ -n "$TG_BOT" ] || {
    ERR="Telegram sent an unexpected reply. Try again."
    return 1
  }
}

# Learns the owner's numeric ID without asking for it: the owner messages the
# bot and we read it from getUpdates. One update at a time keeps the
# scraping honest.
detect_telegram_owner() {
  call "$TG_API/bot$TELEGRAM_BOT_TOKEN/deleteWebhook?drop_pending_updates=true"
  printf '\n'
  say "Only you should be able to use the bot. Open this link and press ${BOLD}Start$RESET"
  say "(or send any message if you have chatted with it before):"
  link "https://t.me/$TG_BOT?start=wirebot"
  printf '\n'
  tg_offset=0 tg_polls=0
  while [ "$tg_polls" -lt 36 ]; do # 36 long polls of 5 s: three minutes
    tg_polls=$((tg_polls + 1))
    SPIN_QUIET=1
    spin "Waiting for a message from you" http \
      "$TG_API/bot$TELEGRAM_BOT_TOKEN/getUpdates?timeout=5&limit=1&offset=$tg_offset&allowed_updates=%5B%22message%22%5D" || true
    SPIN_QUIET=0
    parse_response "$(cat "$LOG")"
    [ "$HTTP_CODE" != 409 ] || die "Another program is already reading this bot's messages. Stop it (a running Wirebot?) and run again."
    tg_update=$(json_num update_id)
    [ -n "$tg_update" ] || continue
    tg_from=$(printf '%s' "$HTTP_BODY" | grep -o '"from":{[^}]*}' | head -n 1)
    tg_id=$(json_num id "$tg_from")
    if [ -n "$tg_id" ] && ! json_true is_bot "$tg_from" &&
      printf '%s' "$HTTP_BODY" | grep -q '"chat":{[^}]*"type":"private"'; then
      tg_name=$(json_str username "$tg_from")
      if [ -n "$tg_name" ]; then tg_name="@$tg_name"; else tg_name=$(json_str first_name "$tg_from"); fi
      if confirm "We found ${BOLD}${tg_name:-someone}$RESET (ID $tg_id). That's you?" Y; then
        # The update stays unconfirmed on purpose: Wirebot receives this very
        # message on its first start and greets you.
        TELEGRAM_ALLOWED_USER_IDS=$tg_id
        return
      fi
    fi
    tg_offset=$((tg_update + 1))
  done
  warn "No message arrived."
  while :; do
    ask "Your numeric Telegram user ID (@userinfobot tells you)"
    TELEGRAM_ALLOWED_USER_IDS=$(strip_spaces "$REPLY")
    ! matches "$TELEGRAM_ALLOWED_USER_IDS" '^[0-9]+(,[0-9]+)*$' || return 0
    warn "That should be a number like 123456789."
  done
}

setup_telegram() {
  [ "$AUTO" != 1 ] || [ -n "$TELEGRAM_ALLOWED_USER_IDS" ] ||
    die "Telegram needs --telegram-token and --telegram-user-ids together when using --yes."
  if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    say "1. Open ${BOLD}@BotFather$RESET in Telegram: ${CYAN}https://t.me/BotFather$RESET"
    say "2. Send ${BOLD}/newbot$RESET, pick a name and a username."
    say "3. Copy the token it gives you."
    printf '\n'
  fi
  while :; do
    if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
      ask_secret "Bot token from @BotFather"
      TELEGRAM_BOT_TOKEN=$REPLY
    fi
    ! check_telegram || break
    retry "$ERR"
    TELEGRAM_BOT_TOKEN=''
  done
  ok "Connected to @$TG_BOT"
  TELEGRAM_ALLOWED_USER_IDS=$(strip_spaces "$TELEGRAM_ALLOWED_USER_IDS")
  [ -n "$TELEGRAM_ALLOWED_USER_IDS" ] || detect_telegram_owner
  matches "$TELEGRAM_ALLOWED_USER_IDS" '^[0-9]+(,[0-9]+)*$' ||
    die "Telegram user IDs must be comma-separated numbers, got: $TELEGRAM_ALLOWED_USER_IDS"
  ok "Telegram answers only to $TELEGRAM_ALLOWED_USER_IDS"
}

check_slack_app() {
  case $SLACK_APP_TOKEN in
    xapp-*) token_shaped "$SLACK_APP_TOKEN" ;;
    *) false ;;
  esac || {
    ERR="App-level tokens start with xapp-"
    return 1
  }
  call https://slack.com/api/apps.connections.open "Authorization: Bearer $SLACK_APP_TOKEN" ""
  [ "$HTTP_CODE" = 200 ] || {
    ERR="Slack is unreachable (HTTP $HTTP_CODE). Try again."
    return 1
  }
  json_true ok || {
    ERR="Slack rejected this app token ($(json_str error)). It must be an app-level token (xapp-…) with connections:write."
    return 1
  }
}

check_slack_bot() {
  token_shaped "$SLACK_BOT_TOKEN" || {
    ERR="That does not look like a Slack token."
    return 1
  }
  call https://slack.com/api/auth.test "Authorization: Bearer $SLACK_BOT_TOKEN" ""
  [ "$HTTP_CODE" = 200 ] || {
    ERR="Slack is unreachable (HTTP $HTTP_CODE). Try again."
    return 1
  }
  # A user token passes auth.test too, but carries no bot_id.
  json_true ok && [ -n "$(json_str bot_id)" ] || {
    ERR="Slack rejected this bot token ($(json_str error)). Copy the Bot User OAuth Token (xoxb-…)."
    return 1
  }
  SLACK_TEAM=$(json_str team)
}

check_slack_member() { # one member ID must be a live human in this workspace
  call "https://slack.com/api/users.info?user=$1" "Authorization: Bearer $SLACK_BOT_TOKEN"
  json_true ok && ! json_true is_bot && ! json_true deleted
}

setup_slack() {
  [ "$AUTO" != 1 ] || { [ -n "$SLACK_BOT_TOKEN" ] && [ -n "$SLACK_APP_TOKEN" ] && [ -n "$SLACK_ALLOWED_USER_IDS" ]; } ||
    die "Slack needs --slack-bot-token, --slack-app-token and --slack-user-ids together when using --yes."
  if [ -z "$SLACK_APP_TOKEN" ] || [ -z "$SLACK_BOT_TOKEN" ]; then
    say "${BOLD}Create the Slack app.$RESET Everything is pre-filled: pick your workspace and click Create."
    link "$SLACK_MANIFEST_URL"
    printf '\n'
  fi
  if [ -z "$SLACK_APP_TOKEN" ]; then
    say "${BOLD}App token.$RESET On the Basic Information page, scroll to App-Level Tokens >"
    say "Generate Token and Scopes, add ${BOLD}connections:write$RESET, and Generate."
  fi
  while :; do
    if [ -z "$SLACK_APP_TOKEN" ]; then
      ask_secret "App-level token (xapp-…)"
      SLACK_APP_TOKEN=$REPLY
    fi
    ! check_slack_app || break
    retry "$ERR"
    SLACK_APP_TOKEN=''
  done
  ok "App token works"
  if [ -z "$SLACK_BOT_TOKEN" ]; then
    printf '\n'
    say "${BOLD}Bot token.$RESET In the sidebar open OAuth & Permissions > Install to Workspace > Allow,"
    say "then copy the ${BOLD}Bot User OAuth Token$RESET."
  fi
  while :; do
    if [ -z "$SLACK_BOT_TOKEN" ]; then
      ask_secret "Bot User OAuth Token (xoxb-…)"
      SLACK_BOT_TOKEN=$REPLY
    fi
    ! check_slack_bot || break
    retry "$ERR"
    SLACK_BOT_TOKEN=''
  done
  ok "Connected to the $SLACK_TEAM workspace"
  if [ -z "$SLACK_ALLOWED_USER_IDS" ]; then
    printf '\n'
    say "${BOLD}Who may use it?$RESET In Slack, open your profile > ⋯ > ${BOLD}Copy member ID$RESET (like U0123ABCDEF)."
    say "Separate several IDs with commas, or enter * for every member of the workspace."
  fi
  while :; do
    [ -n "$SLACK_ALLOWED_USER_IDS" ] || {
      ask "Your Slack member ID"
      SLACK_ALLOWED_USER_IDS=$REPLY
    }
    SLACK_ALLOWED_USER_IDS=$(strip_spaces "$SLACK_ALLOWED_USER_IDS")
    ERR=''
    if [ "$SLACK_ALLOWED_USER_IDS" != '*' ]; then
      matches "$SLACK_ALLOWED_USER_IDS" '^[UW][A-Z0-9]+(,[UW][A-Z0-9]+)*$' ||
        ERR="Member IDs look like U0123ABCDEF."
      for slack_member in $(printf '%s' "$SLACK_ALLOWED_USER_IDS" | tr ',' ' '); do
        [ -n "$ERR" ] || check_slack_member "$slack_member" || {
          slack_error=$(json_str error)
          ERR="$slack_member is not a person in the $SLACK_TEAM workspace${slack_error:+ ($slack_error)}."
        }
      done
    fi
    [ -n "$ERR" ] || break
    retry "$ERR"
    SLACK_ALLOWED_USER_IDS=''
  done
  ok "Slack answers only to $SLACK_ALLOWED_USER_IDS"
}

check_discord() {
  token_shaped "$DISCORD_BOT_TOKEN" || {
    ERR="That does not look like a Discord bot token."
    return 1
  }
  call https://discord.com/api/v10/applications/@me "Authorization: Bot $DISCORD_BOT_TOKEN"
  case $HTTP_CODE in
    200) ;;
    401)
      ERR="Discord rejected this token. Copy the Bot Token from the developer portal."
      return 1
      ;;
    *)
      ERR="Discord is unreachable (HTTP $HTTP_CODE). Try again."
      return 1
      ;;
  esac
  ! json_true bot_require_code_grant || {
    ERR="Disable \"Requires OAuth2 Code Grant\" on the Bot page, then try again."
    return 1
  }
  DISCORD_APP_ID=$(json_str id)
  DISCORD_APP=$(json_str name)
}

# GATEWAY_MESSAGE_CONTENT is bit 18 of the application flags, its "limited"
# variant (unverified bots) bit 19.
# ponytail: tests every "flags" number in the reply, since scraping cannot tell
# the application's from the nested bot user's. A false yes needs an
# HTTP-interactions-only bot, which a bot made for Wirebot is not.
message_content_bits() { [ $(($1 / 262144 % 4)) -ne 0 ]; }
discord_intent_enabled() {
  call https://discord.com/api/v10/applications/@me "Authorization: Bot $DISCORD_BOT_TOKEN"
  for discord_flags in $(printf '%s' "$HTTP_BODY" | grep -o '"flags" *: *[0-9][0-9]*' | sed 's/.*: *//'); do
    ! message_content_bits "$discord_flags" || return 0
  done
  return 1
}

setup_discord() {
  [ "$AUTO" != 1 ] || [ -n "$DISCORD_ALLOWED_USER_IDS" ] ||
    die "Discord needs --discord-token and --discord-user-ids together when using --yes."
  if [ -z "$DISCORD_BOT_TOKEN" ]; then
    say "${BOLD}Create the app.$RESET Name it anything: that is your bot's name."
    link "https://discord.com/developers/applications?new_application=true"
    say "Then on its ${BOLD}Bot$RESET page press ${BOLD}Reset Token$RESET and copy it."
    printf '\n'
  fi
  while :; do
    if [ -z "$DISCORD_BOT_TOKEN" ]; then
      ask_secret "Bot token"
      DISCORD_BOT_TOKEN=$REPLY
    fi
    ! check_discord || break
    retry "$ERR"
    DISCORD_BOT_TOKEN=''
  done
  ok "Connected to the $DISCORD_APP application"

  if [ -z "$DISCORD_ALLOWED_USER_IDS" ]; then
    printf '\n'
    say "${BOLD}Who may use it?$RESET In Discord: Settings > Advanced > enable Developer Mode,"
    say "then right-click your profile > ${BOLD}Copy User ID$RESET. Separate several IDs with commas."
  fi
  while :; do
    [ -n "$DISCORD_ALLOWED_USER_IDS" ] || {
      ask "Your Discord user ID"
      DISCORD_ALLOWED_USER_IDS=$REPLY
    }
    DISCORD_ALLOWED_USER_IDS=$(strip_spaces "$DISCORD_ALLOWED_USER_IDS")
    ! matches "$DISCORD_ALLOWED_USER_IDS" '^[0-9]{17,20}(,[0-9]{17,20})*$' || break
    retry "That doesn't look like a Discord user ID (17 to 20 digits)."
    DISCORD_ALLOWED_USER_IDS=''
  done
  ok "Discord answers only to $DISCORD_ALLOWED_USER_IDS"

  until discord_intent_enabled; do
    if [ "$AUTO" = 1 ]; then
      warn "Message Content Intent is off: enable it at https://discord.com/developers/applications/$DISCORD_APP_ID/bot"
      break
    fi
    printf '\n'
    say "${BOLD}One toggle left.$RESET On the Bot page, under Privileged Gateway Intents, switch on"
    say "${BOLD}Message Content Intent$RESET and Save. Discord drops the connection without it."
    link "https://discord.com/developers/applications/$DISCORD_APP_ID/bot"
    ask "Press Enter when it is on (or type skip)"
    [ "$REPLY" != skip ] || break
  done
  printf '\n'
  say "${BOLD}Invite your bot$RESET to a server (direct messages work without one):"
  link "https://discord.com/oauth2/authorize?client_id=$DISCORD_APP_ID&scope=bot+applications.commands&permissions=$DISCORD_PERMISSIONS"
}

setup_channels() {
  # Whatever came from flags, the environment or an earlier .env gets verified.
  channels=''
  if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    setup_telegram
    channels="$channels Telegram"
  fi
  if [ -n "$SLACK_BOT_TOKEN$SLACK_APP_TOKEN" ]; then
    setup_slack
    channels="$channels Slack"
  fi
  if [ -n "$DISCORD_BOT_TOKEN" ]; then
    setup_discord
    channels="$channels Discord"
  fi
  if [ "$AUTO" = 1 ]; then
    [ -n "$channels" ] || die "With --yes, configure at least one messenger (see --help)."
    return
  fi
  while :; do
    if [ -n "$channels" ]; then
      printf '\n'
      confirm "Connect another messenger?" N || return 0
    fi
    say "Where do you want to talk to the agent?"
    say "  ${BOLD}1$RESET  Telegram  ${DIM}richest: files, Mini App$RESET"
    say "  ${BOLD}2$RESET  Slack     ${DIM}DMs and channel threads$RESET"
    say "  ${BOLD}3$RESET  Discord   ${DIM}text-only DMs and threads$RESET"
    ask "Pick one" 1
    printf '\n'
    case $REPLY in
      1 | [Tt]*) setup_telegram && channels="$channels Telegram" ;;
      2 | [Ss]*) setup_slack && channels="$channels Slack" ;;
      3 | [Dd]*) setup_discord && channels="$channels Discord" ;;
      *) warn "Type 1, 2 or 3." ;;
    esac
  done
}

# ── Web address ──────────────────────────────────────────────────────────────

# host_of URL → lower-case host, no scheme, path or port
host_of() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's#^[a-z]+://##; s#[/?].*$##; s#:[0-9]+$##'; }
port_of() { printf '%s' "$1" | sed -E 's#^[A-Za-z]+://##; s#[/?].*$##' | sed -n -E 's#.*:([0-9]+)$#\1#p'; }

ports_busy() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq ':(80|443)$'
}

public_health() {
  curl -fsS --connect-timeout 4 --max-time 8 "$PUBLIC_URL/healthz" 2>/dev/null | grep -q '"ok" *: *true'
}

# Behind Cloudflare's proxy the origin must answer in whatever SSL mode the
# zone uses: plain HTTP on 80 for Flexible (a redirect to HTTPS would loop),
# any certificate on 443 for Full, a trusted one for Full (strict). Cloudflare
# hands /.well-known/acme-challenge/ to the origin, so Let's Encrypt works
# through the proxy; Caddy's own CA is the fallback when it does not.
# ponytail: the origin answers anyone, not only Cloudflare's address ranges.
# Firewall 80/443 to those ranges if direct hits on the IP ever matter.
write_caddyfile() {
  if [ "$PROXIED" = 1 ]; then
    printf 'http://%s, https://%s {\n\ttls {\n\t\tissuer acme\n\t\tissuer internal\n\t}\n\treverse_proxy wirebot:8787\n}\n' \
      "$DOMAIN" "$DOMAIN"
  else
    printf '%s {\n\treverse_proxy wirebot:8787\n}\n' "$DOMAIN"
  fi >Caddyfile
}

# Decides whether the domain can serve Wirebot, and whether Caddy should.
# ponytail: IPv4 only. An AAAA-only domain reads as "does not resolve".
check_domain() {
  my_ip=$(curl -4 -fsS --max-time 8 https://icanhazip.com 2>/dev/null ||
    curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  my_ip=$(strip_spaces "$my_ip")
  dns_ips=$({ getent ahostsv4 "$DOMAIN" || getent hosts "$DOMAIN" || true; } 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')
  direct=0 PROXIED=0
  case " $dns_ips" in
    *" ${my_ip:-none} "*) direct=1 ;;
    *) ! curl -sI --max-time 8 "http://$DOMAIN/" 2>/dev/null | grep -qi '^server: *cloudflare' || PROXIED=1 ;;
  esac

  if public_health; then
    ok "$PUBLIC_URL already serves Wirebot over HTTPS."
    [ -n "$CADDY" ] || CADDY=0
  else
    if [ "$PROXIED" = 1 ]; then
      info "$DOMAIN is proxied through Cloudflare."
    elif [ "$direct" = 1 ]; then
      ok "$DOMAIN points straight at this server ($my_ip)."
    elif [ -z "$dns_ips" ]; then
      warn "$DOMAIN does not resolve yet. Add an A record pointing at ${my_ip:-this server}."
      [ "$AUTO" = 1 ] || confirm "Use it anyway? (HTTPS starts working once DNS does)" N || return 1
    else
      warn "$DOMAIN resolves to ${dns_ips}but this server is ${my_ip:-unknown}."
      [ "$AUTO" = 1 ] || confirm "Use it anyway? (fine behind NAT or a load balancer)" N || return 1
    fi
    [ -n "$CADDY" ] || offer_caddy
  fi
  [ "$CADDY" != 1 ] || write_caddyfile
}

offer_caddy() {
  CADDY=0
  if [ -n "$(port_of "$PUBLIC_URL")" ]; then
    return 0
  elif ports_busy; then
    info "Ports 80/443 are already taken on this server, so Caddy is not an option."
    say "  Point your existing web server at ${BOLD}127.0.0.1:8787$RESET for $DOMAIN."
    ! command -v caddy >/dev/null 2>&1 ||
      say "  Caddyfile:  ${BOLD}$DOMAIN { reverse_proxy 127.0.0.1:8787 }$RESET"
  elif [ "$AUTO" = 1 ]; then
    info "Nothing serves $DOMAIN on this server. Pass --caddy to have the installer run Caddy."
  elif [ "$PROXIED" = 1 ]; then
    say "Cloudflare needs a web server on this machine to forward to, and nothing listens"
    say "on ports 80/443 yet. Caddy can run next to Wirebot as that server; it works with"
    say "every Cloudflare SSL mode and fetches its own Let's Encrypt certificate."
    ! confirm "Set up Caddy behind Cloudflare?" Y || CADDY=1
  else
    say "HTTPS is not working for $DOMAIN yet. Caddy can run next to Wirebot as a reverse"
    say "proxy that obtains and renews a Let's Encrypt certificate on its own."
    ! confirm "Set up Caddy for automatic HTTPS?" Y || CADDY=1
  fi
}

setup_public_url() {
  if [ -z "$PUBLIC_URL" ] && [ "$AUTO" != 1 ]; then
    say "The web app and the Telegram Mini App need a public HTTPS address. Without one,"
    say "Wirebot opens a free Cloudflare quick tunnel: it works, but its URL changes on"
    say "every restart. A (sub)domain pointed at this server makes it permanent."
    printf '\n'
  fi
  while :; do
    if [ -z "$PUBLIC_URL" ]; then
      [ "$AUTO" != 1 ] || break
      ask "Domain for Wirebot, like bot.example.com (Enter to skip)"
      PUBLIC_URL=$REPLY
      [ -n "$PUBLIC_URL" ] || break
    fi
    DOMAIN=$(host_of "$PUBLIC_URL")
    if matches "$DOMAIN" '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'; then
      url_port=$(port_of "$PUBLIC_URL")
      PUBLIC_URL=https://$DOMAIN${url_port:+:$url_port}
      ! check_domain || break
    else
      retry "\"$PUBLIC_URL\" is not a domain name."
    fi
    PUBLIC_URL='' DOMAIN=''
  done
  [ -n "$PUBLIC_URL" ] || {
    CADDY=0
    info "No domain: Wirebot will use a Cloudflare quick tunnel."
  }
}

# ── Launch ───────────────────────────────────────────────────────────────────

health() {
  docker compose exec -T wirebot sh -c 'curl -fsS --max-time 5 "http://127.0.0.1:${PORT:-8787}/healthz"' 2>/dev/null
}
wait_until() { # wait_until TRIES CMD…, two seconds apart
  wait_left=$1
  shift
  until "$@"; do
    wait_left=$((wait_left - 1))
    [ "$wait_left" -gt 0 ] || return 1
    sleep 2
  done
}
wirebot_up() { health | grep -q '"ok" *: *true'; }

launch() {
  write_env
  write_compose
  spin "Starting Wirebot" docker compose up -d --remove-orphans || die "docker compose up failed."
  spin "Waiting for Wirebot to come up" wait_until 60 wirebot_up || {
    docker compose logs --tail 30 wirebot 2>&1 | sed 's/^/    /' >&2
    die "Wirebot did not become healthy. Its last log lines are above."
  }
  [ -n "$CLAUDE_VIA" ] ||
    warn "No Claude credential yet: add one to $DIR/.env, then run: cd $DIR && docker compose up -d"
  [ -n "$PUBLIC_URL" ] || return 0
  if [ "$CADDY" = 1 ]; then
    # A re-run may have rewritten the Caddyfile under a Caddy that is already up.
    docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
    spin "Getting a certificate for $DOMAIN" wait_until 30 public_health ||
      warn "$PUBLIC_URL does not answer yet. Check DNS and that ports 80 and 443 are open in your firewall."
  elif public_health; then
    ok "$PUBLIC_URL serves Wirebot."
  else
    warn "$PUBLIC_URL does not reach Wirebot yet; the web app stays unavailable until it does."
  fi
}

# ── Auto-updater ─────────────────────────────────────────────────────────────

install_updater() {
  if [ "$AUTO_UPDATE" != 1 ]; then
    info "Skipped. Update by hand: cd $DIR && docker compose pull && docker compose up -d"
    return
  fi
  if [ ! -d /run/systemd/system ]; then
    warn "No systemd here, so no auto-updater. Update by hand: cd $DIR && docker compose pull && docker compose up -d"
    return
  fi
  cat >"$DIR/updater.sh" <<'EOF'
#!/bin/sh
# Wirebot auto-updater, installed by install.sh and run by wirebot-updater.service.
# Every hour it pulls the images named in docker-compose.yml. Once a newer one
# has arrived, it checks every minute whether the agent is working (a Claude
# Code process exists only while a turn or scheduled run is in flight) and
# recreates the containers after five idle checks in a row.
set -u
cd "$(dirname "$0")" || exit 1
export COMPOSE_PROGRESS=quiet

update_pending() {
  for cid in $(docker compose ps -q); do
    running=$(docker inspect -f '{{.Image}}' "$cid") || continue
    pulled=$(docker image inspect -f '{{.Id}}' "$(docker inspect -f '{{.Config.Image}}' "$cid")") || continue
    [ "$running" = "$pulled" ] || return 0
  done
  return 1
}

# An unreachable Wirebot counts as idle: an update may be what fixes it.
busy() {
  docker compose exec -T wirebot pgrep -x claude >/dev/null 2>&1
}

while :; do
  if docker compose pull -q && update_pending; then
    echo "A newer image is here; waiting for five idle checks in a row."
    idle=0 announced=0
    while [ "$idle" -lt 5 ]; do
      if busy; then
        # Said once per busy stretch: a long task must not fill the journal.
        [ "$announced" = 1 ] || echo "Wirebot is working; waiting for it to go quiet."
        idle=0 announced=1
      else
        idle=$((idle + 1)) announced=0
      fi
      [ "$idle" -ge 5 ] || sleep 60
    done
    echo "Updating."
    # Only services that are running: a stack stopped on purpose stays stopped.
    # shellcheck disable=SC2046
    docker compose up -d $(docker compose ps --services) && docker image prune -f >/dev/null
  fi
  sleep 3600
done
EOF
  chmod 755 "$DIR/updater.sh"
  cat >/etc/systemd/system/wirebot-updater.service <<EOF
[Unit]
Description=Wirebot auto-updater
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
ExecStart=/bin/sh $DIR/updater.sh
Restart=always
RestartSec=60

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload && systemctl enable wirebot-updater.service >/dev/null 2>&1 &&
    systemctl restart wirebot-updater.service || {
    warn "Could not start wirebot-updater.service; see: systemctl status wirebot-updater"
    return 0
  }
  ok "wirebot-updater.service checks hourly and updates only while Wirebot is idle."
}

summary() {
  printf '\n  %s%s Wirebot is running%s\n\n' "$GREEN$BOLD" "$G_OK" "$RESET"
  [ -z "$TG_BOT" ] || say "Telegram   open https://t.me/$TG_BOT and send /start"
  [ -z "$SLACK_TEAM" ] || say "Slack      DM the app in $SLACK_TEAM and send /wirebot start"
  [ -z "$DISCORD_APP" ] || say "Discord    DM $DISCORD_APP and send /wirebot start"
  [ -z "$PUBLIC_URL" ] || say "Web app    $PUBLIC_URL/app"
  say "Claude     ${CLAUDE_VIA:-not configured yet: add a credential to .env}"
  say "Files      $DIR (docker-compose.yml, .env)"
  say "Logs       cd $DIR && docker compose logs -f"
  [ ! -f /etc/systemd/system/wirebot-updater.service ] || say "Updates    automatic: journalctl -u wirebot-updater"
  printf '\n'
}

# Offline check of the pure helpers: sh install.sh --self-test
self_test() {
  check() { [ "$2" = "$3" ] || die "self-test: $1: expected '$3', got '$2'"; }
  HTTP_BODY='{"ok":true,"result":[{"update_id":42,"message":{"message_id":7,"from":{"id":111,"is_bot":false,"first_name":"Ann","username":"ann"},"chat":{"id":111,"type":"private"},"reply_to_message":{"from":{"id":999,"is_bot":true,"username":"other_bot"}},"text":"/start wirebot"}}]}'
  tg_from=$(printf '%s' "$HTTP_BODY" | grep -o '"from":{[^}]*}' | head -n 1)
  check update_id "$(json_num update_id)" 42
  check from.id "$(json_num id "$tg_from")" 111
  check from.username "$(json_str username "$tg_from")" ann
  json_true ok || die "self-test: ok"
  ! json_true is_bot "$tg_from" || die "self-test: is_bot"
  check spaced "$(json_str error '{"ok": false, "error": "invalid_auth"}')" invalid_auth
  check discord-id "$(json_str id '{"id": "1234567890123456789", "name": "x", "bot": {"id": "5"}}')" 1234567890123456789
  parse_response "body line${NL}second${NL}200"
  check http-code "$HTTP_CODE" 200
  check http-body "$HTTP_BODY" "body line${NL}second"
  check host "$(host_of 'HTTPS://Bot.Example.com:8443/app?x=1')" bot.example.com
  check port "$(port_of 'https://bot.example.com:8443/app')" 8443
  check no-port "$(port_of 'bot.example.com')" ''
  message_content_bits 262144 || die "self-test: intent bit 18"
  message_content_bits 8953856 || die "self-test: intent bit 19"
  ! message_content_bits 8388608 || die "self-test: intent off"
  ! message_content_bits 0 || die "self-test: intent zero"
  token_shaped '123:AAH-x_y.z' || die "self-test: token_shaped accepts"
  ! token_shaped 'a"b' || die "self-test: token_shaped rejects quotes"
  ! token_shaped '' || die "self-test: token_shaped rejects empty"
  matches 'U0123ABC,W9ZZ' '^[UW][A-Z0-9]+(,[UW][A-Z0-9]+)*$' || die "self-test: slack ids"
  TELEGRAM_ALLOWED_USER_IDS=111 SLACK_ALLOWED_USER_IDS='' DISCORD_ALLOWED_USER_IDS=''
  check sharing-one "$(sharing)" 0
  SLACK_ALLOWED_USER_IDS=U0123ABC
  check sharing-maybe "$(sharing)" 1
  SLACK_ALLOWED_USER_IDS='*'
  check sharing-workspace "$(sharing)" 2
  TELEGRAM_ALLOWED_USER_IDS=111,222 SLACK_ALLOWED_USER_IDS=''
  check sharing-several "$(sharing)" 2
  RESET='' DIM='' GREEN='' G_FULL='#' G_EMPTY='-'
  check bar "$(bar 1 4 8)" '##------'
  echo "self-test passed"
}

main() {
  parse_args "$@"
  if [ "$SELF_TEST" = 1 ]; then
    self_test
    exit 0
  fi
  # Piped from curl, stdin is this script. Nothing below may read it.
  exec </dev/null
  export COMPOSE_PROGRESS=quiet
  setup_ui
  preflight
  TMP=$(mktemp -d)
  LOG=$TMP/log
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  banner
  step "Docker"
  ensure_docker
  step "Wirebot image"
  prepare_dir
  pull_image
  step "Connect a messenger"
  setup_channels
  step "Connect Claude"
  setup_claude
  step "Web address"
  setup_public_url
  step "Launch"
  launch
  step "Automatic updates"
  install_updater
  summary
}

# Last line on purpose: a truncated download must never run half a script.
main "$@"
