/*global chrome */
import size from 'lodash/size';
import debounce from 'lodash/debounce';
import Mustache from 'mustache';
import {centerPopup, waitForDocument} from 'src/utils';
import {sendMessage, storageGet, storageSet} from 'src/chrome';
import {snackBar} from 'src/snack';
import config from 'options/config.js';

console.log('[JX] content.jsx loaded');

waitForDocument(() => {
  console.log('[JX] Document ready, loading SCSS');
  require('src/content.scss');
});

const getInstanceUrl = async () => {
  const result = (await storageGet({
    instanceUrl: config.instanceUrl
  })).instanceUrl;
  console.log('[JX] getInstanceUrl =>', result);
  return result;
};

const getConfig = async () => {
  const cfg = await storageGet(config);
  console.log('[JX] getConfig =>', JSON.stringify(cfg));
  return cfg;
};

/**
 * Returns a function that will return an array of jira tickets for any given string
 * @param projectKeys project keys to match
 * @returns {Function}
 */
function buildJiraKeyMatcher(projectKeys) {
  const projectMatches = projectKeys.join('|');
  const jiraTicketRegex = new RegExp('(?:' + projectMatches + ')[- ]\\d+', 'ig');

  return function (text) {
    let matches;
    const result = [];

    while ((matches = jiraTicketRegex.exec(text)) !== null) {
      result.push(matches[0]);
    }
    return result;
  };
}

chrome.runtime.onMessage.addListener(function (msg) {
  console.log('[JX] onMessage received:', msg);
  if (msg.action === 'message') {
    snackBar(msg.message);
  }
});

let ui_tips_shown_local = [];

async function showTip(tipName, tipMessage) {
  if (ui_tips_shown_local.indexOf(tipName) !== -1) {
    return;
  }
  ui_tips_shown_local.push(tipName);
  const ui_tips_shown = (await storageGet({['ui_tips_shown']: []})).ui_tips_shown;
  if (ui_tips_shown.indexOf(tipName) === -1) {
    snackBar(tipMessage);
    ui_tips_shown.push(tipName);
    storageSet({'ui_tips_shown': ui_tips_shown});
  }
}

storageGet({'ui_tips_shown': []}).then(function ({ui_tips_shown}) {
  ui_tips_shown_local = ui_tips_shown;
});

async function get(url) {
  console.log('[JX] get() fetching:', url);
  var response = await sendMessage({action: "get", url: url});
  console.log('[JX] get() response:', typeof response, response ? 'ok' : 'empty');
  if (response && response.result) {
    return response.result;
  } else if (response && response.error) {
    console.error('[JX] get() error:', response.error);
    const err = new Error(response.error);
    err.inner = response.error;
    throw err;
  } else {
    console.error('[JX] get() unexpected response:', response);
    throw new Error('Unexpected empty response from background script');
  }
}

// Simple draggable implementation (replaces jquery-ui draggable)
function makeDraggable(element, handleSelector) {
  let isDragging = false;
  let startX, startY, origLeft, origTop;

  element.addEventListener('mousedown', function (e) {
    const handle = e.target.closest(handleSelector);
    if (!handle) return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = element.getBoundingClientRect();
    origLeft = rect.left + window.scrollX;
    origTop = rect.top + window.scrollY;
    e.preventDefault();
  });

  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    element.style.left = (origLeft + dx) + 'px';
    element.style.top = (origTop + dy) + 'px';
  });

  document.addEventListener('mouseup', function () {
    if (isDragging) {
      isDragging = false;
      element.dispatchEvent(new Event('dragstop'));
    }
  });
}

async function mainAsyncLocal() {
  console.log('[JX] mainAsyncLocal() started');

  let ClipboardJS;
  try {
    ClipboardJS = require('clipboard/dist/clipboard');
    console.log('[JX] ClipboardJS loaded');
  } catch (e) {
    console.error('[JX] Failed to load ClipboardJS:', e);
  }

  let configData;
  try {
    configData = await getConfig();
    console.log('[JX] Config loaded:', JSON.stringify(configData));
  } catch (e) {
    console.error('[JX] Failed to load config:', e);
    return;
  }

  const INSTANCE_URL = configData.instanceUrl;
  if (!INSTANCE_URL) {
    console.warn('[JX] No instanceUrl configured! Open extension options to set your Jira URL.');
    return;
  }

  console.log('[JX] Fetching Jira projects from:', INSTANCE_URL + 'rest/api/2/project');

  let jiraProjects;
  try {
    jiraProjects = await get(INSTANCE_URL + 'rest/api/2/project');
    console.log('[JX] Jira projects fetched:', Array.isArray(jiraProjects) ? jiraProjects.length + ' projects' : typeof jiraProjects);
  } catch (e) {
    console.error('[JX] Failed to fetch Jira projects:', e.message);
    return;
  }

  if (!size(jiraProjects)) {
    console.log('[JX] No jira projects found. Check your Jira instance URL and authentication.');
    return;
  }

  const projectKeys = jiraProjects.map(function (project) {
    return project.key;
  });
  console.log('[JX] Project keys:', projectKeys.join(', '));
  const getJiraKeys = buildJiraKeyMatcher(projectKeys);

  let annotationTemplate;
  try {
    annotationTemplate = await get(chrome.runtime.getURL('resources/annotation.html'));
    console.log('[JX] Annotation template loaded, length:', annotationTemplate.length);
  } catch (e) {
    console.error('[JX] Failed to load annotation template:', e);
    return;
  }

  const loaderGifUrl = chrome.runtime.getURL('resources/ajax-loader.gif');

  // --- Auto-link Jira keys: scan page and convert text matches to clickable links ---
  const projectMatches = projectKeys.join('|');
  const jiraLinkRegex = new RegExp('((?:' + projectMatches + ')[- ]\\d+)', 'ig');

  function linkifyTextNode(textNode) {
    const text = textNode.textContent;
    if (!jiraLinkRegex.test(text)) return;
    jiraLinkRegex.lastIndex = 0; // reset after .test()

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    while ((match = jiraLinkRegex.exec(text)) !== null) {
      // Add any text before this match
      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      // Create the clickable link
      const key = match[1].replace(' ', '-');
      const link = document.createElement('a');
      link.href = INSTANCE_URL + 'browse/' + key;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = '_JX_auto_link';
      link.textContent = match[0];
      link.title = 'Open ' + key + ' in Jira';
      frag.appendChild(link);
      lastIndex = jiraLinkRegex.lastIndex;
    }

    // Add any remaining text after the last match
    if (lastIndex < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    textNode.parentNode.replaceChild(frag, textNode);
  }

  /**
   * For Jira keys inside existing <a> tags (e.g. GitHub PR titles),
   * we can't nest a link. Instead, append a small Jira icon-link after the <a>.
   */
  function addJiraIconToLink(anchorEl) {
    // Skip if we already processed this link
    if (anchorEl.dataset._jxProcessed) return false;
    // Skip links that already point to Jira
    if (anchorEl.href && anchorEl.href.indexOf(INSTANCE_URL) !== -1) return false;

    const text = anchorEl.textContent;
    jiraLinkRegex.lastIndex = 0;
    const match = jiraLinkRegex.exec(text);
    if (!match) return false;

    const key = match[1].replace(' ', '-');
    anchorEl.dataset._jxProcessed = 'true';

    const icon = document.createElement('a');
    icon.href = INSTANCE_URL + 'browse/' + key;
    icon.target = '_blank';
    icon.rel = 'noopener noreferrer';
    icon.className = '_JX_inline_icon';
    icon.title = 'Open ' + key + ' in Jira';
    icon.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="currentColor"/></svg>';

    // Insert after the anchor (or after its parent if needed)
    if (anchorEl.nextSibling) {
      anchorEl.parentNode.insertBefore(icon, anchorEl.nextSibling);
    } else {
      anchorEl.parentNode.appendChild(icon);
    }
    return true;
  }

  function linkifyNode(root) {
    // Skip our own elements
    const SKIP_SELECTOR = '._JX_container, ._JX_snack, ._JX_auto_link, ._JX_inline_icon';
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT']);
    let linked = 0;

    // 1) Handle text nodes NOT inside <a> tags — replace with clickable links
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (parent.closest('a, code, pre')) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }
    textNodes.forEach(node => {
      jiraLinkRegex.lastIndex = 0;
      if (jiraLinkRegex.test(node.textContent)) {
        jiraLinkRegex.lastIndex = 0;
        linkifyTextNode(node);
        linked++;
      }
    });

    // 2) Handle <a> tags that contain Jira keys — add a Jira icon next to them
    const anchors = (root.tagName === 'A') ? [root] : Array.from(root.querySelectorAll('a'));
    anchors.forEach(a => {
      if (a.closest(SKIP_SELECTOR)) return;
      jiraLinkRegex.lastIndex = 0;
      if (jiraLinkRegex.test(a.textContent)) {
        if (addJiraIconToLink(a)) linked++;
      }
    });

    return linked;
  }

  // Run initial scan
  const initialLinked = linkifyNode(document.body);
  console.log('[JX] Initial linkify scan: linked', initialLinked, 'text nodes/links');

  // Watch for DOM changes (SPAs, dynamic content) and linkify new nodes
  const linkifyObserver = new MutationObserver(debounce(function (mutations) {
    let linked = 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !node.closest('._JX_container, ._JX_snack')) {
          linked += linkifyNode(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement;
          if (parent && !parent.closest('._JX_container, ._JX_snack, script, style')) {
            if (parent.closest('a')) {
              // Text inside a link — try to add icon
              const anchor = parent.closest('a');
              if (addJiraIconToLink(anchor)) linked++;
            } else {
              jiraLinkRegex.lastIndex = 0;
              if (jiraLinkRegex.test(node.textContent)) {
                jiraLinkRegex.lastIndex = 0;
                linkifyTextNode(node);
                linked++;
              }
            }
          }
        }
      }
    }
    if (linked > 0) {
      console.log('[JX] MutationObserver linkified', linked, 'new text nodes/links');
    }
  }, 300));
  linkifyObserver.observe(document.body, { childList: true, subtree: true });
  console.log('[JX] MutationObserver watching for new Jira keys');
  // --- End auto-link ---

  // --- Hover tooltip (only if enabled in options) ---
  const hoverEnabled = configData.hoverEnabled;
  console.log('[JX] Hover tooltip enabled:', hoverEnabled);

  if (hoverEnabled) {
    /***
     * Retrieve only the text that is directly owned by the node
     * @param node
     */
    function getShallowText(node) {
      const TEXT_NODE = 3;
      let text = '';
      for (const child of node.childNodes) {
        if (child.nodeType === TEXT_NODE) {
          text += child.textContent;
        }
      }
      return text;
    }

    function getPullRequestData(issueId, applicationType) {
      return get(INSTANCE_URL + 'rest/dev-status/1.0/issue/details?issueId=' + issueId + '&applicationType=' + applicationType + '&dataType=pullrequest');
    }

    function getIssueMetaData(issueKey) {
      return get(INSTANCE_URL + 'rest/api/2/issue/' + issueKey + '?fields=description,id,reporter,assignee,summary,attachment,comment,issuetype,status,priority&expand=renderedFields');
    }

    function getRelativeHref(href) {
      const documentHref = document.location.href.split('#')[0];
      if (href.startsWith(documentHref)) {
        return href.slice(documentHref.length);
      }
      return href;
    }

    const container = document.createElement('div');
    container.className = '_JX_container';
    document.body.appendChild(container);
    console.log('[JX] Container element appended to body');

    makeDraggable(container, '._JX_title, ._JX_status');

    if (ClipboardJS) {
      new ClipboardJS('._JX_title_copy', {
        text: function (trigger) {
          return document.getElementById('_JX_title_link').text;
        }
      })
      .on('success', e => { snackBar('Copied!');})
      .on('error', e => { snackBar('There was an error!');});
    }

    document.body.addEventListener('click', function (e) {
      const currentTarget = e.target.closest('._JX_thumb');
      if (!currentTarget) return;
      if (currentTarget.dataset._jx_loading) {
        return;
      }
      if (!currentTarget.dataset.mimeType || !currentTarget.dataset.mimeType.startsWith('image')) {
        return;
      }
      e.preventDefault();
      currentTarget.dataset._jx_loading = 'true';
      const opacityElements = Array.from(currentTarget.children).filter(
        el => !el.classList.contains('_JX_file_loader')
      );
      opacityElements.forEach(el => el.style.opacity = '0.2');
      const loader = currentTarget.querySelector('._JX_file_loader');
      if (loader) loader.style.display = 'block';
      const localCancelToken = cancelToken;
      const img = new Image();
      img.onload = function () {
        delete currentTarget.dataset._jx_loading;
        if (loader) loader.style.display = 'none';
        const nameEl = currentTarget.querySelector('._JX_thumb_filename');
        const name = nameEl ? nameEl.textContent : '';
        opacityElements.forEach(el => el.style.opacity = '1');
        if (localCancelToken.cancel) {
          return;
        }
        centerPopup(chrome.runtime.getURL(`resources/preview.html?url=${currentTarget.dataset.url}&title=${name}`), name, {
          width: this.naturalWidth,
          height: this.naturalHeight
        }).focus();
      };
      img.src = currentTarget.dataset.url;
    });

    function hideContainer() {
      containerPinned = false;
      container.style.left = '-5000px';
      container.style.top = '-5000px';
      container.style.position = 'absolute';
      container.classList.remove('container-pinned');

      passiveCancel(0);
    }

    document.body.addEventListener('keydown', function (e) {
      const ESCAPE_KEY_CODE = 27;
      if (e.keyCode === ESCAPE_KEY_CODE) {
        hideContainer();
        passiveCancel(200);
      }
    });

    let cancelToken = {};

    function passiveCancel(cooldown) {
      cancelToken.cancel = true;
      setTimeout(function () {
        cancelToken = {};
      }, cooldown);
    }

    let hideTimeOut;
    let containerPinned = false;
    container.addEventListener('dragstop', () => {
      if (!containerPinned) {
        snackBar('Ticket Pinned! Hit esc to close !');
        container.classList.add('container-pinned');
        const rect = container.getBoundingClientRect();
        container.style.left = rect.left + 'px';
        container.style.top = rect.top + 'px';
        containerPinned = true;
        clearTimeout(hideTimeOut);
      }
    });

    console.log('[JX] Setting up mousemove listener for Jira key detection');
    document.body.addEventListener('mousemove', debounce(function (e) {
      if (cancelToken.cancel) {
        return;
      }
      const element = document.elementFromPoint(e.clientX, e.clientY);
      if (element === container || container.contains(element)) {
        showTip('tooltip_drag', 'Tip: You can pin the tooltip by dragging the title !');
        return;
      }
      if (element) {
        let keys = getJiraKeys(getShallowText(element));
        if (!size(keys) && element.href) {
          keys = getJiraKeys(getRelativeHref(element.href));
        }
        if (!size(keys) && element.parentElement && element.parentElement.href) {
          keys = getJiraKeys(getRelativeHref(element.parentElement.href));
        }

        if (size(keys)) {
          console.log('[JX] Jira keys detected:', keys);
          clearTimeout(hideTimeOut);
          const key = keys[0].replace(" ", "-");
          (async function (cancelToken) {
            try {
              const issueData = await getIssueMetaData(key);
              console.log('[JX] Issue metadata loaded for', key);
              let pullRequests = [];
              try {
                const githubPrs = await getPullRequestData(issueData.id, 'github');
                pullRequests = githubPrs.detail[0].pullRequests;
              } catch (ex) {
                // probably no access
              }

              if (cancelToken.cancel) {
                return;
              }
              let comments = '';
              if (issueData.fields.comment && issueData.fields.comment.total) {
                comments = issueData.fields.comment.comments.map(
                  comment => comment.author.displayName + ':\n' + comment.body
                ).join('\n\n');
              }
              const displayData = {
                urlTitle: key + ' ' + issueData.fields.summary,
                url: INSTANCE_URL + 'browse/' + key,
                prs: [],
                description: issueData.renderedFields.description,
                attachments: issueData.fields.attachment,
                issuetype: issueData.fields.issuetype,
                status: issueData.fields.status,
                priority: issueData.fields.priority,
                comment: issueData.fields.comment,
                reporter: issueData.fields.reporter,
                assignee: issueData.fields.assignee,
                comments,
                commentUrl: '',
                loaderGifUrl,
              };
              displayData.commentUrl = `${displayData.url}#comment-${displayData.comment?.comments?.[0]?.id || ''}`;
              if (size(pullRequests)) {
                displayData.prs = pullRequests.filter(function (pr) {
                  return pr.url !== location.href;
                }).map(function (pr) {
                  return {
                    id: pr.id,
                    url: pr.url,
                    name: pr.name,
                    status: pr.status,
                    author: pr.author
                  };
                });
              }
              const left = e.pageX + 20;
              const top = e.pageY + 25;
              container.innerHTML = Mustache.render(annotationTemplate, displayData);
              if (!containerPinned) {
                container.style.left = left + 'px';
                container.style.top = top + 'px';
              }
              console.log('[JX] Tooltip rendered for', key);
            } catch (err) {
              console.error('[JX] Error fetching issue data for', key, ':', err.message);
            }
          })(cancelToken);
        } else if (!containerPinned) {
          hideTimeOut = setTimeout(hideContainer, 250);
        }
      }
    }, 100));
  } else {
    console.log('[JX] Hover tooltip is disabled. Enable it in extension options.');
  }
  // --- End hover tooltip ---

  console.log('[JX] mainAsyncLocal() completed successfully — extension is active!');
}

if (!window.__JX__script_injected__) {
  console.log('[JX] First injection, calling waitForDocument -> mainAsyncLocal');
  waitForDocument(mainAsyncLocal);
} else {
  console.log('[JX] Script already injected, skipping');
}

window.__JX__script_injected__ = true;
