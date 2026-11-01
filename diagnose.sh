#!/usr/bin/env bash
set -euo pipefail

UUID="stereo-splitter@evn.local"
STATE_FILE="${HOME}/.config/${UUID}/state.json"
PHYS_SINK="alsa_output.usb-Apple__Inc._EarPods_H0X0NXMGF9-00.analog-stereo"

echo "Stereo Splitter: Диагностика и проверка состояния"

echo ""
echo "[1] Версии окружения:"
gnome-shell --version || true
LC_ALL=C.UTF-8 pactl info | grep -E "Server Name|Server Version|Default Sink" || true

echo ""
echo "[2] Статус расширения в GNOME Shell:"
if gnome-extensions info "${UUID}" >/dev/null 2>&1; then
    gnome-extensions info "${UUID}"
else
    echo "Расширение ${UUID} ещё не зарегистрировано."
fi

echo ""
echo "[3] Аудиовыходы (Sinks):"
LC_ALL=C.UTF-8 pactl list short sinks

if LC_ALL=C.UTF-8 pactl list short sinks | awk '{print $2}' | grep -qx "${PHYS_SINK}"; then
    echo "  [OK] Физический выход Apple EarPods подключён (${PHYS_SINK})"
else
    echo "  [WARN] Физический выход Apple EarPods отключён"
fi

if LC_ALL=C.UTF-8 pactl list sinks | grep -Eq 'Name: (LEFT_EAR|LEFT_AUDIO)|device\.description = "LEFT_EAR"'; then
    echo "  [OK] Виртуальный левый канал (LEFT_EAR) активен"
else
    echo "  [WARN] Виртуальный левый канал (LEFT_EAR) не найден"
fi

if LC_ALL=C.UTF-8 pactl list sinks | grep -Eq 'Name: (RIGHT_EAR|RIGHT_AUDIO)|device\.description = "RIGHT_EAR"'; then
    echo "  [OK] Виртуальный правый канал (RIGHT_EAR) активен"
else
    echo "  [WARN] Виртуальный правый канал (RIGHT_EAR) не найден"
fi

echo ""
echo "[4] Загруженные модули разделения:"
LC_ALL=C.UTF-8 pactl list short modules | grep -E "module-remap-sink|module-combine-sink" || echo "  (нет активных модулей)"

echo ""
echo "[5] Активные аудиопотоки (sink-inputs):"
LC_ALL=C.UTF-8 pactl list sink-inputs | awk '
    /^Sink Input #/ { id=$3 }
    /^\tSink:/ { sink=$2 }
    /^\tCorked:/ { corked=$2 }
    /application\.name = / { app=$0; sub(/.*application\.name = "/, "", app); sub(/".*/, "", app) }
    /media\.name = / { media=$0; sub(/.*media\.name = "/, "", media); sub(/".*/, "", media) }
    /node\.virtual = "true"/ { virt=" [virtual]" }
    /^$/ {
        if (id != "") {
            printf "  Sink-Input %-6s | Sink: %-5s | Corked: %-4s | App: %-18s | Media: %s%s\n", id, sink, corked, (app?app:"N/A"), (media?media:"N/A"), virt
        }
        id=""; sink=""; corked=""; app=""; media=""; virt=""
    }
    END {
        if (id != "") {
            printf "  Sink-Input %-6s | Sink: %-5s | Corked: %-4s | App: %-18s | Media: %s%s\n", id, sink, corked, (app?app:"N/A"), (media?media:"N/A"), virt
        }
    }
'

echo ""
echo "[6] Конфигурация (${STATE_FILE}):"
if [[ -f "${STATE_FILE}" ]]; then
    cat "${STATE_FILE}"
else
    echo "  (файл конфигурации ещё не создан)"
fi

echo ""
echo "[7] Журнал GNOME Shell:"
journalctl --user -b -u org.gnome.Shell@x11.service --no-pager -n 200 2>/dev/null | grep -i "StereoSplitter" | tail -n 15 || echo "  Ошибок не обнаружено."
