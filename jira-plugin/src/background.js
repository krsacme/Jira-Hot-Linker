/*global chrome */
import defaultConfig from 'options/config.js';
import {storageGet, storageSet, permissionsRequest, promisifyChrome} from 'src/chrome';
import {contentScript, resetDeclarativeMapping} from 'options/declarative';

const executeScript = promisifyChrome(chrome.scripting, 'executeScript');
const sendMessage = promisifyChrome(chrome.tabs, 'sendMessage');

console.log('[JX-BG] background.js service worker started');

var SEND_RESPONSE_IS_ASYNC = true;
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  console.log('[JX-BG] onMessage:', request.action, request.url ? request.url.substring(0, 80) : '');
  if (request.action === 'get') {
    fetch(request.url)
      .then(async response => {
        console.log('[JX-BG] fetch response:', response.status, response.statusText, 'for', request.url.substring(0, 80));
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} – ${response.statusText}`);
        }

        const contentType = response.headers.get('Content-Type') || '';
        const isJson = contentType.includes('application/json');

        const result = isJson
          ? await response.json()
          : await response.text();
        sendResponse({ result });
      })
      .catch(error => {
        console.error('[JX-BG] fetch error:', error.message, 'for', request.url);
        sendResponse({ error: error.message });
      });
    return SEND_RESPONSE_IS_ASYNC;
  }
});

async function browserOnClicked (tab) {
  console.log('[JX-BG] browserOnClicked, tab:', tab.id, tab.url);
  const config = await storageGet(defaultConfig);
  console.log('[JX-BG] config:', JSON.stringify(config));
  if (!config.instanceUrl || !config.v15upgrade) {
    console.log('[JX-BG] No instanceUrl or v15upgrade not set, opening options page');
    chrome.runtime.openOptionsPage();
    return;
  }
  const origin = new URL(tab.url).origin + '/';
  console.log('[JX-BG] Requesting permission for origin:', origin);
  const granted = await permissionsRequest({origins: [origin]});
  console.log('[JX-BG] Permission granted:', granted);
  if (granted) {
    const config = await storageGet(defaultConfig);
    if (config.domains.indexOf(origin) !== -1) {
      console.log('[JX-BG] Domain already added:', origin);
      try {
        await sendMessage(tab.id, {
          action: 'message',
          message: origin + ' is already added.'
        });
      } catch (ex) {
        console.log('[JX-BG] Content script not yet injected, injecting now...');
        await executeScript({
          target: {tabId: tab.id},
          files: [contentScript]
        });
        await sendMessage(tab.id, {
          action: 'message',
          message: 'Jira HotLinker enabled successfully !'
        });
      }
      return;
    }
    config.domains.push(origin);
    await storageSet(config);
    console.log('[JX-BG] Domain added:', origin, 'Total domains:', config.domains);
    await resetDeclarativeMapping();
    console.log('[JX-BG] Injecting content script into tab:', tab.id);
    await executeScript({
      target: {tabId: tab.id},
      files: [contentScript]
    });
    await sendMessage(tab.id, {
      action: 'message',
      message: origin + ' added successfully !'
    });
    console.log('[JX-BG] Done! Extension active on', origin);
  }
}

(function () {
  chrome.runtime.onInstalled.addListener(async () => {
    console.log('[JX-BG] onInstalled fired');
    const config = await storageGet(defaultConfig);
    console.log('[JX-BG] onInstalled config:', JSON.stringify(config));
    if (!config.instanceUrl || !config.v15upgrade) {
      console.log('[JX-BG] Opening options page (first install or upgrade needed)');
      chrome.runtime.openOptionsPage();
      return;
    }
    resetDeclarativeMapping();
  });

  chrome.action.onClicked.addListener(tab => {
    console.log('[JX-BG] Action icon clicked');
    browserOnClicked(tab).catch( (err) => {
      console.error('[JX-BG] Error in browserOnClicked:', err);
    });
  });
})();
