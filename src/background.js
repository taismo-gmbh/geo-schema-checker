// Hintergrund der Erweiterung. Braucht keine zusätzliche Berechtigung.
//
// 1. Das Icon zeigt den Status der letzten Prüfung dieses Tabs. Lädt der Tab eine neue Seite,
//    gilt der alte Status nicht mehr: zurück zur normalen Katze, Badge leeren.
// 2. Nach der Installation öffnet sich die Begrüßungsseite auf taismo.de, bei der
//    Deinstallation die Feedback-Seite. Beides erst, wenn die Seiten live sind (PAGES_LIVE).

const PAGES_LIVE = false;

const PAGES = {
  de: {
    welcome: 'https://taismo.de/schema-checker/willkommen/',
    feedback: 'https://taismo.de/schema-checker/feedback/',
  },
  en: {
    welcome: 'https://taismo.de/en/schema-checker/welcome/',
    feedback: 'https://taismo.de/en/schema-checker/feedback/',
  },
};

function pages() {
  const lang = (chrome.i18n.getUILanguage() || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
  return PAGES[lang];
}

function withUtm(url, medium) {
  const u = new URL(url);
  u.searchParams.set('utm_source', 'chrome-extension');
  u.searchParams.set('utm_medium', medium);
  u.searchParams.set('utm_campaign', 'geo-schema-checker');
  return u.toString();
}

function setUninstall() {
  if (!PAGES_LIVE) return;
  chrome.runtime.setUninstallURL(withUtm(pages().feedback, 'uninstall')).catch(() => {});
}

// Standard-Icon ausdrücklich setzen: Chrome hält sonst ein früher geladenes Icon im Cache
// und zeigt es bis zum ersten Klick.
const DEFAULT_ICON = { 16: '/icons/icon-16.png', 32: '/icons/icon-32.png', 48: '/icons/icon-48.png', 128: '/icons/icon-128.png' };

function setDefaultIcon() {
  chrome.action.setIcon({ path: DEFAULT_ICON }).catch(() => {});
}

chrome.runtime.onStartup.addListener(setDefaultIcon);

chrome.runtime.onInstalled.addListener((details) => {
  setDefaultIcon();
  setUninstall();
  if (PAGES_LIVE && details.reason === 'install') {
    chrome.tabs.create({ url: withUtm(pages().welcome, 'install') }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(setUninstall);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  chrome.action.setIcon({ tabId, path: DEFAULT_ICON }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
