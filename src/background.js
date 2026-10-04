const kDefaultSettings = require('./default-settings');


////////////////////////////////////////////////////////////////////////////////


let gSettings = Object.assign({}, kDefaultSettings);
let gWordBank = [];

// return true if valid; otherwise return false
function validateSettings(settings) {
  const keys = Object.keys(kDefaultSettings);
  return keys.every(key => (key in settings));
}


// Connections can arrive before storage is loaded (e.g. when the background is started by a page
// connecting), so don't answer or apply changes until then -- otherwise the page gets the defaults.
const gStorageLoaded = new Promise(resolve => {
  chrome.storage.local.get(['settings', 'wordBank'], (result) => {
    console.log('Loaded: settings=', result.settings, 'wordBank=', result.wordBank);
    // fill in keys missing from stored settings (new settings, or `undefined` values dropped by storage)
    // instead of throwing the user's settings away
    gSettings = Object.assign({}, kDefaultSettings, result.settings);
    if (Array.isArray(result.wordBank)) gWordBank = result.wordBank;
    saveSettings();
    resolve();
  });
});

function saveSettings() {
  // hack to update opacity for existing users
  gSettings.primaryImageOpacity = 1
  gSettings.primaryTextOpacity = 1
  gSettings.secondaryImageOpacity = 1
  gSettings.secondaryTextOpacity = 1
  chrome.storage.local.set({ settings: gSettings }, () => {
    console.log('Settings: saved into local storage');
  });
}

function saveWordBank() {
  chrome.storage.local.set({ wordBank: gWordBank }, () => {
    console.log('Word Bank: saved into local storage');
  });
}

function isSameWord(a, b) {
  return a.word.toLowerCase() === b.word.toLowerCase();
}

function addWord(wordDefinition) {
  if (!wordDefinition || !wordDefinition.word) return;
  if (gWordBank.some(w => isSameWord(w, wordDefinition))) return;
  gWordBank.push(wordDefinition);
  saveWordBank();
  dispatchWordBank();
}

// ----------------------------------------------------------------------------

function saturateActionIconForTab(tabId) {
  chrome.browserAction.setIcon({
    tabId: tabId,
    path: {
      '16': 'icon16.png',
      '32': 'icon32.png',
    },
  });
}

function desaturateActionIconForTab(tabId) {
  chrome.browserAction.setIcon({
    tabId: tabId,
    path: {
      '16': 'icon16-gray.png',
      '32': 'icon32-gray.png',
    },
  });
}


// -----------------------------------------------------------------------------


let gAgentPorts = {}; // tabId -> msgPort; for config dispatching
function dispatchSettings() {
  Object.values(gAgentPorts).forEach(port => {
    try {
      port.postMessage({ settings: gSettings });
    }
    catch (err) {
      console.error('Error: cannot dispatch settings,', err);
    }
  });
}

// merge (partial) settings sent by the agent or the pop-up, then save and broadcast them
function updateSettings(settings) {
  const merged = Object.assign({}, gSettings, settings);
  gSettings = validateSettings(merged) ? merged : Object.assign({}, kDefaultSettings);
  saveSettings();
  dispatchSettings();
}


// connected from target website (our injected agent, relayed by the content script)
function handleAgentConnection(port) {
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (!tabId) return;

  gAgentPorts[tabId] = port;
  console.log(`Connected: ${tabId} (tab)`);

  gStorageLoaded.then(() => port.postMessage({ settings: gSettings }));

  port.onMessage.addListener(msg => gStorageLoaded.then(() => {
    if (msg.settings) {
      console.log('Received from injected agent: settings=', msg.settings);
      updateSettings(msg.settings);
    }
    else if (msg.startPlayback) {
      saturateActionIconForTab(tabId);
    }
    else if (msg.stopPlayback) {
      desaturateActionIconForTab(tabId);
    }
    else if (msg.addWord) {
      console.log('Received from injected agent: word=', msg.addWord);
      addWord(msg.addWord);
    }
  }));

  port.onDisconnect.addListener(() => {
    delete gAgentPorts[tabId];
    console.log(`Disconnected: ${tabId} (tab)`);
  });
}

// dispatch word bank to the pop-up
function dispatchWordBank() {
  if (!gPopupPort) return;
  try {
    gPopupPort.postMessage({ wordBank: gWordBank });
  }
  catch (err) {
    console.error('Error: cannot dispatch word bank,', err);
  }
}


let gPopupPort;

// connected from our pop-up page
function handlePopupConnection(port) {
  console.log('Connected: settings (pop-up)');
  gPopupPort = port;

  gStorageLoaded.then(() => {
    port.postMessage({ settings: gSettings });
    port.postMessage({ wordBank: gWordBank });
  });

  port.onMessage.addListener(msg => gStorageLoaded.then(() => {
    if (!msg.settings) {
      // "Reset to Default"
      gSettings = Object.assign({}, kDefaultSettings);
      saveSettings();
      dispatchSettings();
      port.postMessage({ settings: gSettings });
    }
    else {
      console.log('Received: settings=', msg.settings);
      updateSettings(msg.settings);
    }
  }));

  port.onDisconnect.addListener(() => {
    if (gPopupPort === port) gPopupPort = null;
    console.log('Disconnected: settings (pop-up)');
  });
}


chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'settings') {
    handlePopupConnection(port);
  }
  else if (port.name === 'agent') {
    handleAgentConnection(port);
  }
});
