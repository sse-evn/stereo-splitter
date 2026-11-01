# Stereo Splitter (`stereo-splitter@evn.local`)

**Author:** `evn`

GNOME Shell 46 Extension для Ubuntu 24.04 LTS, добавляющее независимую маршрутизацию аудиопотоков приложений (`LEFT` / `RIGHT` / `STEREO`) и одновременный вывод звука на несколько наушников прямо в системное меню **Quick Settings**.

## Возможности

* **Интеграция в Quick Settings (GNOME 46)**:
  * Переключатель **Stereo Splitter** в системном меню быстрых настроек.
  * Мультивыбор устройств вывода (`✓` на нескольких наушниках одновременно через `module-combine-sink`).
  * Управление каждым приложением и отдельным потоком (`LEFT`, `RIGHT`, `STEREO`).
  * Полная поддержка тёмной и светлой темы GNOME 46.
* **Удержание каналов без сбросов**:
  * Асинхронный мониторинг событий PipeWire (`pactl subscribe`).
  * Распознавание потоков по `sink-input`, `media.name`, сигнатурам сайтов (`YouTube`, `Kodik`, сериалы/фильмы) и имени приложения.
  * Изоляция системных звуков уведомлений (`System Sounds`).

## Структура проекта

* `metadata.json` : метаданные расширения (`author: evn`)
* `extension.js` : интерфейс Quick Settings и жизненный цикл расширения
* `stylesheet.css` : стили для тёмной и светлой темы GNOME 46
* `audioManager.js` : асинхронное управление PipeWire, `module-remap-sink` и `module-combine-sink`
* `streamMatcher.js` : сопоставление потоков и удержание каналов при смене треков/серий
* `stateStore.js` : сохранение пользовательских правил в `~/.config/stereo-splitter@evn.local/state.json`
* `appIconResolver.js` : получение иконок приложений через `Shell.AppSystem` и `Shell.WindowTracker`
* `install.sh` : установка и активация расширения
* `uninstall.sh` : удаление расширения и возврат потоков в `STEREO`
* `diagnose.sh` : диагностика аудиовыходов и активных потоков

## Установка

```bash
chmod +x install.sh uninstall.sh diagnose.sh
./install.sh
```

## Диагностика

```bash
./diagnose.sh
```

## Удаление

```bash
./uninstall.sh
```
