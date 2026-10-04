const console = require('./console');


// The injected agent (nflxmultisubs.min.js) runs in the page and cannot use the extension APIs
// (Safari, Firefox), so this content script relays its messages to/from the background script:
//   agent -> background: window.postMessage({ namespace, direction: 'to-background', msg })
//   background -> agent: window.postMessage({ namespace, direction: 'to-agent', msg })
// The first message from the agent opens the port; the background replies with the current settings.
const kNamespace = 'nflxmultisubs';
let gMsgPort;

window.addEventListener('message', evt => {
  // (compare origins, `evt.source === window` isn't reliable across the content script/page boundary)
  if (evt.origin !== window.location.origin || !evt.data || evt.data.namespace !== kNamespace) return;
  if (evt.data.direction !== 'to-background') return;

  if (!gMsgPort) {
    gMsgPort = chrome.runtime.connect({ name: 'agent' });
    gMsgPort.onMessage.addListener(msg => {
      window.postMessage({ namespace: kNamespace, direction: 'to-agent', msg }, '*');
    });
    gMsgPort.onDisconnect.addListener(() => {
      gMsgPort = null;
    });
  }
  if (evt.data.msg) {
    gMsgPort.postMessage(evt.data.msg);
  }
}, false);


window.addEventListener('load', () => {
  const scriptElem = document.createElement('script');
  scriptElem.setAttribute('type', 'text/javascript');
  scriptElem.setAttribute('src', chrome.runtime.getURL('nflxmultisubs.min.js'));
  document.head.appendChild(scriptElem);
  console.log('Injected: nflxmultisubs.min.js');
});
