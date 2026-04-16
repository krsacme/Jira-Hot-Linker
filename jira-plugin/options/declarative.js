/*global chrome */
import defaultConfig from 'options/config';
import regexEscape from 'escape-string-regexp';
import {storageGet} from 'src/chrome';

export function toMatchUrl(pattern) {
  if (pattern === '<all_urls>') {
    return '*://*/*';
  }
  if (pattern.indexOf('://') === -1) {
    pattern = '*://' + pattern;
  }
  if (!hasPathSlash.test(pattern)) {
    pattern = pattern + '/';
  }
  if (pattern.indexOf('*') === -1) {
    pattern = pattern + '*';
  }
  return pattern;
}

export const hasPathSlash = /.*:\/\/.*\//;
export const contentScript = 'build/main.js';

export async function resetDeclarativeMapping() {
  const config = await storageGet(defaultConfig);

  // Use chrome.scripting.registerContentScripts (MV3) instead of
  // declarativeContent.RequestContentScript (removed in MV3)
  try {
    await chrome.scripting.unregisterContentScripts({ids: ['jira-hotlinker-content']});
  } catch (e) {
    // Script might not be registered yet, that's fine
  }

  const matchPatterns = config.domains.map(toMatchUrl);

  if (matchPatterns.length === 0) {
    return;
  }

  await chrome.scripting.registerContentScripts([{
    id: 'jira-hotlinker-content',
    matches: matchPatterns,
    js: [contentScript],
    runAt: 'document_idle'
  }]);

  // Still set up declarativeContent for the action icon state
  chrome.declarativeContent.onPageChanged.removeRules(
    undefined,
    function () {
      const conditions = config.domains.map(domain => {
        const urlRegex = regexEscape(toMatchUrl(domain).replace(/\*/g, '__WILD__')).replace(/__WILD__/g, '.*');
        return new chrome.declarativeContent.PageStateMatcher({
          pageUrl: {
            urlMatches: urlRegex,
            schemes: ['http', 'https'],
          }
        });
      });
      chrome.declarativeContent.onPageChanged.addRules([{
        conditions: conditions,
        actions: [new chrome.declarativeContent.ShowAction()]
      }]);
    }
  );
}
