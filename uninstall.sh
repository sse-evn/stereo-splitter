#!/usr/bin/env bash
set -euo pipefail

UUID="stereo-splitter@evn.local"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
PHYS_SINK="alsa_output.usb-Apple__Inc._EarPods_H0X0NXMGF9-00.analog-stereo"

echo "Удаление GNOME Shell Extension: ${UUID}"

gnome-extensions disable "${UUID}" 2>/dev/null || true
sleep 1

if LC_ALL=C.UTF-8 pactl list short sinks | awk '{print $2}' | grep -qx "${PHYS_SINK}"; then
    while read -r idx; do
        [[ -n "${idx}" ]] && pactl move-sink-input "${idx}" "${PHYS_SINK}" 2>/dev/null || true
    done < <(
        LC_ALL=C.UTF-8 pactl list sink-inputs | awk '
            /^Sink Input #/ { gsub("#", "", $3); id=$3; virt=0 }
            /node\.virtual = "true"/ { virt=1 }
            /node\.name = "output\./ { virt=1 }
            /device\.description = "(LEFT_EAR|RIGHT_EAR)"/ { virt=1 }
            /^$/ { if (id != "" && virt == 0) print id; id=""; virt=0 }
            END { if (id != "" && virt == 0) print id }
        '
    )
fi

python3 - "${UUID}" <<'PYEOF'
import sys
from gi.repository import Gio

uuid = sys.argv[1]
settings = Gio.Settings.new("org.gnome.shell")

enabled = [x for x in settings.get_strv("enabled-extensions") if x != uuid]
settings.set_strv("enabled-extensions", enabled)

disabled = [x for x in settings.get_strv("disabled-extensions") if x != uuid]
settings.set_strv("disabled-extensions", disabled)

Gio.Settings.sync()
print(f"[OK] {uuid} удалён из списков GNOME Shell")
PYEOF

if [[ -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "[OK] Директория ${TARGET_DIR} удалена."
fi

echo "[ГОТОВО] Stereo Splitter удалён."
