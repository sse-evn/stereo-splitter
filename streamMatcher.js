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
        this._activeStreamSnapshots = new Map();
        this._recentlyRemoved = [];
    }

    recordStreamRemoved(index) {
        const snapshot = this._activeStreamSnapshots.get(index);
        const mode =
            this._userExplicitStreamModes.get(index) ||
            this._activeStreamModes.get(index);

        if (snapshot && mode) {
            const nowUs = GLib.get_monotonic_time();
            this._recentlyRemoved.push({
                index,
                appKey: snapshot.appKey,
                mediaKey: snapshot.mediaKey,
                signatures: snapshot.signatures,
                mode,
                removedAtUs: nowUs,
            });
            this._pruneRecentlyRemoved(nowUs);
        }

        this._activeStreamSnapshots.delete(index);
        this._activeStreamModes.delete(index);
        this._userExplicitStreamModes.delete(index);
    }

    _pruneRecentlyRemoved(nowUs = GLib.get_monotonic_time()) {
        const maxAgeUs = 30 * 1000 * 1000;
        this._recentlyRemoved = this._recentlyRemoved.filter(
            item => nowUs - item.removedAtUs <= maxAgeUs
        );
    }

    assignStreamMode(stream, mode, allAppStreams = []) {
        this._userExplicitStreamModes.set(stream.index, mode);
        this._activeStreamModes.set(stream.index, mode);
        this._activeStreamSnapshots.set(stream.index, {
            appKey: stream.appKey,
            mediaKey: stream.mediaKey,
            signatures: stream.signatures,
        });

        const otherStreams = allAppStreams.filter(s => s.index !== stream.index);
        const hasDifferentPeer = otherStreams.some(
            s => (this._activeStreamModes.get(s.index) || s.mode) !== mode
        );

        for (const peer of otherStreams) {
            const peerMode =
                this._userExplicitStreamModes.get(peer.index) ||
                this._activeStreamModes.get(peer.index) ||
                peer.mode;
            if (peerMode && peerMode !== mode && (peer.mediaKey || peer.signatures?.length)) {
                this._store.setStreamRule(
                    peer.appKey,
                    peer.mediaKey,
                    peer.signatures,
                    peerMode,
                    true
                );
            }
        }

        const peerSignatures = new Set();
        for (const peer of otherStreams) {
            const peerMode = this._activeStreamModes.get(peer.index) || peer.mode;
            if (peerMode !== mode && Array.isArray(peer.signatures)) {
                for (const sig of peer.signatures)
                    peerSignatures.add(sig);
            }
        }

        const uniqueSignatures = (stream.signatures || []).filter(
            sig => !peerSignatures.has(sig)
        );

        this._store.setStreamRule(
            stream.appKey,
            stream.mediaKey,
            uniqueSignatures,
            mode,
            hasDifferentPeer
        );
    }

    assignAppMode(appKey, mode, appStreams = []) {
        this._store.setAppRule(appKey, mode, true);

        for (const stream of appStreams) {
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

        const explicitMode = this._userExplicitStreamModes.get(stream.index);
        if (explicitMode) {
            this._rememberStream(stream, explicitMode);
            return explicitMode;
        }

        if (stream.mediaKey) {
            const exactRule =
                this._store.streamMediaRules[`${stream.appKey}::${stream.mediaKey}`];
            if (exactRule) {
                this._rememberStream(stream, exactRule);
                return exactRule;
            }
        }

        if (Array.isArray(stream.signatures) && stream.signatures.length > 0) {
            for (const sig of stream.signatures) {
                const sigRule =
                    this._store.streamSignatureRules[`${stream.appKey}::${sig}`];
                if (sigRule) {
                    this._rememberStream(stream, sigRule);
                    return sigRule;
                }
            }
        }

        const isSplitApp = Boolean(this._store.appSplitMode?.[stream.appKey]);
        const sameAppRemoved = this._recentlyRemoved.filter(
            r => r.appKey === stream.appKey
        );

        if (isSplitApp && !stream.mediaKey) {
            if (sameAppRemoved.length > 0) {
                const latestRemoved = sameAppRemoved[sameAppRemoved.length - 1];
                this._rememberStream(stream, latestRemoved.mode);
                return latestRemoved.mode;
            }
            if (currentHardwareMode === MODES.LEFT || currentHardwareMode === MODES.RIGHT) {
                this._rememberStream(stream, currentHardwareMode);
                return currentHardwareMode;
            }
        }

        const appRule = this._store.appRules[stream.appKey];
        if (appRule) {
            this._rememberStream(stream, appRule);
            return appRule;
        }

        if (sameAppRemoved.length > 0) {
            let matchedRemoved = sameAppRemoved.find(
                r => stream.mediaKey && r.mediaKey === stream.mediaKey
            );
            if (!matchedRemoved && Array.isArray(stream.signatures)) {
                matchedRemoved = sameAppRemoved.find(
                    r =>
                        Array.isArray(r.signatures) &&
                        r.signatures.some(sig => stream.signatures.includes(sig))
                );
            }
            if (!matchedRemoved)
                matchedRemoved = sameAppRemoved[sameAppRemoved.length - 1];

            this._rememberStream(stream, matchedRemoved.mode);
            return matchedRemoved.mode;
        }

        if (
            allowHardwareAdopt &&
            (currentHardwareMode === MODES.LEFT || currentHardwareMode === MODES.RIGHT)
        ) {
            this._rememberStream(stream, currentHardwareMode);
            return currentHardwareMode;
        }

        const fallback = this._activeStreamModes.get(stream.index) || MODES.STEREO;
        this._rememberStream(stream, fallback);
        return fallback;
    }

    _rememberStream(stream, mode) {
        this._activeStreamModes.set(stream.index, mode);
        this._activeStreamSnapshots.set(stream.index, {
            appKey: stream.appKey,
            mediaKey: stream.mediaKey,
            signatures: stream.signatures,
        });
    }

    pruneStaleStreams(currentIndicesSet) {
        for (const index of Array.from(this._activeStreamModes.keys())) {
            if (!currentIndicesSet.has(index)) {
                this.recordStreamRemoved(index);
            }
        }
    }
}
