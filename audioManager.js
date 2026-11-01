import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {MODES, DEFAULT_MASTER_SINK} from './stateStore.js';
import {
    StreamMatcher,
    normalizeAppIdentity,
    extractMediaSignatures,
} from './streamMatcher.js';

const LEFT_SINK_NAMES = new Set(['LEFT_EAR', 'LEFT_AUDIO']);
const RIGHT_SINK_NAMES = new Set(['RIGHT_EAR', 'RIGHT_AUDIO']);
const COMBINED_SINK_NAME = 'STEREO_SPLITTER_COMBINED';

function defaultIconResolver(props = {}, appKey = 'unknown', fallbackName = 'Audio') {
    const names = [];
    if (props['application.icon_name'])
        names.push(props['application.icon_name']);
    if (appKey && appKey !== 'unknown')
        names.push(appKey);
    names.push('applications-multimedia-symbolic', 'audio-x-generic-symbolic');
    return {
        gicon: Gio.ThemedIcon.new_from_names(names),
        displayName: fallbackName,
    };
}

export class AudioManager {
    constructor(stateStore, onUpdateCallback, iconResolver = defaultIconResolver) {
        this._store = stateStore;
        this._onUpdate = onUpdateCallback;
        this._iconResolver = iconResolver || defaultIconResolver;
        this._matcher = new StreamMatcher(stateStore);

        this._destroyed = false;
        this._isInitialSync = true;
        this._syncInProgress = false;
        this._pendingSync = false;
        this._pendingFullTopology = false;

        this._syncTimerId = 0;
        this._followUpTimerId = 0;
        this._healthTimerId = 0;
        this._subscribeRestartTimerId = 0;

        this._subscribeProc = null;
        this._subscribeCancel = null;

        this._ownedModuleIds = new Set();

        this._originalStreamSinks = new Map();
        this._knownStreamModes = new Map();
        this._knownStreamMediaKeys = new Map();
        this._initialDefaultSink = null;

        this._sinks = [];
        this._physicalSinks = [];
        this._selectedSinks = [];
        this._masterSink = null;
        this._leftSink = null;
        this._rightSink = null;
        this._earpodsConnected = false;
        this._combineModuleId = null;
        this._combineSlavesKey = '';

        this._streams = [];
    }

    get enabled() {
        return this._store.enabled;
    }

    get streams() {
        return this._streams;
    }

    get masterSink() {
        return this._masterSink;
    }

    get physicalSinks() {
        return this._physicalSinks;
    }

    get selectedSinks() {
        return this._selectedSinks;
    }

    get leftSink() {
        return this._leftSink;
    }

    get rightSink() {
        return this._rightSink;
    }

    get earpodsConnected() {
        return this._earpodsConnected;
    }

    formatSinkMenuLabel(sink) {
        if (!sink)
            return 'Нет аудиовыхода';
        const name = sink.name || '';
        const desc = sink.description || '';
        if (name.includes('Apple__Inc._EarPods') || desc.includes('EarPods'))
            return 'Headphones (EarPods)';
        if (name.includes('MCHOSE_V9_PRO') || desc.includes('MCHOSE V9 PRO'))
            return 'Headphones (MCHOSE V9 PRO)';
        if (name.includes('pci-0000_00_1b.0') || desc.includes('Built-in Audio'))
            return 'Headphones (Built-in Audio)';
        if (name.includes('hdmi'))
            return 'HDMI / DisplayPort (Mi Monitor)';
        return desc || name;
    }

    formatSinkShortLabel(sink) {
        if (!sink)
            return 'Нет выхода';
        const name = sink.name || '';
        const desc = sink.description || '';
        if (name.includes('Apple__Inc._EarPods') || desc.includes('EarPods'))
            return 'EarPods';
        if (name.includes('MCHOSE_V9_PRO') || desc.includes('MCHOSE V9 PRO'))
            return 'MCHOSE V9 PRO';
        if (name.includes('pci-0000_00_1b.0') || desc.includes('Built-in Audio'))
            return 'Built-in Audio';
        if (name.includes('hdmi'))
            return 'HDMI';
        return desc || name;
    }

    getSinkIconName(sink) {
        const name = sink?.name || '';
        if (name.includes('hdmi'))
            return 'video-display-symbolic';
        return 'audio-headphones-symbolic';
    }

    async toggleOutputDevice(sinkName) {
        if (this._destroyed || !sinkName)
            return;

        const currentNames = this._selectedSinks.map(s => s.name);
        let nextNames;

        if (currentNames.includes(sinkName)) {
            if (currentNames.length <= 1)
                return;
            nextNames = currentNames.filter(n => n !== sinkName);
        } else {
            nextNames = [...currentNames, sinkName];
            try {
                await this._execPactl(['set-sink-mute', sinkName, '0']);
            } catch (_e) {
            }
        }

        this._store.setSelectedMasterSinks(nextNames);
        await this.syncNow(true);
    }

    start() {
        this._destroyed = false;
        this._isInitialSync = true;

        this._startSubscribeLoop();
        this._scheduleSync(10, true);

        this._healthTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            4,
            () => {
                if (this._destroyed)
                    return GLib.SOURCE_REMOVE;

                this._scheduleSync(50, true);
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    async setEnabled(enabled) {
        if (this._destroyed)
            return;

        this._store.enabled = enabled;
        if (enabled) {
            await this.syncNow(true);
        } else {
            await this._restoreAllStreamsToOriginal();
            await this.syncNow(false);
        }
    }

    async setStreamMode(streamIndex, mode) {
        if (this._destroyed)
            return;

        const stream = this._streams.find(s => s.index === streamIndex);
        if (!stream)
            return;

        const appStreams = this._streams.filter(s => s.appKey === stream.appKey);
        this._matcher.assignStreamMode(stream, mode, appStreams);
        stream.mode = mode;
        this._knownStreamModes.set(stream.index, mode);
        this._knownStreamMediaKeys.set(stream.index, stream.mediaKey || '');

        if (!this._store.enabled) {
            this._store.enabled = true;
        }

        if (!this._leftSink || !this._rightSink || !this._masterSink) {
            await this._syncTopology();
        }

        const targetSink = this._getTargetSinkForMode(mode);
        if (targetSink) {
            this._recordOriginalSinkIfNeeded(stream);
            await this._moveSinkInput(stream.index, targetSink.name);
            stream.sink = targetSink.index;
            stream.sinkName = targetSink.name;
        }

        this._notifyUI();
        this._scheduleSync(120, false);
    }

    async setAppMode(appKey, mode) {
        if (this._destroyed)
            return;

        const appStreams = this._streams.filter(s => s.appKey === appKey);
        this._matcher.assignAppMode(appKey, mode, appStreams);

        if (!this._store.enabled) {
            this._store.enabled = true;
        }

        if (!this._leftSink || !this._rightSink || !this._masterSink) {
            await this._syncTopology();
        }

        const targetSink = this._getTargetSinkForMode(mode);
        if (targetSink) {
            for (const stream of appStreams) {
                stream.mode = mode;
                this._knownStreamModes.set(stream.index, mode);
                this._knownStreamMediaKeys.set(stream.index, stream.mediaKey || '');
                this._recordOriginalSinkIfNeeded(stream);
                await this._moveSinkInput(stream.index, targetSink.name);
                stream.sink = targetSink.index;
                stream.sinkName = targetSink.name;
            }
        }

        this._notifyUI();
        this._scheduleSync(120, false);
    }

    async resetAllToStereo() {
        if (this._destroyed)
            return;

        const appKeys = new Set(this._streams.map(s => s.appKey));
        for (const appKey of appKeys) {
            await this.setAppMode(appKey, MODES.STEREO);
        }
    }

    _scheduleSync(delayMs = 25, fullTopology = false) {
        if (this._destroyed)
            return;

        if (fullTopology)
            this._pendingFullTopology = true;

        if (this._syncTimerId) {
            if (delayMs < 25) {
                GLib.Source.remove(this._syncTimerId);
                this._syncTimerId = 0;
            } else {
                return;
            }
        }

        this._syncTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._syncTimerId = 0;
                const doFull = this._pendingFullTopology;
                this._pendingFullTopology = false;
                this.syncNow(doFull).catch(e =>
                    console.error(`[StereoSplitter] Sync error: ${e}`)
                );
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _scheduleFollowUpSync(delayMs = 160) {
        if (this._destroyed)
            return;

        if (this._followUpTimerId) {
            GLib.Source.remove(this._followUpTimerId);
            this._followUpTimerId = 0;
        }

        this._followUpTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._followUpTimerId = 0;
                this.syncNow(false).catch(e =>
                    console.error(`[StereoSplitter] Follow-up sync error: ${e}`)
                );
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    async syncNow(fullTopology = true) {
        if (this._destroyed)
            return;

        if (this._syncInProgress) {
            this._pendingSync = true;
            if (fullTopology)
                this._pendingFullTopology = true;
            return;
        }

        this._syncInProgress = true;

        try {
            const needTopology =
                fullTopology ||
                !this._masterSink ||
                !this._leftSink ||
                !this._rightSink;

            if (needTopology) {
                await this._syncTopology();
            }

            await this._syncStreams();
            this._isInitialSync = false;
            this._notifyUI();
        } catch (e) {
            console.error(`[StereoSplitter] syncNow failed: ${e}`);
        } finally {
            this._syncInProgress = false;

            if (this._pendingSync && !this._destroyed) {
                const nextFull = this._pendingFullTopology;
                this._pendingSync = false;
                this._pendingFullTopology = false;
                this._scheduleSync(20, nextFull);
            }
        }
    }

    async _syncTopology() {
        const [sinksOut, infoOut] = await Promise.all([
            this._execPactl(['list', 'sinks']),
            this._execPactl(['info']),
        ]);

        const sinks = this._parseSinks(sinksOut);
        this._sinks = sinks;

        const defaultSinkName = this._parseDefaultSink(infoOut);
        if (!this._initialDefaultSink && defaultSinkName) {
            if (!this._isVirtualSplitterSinkName(defaultSinkName))
                this._initialDefaultSink = defaultSinkName;
        }

        let leftSink = null;
        let rightSink = null;
        let physicalSinks = [];

        for (const sink of sinks) {
            if (this._isLeftSink(sink)) {
                if (!leftSink)
                    leftSink = sink;
            } else if (this._isRightSink(sink)) {
                if (!rightSink)
                    rightSink = sink;
            } else if (!this._isVirtualSink(sink)) {
                physicalSinks.push(sink);
            }
        }

        physicalSinks.sort((a, b) => {
            const score = s => {
                if (s.name.includes('Apple__Inc._EarPods'))
                    return 1;
                if (s.name.includes('MCHOSE_V9_PRO'))
                    return 2;
                if (s.name.includes('hdmi'))
                    return 4;
                return 3;
            };
            return score(a) - score(b);
        });
        this._physicalSinks = physicalSinks;

        const preferredName = this._store.preferredMasterSink || DEFAULT_MASTER_SINK;
        const earpodsSink =
            physicalSinks.find(
                s =>
                    s.name.includes('Apple__Inc._EarPods') ||
                    (s.description && s.description.includes('EarPods'))
            ) || null;
        this._earpodsConnected = Boolean(earpodsSink);

        const storedSelected = this._store.selectedMasterSinks || [preferredName];
        let selectedSinks = physicalSinks.filter(s => storedSelected.includes(s.name));
        if (selectedSinks.length === 0) {
            const fallback =
                physicalSinks.find(s => s.name === preferredName) ||
                earpodsSink ||
                physicalSinks.find(s => !s.name.includes('hdmi')) ||
                physicalSinks[0] ||
                null;
            if (fallback)
                selectedSinks = [fallback];
        }
        this._selectedSinks = selectedSinks;

        let masterSink = selectedSinks[0] || null;

        if (this._store.enabled && selectedSinks.length >= 2) {
            const slavesKey = selectedSinks.map(s => s.name).join(',');
            let combinedSink = this._sinks.find(s => s.name === COMBINED_SINK_NAME) || null;

            if (!combinedSink || (this._combineSlavesKey && this._combineSlavesKey !== slavesKey)) {
                await this._unloadCombineSinkIfAny();
                const modId = await this._createCombineSink(slavesKey);
                if (modId) {
                    this._combineModuleId = modId;
                    this._combineSlavesKey = slavesKey;
                    this._ownedModuleIds.add(modId);
                    const refOut = await this._execPactl(['list', 'sinks']);
                    this._sinks = this._parseSinks(refOut);
                    combinedSink = this._sinks.find(s => s.name === COMBINED_SINK_NAME) || null;
                }
            } else if (!this._combineSlavesKey) {
                this._combineSlavesKey = slavesKey;
            }

            if (combinedSink) {
                masterSink = combinedSink;
            }
        } else {
            if (this._combineModuleId || this._sinks.some(s => s.name === COMBINED_SINK_NAME)) {
                if (masterSink) {
                    const inputsOut = await this._execPactl(['list', 'sink-inputs']);
                    const rawInputs = this._parseSinkInputs(inputsOut);
                    for (const inp of rawInputs) {
                        if (this._isRemapLoopbackInput(inp)) {
                            await this._moveSinkInput(inp.index, masterSink.name);
                        }
                    }
                }
                await this._unloadCombineSinkIfAny();
            }
        }

        this._masterSink = masterSink;

        const primaryPhysical = selectedSinks[0] || masterSink;
        if (
            this._store.enabled &&
            primaryPhysical &&
            defaultSinkName !== primaryPhysical.name &&
            (this._isVirtualSplitterSinkName(defaultSinkName) ||
                defaultSinkName.includes('hdmi'))
        ) {
            await this._execPactl(['set-default-sink', primaryPhysical.name]);
        }

        if (this._store.enabled && masterSink) {
            let createdAny = false;

            if (!leftSink) {
                const modId = await this._createRemapSink(
                    'LEFT_EAR',
                    'LEFT_EAR',
                    masterSink.name,
                    'front-left'
                );
                if (modId) {
                    this._ownedModuleIds.add(modId);
                    createdAny = true;
                }
            }

            if (!rightSink) {
                const modId = await this._createRemapSink(
                    'RIGHT_EAR',
                    'RIGHT_EAR',
                    masterSink.name,
                    'front-right'
                );
                if (modId) {
                    this._ownedModuleIds.add(modId);
                    createdAny = true;
                }
            }

            if (createdAny) {
                const updatedSinksOut = await this._execPactl(['list', 'sinks']);
                const updatedSinks = this._parseSinks(updatedSinksOut);
                this._sinks = updatedSinks;
                leftSink = updatedSinks.find(s => this._isLeftSink(s)) || null;
                rightSink = updatedSinks.find(s => this._isRightSink(s)) || null;

                if (leftSink) {
                    await this._execPactl(['set-sink-mute', leftSink.name, '0']);
                    await this._execPactl(['set-sink-volume', leftSink.name, '100%']);
                }
                if (rightSink) {
                    await this._execPactl(['set-sink-mute', rightSink.name, '0']);
                    await this._execPactl(['set-sink-volume', rightSink.name, '100%']);
                }
            } else {
                if (leftSink) {
                    if (leftSink.mute)
                        await this._execPactl(['set-sink-mute', leftSink.name, '0']);
                    await this._execPactl(['set-sink-volume', leftSink.name, '100%']);
                }
                if (rightSink) {
                    if (rightSink.mute)
                        await this._execPactl(['set-sink-mute', rightSink.name, '0']);
                    await this._execPactl(['set-sink-volume', rightSink.name, '100%']);
                }
            }
        }

        this._leftSink = leftSink;
        this._rightSink = rightSink;
    }

    async _syncStreams() {
        const sinkInputsOut = await this._execPactl(['list', 'sink-inputs']);
        const rawInputs = this._parseSinkInputs(sinkInputsOut);

        const sinkMapByIndex = new Map();
        for (const s of this._sinks)
            sinkMapByIndex.set(s.index, s);

        if (this._store.enabled && this._masterSink) {
            for (const input of rawInputs) {
                if (this._isRemapLoopbackInput(input) || this._isSystemEventSound(input)) {
                    if (
                        input.sink !== this._masterSink.index &&
                        this._masterSink.name
                    ) {
                        await this._moveSinkInput(
                            input.index,
                            this._masterSink.name
                        );
                    }
                }
            }
        }

        const userInputs = rawInputs.filter(input => !this._isInternalInput(input));
        const activeIndices = new Set(userInputs.map(i => i.index));
        this._matcher.pruneStaleStreams(activeIndices);

        const preliminaryStreams = userInputs.map(input => {
            const props = input.properties || {};
            const {appKey, appName} = normalizeAppIdentity(props);
            const {mediaKey, signatures, isGeneric} = extractMediaSignatures(
                props['media.name'] || ''
            );
            const {gicon, displayName} = this._iconResolver(
                props,
                appKey,
                appName
            );

            const currentSinkObj = sinkMapByIndex.get(input.sink);
            const currentSinkName = currentSinkObj?.name || '';
            const currentHwMode = this._getModeForSink(currentSinkObj);

            const rawMedia = (props['media.name'] || '').trim();
            const displayMedia =
                !isGeneric && rawMedia && rawMedia !== displayName
                    ? rawMedia
                    : '';

            return {
                index: input.index,
                sink: input.sink,
                sinkName: currentSinkName,
                corked: Boolean(input.corked),
                mute: Boolean(input.mute),
                appKey,
                appName: displayName || appName,
                mediaName: displayMedia,
                mediaKey,
                signatures,
                gicon,
                properties: props,
                hardwareMode: currentHwMode,
                mode: currentHwMode,
            };
        });

        const orderedForResolution = [...preliminaryStreams].sort((a, b) => {
            const aKnown = this._matcher.hasActiveStream(a.index) ? 0 : 1;
            const bKnown = this._matcher.hasActiveStream(b.index) ? 0 : 1;
            return aKnown - bKnown;
        });

        for (const stream of orderedForResolution) {
            this._recordOriginalSinkIfNeeded(stream);

            const desiredMode = this._matcher.resolveStreamMode(
                stream,
                preliminaryStreams,
                stream.hardwareMode,
                this._isInitialSync
            );
            stream.mode = desiredMode;

            if (this._store.enabled) {
                const targetSink = this._getTargetSinkForMode(desiredMode);
                if (
                    targetSink &&
                    stream.sink !== targetSink.index &&
                    stream.sinkName !== targetSink.name
                ) {
                    const moved = await this._moveSinkInput(
                        stream.index,
                        targetSink.name
                    );
                    if (moved) {
                        stream.sink = targetSink.index;
                        stream.sinkName = targetSink.name;
                        stream.hardwareMode = desiredMode;
                    } else {
                        this._pendingFullTopology = true;
                    }
                }
            }

            this._knownStreamModes.set(stream.index, desiredMode);
            this._knownStreamMediaKeys.set(stream.index, stream.mediaKey || '');
        }

        for (const idx of Array.from(this._originalStreamSinks.keys())) {
            if (!activeIndices.has(idx))
                this._originalStreamSinks.delete(idx);
        }
        for (const idx of Array.from(this._knownStreamModes.keys())) {
            if (!activeIndices.has(idx)) {
                this._knownStreamModes.delete(idx);
                this._knownStreamMediaKeys.delete(idx);
            }
        }

        this._streams = preliminaryStreams;
    }

    _recordOriginalSinkIfNeeded(stream) {
        if (this._originalStreamSinks.has(stream.index))
            return;

        if (
            stream.sinkName &&
            !this._isVirtualSplitterSinkName(stream.sinkName)
        ) {
            this._originalStreamSinks.set(stream.index, stream.sinkName);
        } else if (this._selectedSinks[0]?.name) {
            this._originalStreamSinks.set(stream.index, this._selectedSinks[0].name);
        } else if (this._masterSink?.name) {
            this._originalStreamSinks.set(stream.index, this._masterSink.name);
        }
    }

    async _restoreAllStreamsToOriginal() {
        try {
            const [sinksOut, inputsOut] = await Promise.all([
                this._execPactl(['list', 'sinks']),
                this._execPactl(['list', 'sink-inputs']),
            ]);

            const sinks = this._parseSinks(sinksOut);
            const availableSinkNames = new Set(sinks.map(s => s.name));
            const fallbackPhysical =
                sinks.find(s => s.name === (this._store.preferredMasterSink || DEFAULT_MASTER_SINK)) ||
                sinks.find(s => !this._isVirtualSink(s) && !s.name.includes('hdmi')) ||
                sinks.find(s => !this._isVirtualSink(s));

            const inputs = this._parseSinkInputs(inputsOut);
            for (const input of inputs) {
                if (this._isRemapLoopbackInput(input)) {
                    if (fallbackPhysical)
                        await this._moveSinkInput(input.index, fallbackPhysical.name);
                    continue;
                }
                if (this._isInternalInput(input))
                    continue;

                const savedSinkName = this._originalStreamSinks.get(input.index);
                let restoreSinkName = null;

                if (
                    savedSinkName &&
                    availableSinkNames.has(savedSinkName) &&
                    !this._isVirtualSplitterSinkName(savedSinkName)
                ) {
                    restoreSinkName = savedSinkName;
                } else if (fallbackPhysical) {
                    restoreSinkName = fallbackPhysical.name;
                }

                if (restoreSinkName) {
                    await this._moveSinkInput(input.index, restoreSinkName);
                }
            }
            await this._unloadCombineSinkIfAny();
        } catch (e) {
            console.error(`[StereoSplitter] Failed to restore streams: ${e}`);
        }
    }

    async _unloadOwnedModules() {
        for (const modId of Array.from(this._ownedModuleIds)) {
            try {
                await this._execPactl(['unload-module', String(modId)]);
            } catch (e) {
                console.error(`[StereoSplitter] Failed to unload module ${modId}: ${e}`);
            }
            this._ownedModuleIds.delete(modId);
        }
    }

    async _createCombineSink(slavesCsv) {
        try {
            const out = await this._execPactl([
                'load-module',
                'module-combine-sink',
                `sink_name=${COMBINED_SINK_NAME}`,
                `slaves=${slavesCsv}`,
                'sink_properties=device.description=MULTI_OUTPUT',
            ]);
            const modId = Number.parseInt((out || '').trim(), 10);
            return Number.isNaN(modId) ? null : modId;
        } catch (e) {
            console.error(`[StereoSplitter] Failed to create combine-sink: ${e}`);
            return null;
        }
    }

    async _unloadCombineSinkIfAny() {
        try {
            if (this._combineModuleId) {
                await this._execPactl(['unload-module', String(this._combineModuleId)]);
                this._ownedModuleIds.delete(this._combineModuleId);
                this._combineModuleId = null;
                this._combineSlavesKey = '';
                return;
            }
            const modsOut = await this._execPactl(['list', 'modules', 'short']);
            for (const line of (modsOut || '').split('\n')) {
                if (line.includes('module-combine-sink') && line.includes(COMBINED_SINK_NAME)) {
                    const idStr = line.trim().split(/\s+/)[0];
                    if (idStr && /^\d+$/.test(idStr)) {
                        await this._execPactl(['unload-module', idStr]);
                    }
                }
            }
        } catch (_e) {
        }
        this._combineModuleId = null;
        this._combineSlavesKey = '';
    }

    async _createRemapSink(sinkName, description, masterSinkName, masterChannel) {
        const out = await this._execPactl([
            'load-module',
            'module-remap-sink',
            `sink_name=${sinkName}`,
            `master=${masterSinkName}`,
            'channels=1',
            `master_channel_map=${masterChannel}`,
            'channel_map=mono',
            'remix=no',
            `sink_properties=device.description=${description}`,
        ]);

        const trimmed = (out || '').trim();
        const modId = Number.parseInt(trimmed, 10);
        return Number.isNaN(modId) ? null : modId;
    }

    async _moveSinkInput(streamIndex, targetSinkName) {
        if (!targetSinkName)
            return false;

        try {
            await this._execPactl([
                'move-sink-input',
                String(streamIndex),
                targetSinkName,
            ]);
            return true;
        } catch (e) {
            console.error(
                `[StereoSplitter] Failed to move sink-input ${streamIndex} -> ${targetSinkName}: ${e}`
            );
            return false;
        }
    }

    _getTargetSinkForMode(mode) {
        if (mode === MODES.LEFT)
            return this._leftSink || this._masterSink;
        if (mode === MODES.RIGHT)
            return this._rightSink || this._masterSink;
        return this._masterSink;
    }

    _getModeForSink(sinkObj) {
        if (!sinkObj)
            return MODES.STEREO;
        if (this._isLeftSink(sinkObj))
            return MODES.LEFT;
        if (this._isRightSink(sinkObj))
            return MODES.RIGHT;
        return MODES.STEREO;
    }

    _isLeftSink(sink) {
        if (!sink)
            return false;
        const desc = sink.properties?.['device.description'] || sink.description || '';
        return LEFT_SINK_NAMES.has(sink.name) || LEFT_SINK_NAMES.has(desc);
    }

    _isRightSink(sink) {
        if (!sink)
            return false;
        const desc = sink.properties?.['device.description'] || sink.description || '';
        return RIGHT_SINK_NAMES.has(sink.name) || RIGHT_SINK_NAMES.has(desc);
    }

    _isVirtualSplitterSinkName(name = '') {
        return (
            LEFT_SINK_NAMES.has(name) ||
            RIGHT_SINK_NAMES.has(name) ||
            name === COMBINED_SINK_NAME
        );
    }

    _isVirtualSink(sink) {
        if (!sink)
            return false;
        if (
            this._isLeftSink(sink) ||
            this._isRightSink(sink) ||
            sink.name === COMBINED_SINK_NAME
        )
            return true;
        const props = sink.properties || {};
        return (
            props['node.virtual'] === 'true' ||
            props['device.class'] === 'filter'
        );
    }

    _isRemapLoopbackInput(input) {
        const props = input.properties || {};
        const nodeName = props['node.name'] || '';
        const desc = props['device.description'] || '';
        const mediaName = props['media.name'] || '';

        return (
            nodeName === 'output.LEFT_EAR' ||
            nodeName === 'output.LEFT_AUDIO' ||
            nodeName === 'output.RIGHT_EAR' ||
            nodeName === 'output.RIGHT_AUDIO' ||
            desc === 'LEFT_EAR' ||
            desc === 'RIGHT_EAR' ||
            mediaName === 'LEFT_EAR output' ||
            mediaName === 'RIGHT_EAR output'
        );
    }

    _isSystemEventSound(input) {
        const props = input.properties || {};
        const appId = (props['application.id'] || '').toLowerCase();
        const appName = (props['application.name'] || '').toLowerCase();
        const mediaName = (props['media.name'] || '').toLowerCase();
        const mediaRole = (props['media.role'] || '').toLowerCase();

        if (
            mediaRole === 'event' ||
            mediaRole === 'notification' ||
            mediaRole === 'system'
        )
            return true;

        if (
            appId === 'org.freedesktop.libcanberra' ||
            appId === 'org.gnome.volumecontrol' ||
            appName === 'libcanberra' ||
            appName === 'mutter' ||
            appName === 'gnome shell' ||
            appName === 'gnome shell volume control' ||
            appName === 'xdg-desktop-portal' ||
            appName.startsWith('speech-dispatcher')
        )
            return true;

        if (
            mediaName === 'bell-window-system' ||
            mediaName === 'audio-volume-change' ||
            mediaName === 'system sounds'
        )
            return true;

        return false;
    }

    _isInternalInput(input) {
        if (this._isRemapLoopbackInput(input) || this._isSystemEventSound(input))
            return true;

        const props = input.properties || {};
        const nodeName = props['node.name'] || '';
        const nodeGroup = props['node.group'] || '';
        const appId = props['application.id'] || '';
        const mediaName = props['media.name'] || '';

        if (props['node.virtual'] === 'true')
            return true;
        if (props['node.link-group'])
            return true;
        if (nodeGroup.startsWith('remap-sink') || nodeGroup.startsWith('loopback'))
            return true;
        if (nodeName.startsWith('output.'))
            return true;
        if (
            appId === 'org.PulseAudio.pavucontrol' ||
            appId === 'org.gnome.VolumeControl'
        )
            return true;
        if (mediaName === 'Peak detect')
            return true;

        return false;
    }

    _startSubscribeLoop() {
        if (this._destroyed)
            return;

        this._stopSubscribeLoop();

        try {
            this._subscribeCancel = new Gio.Cancellable();
            this._subscribeProc = Gio.Subprocess.new(
                ['/usr/bin/env', 'LC_ALL=C.UTF-8', 'LANG=C.UTF-8', 'pactl', 'subscribe'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );

            const stdoutStream = new Gio.DataInputStream({
                base_stream: this._subscribeProc.get_stdout_pipe(),
                close_base_stream: true,
            });

            this._readSubscribeLine(stdoutStream);
        } catch (e) {
            console.error(`[StereoSplitter] Failed to start pactl subscribe: ${e}`);
            this._scheduleSubscribeRestart();
        }
    }

    _readSubscribeLine(dataInputStream) {
        if (this._destroyed || !this._subscribeCancel)
            return;

        dataInputStream.read_line_async(
            GLib.PRIORITY_DEFAULT,
            this._subscribeCancel,
            (stream, res) => {
                if (this._destroyed)
                    return;

                try {
                    const [lineBytes] = stream.read_line_finish(res);
                    if (lineBytes === null) {
                        this._scheduleSubscribeRestart();
                        return;
                    }

                    const line = new TextDecoder('utf-8').decode(lineBytes).trim();
                    this._handleSubscribeEvent(line);
                    this._readSubscribeLine(stream);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        this._scheduleSubscribeRestart();
                    }
                }
            }
        );
    }

    _handleSubscribeEvent(line) {
        if (!line || this._destroyed)
            return;

        const match = line.match(
            /^Event\s+'([^']+)'\s+on\s+([a-z-]+)\s+#(\d+)/i
        );
        if (!match)
            return;

        const [, eventType, facility, idStr] = match;
        const id = Number.parseInt(idStr, 10);

        if (facility === 'sink-input') {
            if (eventType === 'remove') {
                this._matcher.recordStreamRemoved(id);
                this._scheduleSync(20, false);
            } else if (eventType === 'new') {
                this._scheduleSync(10, false);
                this._scheduleFollowUpSync(150);
            } else if (eventType === 'change') {
                this._scheduleSync(25, false);
            }
        } else if (
            facility === 'sink' ||
            facility === 'card' ||
            facility === 'server' ||
            facility === 'module'
        ) {
            this._scheduleSync(50, true);
            this._scheduleFollowUpSync(300);
        }
    }

    _scheduleSubscribeRestart() {
        if (this._destroyed || this._subscribeRestartTimerId)
            return;

        this._stopSubscribeLoop();

        this._subscribeRestartTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1000,
            () => {
                this._subscribeRestartTimerId = 0;
                if (!this._destroyed) {
                    this._startSubscribeLoop();
                    this._scheduleSync(100, true);
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _stopSubscribeLoop() {
        if (this._subscribeCancel) {
            this._subscribeCancel.cancel();
            this._subscribeCancel = null;
        }
        if (this._subscribeProc) {
            try {
                this._subscribeProc.force_exit();
            } catch (_e) {
            }
            this._subscribeProc = null;
        }
    }

    _execPactl(args) {
        return new Promise((resolve, reject) => {
            try {
                const proc = Gio.Subprocess.new(
                    ['/usr/bin/env', 'LC_ALL=C.UTF-8', 'LANG=C.UTF-8', 'pactl', ...args],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                proc.communicate_utf8_async(null, null, (process, res) => {
                    try {
                        const [, stdout, stderr] = process.communicate_utf8_finish(res);
                        if (process.get_successful()) {
                            resolve(stdout || '');
                        } else {
                            reject(new Error((stderr || '').trim() || `pactl ${args[0]} failed`));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    _parseDefaultSink(infoText = '') {
        for (const line of infoText.split('\n')) {
            if (line.startsWith('Default Sink:')) {
                return line.slice('Default Sink:'.length).trim();
            }
        }
        return '';
    }

    _parseSinks(text = '') {
        const sinks = [];
        let current = null;
        let inProps = false;

        for (const rawLine of text.split('\n')) {
            const headerMatch = rawLine.match(/^Sink\s+#(\d+)/);
            if (headerMatch) {
                if (current)
                    sinks.push(current);
                current = {
                    index: Number.parseInt(headerMatch[1], 10),
                    name: '',
                    description: '',
                    state: '',
                    ownerModule: '',
                    mute: false,
                    properties: {},
                };
                inProps = false;
                continue;
            }

            if (!current)
                continue;

            if (/^\tProperties:\s*$/.test(rawLine)) {
                inProps = true;
                continue;
            }

            if (inProps) {
                if (rawLine.startsWith('\t\t')) {
                    const propMatch = rawLine.trim().match(/^([^=]+?)\s*=\s*"(.*)"$/);
                    if (propMatch) {
                        current.properties[propMatch[1].trim()] = propMatch[2];
                    }
                    continue;
                } else if (rawLine.startsWith('\t') && !rawLine.startsWith('\t\t')) {
                    inProps = false;
                }
            }

            const trimmed = rawLine.trim();
            if (trimmed.startsWith('Name:')) {
                current.name = trimmed.slice('Name:'.length).trim();
            } else if (trimmed.startsWith('Description:')) {
                current.description = trimmed.slice('Description:'.length).trim();
            } else if (trimmed.startsWith('State:')) {
                current.state = trimmed.slice('State:'.length).trim();
            } else if (trimmed.startsWith('Owner Module:')) {
                current.ownerModule = trimmed.slice('Owner Module:'.length).trim();
            } else if (trimmed.startsWith('Mute:')) {
                current.mute = trimmed.slice('Mute:'.length).trim().toLowerCase() === 'yes';
            }
        }

        if (current)
            sinks.push(current);

        return sinks;
    }

    _parseSinkInputs(text = '') {
        const inputs = [];
        let current = null;
        let inProps = false;

        for (const rawLine of text.split('\n')) {
            const headerMatch = rawLine.match(/^Sink Input\s+#(\d+)/);
            if (headerMatch) {
                if (current)
                    inputs.push(current);
                current = {
                    index: Number.parseInt(headerMatch[1], 10),
                    sink: -1,
                    client: '',
                    ownerModule: '',
                    corked: false,
                    mute: false,
                    properties: {},
                };
                inProps = false;
                continue;
            }

            if (!current)
                continue;

            if (/^\tProperties:\s*$/.test(rawLine)) {
                inProps = true;
                continue;
            }

            if (inProps) {
                if (rawLine.startsWith('\t\t')) {
                    const propMatch = rawLine.trim().match(/^([^=]+?)\s*=\s*"(.*)"$/);
                    if (propMatch) {
                        current.properties[propMatch[1].trim()] = propMatch[2];
                    }
                    continue;
                } else if (rawLine.startsWith('\t') && !rawLine.startsWith('\t\t')) {
                    inProps = false;
                }
            }

            const trimmed = rawLine.trim();
            if (trimmed.startsWith('Sink:')) {
                current.sink = Number.parseInt(trimmed.slice('Sink:'.length).trim(), 10);
            } else if (trimmed.startsWith('Client:')) {
                current.client = trimmed.slice('Client:'.length).trim();
            } else if (trimmed.startsWith('Owner Module:')) {
                current.ownerModule = trimmed.slice('Owner Module:'.length).trim();
            } else if (trimmed.startsWith('Corked:')) {
                current.corked = trimmed.slice('Corked:'.length).trim().toLowerCase() === 'yes';
            } else if (trimmed.startsWith('Mute:')) {
                current.mute = trimmed.slice('Mute:'.length).trim().toLowerCase() === 'yes';
            }
        }

        if (current)
            inputs.push(current);

        return inputs;
    }

    _notifyUI() {
        if (!this._destroyed && typeof this._onUpdate === 'function') {
            try {
                this._onUpdate();
            } catch (e) {
                console.error(`[StereoSplitter] UI update error: ${e}`);
            }
        }
    }

    async destroy() {
        this._destroyed = true;

        if (this._syncTimerId) {
            GLib.Source.remove(this._syncTimerId);
            this._syncTimerId = 0;
        }
        if (this._followUpTimerId) {
            GLib.Source.remove(this._followUpTimerId);
            this._followUpTimerId = 0;
        }
        if (this._healthTimerId) {
            GLib.Source.remove(this._healthTimerId);
            this._healthTimerId = 0;
        }
        if (this._subscribeRestartTimerId) {
            GLib.Source.remove(this._subscribeRestartTimerId);
            this._subscribeRestartTimerId = 0;
        }

        this._stopSubscribeLoop();

        await this._restoreAllStreamsToOriginal();
        await this._unloadOwnedModules();
    }
}
