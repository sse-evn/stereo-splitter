import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

const DESKTOP_ID_CANDIDATES = {
    firefox: [
        'firefox.desktop',
        'firefox_firefox.desktop',
        'firefox-esr.desktop',
        'org.mozilla.firefox.desktop',
    ],
    spotify: [
        'spotify.desktop',
        'spotify_spotify.desktop',
        'com.spotify.Client.desktop',
    ],
    discord: [
        'discord.desktop',
        'discord_discord.desktop',
        'com.discordapp.Discord.desktop',
        'vesktop.desktop',
    ],
    telegram: [
        'org.telegram.desktop.desktop',
        'telegram-desktop_telegram-desktop.desktop',
        'telegramdesktop.desktop',
    ],
    chrome: [
        'google-chrome.desktop',
        'com.google.Chrome.desktop',
    ],
    chromium: [
        'chromium.desktop',
        'chromium_chromium.desktop',
        'org.chromium.Chromium.desktop',
    ],
    brave: [
        'brave-browser.desktop',
        'com.brave.Browser.desktop',
    ],
    steam: [
        'steam.desktop',
        'com.valvesoftware.Steam.desktop',
    ],
};

const ICON_NAME_MAP = {
    firefox: ['firefox', 'firefox-esr', 'web-browser-symbolic'],
    spotify: ['spotify', 'spotify-client', 'multimedia-player-symbolic'],
    discord: ['discord', 'com.discordapp.Discord', 'user-available-symbolic'],
    telegram: ['telegram', 'org.telegram.desktop', 'mail-send-symbolic'],
    chrome: ['google-chrome', 'web-browser-symbolic'],
    chromium: ['chromium', 'chromium-browser', 'web-browser-symbolic'],
    brave: ['brave-browser', 'brave-desktop', 'web-browser-symbolic'],
    steam: ['steam', 'applications-games-symbolic'],
};

export function resolveAppIconAndName(props = {}, appKey = 'unknown', fallbackName = 'Audio') {
    let displayName = fallbackName;

    try {
        const windowTracker = Shell.WindowTracker.get_default();
        const appSystem = Shell.AppSystem.get_default();

        const pidStr = props['application.process.id'];
        const pid = pidStr ? Number.parseInt(pidStr, 10) : 0;

        if (windowTracker && pid > 0) {
            const shellApp = windowTracker.get_app_from_pid(pid);
            if (shellApp) {
                const appInfo = shellApp.get_app_info?.();
                const gicon = appInfo?.get_icon?.() || shellApp.get_icon?.();
                const name = shellApp.get_name?.();
                if (name && (displayName === 'Audio Stream' || displayName === 'WEBRTC VoiceEngine'))
                    displayName = name;

                if (gicon)
                    return {gicon, displayName};
            }
        }

        if (appSystem) {
            const lookupCandidates = [];

            if (props['application.id']) {
                const id = props['application.id'];
                lookupCandidates.push(id.endsWith('.desktop') ? id : `${id}.desktop`);
            }
            if (DESKTOP_ID_CANDIDATES[appKey])
                lookupCandidates.push(...DESKTOP_ID_CANDIDATES[appKey]);

            if (props['application.process.binary']) {
                const bin = props['application.process.binary'];
                lookupCandidates.push(`${bin}.desktop`);
                lookupCandidates.push(`${bin.toLowerCase()}.desktop`);
            }
            if (appKey && appKey !== 'unknown')
                lookupCandidates.push(`${appKey}.desktop`);

            for (const desktopId of lookupCandidates) {
                const app =
                    appSystem.lookup_app(desktopId) ||
                    appSystem.lookup_heuristic_basename?.(desktopId);
                if (app) {
                    const appInfo = app.get_app_info?.();
                    const gicon = appInfo?.get_icon?.() || app.get_icon?.();
                    if (gicon)
                        return {gicon, displayName};
                }
            }

            const wmCandidates = [
                props['application.process.binary'],
                props['application.name'],
                appKey,
            ].filter(Boolean);

            for (const wm of wmCandidates) {
                const app =
                    appSystem.lookup_desktop_wmclass?.(wm) ||
                    appSystem.lookup_startup_wmclass?.(wm);
                if (app) {
                    const appInfo = app.get_app_info?.();
                    const gicon = appInfo?.get_icon?.() || app.get_icon?.();
                    if (gicon)
                        return {gicon, displayName};
                }
            }
        }
    } catch (_e) {
    }

    const themedNames = [];
    if (props['application.icon_name'])
        themedNames.push(props['application.icon_name']);

    if (ICON_NAME_MAP[appKey])
        themedNames.push(...ICON_NAME_MAP[appKey]);

    if (props['application.process.binary']) {
        const bin = props['application.process.binary'].toLowerCase();
        themedNames.push(bin);
        if (bin.endsWith('-esr'))
            themedNames.push(bin.replace(/-esr$/, ''));
    }

    if (appKey && appKey !== 'unknown')
        themedNames.push(appKey);

    themedNames.push('applications-multimedia-symbolic', 'audio-x-generic-symbolic');

    return {
        gicon: Gio.ThemedIcon.new_from_names(themedNames),
        displayName,
    };
}
