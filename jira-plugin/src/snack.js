/*global chrome */
import {waitForDocument} from 'src/utils';

waitForDocument(() => require('src/snack.scss'));

export function snackBar(message, timeout = 6000) {
  console.log('[JX] snackBar:', message);

  // Remove any existing snack notifications
  document.querySelectorAll('._JX_snack').forEach(el => {
    el.classList.remove('_JX_snack_show');
  });

  const content = document.createElement('div');
  content.className = '_JX_snack';
  content.innerHTML = `
      <div class="_JX_snack_icon">
        <img src="${chrome.runtime.getURL('resources/jiralink128.png')}" class="_JX_snack_icon_img" />
      </div>
      <div class="_JX_snack_message">${message}</div>
  `;

  document.body.appendChild(content);

  // Force a reflow so the CSS transition triggers
  content.offsetHeight;
  content.classList.add('_JX_snack_show');

  setTimeout(function () {
    content.classList.remove('_JX_snack_show');
    content.addEventListener('transitionend', () => content.remove());
  }, timeout);
}
