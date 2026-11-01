#!/usr/bin/env bash
set -euo pipefail

UUID="stereo-splitter@evn.local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_BASE_DIR="${HOME}/.local/share/gnome-shell/extensions"
TARGET_DIR="${EXT_BASE_DIR}/${UUID}"
CONFIG_DIR="${HOME}/.config/${UUID}"

echo "Установка GNOME Shell Extension: ${UUID}"

mkdir -p "${TARGET_DIR}"
mkdir -p "${CONFIG_DIR}"

FILES=(
    "metadata.json"
    "extension.js"
    "stylesheet.css"
    "stateStore.js"
    "streamMatcher.js"
    "appIconResolver.js"
    "audioManager.js"
    "README.md"
    "install.sh"
    "uninstall.sh"
    "diagnose.sh"
)

for f in "${FILES[@]}"; do
    if [[ -f "${SRC_DIR}/${f}" ]]; then
        if [[ "${SRC_DIR}/${f}" != "${TARGET_DIR}/${f}" ]]; then
            cp -f "${SRC_DIR}/${f}" "${TARGET_DIR}/${f}"
        fi
    fi
done

chmod +x "${TARGET_DIR}/install.sh" "${TARGET_DIR}/uninstall.sh" "${TARGET_DIR}/diagnose.sh" 2>/dev/null || true

python3 - "${UUID}" <<'PYEOF'
import sys
from gi.repository import Gio

uuid = sys.argv[1]
settings = Gio.Settings.new("org.gnome.shell")

enabled = list(settings.get_strv("enabled-extensions"))
if uuid not in enabled:
    enabled.append(uuid)
    settings.set_strv("enabled-extensions", enabled)

disabled = list(settings.get_strv("disabled-extensions"))
if uuid in disabled:
    disabled = [x for x in disabled if x != uuid]
    settings.set_strv("disabled-extensions", disabled)

settings.set_boolean("disable-user-extensions", False)
Gio.Settings.sync()
print(f"[OK] {uuid} зарегистрирован")
PYEOF

rm -f "/run/user/$(id -u)/gnome-shell-disable-extensions" 2>/dev/null || true
SHELL_PID="$(pidof gnome-shell || true)"
if [[ -n "${SHELL_PID}" ]]; then
    kill -TERM ${SHELL_PID} 2>/dev/null || true
    sleep 3
fi

gnome-extensions enable "${UUID}" 2>/dev/null || true
sleep 1

gnome-extensions info "${UUID}" || true
echo "[ГОТОВО] Stereo Splitter установлен в: ${TARGET_DIR}"
