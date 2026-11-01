import GLib from 'gi://GLib';

export const MODES = Object.freeze({
    LEFT: 'LEFT',
    RIGHT: 'RIGHT',
    STEREO: 'STEREO',
});

export const DEFAULT_MASTER_SINK =
    'alsa_output.usb-Apple__Inc._EarPods_H0X0NXMGF9-00.analog-stereo';
export const SECONDARY_HEADSET_SINK =
    'alsa_output.usb-C-Media_Electronics_Inc_MCHOSE_V9_PRO_0123456789AB-01.analog-stereo';

const CONFIG_DIR_NAME = 'stereo-splitter@evn.local';
const STATE_FILE_NAME = 'state.json';

export class StateStore {
    constructor() {
        this._configDir = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            CONFIG_DIR_NAME,
        ]);
        this._filePath = GLib.build_filenamev([
            this._configDir,
            STATE_FILE_NAME,
        ]);

        this._saveTimeoutId = 0;
        this._destroyed = false;

        this._state = this._getDefaultState();
        this.load();
    }

    _getDefaultState() {
        return {
            version: 1,
            enabled: true,
            preferredMasterSink: DEFAULT_MASTER_SINK,
            selectedMasterSinks: [DEFAULT_MASTER_SINK, SECONDARY_HEADSET_SINK],
            appRules: {
                spotify: MODES.LEFT,
                discord: MODES.STEREO,
                firefox: MODES.RIGHT,
                chrome: MODES.LEFT,
            },
            appSplitMode: {
                firefox: true,
            },
            streamMediaRules: {
                'firefox::kodik player': MODES.RIGHT,
            },
            streamSignatureRules: {
                'firefox::site:kodik': MODES.RIGHT,
                'firefox::site:movie-player': MODES.RIGHT,
                'firefox::pattern:kodik player': MODES.RIGHT,
                'firefox::site:youtube': MODES.LEFT,
                'firefox::site:youtube-music': MODES.LEFT,
                'firefox::suffix:youtube': MODES.LEFT,
                'firefox::pattern:тетрадь смерти [тв]-s#-e#-мега-аниме': MODES.RIGHT,
            },
        };
    }

    load() {
        try {
            if (!GLib.file_test(this._filePath, GLib.FileTest.EXISTS)) {
                this._state = this._getDefaultState();
                this.saveNow();
                return this._state;
            }

            const [ok, bytes] = GLib.file_get_contents(this._filePath);
            if (!ok || !bytes) {
                this._state = this._getDefaultState();
                return this._state;
            }

            const text = new TextDecoder('utf-8').decode(bytes);
            const parsed = JSON.parse(text);

            const defaults = this._getDefaultState();
            const preferredSink =
                typeof parsed.preferredMasterSink === 'string' && parsed.preferredMasterSink
                    ? parsed.preferredMasterSink
                    : defaults.preferredMasterSink;

            const selectedSinks = Array.isArray(parsed.selectedMasterSinks)
                ? parsed.selectedMasterSinks.filter(s => typeof s === 'string' && s.length > 0)
                : [preferredSink];

            this._state = {
                version: 1,
                enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : defaults.enabled,
                preferredMasterSink: preferredSink,
                selectedMasterSinks:
                    selectedSinks.length > 0 ? selectedSinks : [preferredSink],
                appRules: this._sanitizeRuleMap(parsed.appRules),
                appSplitMode:
                    parsed.appSplitMode && typeof parsed.appSplitMode === 'object'
                        ? {...parsed.appSplitMode}
                        : {},
                streamMediaRules: this._sanitizeRuleMap(parsed.streamMediaRules),
                streamSignatureRules: this._sanitizeRuleMap(parsed.streamSignatureRules),
            };
        } catch (e) {
            console.error(`[StereoSplitter] Failed to load state.json: ${e}`);
            this._state = this._getDefaultState();
        }

        return this._state;
    }

    _sanitizeRuleMap(mapObj) {
        const clean = {};
        if (!mapObj || typeof mapObj !== 'object')
            return clean;

        for (const [k, v] of Object.entries(mapObj)) {
            if (v === MODES.LEFT || v === MODES.RIGHT || v === MODES.STEREO)
                clean[k] = v;
        }
        return clean;
    }

    scheduleSave() {
        if (this._destroyed)
            return;

        if (this._saveTimeoutId) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
        }

        this._saveTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            150,
            () => {
                this._saveTimeoutId = 0;
                this.saveNow();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    saveNow() {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o755);
            const json = JSON.stringify(this._state, null, 2);
            GLib.file_set_contents(this._filePath, json);
        } catch (e) {
            console.error(`[StereoSplitter] Failed to save state.json: ${e}`);
        }
    }

    get enabled() {
        return Boolean(this._state.enabled);
    }

    set enabled(val) {
        const next = Boolean(val);
        if (this._state.enabled !== next) {
            this._state.enabled = next;
            this.scheduleSave();
        }
    }

    get preferredMasterSink() {
        return this._state.preferredMasterSink || DEFAULT_MASTER_SINK;
    }

    set preferredMasterSink(sinkName) {
        if (sinkName && this._state.preferredMasterSink !== sinkName) {
            this._state.preferredMasterSink = sinkName;
            this.scheduleSave();
        }
    }

    get selectedMasterSinks() {
        const list = this._state.selectedMasterSinks;
        if (Array.isArray(list) && list.length > 0)
            return list;
        return [this.preferredMasterSink];
    }

    setSelectedMasterSinks(sinkNames) {
        const clean = Array.from(
            new Set((sinkNames || []).filter(s => typeof s === 'string' && s.length > 0))
        );
        if (clean.length === 0)
            return;

        this._state.selectedMasterSinks = clean;
        this._state.preferredMasterSink = clean[0];
        this.scheduleSave();
    }

    get appRules() {
        return this._state.appRules;
    }

    get appSplitMode() {
        return this._state.appSplitMode;
    }

    get streamMediaRules() {
        return this._state.streamMediaRules;
    }

    get streamSignatureRules() {
        return this._state.streamSignatureRules;
    }

    setAppRule(appKey, mode, clearStreamOverrides = false) {
        if (!appKey)
            return;

        this._state.appRules[appKey] = mode;

        if (clearStreamOverrides) {
            delete this._state.appSplitMode[appKey];
            const prefix = `${appKey}::`;
            for (const key of Object.keys(this._state.streamMediaRules)) {
                if (key.startsWith(prefix))
                    delete this._state.streamMediaRules[key];
            }
            for (const key of Object.keys(this._state.streamSignatureRules)) {
                if (key.startsWith(prefix))
                    delete this._state.streamSignatureRules[key];
            }
        }

        this.scheduleSave();
    }

    setStreamRule(appKey, mediaKey, signatures, mode, isMultiStreamSplit = false) {
        if (!appKey)
            return;

        const sigList = Array.isArray(signatures) ? signatures : [];
        const isYouTube = sigList.some(
            s => s === 'site:youtube' || s === 'site:youtube-music' || s === 'suffix:youtube'
        );

        if (isYouTube) {
            const prefix = `${appKey}::`;
            for (const key of Object.keys(this._state.streamMediaRules)) {
                if (key.startsWith(prefix) && key.includes('youtube'))
                    delete this._state.streamMediaRules[key];
            }
            for (const key of Object.keys(this._state.streamSignatureRules)) {
                if (key.startsWith(`${prefix}pattern:`) && key.includes('youtube'))
                    delete this._state.streamSignatureRules[key];
            }
        }

        if (mediaKey)
            this._state.streamMediaRules[`${appKey}::${mediaKey}`] = mode;

        for (const sig of sigList) {
            if (sig)
                this._state.streamSignatureRules[`${appKey}::${sig}`] = mode;
        }

        const prefix = `${appKey}::`;
        const modesForApp = new Set([mode]);
        for (const [k, v] of Object.entries(this._state.streamMediaRules)) {
            if (k.startsWith(prefix))
                modesForApp.add(v);
        }
        for (const [k, v] of Object.entries(this._state.streamSignatureRules)) {
            if (k.startsWith(prefix))
                modesForApp.add(v);
        }

        if (isMultiStreamSplit || modesForApp.size > 1) {
            this._state.appSplitMode[appKey] = true;
        } else {
            delete this._state.appSplitMode[appKey];
        }

        if (!isYouTube) {
            this._state.appRules[appKey] = mode;
        } else if (!this._state.appSplitMode[appKey]) {
            this._state.appRules[appKey] = mode;
        }

        this.scheduleSave();
    }

    destroy() {
        this._destroyed = true;
        if (this._saveTimeoutId) {
            GLib.Source.remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
            this.saveNow();
        }
    }
}
