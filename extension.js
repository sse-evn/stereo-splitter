import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {StateStore, MODES} from './stateStore.js';
import {AudioManager} from './audioManager.js';
import {resolveAppIconAndName} from './appIconResolver.js';

const StereoSplitterMenuToggle = GObject.registerClass(
class StereoSplitterMenuToggle extends QuickSettings.QuickMenuToggle {
    _init(audioManager) {
        super._init({
            title: 'Stereo Splitter',
            subtitle: 'Инициализация…',
            iconName: 'audio-headphones-symbolic',
            toggleMode: true,
            checked: audioManager.enabled,
        });

        this._audioManager = audioManager;
        this._updatingChecked = false;
        this._lastStructureKey = null;
        this._lastDevicesKey = null;

        this._streamRowRefs = new Map();
        this._appGroupRefs = new Map();
        this._deviceItemRefs = new Map();

        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });
        this._colorSchemeSignalId = this._interfaceSettings.connect(
            'changed::color-scheme',
            () => this._syncThemeClass()
        );
        this._gtkThemeSignalId = this._interfaceSettings.connect(
            'changed::gtk-theme',
            () => this._syncThemeClass()
        );

        this.connect('clicked', () => {
            if (this._updatingChecked)
                return;
            this._audioManager.setEnabled(this.checked);
        });

        this.menu.box.add_style_class_name('stereo-splitter-menu');
        this.menu.box.connect('style-changed', () => {
            this._syncThemeClass();
        });

        this.menu.setHeader(
            'audio-headphones-symbolic',
            'Stereo Splitter',
            'Разделение каналов L / R / STEREO'
        );

        const suffixBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'stereo-splitter-header-actions',
        });

        const allStereoBtn = new St.Button({
            label: 'Сброс',
            style_class: 'stereo-splitter-header-btn',
            can_focus: true,
        });
        allStereoBtn.connect('clicked', () => {
            this._audioManager.resetAllToStereo();
        });

        const refreshBtn = new St.Button({
            style_class: 'stereo-splitter-header-btn stereo-splitter-header-icon-btn',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: 14,
            }),
        });
        refreshBtn.connect('clicked', () => {
            this._audioManager.syncNow(true);
        });

        suffixBox.add_child(allStereoBtn);
        suffixBox.add_child(refreshBtn);
        this.menu.addHeaderSuffix(suffixBox);

        this._deviceHeaderItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'stereo-splitter-section-header-item',
        });
        this._deviceHeaderLabel = new St.Label({
            text: 'Устройства вывода (можно выбрать несколько):',
            style_class: 'stereo-splitter-section-title',
            x_expand: true,
        });
        this._deviceHeaderItem.add_child(this._deviceHeaderLabel);
        this.menu.addMenuItem(this._deviceHeaderItem);

        this._deviceSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._deviceSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._streamsHeaderItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'stereo-splitter-section-header-item',
        });
        const streamsHeaderLabel = new St.Label({
            text: 'Маршрутизация приложений:',
            style_class: 'stereo-splitter-section-title',
            x_expand: true,
        });
        this._streamsHeaderItem.add_child(streamsHeaderLabel);
        this.menu.addMenuItem(this._streamsHeaderItem);

        const streamsSection = new PopupMenu.PopupMenuSection();
        this._scrollView = new St.ScrollView({
            style_class: 'stereo-splitter-streams-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
        });

        this._streamsBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'stereo-splitter-streams-box',
        });

        this._scrollView.set_child(this._streamsBox);
        streamsSection.actor.add_child(this._scrollView);
        this.menu.addMenuItem(streamsSection);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._syncThemeClass();
                this._audioManager.syncNow(false);
            }
        });

        this._syncThemeClass();
        this.refreshUI();
    }

    _syncThemeClass() {
        try {
            const scheme = this._interfaceSettings?.get_string('color-scheme') || 'default';
            let isDark = scheme === 'prefer-dark';

            if (this.menu?.box?.get_stage()) {
                const themeNode = this.menu.box.get_theme_node();
                const bg = themeNode.get_background_color();
                if (bg && bg.alpha > 20) {
                    const lum = (0.299 * bg.red + 0.587 * bg.green + 0.114 * bg.blue) / 255;
                    isDark = lum < 0.5;
                } else {
                    const fg = themeNode.get_foreground_color();
                    if (fg && fg.alpha > 20) {
                        const fgLum = (0.299 * fg.red + 0.587 * fg.green + 0.114 * fg.blue) / 255;
                        isDark = fgLum > 0.5;
                    }
                }
            }

            if (isDark) {
                this.menu.box.remove_style_class_name('stereo-splitter-light');
                this.menu.box.add_style_class_name('stereo-splitter-dark');
            } else {
                this.menu.box.remove_style_class_name('stereo-splitter-dark');
                this.menu.box.add_style_class_name('stereo-splitter-light');
            }
        } catch (_e) {
            this.menu?.box?.add_style_class_name('stereo-splitter-dark');
        }
    }

    refreshUI() {
        this._syncThemeClass();

        const isEnabled = this._audioManager.enabled;
        const streams = this._audioManager.streams || [];
        const physicalSinks = this._audioManager.physicalSinks || [];
        const selectedSinks = this._audioManager.selectedSinks || [];

        this._updatingChecked = true;
        this.checked = isEnabled;
        this._updatingChecked = false;

        let leftCount = 0;
        let rightCount = 0;
        let stereoCount = 0;
        for (const s of streams) {
            if (s.mode === MODES.LEFT)
                leftCount++;
            else if (s.mode === MODES.RIGHT)
                rightCount++;
            else
                stereoCount++;
        }

        const selectedShortLabels = selectedSinks
            .map(s => this._audioManager.formatSinkShortLabel(s))
            .join(' + ');
        const deviceSummary = selectedShortLabels || 'Нет выхода';

        if (!isEnabled) {
            this.subtitle = 'OFF';
        } else if (selectedSinks.length === 0) {
            this.subtitle = 'Нет аудиовыхода';
        } else if (streams.length === 0) {
            this.subtitle = selectedSinks.length > 1
                ? `${selectedSinks.length} вых. • Ожидание`
                : `ON • ${deviceSummary}`;
        } else {
            this.subtitle = `L:${leftCount}  R:${rightCount}  S:${stereoCount}`;
        }

        const headerSubtitle = isEnabled
            ? `${deviceSummary} • Потоков: ${streams.length}`
            : `Выключено • ${deviceSummary}`;

        this.menu.setHeader(
            'audio-headphones-symbolic',
            'Stereo Splitter',
            headerSubtitle
        );

        this._refreshDeviceItems(physicalSinks, selectedSinks);

        const appGroups = this._groupStreamsByApp(streams);
        const structureKey = appGroups
            .map(g => `${g.appKey}:${g.streams.map(s => s.index).join(',')}`)
            .join('|');

        if (structureKey !== this._lastStructureKey) {
            this._lastStructureKey = structureKey;
            this._rebuildStreamCards(appGroups);
            this._relayoutQuickSettingsMenu();
        } else {
            this._updateExistingCardsInPlace(appGroups);
        }
    }

    _refreshDeviceItems(physicalSinks, selectedSinks) {
        const devicesKey = physicalSinks.map(s => s.name).join('|');
        if (devicesKey !== this._lastDevicesKey) {
            this._lastDevicesKey = devicesKey;
            this._deviceSection.removeAll();
            this._deviceItemRefs.clear();

            for (const sink of physicalSinks) {
                const label = this._audioManager.formatSinkMenuLabel(sink);
                const iconName = this._audioManager.getSinkIconName(sink);
                const item = new PopupMenu.PopupImageMenuItem(label, iconName);
                item.add_style_class_name('stereo-splitter-device-item');

                item.activate = () => {
                    this._audioManager.toggleOutputDevice(sink.name);
                };

                this._deviceSection.addMenuItem(item);
                this._deviceItemRefs.set(sink.name, item);
            }
        }

        const selectedSet = new Set(selectedSinks.map(s => s.name));
        for (const [sinkName, item] of this._deviceItemRefs.entries()) {
            const isSelected = selectedSet.has(sinkName);
            item.setOrnament(
                isSelected
                    ? PopupMenu.Ornament.CHECK
                    : PopupMenu.Ornament.NONE
            );
        }
    }

    _groupStreamsByApp(streams) {
        const map = new Map();
        for (const stream of streams) {
            let group = map.get(stream.appKey);
            if (!group) {
                group = {
                    appKey: stream.appKey,
                    appName: stream.appName,
                    gicon: stream.gicon,
                    streams: [],
                };
                map.set(stream.appKey, group);
            }
            group.streams.push(stream);
        }
        return Array.from(map.values());
    }

    _rebuildStreamCards(appGroups) {
        this._streamsBox.destroy_all_children();
        this._streamRowRefs.clear();
        this._appGroupRefs.clear();

        if (appGroups.length === 0) {
            const emptyBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'stereo-splitter-empty-box',
            });
            const emptyLabel = new St.Label({
                text: 'Нет активных аудиопотоков',
                style_class: 'stereo-splitter-empty-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            emptyBox.add_child(emptyLabel);
            this._streamsBox.add_child(emptyBox);
            return;
        }

        for (const group of appGroups) {
            const card = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'stereo-splitter-app-card',
            });

            if (group.streams.length === 1) {
                const stream = group.streams[0];
                const singleBlock = this._buildSingleStreamBlock(stream);
                card.add_child(singleBlock);
            } else {
                const groupHeader = this._buildAppGroupHeaderRow(group);
                card.add_child(groupHeader);

                for (const stream of group.streams) {
                    const subBlock = this._buildSubStreamBlock(stream);
                    card.add_child(subBlock);
                }
            }

            this._streamsBox.add_child(card);
        }
    }

    _buildSingleStreamBlock(stream) {
        const container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'stereo-splitter-stream-block',
        });

        const topRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'stereo-splitter-top-line',
        });

        const icon = new St.Icon({
            gicon: stream.gicon,
            icon_size: 18,
            style_class: 'stereo-splitter-app-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(icon);

        const titleBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'stereo-splitter-info-box',
        });

        const appTitle = new St.Label({
            text: stream.appName,
            style_class: 'stereo-splitter-app-title',
            x_expand: true,
        });
        appTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBox.add_child(appTitle);

        const mediaLabel = new St.Label({
            text: stream.mediaName || `Поток #${stream.index}`,
            style_class: 'stereo-splitter-media-subtitle',
            x_expand: true,
        });
        mediaLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBox.add_child(mediaLabel);

        topRow.add_child(titleBox);

        const badge = new St.Label({
            text: stream.mode,
            style_class: 'stereo-splitter-mode-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(badge);

        container.add_child(topRow);

        const {btnBox, btnLeft, btnRight, btnStereo} = this._createModeButtons(
            mode => this._audioManager.setStreamMode(stream.index, mode),
            false
        );
        container.add_child(btnBox);

        const refs = {badge, mediaLabel, btnLeft, btnRight, btnStereo};
        this._streamRowRefs.set(stream.index, refs);
        this._applyModeVisuals(refs, stream.mode);

        return container;
    }

    _buildAppGroupHeaderRow(group) {
        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'stereo-splitter-group-header',
        });

        const icon = new St.Icon({
            gicon: group.gicon,
            icon_size: 18,
            style_class: 'stereo-splitter-app-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(icon);

        const appTitle = new St.Label({
            text: `${group.appName} (${group.streams.length})`,
            style_class: 'stereo-splitter-app-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        appTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(appTitle);

        const badge = new St.Label({
            text: '',
            style_class: 'stereo-splitter-mode-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(badge);

        const allHint = new St.Label({
            text: 'Все:',
            style_class: 'stereo-splitter-all-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(allHint);

        const {btnBox, btnLeft, btnRight, btnStereo} = this._createModeButtons(
            mode => this._audioManager.setAppMode(group.appKey, mode),
            true
        );
        row.add_child(btnBox);

        const groupMode = this._computeGroupMode(group.streams);
        const refs = {badge, btnLeft, btnRight, btnStereo};
        this._appGroupRefs.set(group.appKey, refs);
        this._applyModeVisuals(refs, groupMode);

        return row;
    }

    _buildSubStreamBlock(stream) {
        const container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'stereo-splitter-substream-block',
        });

        const topRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'stereo-splitter-top-line',
        });

        const streamIcon = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            icon_size: 14,
            style_class: 'stereo-splitter-stream-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(streamIcon);

        const mediaLabel = new St.Label({
            text: stream.mediaName || `Поток #${stream.index}`,
            style_class: 'stereo-splitter-stream-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        mediaLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        topRow.add_child(mediaLabel);

        const badge = new St.Label({
            text: stream.mode,
            style_class: 'stereo-splitter-mode-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(badge);

        container.add_child(topRow);

        const {btnBox, btnLeft, btnRight, btnStereo} = this._createModeButtons(
            mode => this._audioManager.setStreamMode(stream.index, mode),
            false
        );
        container.add_child(btnBox);

        const refs = {badge, mediaLabel, btnLeft, btnRight, btnStereo};
        this._streamRowRefs.set(stream.index, refs);
        this._applyModeVisuals(refs, stream.mode);

        return container;
    }

    _createModeButtons(onSelectMode, compactMini = false) {
        const btnBox = new St.BoxLayout({
            vertical: false,
            x_expand: !compactMini,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: compactMini
                ? 'stereo-splitter-mini-btn-group'
                : 'stereo-splitter-btn-group',
        });

        const btnLeft = new St.Button({
            label: compactMini ? 'L' : 'LEFT',
            style_class: compactMini
                ? 'stereo-splitter-mini-btn'
                : 'stereo-splitter-mode-btn',
            x_expand: !compactMini,
            can_focus: true,
        });
        const btnRight = new St.Button({
            label: compactMini ? 'R' : 'RIGHT',
            style_class: compactMini
                ? 'stereo-splitter-mini-btn'
                : 'stereo-splitter-mode-btn',
            x_expand: !compactMini,
            can_focus: true,
        });
        const btnStereo = new St.Button({
            label: compactMini ? 'S' : 'STEREO',
            style_class: compactMini
                ? 'stereo-splitter-mini-btn'
                : 'stereo-splitter-mode-btn',
            x_expand: !compactMini,
            can_focus: true,
        });

        btnLeft.connect('clicked', () => onSelectMode(MODES.LEFT));
        btnRight.connect('clicked', () => onSelectMode(MODES.RIGHT));
        btnStereo.connect('clicked', () => onSelectMode(MODES.STEREO));

        btnBox.add_child(btnLeft);
        btnBox.add_child(btnRight);
        btnBox.add_child(btnStereo);

        return {btnBox, btnLeft, btnRight, btnStereo};
    }

    _computeGroupMode(streams) {
        if (!streams || streams.length === 0)
            return MODES.STEREO;
        const first = streams[0].mode;
        const allSame = streams.every(s => s.mode === first);
        return allSame ? first : 'SPLIT';
    }

    _applyModeVisuals(refs, mode) {
        if (!refs)
            return;

        const {badge, btnLeft, btnRight, btnStereo} = refs;

        if (badge) {
            badge.text = mode;
            badge.remove_style_class_name('badge-left');
            badge.remove_style_class_name('badge-right');
            badge.remove_style_class_name('badge-stereo');
            badge.remove_style_class_name('badge-split');

            if (mode === MODES.LEFT)
                badge.add_style_class_name('badge-left');
            else if (mode === MODES.RIGHT)
                badge.add_style_class_name('badge-right');
            else if (mode === MODES.STEREO)
                badge.add_style_class_name('badge-stereo');
            else
                badge.add_style_class_name('badge-split');
        }

        btnLeft?.remove_style_class_name('active-left');
        btnRight?.remove_style_class_name('active-right');
        btnStereo?.remove_style_class_name('active-stereo');

        if (mode === MODES.LEFT)
            btnLeft?.add_style_class_name('active-left');
        else if (mode === MODES.RIGHT)
            btnRight?.add_style_class_name('active-right');
        else if (mode === MODES.STEREO)
            btnStereo?.add_style_class_name('active-stereo');
    }

    _updateExistingCardsInPlace(appGroups) {
        for (const group of appGroups) {
            if (group.streams.length > 1) {
                const groupRefs = this._appGroupRefs.get(group.appKey);
                if (groupRefs) {
                    const groupMode = this._computeGroupMode(group.streams);
                    this._applyModeVisuals(groupRefs, groupMode);
                }
            }

            for (const stream of group.streams) {
                const refs = this._streamRowRefs.get(stream.index);
                if (refs) {
                    if (refs.mediaLabel) {
                        refs.mediaLabel.text =
                            stream.mediaName || `Поток #${stream.index}`;
                    }
                    this._applyModeVisuals(refs, stream.mode);
                }
            }
        }
    }

    _relayoutQuickSettingsMenu() {
        try {
            if (this.menu?.isOpen && this.menu?.actor) {
                this.menu.actor.height = -1;
                const qsMenu = Main.panel.statusArea.quickSettings?.menu;
                qsMenu?._grid?.queue_relayout?.();
            }
        } catch (_e) {
        }
    }

    destroy() {
        if (this._interfaceSettings) {
            if (this._colorSchemeSignalId)
                this._interfaceSettings.disconnect(this._colorSchemeSignalId);
            if (this._gtkThemeSignalId)
                this._interfaceSettings.disconnect(this._gtkThemeSignalId);
            this._interfaceSettings = null;
        }
        super.destroy();
    }
});

const StereoSplitterIndicator = GObject.registerClass(
class StereoSplitterIndicator extends QuickSettings.SystemIndicator {
    _init(audioManager) {
        super._init();

        this._audioManager = audioManager;

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'audio-headphones-symbolic';
        this._indicator.visible = audioManager.enabled;

        this._toggle = new StereoSplitterMenuToggle(audioManager);
        this.quickSettingsItems.push(this._toggle);
    }

    refreshUI() {
        if (this._indicator)
            this._indicator.visible = this._audioManager.enabled;
        this._toggle?.refreshUI();
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});

export default class StereoSplitterExtension extends Extension {
    enable() {
        this._stateStore = new StateStore();
        this._audioManager = new AudioManager(
            this._stateStore,
            () => {
                this._indicator?.refreshUI();
            },
            resolveAppIconAndName
        );

        this._indicator = new StereoSplitterIndicator(this._audioManager);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._audioManager.start();
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        if (this._audioManager) {
            this._audioManager.destroy().catch(e =>
                console.error(`[StereoSplitter] Error during disable cleanup: ${e}`)
            );
            this._audioManager = null;
        }

        if (this._stateStore) {
            this._stateStore.destroy();
            this._stateStore = null;
        }
    }
}
