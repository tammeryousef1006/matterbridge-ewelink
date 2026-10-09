#!/usr/bin/env bash
#
# Removes what install.sh set up: the Matterbridge service, Matterbridge and its plugins, the firewall
# rules, and (if you choose) the "matterbridge" user with all its data, including the Matter pairing and
# the eWeLink login. Node.js is kept unless REMOVE_NODE=1, because other programs may use it.
#
#   curl -fsSL https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ewelink/main/uninstall.sh | sudo bash
#   wget -qO- https://raw.githubusercontent.com/tammeryousef1006/matterbridge-ewelink/main/uninstall.sh | sudo bash
#
# Settings (environment variables, all optional):
#   MATTERBRIDGE_USER   user created by the installer (default: matterbridge)
#   REMOVE_DATA         1 = delete the user and all data, 0 = keep them (default: ask)
#   REMOVE_NODE         1 = also remove Node.js and the NodeSource repository (default: 0)

set -euo pipefail

MB_USER="${MATTERBRIDGE_USER:-matterbridge}"
REMOVE_DATA="${REMOVE_DATA:-ask}"
REMOVE_NODE="${REMOVE_NODE:-0}"

if [ -t 1 ]; then BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'; else BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; fi
step() { echo "${BOLD}==> $*${RESET}"; }
ok() { echo "${GREEN}    $*${RESET}"; }
warn() { echo "${YELLOW}    $*${RESET}"; }
fail() { echo "${RED}Error: $*${RESET}" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "please run as root, e.g. with: curl -fsSL <url> | sudo bash"

MB_HOME="$(getent passwd "$MB_USER" 2>/dev/null | cut -d: -f6 || true)"
# Also found after an earlier run that removed Matterbridge but kept the data
if [ -z "$MB_HOME" ] || { [ ! -d "$MB_HOME/.npm-global" ] && [ ! -d "$MB_HOME/.matterbridge" ]; }; then
  echo "No Matterbridge installation from the eWeLink installer was found (user ${MB_USER})."
  if command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 matterbridge-ewelink >/dev/null 2>&1; then
    npm uninstall -g matterbridge-ewelink >/dev/null 2>&1 && echo "Removed the matterbridge-ewelink plugin from the global npm folder."
  fi
  echo "If Matterbridge was installed another way, remove the eWeLink plugin in the Matterbridge frontend (Plugins)."
  exit 0
fi

# Asking needs the keyboard, which is not stdin when the script is piped from curl
if [ "$REMOVE_DATA" = ask ]; then
  if [ -r /dev/tty ]; then
    echo "Also delete all Matterbridge data (controller pairing, settings, eWeLink login) and the ${MB_USER} user?"
    printf "Type yes to delete, or press Enter to keep the data: "
    read -r answer </dev/tty || answer=""
    [ "$answer" = yes ] && REMOVE_DATA=1 || REMOVE_DATA=0
  else
    REMOVE_DATA=0
  fi
fi

echo "${BOLD}Matterbridge + eWeLink uninstaller${RESET}"

step "Stopping the Matterbridge service"
if [ -f /etc/systemd/system/matterbridge.service ]; then
  systemctl disable --now matterbridge >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/matterbridge.service
  systemctl daemon-reload 2>/dev/null || true
  ok "Removed the systemd service"
elif [ -f /etc/init.d/matterbridge ]; then
  rc-service matterbridge stop >/dev/null 2>&1 || true
  rc-update del matterbridge default >/dev/null 2>&1 || true
  rm -f /etc/init.d/matterbridge
  ok "Removed the OpenRC service"
else
  ok "No service found"
fi
pkill -u "$MB_USER" -f matterbridge 2>/dev/null || true

step "Removing Matterbridge and its plugins"
rm -rf "$MB_HOME/.npm-global" "$MB_HOME/.npm"
ok "Removed ${MB_HOME}/.npm-global"

if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  step "Closing firewall ports (firewalld)"
  firewall-cmd --permanent --remove-port=8283/tcp --remove-port=8284/tcp --remove-port=5540/udp --remove-port=5540/tcp --remove-service=mdns >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "Closed 8283, 8284, 5540 and mDNS"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  step "Closing firewall ports (ufw)"
  for rule in 8283/tcp 8284/tcp 5540/udp 5540/tcp 5353/udp; do ufw delete allow "$rule" >/dev/null 2>&1 || true; done
  ok "Closed 8283, 8284, 5540 and mDNS"
fi

if [ "$REMOVE_DATA" = 1 ]; then
  step "Deleting the ${MB_USER} user and all its data"
  if command -v userdel >/dev/null 2>&1; then userdel "$MB_USER" >/dev/null 2>&1 || true; else deluser "$MB_USER" >/dev/null 2>&1 || true; fi
  rm -rf "$MB_HOME"
  ok "Deleted ${MB_HOME}"
else
  step "Keeping data"
  ok "Pairing, settings and the eWeLink login stay in ${MB_HOME}; running the installer again picks them up."
  ok "To delete them later: run this uninstaller again with REMOVE_DATA=1"
fi

if [ "$REMOVE_NODE" = 1 ]; then
  step "Removing Node.js"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq nodejs >/dev/null 2>&1 || true
    rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources /etc/apt/keyrings/nodesource.gpg /usr/share/keyrings/nodesource.gpg
  elif command -v dnf >/dev/null 2>&1; then
    dnf remove -y -q nodejs >/dev/null 2>&1 || true
    rm -f /etc/yum.repos.d/nodesource*.repo
  elif command -v yum >/dev/null 2>&1; then
    yum remove -y -q nodejs >/dev/null 2>&1 || true
    rm -f /etc/yum.repos.d/nodesource*.repo
  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive --quiet remove 'nodejs*' 'npm*' >/dev/null 2>&1 || true
  elif command -v pacman >/dev/null 2>&1; then pacman -Rns --noconfirm nodejs npm >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then apk del --quiet nodejs npm >/dev/null 2>&1 || true
  fi
  ok "Removed Node.js"
fi

echo
echo "${GREEN}${BOLD}Done.${RESET} Matterbridge and the eWeLink plugin are removed."
echo "Remove the bridge from your controller app (Apple Home, Google Home, SmartThings...) as well."
