import GLib from 'gi://GLib';
import {MODES} from './stateStore.js';

const GENERIC_MEDIA_NAMES = new Set([
    '',
    '(null)',
    'null',
    'audiostream',
    'audio stream',
    'playback',
    'playback stream',
    'audio',
    'output',
    'alsa playback',
    'pulseaudio',
    'pipewire',
    'webrtc',
    'voiceengine',
]);

const KNOWN_SITES = [
    {pattern: /(?:^|\s|[-—|])\s*youtube music\s*$/i, key: 'site:youtube-music'},
    {pattern: /(?:^|\s|[-—|])\s*youtube\s*$/i, key: 'site:youtube'},
    {pattern: /(?:^|\s|[-—|])\s*twitch\s*$/i, key: 'site:twitch'},
    {pattern: /(?:^|\s|[-—|])\s*soundcloud\s*$/i, key: 'site:soundcloud'},
    {pattern: /(?:^|\s|[-—|])\s*vk(?:\s+video|\s+видео)?\s*$/i, key: 'site:vk'},
    {pattern: /(?:^|\s|[-—|])\s*kinopoisk|кинопоиск\s*$/i, key: 'site:kinopoisk'},
    {pattern: /\b(?:kodik|alloha|sibnet|aniboom|videocdn|collaps|ashdi|playerjs|hdrezka|rezka)(?:\s+player)?\b/i, key: 'site:kodik'},
    {pattern: /\[тв\]|\bs\d+-e\d+\b|\b(?:аниме|мега-аниме|anime|серия|сезон|фильм|смотреть)\b/i, key: 'site:movie-player'},
];

export function normalizeAppIdentity(props = {}) {
    const rawAppName = (props['application.name'] || '').trim();
    const rawAppId = (props['application.id'] || '').trim();
    const rawBinary = (props['application.process.binary'] || '').trim();
    const rawNodeName = (props['node.name'] || '').trim();

    const lowerName = rawAppName.toLowerCase();
    const lowerBin = rawBinary.toLowerCase();
    const lowerId = rawAppId.toLowerCase();

    if (
        lowerBin.includes('discord') ||
        lowerId.includes('discord') ||
        lowerName.includes('discord') ||
        lowerBin.includes('vesktop')
    ) {
        return {appKey: 'discord', appName: 'Discord'};
    }

    if (
        lowerBin.includes('spotify') ||
        lowerId.includes('spotify') ||
        lowerName.includes('spotify')
    ) {
        return {appKey: 'spotify', appName: 'Spotify'};
    }

    if (
        lowerBin.startsWith('firefox') ||
        lowerId.includes('firefox') ||
        lowerName.includes('firefox')
    ) {
        return {appKey: 'firefox', appName: 'Firefox'};
    }

    if (
        lowerBin.includes('telegram') ||
        lowerId.includes('telegram') ||
        lowerName.includes('telegram')
    ) {
        return {appKey: 'telegram', appName: 'Telegram'};
    }

    if (
        lowerBin.includes('chrome') ||
        lowerName.includes('google chrome')
    ) {
        return {appKey: 'chrome', appName: 'Google Chrome'};
    }

    if (
        lowerBin.includes('chromium') ||
        lowerName.includes('chromium')
    ) {
        return {appKey: 'chromium', appName: 'Chromium'};
    }

    if (
        lowerBin.includes('brave') ||
        lowerName.includes('brave')
    ) {
        return {appKey: 'brave', appName: 'Brave'};
    }

    let appName = rawAppName || rawBinary || rawNodeName || rawAppId || 'Audio Stream';
    if (
        lowerName === 'webrtc voiceengine' ||
        lowerName === 'fmod ex app' ||
        lowerName === 'sdl application' ||
        lowerName === 'cubeb'
    ) {
        if (rawBinary)
            appName = rawBinary;
    }

    const baseKey = (rawAppId || appName || rawBinary || 'unknown')
        .toLowerCase()
        .replace(/\.desktop$/i, '')
        .replace(/-esr$/i, '')
        .trim();

    return {
        appKey: baseKey || 'unknown',
        appName,
    };
}

export function extractMediaSignatures(rawMediaName = '') {
    const trimmed = (rawMediaName || '').trim();
    const lower = trimmed.toLowerCase();

    if (!trimmed || GENERIC_MEDIA_NAMES.has(lower)) {
        return {
            isGeneric: true,
            mediaKey: '',
            signatures: [],
        };
    }

    const withoutNotifCount = lower.replace(/^\(\d+\)\s*/, '').trim();
    const mediaKey = withoutNotifCount || lower;
    const signatures = [];

    for (const site of KNOWN_SITES) {
        if (site.pattern.test(withoutNotifCount)) {
            signatures.push(site.key);
        }
    }

    const dashParts = withoutNotifCount.split(/\s+[-—|]\s+/);
    if (dashParts.length >= 2) {
        const suffix = dashParts[dashParts.length - 1].trim();
        if (suffix.length >= 3 && suffix.length <= 30 && !/^\d+$/.test(suffix)) {
            const siteSig = `suffix:${suffix}`;
            if (!signatures.includes(siteSig))
                signatures.push(siteSig);
        }
    }

    const episodePattern = withoutNotifCount
        .replace(/\bs\d+\b/gi, 's#')
        .replace(/\be\d+\b/gi, 'e#')
        .replace(/s\d+-e\d+/gi, 's#-e#')
        .replace(/(?:серия|эпизод|episode|ep\.?|part|часть)\s*\d+/gi, 'ep#')
        .replace(/\b\d+\b/g, '#')
        .replace(/\s+/g, ' ')
        .trim();

    if (episodePattern.length >= 4 && /[a-zа-яё]/i.test(episodePattern)) {
        const patSig = `pattern:${episodePattern}`;
        if (!signatures.includes(patSig))
            signatures.push(patSig);
    }

    return {
        isGeneric: false,
        mediaKey,
        signatures,
    };
}

export class StreamMatcher {
    constructor(stateStore) {
        this._store = stateStore;
        this._activeStreamModes = new Map();
        this._userExplicitStreamModes = new Map();
        this._lockedStreamModes = new Map();
        this._activeStreamSnapshots = new Map();
        this._streamCreatedAtUs = new Map();
        this._appSplitChannels = new Map();
        this._recentlyRemoved = [];
    }

    hasActiveStream(index) {
        return this._activeStreamModes.has(index);
    }

    recordStreamRemoved(index) {
        const snapshot = this._activeStreamSnapshots.get(index);
        const mode =
            this._lockedStreamModes.get(index) ||
            this._userExplicitStreamModes.get(index) ||
            this._activeStreamModes.get(index);
        const removedCreatedAt = this._streamCreatedAtUs.get(index) || 0;

        if (snapshot && mode) {
            const nowUs = GLib.get_monotonic_time();
            let handedOffToRecentSibling = false;

            for (const [otherIndex, otherSnap] of this._activeStreamSnapshots.entries()) {
                if (otherIndex <= index || otherSnap.appKey !== snapshot.appKey)
                    continue;

                const otherCreatedAt = this._streamCreatedAtUs.get(otherIndex) || 0;
                const ageUs = nowUs - otherCreatedAt;
                const otherMode = this._activeStreamModes.get(otherIndex);

                if (
                    otherCreatedAt >= removedCreatedAt &&
                    ageUs >= 0 &&
                    ageUs <= 2 * 1000 * 1000 &&
                    !this._lockedStreamModes.has(otherIndex) &&
                    otherMode !== mode
                ) {
                    this._lockedStreamModes.set(otherIndex, mode);
                    this._userExplicitStreamModes.set(otherIndex, mode);
                    this._activeStreamModes.set(otherIndex, mode);
                    if (otherSnap.mediaKey) {
                        this._store.streamMediaRules[
                            `${otherSnap.appKey}::${otherSnap.mediaKey}`
                        ] = mode;
                        this._store.scheduleSave();
                    }
                    handedOffToRecentSibling = true;
                    break;
                }
            }

            if (!handedOffToRecentSibling) {
                this._recentlyRemoved.push({
                    index,
                    appKey: snapshot.appKey,
                    mediaKey: snapshot.mediaKey,
                    signatures: snapshot.signatures,
                    mode,
                    removedAtUs: nowUs,
                });
            }

            this._pruneRecentlyRemoved(nowUs);
        }

        this._activeStreamSnapshots.delete(index);
        this._activeStreamModes.delete(index);
        this._userExplicitStreamModes.delete(index);
        this._lockedStreamModes.delete(index);
        this._streamCreatedAtUs.delete(index);
    }

    _pruneRecentlyRemoved(nowUs = GLib.get_monotonic_time()) {
        const maxAgeUs = 300 * 1000 * 1000;
        this._recentlyRemoved = this._recentlyRemoved.filter(
            item => nowUs - item.removedAtUs <= maxAgeUs
        );
    }

    assignStreamMode(stream, mode, allAppStreams = []) {
        const nowUs = GLib.get_monotonic_time();
        if (!this._streamCreatedAtUs.has(stream.index))
            this._streamCreatedAtUs.set(stream.index, nowUs);

        this._lockedStreamModes.set(stream.index, mode);
        this._userExplicitStreamModes.set(stream.index, mode);
        this._activeStreamModes.set(stream.index, mode);
        this._activeStreamSnapshots.set(stream.index, {
            appKey: stream.appKey,
            mediaKey: stream.mediaKey,
            signatures: stream.signatures,
        });

        const otherStreams = allAppStreams.filter(s => s.index !== stream.index);
        let hasDifferentPeer = false;
        const activeModesSet = new Set([mode]);

        for (const peer of otherStreams) {
            if (!this._streamCreatedAtUs.has(peer.index))
                this._streamCreatedAtUs.set(peer.index, nowUs);

            const peerMode =
                this._lockedStreamModes.get(peer.index) ||
                this._userExplicitStreamModes.get(peer.index) ||
                this._activeStreamModes.get(peer.index) ||
                peer.mode;

            if (peerMode) {
                this._lockedStreamModes.set(peer.index, peerMode);
                this._userExplicitStreamModes.set(peer.index, peerMode);
                this._activeStreamModes.set(peer.index, peerMode);
                this._activeStreamSnapshots.set(peer.index, {
                    appKey: peer.appKey,
                    mediaKey: peer.mediaKey,
                    signatures: peer.signatures,
                });
                activeModesSet.add(peerMode);
                if (peerMode !== mode)
                    hasDifferentPeer = true;
            }
        }

        if (activeModesSet.size > 1) {
            this._appSplitChannels.set(stream.appKey, new Set(activeModesSet));
        } else {
            this._appSplitChannels.delete(stream.appKey);
        }

        const conflictingSignaturesSet = new Set();
        let hasSameMediaKeyConflict = false;

        for (const peer of otherStreams) {
            const peerMode =
                this._lockedStreamModes.get(peer.index) ||
                this._userExplicitStreamModes.get(peer.index) ||
                this._activeStreamModes.get(peer.index) ||
                peer.mode;

            if (peerMode && peerMode !== mode) {
                if (peer.mediaKey && stream.mediaKey && peer.mediaKey === stream.mediaKey)
                    hasSameMediaKeyConflict = true;

                if (Array.isArray(peer.signatures)) {
                    for (const sig of peer.signatures)
                        conflictingSignaturesSet.add(sig);
                }
            }
        }

        const conflictingSignatures = Array.from(conflictingSignaturesSet);

        for (const peer of otherStreams) {
            const peerMode =
                this._lockedStreamModes.get(peer.index) ||
                this._userExplicitStreamModes.get(peer.index) ||
                this._activeStreamModes.get(peer.index) ||
                peer.mode;

            if (peerMode && peerMode !== mode) {
                const peerUniqueSigs = (peer.signatures || []).filter(
                    sig => !(stream.signatures || []).includes(sig)
                );
                const peerMediaKey =
                    peer.mediaKey && peer.mediaKey !== stream.mediaKey
                        ? peer.mediaKey
                        : '';
                this._store.setStreamRule(
                    peer.appKey,
                    peerMediaKey,
                    peerUniqueSigs,
                    peerMode,
                    true,
                    conflictingSignatures
                );
            }
        }

        const uniqueSignatures = (stream.signatures || []).filter(
            sig => !conflictingSignaturesSet.has(sig)
        );

        const effectiveMediaKey = hasSameMediaKeyConflict ? '' : stream.mediaKey;
        if (hasSameMediaKeyConflict && stream.mediaKey) {
            delete this._store.streamMediaRules[`${stream.appKey}::${stream.mediaKey}`];
        }

        this._store.setStreamRule(
            stream.appKey,
            effectiveMediaKey,
            uniqueSignatures,
            mode,
            hasDifferentPeer,
            conflictingSignatures
        );
    }

    assignAppMode(appKey, mode, appStreams = []) {
        const nowUs = GLib.get_monotonic_time();
        this._store.setAppRule(appKey, mode, true);
        this._appSplitChannels.delete(appKey);
        this._recentlyRemoved = this._recentlyRemoved.filter(r => r.appKey !== appKey);

        for (const stream of appStreams) {
            if (!this._streamCreatedAtUs.has(stream.index))
                this._streamCreatedAtUs.set(stream.index, nowUs);
            this._lockedStreamModes.set(stream.index, mode);
            this._userExplicitStreamModes.set(stream.index, mode);
            this._activeStreamModes.set(stream.index, mode);
            this._activeStreamSnapshots.set(stream.index, {
                appKey: stream.appKey,
                mediaKey: stream.mediaKey,
                signatures: stream.signatures,
            });
            if (stream.mediaKey || (stream.signatures && stream.signatures.length > 0)) {
                this._store.setStreamRule(
                    stream.appKey,
                    stream.mediaKey,
                    stream.signatures,
                    mode,
                    false
                );
            }
        }
    }

    resolveStreamMode(
        stream,
        allCurrentStreams = [],
        currentHardwareMode = null,
        allowHardwareAdopt = false
    ) {
        const nowUs = GLib.get_monotonic_time();
        this._pruneRecentlyRemoved(nowUs);

        if (!this._streamCreatedAtUs.has(stream.index)) {
            this._streamCreatedAtUs.set(stream.index, nowUs);
        }

        const explicitMode =
            this._lockedStreamModes.get(stream.index) ||
            this._userExplicitStreamModes.get(stream.index);
        if (explicitMode) {
            const prevSnap = this._activeStreamSnapshots.get(stream.index);
            if (
                stream.mediaKey &&
                prevSnap &&
                prevSnap.mediaKey !== stream.mediaKey
            ) {
                const peerWithSameMedia = allCurrentStreams.some(
                    s =>
                        s.index !== stream.index &&
                        s.appKey === stream.appKey &&
                        s.mediaKey === stream.mediaKey &&
                        (this._activeStreamModes.get(s.index) || s.mode) !== explicitMode
                );
                if (!peerWithSameMedia) {
                    this._store.streamMediaRules[
                        `${stream.appKey}::${stream.mediaKey}`
                    ] = explicitMode;
                    this._store.scheduleSave();
                }
            }
            this._rememberStream(stream, explicitMode, this._lockedStreamModes.has(stream.index));
            return explicitMode;
        }

        const existingActiveMode = this._activeStreamModes.get(stream.index);
        const prevSnapshot = this._activeStreamSnapshots.get(stream.index);
        if (existingActiveMode && prevSnapshot) {
            if (prevSnapshot.mediaKey && stream.mediaKey) {
                if (prevSnapshot.mediaKey !== stream.mediaKey) {
                    this._lockedStreamModes.set(stream.index, existingActiveMode);
                    this._userExplicitStreamModes.set(stream.index, existingActiveMode);
                    this._store.streamMediaRules[
                        `${stream.appKey}::${stream.mediaKey}`
                    ] = existingActiveMode;
                    this._store.scheduleSave();
                }
                this._rememberStream(stream, existingActiveMode, true);
                return existingActiveMode;
            }
            if (!stream.mediaKey) {
                this._rememberStream(stream, existingActiveMode, false);
                return existingActiveMode;
            }
        }

        const activePeers = allCurrentStreams.filter(
            s => s.index !== stream.index && s.appKey === stream.appKey
        );

        const sameAppRemoved = this._recentlyRemoved.filter(
            r => r.appKey === stream.appKey
        );

        if (sameAppRemoved.length > 0) {
            const peerOccupiedModes = new Set();
            for (const peer of activePeers) {
                if (!peer.corked) {
                    const pm =
                        this._lockedStreamModes.get(peer.index) ||
                        this._userExplicitStreamModes.get(peer.index) ||
                        this._activeStreamModes.get(peer.index) ||
                        peer.mode;
                    if (pm)
                        peerOccupiedModes.add(pm);
                }
            }

            let chosenRemoved = null;

            if (peerOccupiedModes.size > 0) {
                const nonConflictingRemoved = sameAppRemoved.filter(
                    r => !peerOccupiedModes.has(r.mode)
                );
                if (nonConflictingRemoved.length > 0) {
                    chosenRemoved =
                        nonConflictingRemoved[nonConflictingRemoved.length - 1];
                }
            }

            if (!chosenRemoved && Array.isArray(stream.signatures) && stream.signatures.length > 0) {
                const sigMatched = sameAppRemoved.filter(
                    r =>
                        Array.isArray(r.signatures) &&
                        r.signatures.some(sig => stream.signatures.includes(sig))
                );
                if (sigMatched.length > 0)
                    chosenRemoved = sigMatched[sigMatched.length - 1];
            }

            if (!chosenRemoved) {
                chosenRemoved = sameAppRemoved[sameAppRemoved.length - 1];
            }

            if (chosenRemoved) {
                const rmIdx = this._recentlyRemoved.indexOf(chosenRemoved);
                if (rmIdx !== -1)
                    this._recentlyRemoved.splice(rmIdx, 1);

                const inheritedMode = chosenRemoved.mode;
                this._lockedStreamModes.set(stream.index, inheritedMode);
                this._userExplicitStreamModes.set(stream.index, inheritedMode);
                if (stream.mediaKey) {
                    this._store.streamMediaRules[
                        `${stream.appKey}::${stream.mediaKey}`
                    ] = inheritedMode;
                    this._store.scheduleSave();
                }
                this._rememberStream(stream, inheritedMode, true);
                return inheritedMode;
            }
        }

        if (activePeers.length > 0) {
            const uncorkedPeerModes = new Set();
            let corkedPeerMode = null;

            for (const peer of activePeers) {
                const pm =
                    this._lockedStreamModes.get(peer.index) ||
                    this._userExplicitStreamModes.get(peer.index) ||
                    this._activeStreamModes.get(peer.index) ||
                    peer.mode;
                if (!pm)
                    continue;
                if (peer.corked) {
                    corkedPeerMode = pm;
                } else {
                    uncorkedPeerModes.add(pm);
                }
            }

            if (
                corkedPeerMode &&
                uncorkedPeerModes.size > 0 &&
                !uncorkedPeerModes.has(corkedPeerMode)
            ) {
                this._lockedStreamModes.set(stream.index, corkedPeerMode);
                this._userExplicitStreamModes.set(stream.index, corkedPeerMode);
                if (stream.mediaKey) {
                    this._store.streamMediaRules[
                        `${stream.appKey}::${stream.mediaKey}`
                    ] = corkedPeerMode;
                    this._store.scheduleSave();
                }
                this._rememberStream(stream, corkedPeerMode, true);
                return corkedPeerMode;
            }

            const splitChannels = this._appSplitChannels.get(stream.appKey);
            if (
                splitChannels &&
                splitChannels.size > 1 &&
                uncorkedPeerModes.size > 0 &&
                uncorkedPeerModes.size < splitChannels.size
            ) {
                for (const candidateMode of splitChannels) {
                    if (!uncorkedPeerModes.has(candidateMode)) {
                        this._lockedStreamModes.set(stream.index, candidateMode);
                        this._userExplicitStreamModes.set(stream.index, candidateMode);
                        if (stream.mediaKey) {
                            this._store.streamMediaRules[
                                `${stream.appKey}::${stream.mediaKey}`
                            ] = candidateMode;
                            this._store.scheduleSave();
                        }
                        this._rememberStream(stream, candidateMode, true);
                        return candidateMode;
                    }
                }
            }
        }

        const isSplitApp = Boolean(this._store.appSplitMode?.[stream.appKey]);

        if (stream.mediaKey) {
            const exactRule =
                this._store.streamMediaRules[`${stream.appKey}::${stream.mediaKey}`];
            if (exactRule) {
                const peerAlreadyUsingSameMediaAndMode =
                    isSplitApp &&
                    activePeers.some(
                        p =>
                            p.mediaKey === stream.mediaKey &&
                            (this._activeStreamModes.get(p.index) || p.mode) === exactRule
                    );
                if (!peerAlreadyUsingSameMediaAndMode) {
                    this._rememberStream(stream, exactRule, false);
                    return exactRule;
                }
            }
        }

        if (Array.isArray(stream.signatures) && stream.signatures.length > 0) {
            for (const sig of stream.signatures) {
                const sigRule =
                    this._store.streamSignatureRules[`${stream.appKey}::${sig}`];
                if (sigRule) {
                    const peerConflictOnSig =
                        isSplitApp &&
                        activePeers.some(
                            p =>
                                Array.isArray(p.signatures) &&
                                p.signatures.includes(sig) &&
                                (this._activeStreamModes.get(p.index) || p.mode) === sigRule
                        );
                    if (!peerConflictOnSig) {
                        this._rememberStream(stream, sigRule, false);
                        return sigRule;
                    }
                }
            }
        }

        if (
            allowHardwareAdopt &&
            (currentHardwareMode === MODES.LEFT || currentHardwareMode === MODES.RIGHT)
        ) {
            this._lockedStreamModes.set(stream.index, currentHardwareMode);
            this._userExplicitStreamModes.set(stream.index, currentHardwareMode);
            this._rememberStream(stream, currentHardwareMode, true);
            return currentHardwareMode;
        }

        if (isSplitApp && (currentHardwareMode === MODES.LEFT || currentHardwareMode === MODES.RIGHT)) {
            this._rememberStream(stream, currentHardwareMode, false);
            return currentHardwareMode;
        }

        const appRule = this._store.appRules[stream.appKey];
        if (appRule) {
            this._rememberStream(stream, appRule, false);
            return appRule;
        }

        const fallback = existingActiveMode || MODES.STEREO;
        this._rememberStream(stream, fallback, false);
        return fallback;
    }

    _rememberStream(stream, mode, lockExplicit = false) {
        this._activeStreamModes.set(stream.index, mode);
        this._activeStreamSnapshots.set(stream.index, {
            appKey: stream.appKey,
            mediaKey: stream.mediaKey,
            signatures: stream.signatures,
        });

        if (lockExplicit) {
            this._lockedStreamModes.set(stream.index, mode);
            this._userExplicitStreamModes.set(stream.index, mode);
        }
    }

    pruneStaleStreams(currentIndicesSet) {
        for (const index of Array.from(this._activeStreamModes.keys())) {
            if (!currentIndicesSet.has(index)) {
                this.recordStreamRemoved(index);
            }
        }
    }
}
