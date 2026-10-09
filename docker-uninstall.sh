#!/usr/bin/env bash
#
# Removes the Matterbridge container created by docker-install.sh and, if you choose, its data.
# Docker itself is never removed if it was installed before docker-install.sh ran. If the installer
# installed Docker, you are asked whether to remove it as well (default: keep).
#
#   curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ewelink/main/docker-uninstall.sh | sudo bash
#   wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ewelink/main/docker-uninstall.sh | sudo bash
#
# Settings (environment variables, all optional):
#   MATTERBRIDGE_DIR    data folder (default: /opt/matterbridge)
#   REMOVE_DATA         1 = delete the data, 0 = keep it (default: ask)
#   REMOVE_DOCKER       1 = remove Docker if this installer installed it, 0 = keep it (default: ask)

set -euo pipefail

NAME="matterbridge"
DATA_DIR="${MATTERBRIDGE_DIR:-/opt/matterbridge}"
MARKER="$DATA_DIR/.docker-installed-by-script"
REMOVE_DATA="${REMOVE_DATA:-ask}"
REMOVE_DOCKER="${REMOVE_DOCKER:-ask}"

if [ -t 1 ]; then BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'; else BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
step() { echo "${BOLD}==> $*${RESET}"; }
ok() { echo "${GREEN}    $*${RESET}"; }
warn() { echo "${YELLOW}    $*${RESET}"; }
fail() { echo "${RED}Error: $*${RESET}" >&2; exit 1; }

# Run a slow command with a spinner and elapsed time, so it's clear the installer is working.
# The command's output goes to a log that is shown if it fails.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
progress() {
  local message="$1" pid start frames='|/-\' i=0 status=0
  shift
  : >"$LOG"
  "$@" >>"$LOG" 2>&1 &
  pid=$!
  start=$SECONDS
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r    %s %s (%ds) ' "${frames:i++%4:1}" "$message" "$((SECONDS - start))"
      sleep 0.25
    done
    printf '\r\033[K'
  else
    echo "    ${message}..."
    while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  fi
  wait "$pid" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "${RED}    ${message} failed. Last output:${RESET}" >&2
    tail -n 15 "$LOG" | sed 's/^/      /' >&2
  fi
  return "$status"
}

[ "$(id -u)" -eq 0 ] || fail "please run as root, e.g. with: curl -fsSL <url> | sudo bash"
command -v docker >/dev/null 2>&1 || fail "Docker is not installed, so there is no Matterbridge container to remove."

# Questions read from the keyboard, which is not stdin when the script is piped from curl
ask() {
  local answer=""
  if [ -r /dev/tty ]; then
    printf "%s" "$1" >/dev/tty
    read -r answer </dev/tty || answer=""
  fi
  [ "$answer" = yes ]
}

echo "${BOLD}Matterbridge + eWeLink Docker uninstaller${RESET}"

step "Removing the Matterbridge container"
if docker container inspect "$NAME" >/dev/null 2>&1; then
  if [ "$(docker container inspect -f '{{index .Config.Labels "io.github.tammeryousef1006.matterbridge-ewelink"}}' "$NAME")" != "installer" ]; then
    fail "the container ${NAME} was not created by the eWeLink installer, so it is left alone."
  fi
  IMAGE="$(docker container inspect -f '{{.Config.Image}}' "$NAME")"
  progress "Stopping Matterbridge" docker stop -t 60 "$NAME" || true
  docker rm "$NAME" >/dev/null
  ok "Removed container ${NAME}"
  # Remove the image unless another container still uses it
  if [ -z "$(docker ps -a -q --filter "ancestor=$IMAGE")" ]; then
    progress "Removing the image" docker rmi "$IMAGE" && ok "Removed image ${IMAGE}" || true
  fi
else
  ok "No container named ${NAME} found"
fi

if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --remove-port=8283/tcp --remove-port=8284/tcp --remove-port=5540/udp --remove-port=5540/tcp --remove-service=mdns >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "Closed firewall ports 8283, 8284, 5540 and mDNS"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for rule in 8283/tcp 8284/tcp 5540/udp 5540/tcp 5353/udp; do ufw delete allow "$rule" >/dev/null 2>&1 || true; done
  ok "Closed firewall ports 8283, 8284, 5540 and mDNS"
fi

DOCKER_OURS=false
[ -f "$MARKER" ] && DOCKER_OURS=true

if [ -d "$DATA_DIR" ]; then
  if [ "$REMOVE_DATA" = ask ]; then
    ask "Also delete all Matterbridge data in ${DATA_DIR} (controller pairing, settings, eWeLink login)? Type yes to delete, or press Enter to keep: " && REMOVE_DATA=1 || REMOVE_DATA=0
  fi
  if [ "$REMOVE_DATA" = 1 ]; then
    rm -rf "$DATA_DIR"
    ok "Deleted ${DATA_DIR}"
  else
    ok "Kept the data in ${DATA_DIR}; running the installer again picks it up"
  fi
fi

step "Docker"
if [ "$DOCKER_OURS" = true ]; then
  if [ "$REMOVE_DOCKER" = ask ]; then
    ask "Docker was installed by the eWeLink installer. Remove Docker too? Other containers would stop working. Type yes to remove, or press Enter to keep: " && REMOVE_DOCKER=1 || REMOVE_DOCKER=0
  fi
  if [ "$REMOVE_DOCKER" = 1 ]; then
    if command -v apt-get >/dev/null 2>&1; then progress "Removing Docker" env DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras || true
    elif command -v dnf >/dev/null 2>&1; then progress "Removing Docker" dnf remove -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras || true
    elif command -v apk >/dev/null 2>&1; then rc-service docker stop >/dev/null 2>&1 || true; progress "Removing Docker" apk del docker || true
    elif command -v pacman >/dev/null 2>&1; then systemctl disable --now docker >/dev/null 2>&1 || true; progress "Removing Docker" pacman -Rns --noconfirm docker || true
    fi
    rm -f "$MARKER"
    ok "Removed Docker"
  else
    ok "Kept Docker"
  fi
else
  ok "Docker was already installed before Matterbridge, so it is kept"
fi

echo
echo "${GREEN}${BOLD}Done.${RESET} Matterbridge and the eWeLink plugin are removed."
echo "Remove the bridge from your controller app (Apple Home, Google Home, SmartThings...) as well."
