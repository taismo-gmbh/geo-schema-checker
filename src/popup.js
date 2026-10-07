import { collectPageData } from './collect.js';
import { evaluate } from './rules.js';
import { getStrings } from './i18n.js';
import { render, renderLoading, renderMessage, catState } from './ui.js';

const uiLang = (chrome.i18n && chrome.i18n.getUILanguage()) || navigator.language || 'de';
const langKey = uiLang.toLowerCase().startsWith('de') ? 'de' : 'en';
const S = getStrings(langKey);
document.documentElement.lang = langKey;

const root = document.getElementById('app');

// Toolbar-Icon dieses Tabs auf den Status der Prüfung setzen; Fehlerzahl als Badge in taismo-Orange.
function showState(tabId, counts) {
  if (!tabId || !chrome.action) return;
  const state = catState(counts);
  chrome.action.setIcon({ tabId, path: { 16: `/icons/state-${state}-16.png`, 32: `/icons/state-${state}-32.png` } }).catch(() => {});
  const errors = counts && counts.err ? String(counts.err) : '';
  chrome.action.setBadgeText({ tabId, text: errors }).catch(() => {});
  if (errors) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#ED8924' }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {});
  }
}

async function run() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    tab = null;
  }
  // Kopf, Katze und Fuß sofort, die Ergebnisse kommen dazu, sobald sie da sind.
  renderLoading(root, S, tab && tab.url, langKey);

  if (!tab || !/^https?:/i.test(tab.url || '') || /^https:\/\/chromewebstore\.google\.com/i.test(tab.url)) {
    renderMessage(root, S, S.cannotCheck, langKey);
    return;
  }

  let data;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectPageData });
    data = res && res.result;
  } catch (e) {
    renderMessage(root, S, S.cannotCheck, langKey);
    return;
  }
  if (!data) {
    renderMessage(root, S, S.failed, langKey);
    return;
  }

  try {
    const result = evaluate(data);
    render(root, data, result, S, langKey);
    showState(tab.id, result.counts);
  } catch (e) {
    console.error(e);
    renderMessage(root, S, S.failed, langKey);
  }
}

run();
