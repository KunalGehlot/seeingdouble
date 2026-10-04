const kDefaultSettings = require('./default-settings');


////////////////////////////////////////////////////////////////////////////////


let gSettings = Object.assign({}, kDefaultSettings);
let gWordBank = [];
// The OpenAI API key never lives in gSettings: gSettings is broadcast to the page agent
// (dispatchSettings, below) and a key there would be readable by any script on netflix.com.
let gOpenAiApiKey = '';

// return true if valid; otherwise return false
function validateSettings(settings) {
  const keys = Object.keys(kDefaultSettings);
  return keys.every(key => (key in settings));
}


// Connections can arrive before storage is loaded (e.g. when the background is started by a page
// connecting), so don't answer or apply changes until then -- otherwise the page gets the defaults.
const gStorageLoaded = new Promise(resolve => {
  chrome.storage.local.get(['settings', 'wordBank', 'openaiApiKey'], (result) => {
    console.log('Loaded: settings=', result.settings, 'wordBank=', result.wordBank);
    // fill in keys missing from stored settings (new settings, or `undefined` values dropped by storage)
    // instead of throwing the user's settings away
    gSettings = Object.assign({}, kDefaultSettings, result.settings);
    if (Array.isArray(result.wordBank)) gWordBank = result.wordBank;
    gOpenAiApiKey = result.openaiApiKey || '';
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

function saveOpenAiApiKey() {
  chrome.storage.local.set({ openaiApiKey: gOpenAiApiKey }, () => {
    console.log('OpenAI API key: saved into local storage');
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

// Any script on netflix.com can post messages the content script relays here, so the agent
// (unlike the pop-up) may only ever change the "which subtitle did the user pick" bits -- never
// the simplification toggle/level, and it can never set the API key.
const kAgentWritableSettingsKeys = ['secondaryLanguageLastUsed', 'secondaryLanguageLastUsedIsCaption'];
function updateSettingsFromAgent(settings) {
  const filtered = {};
  kAgentWritableSettingsKeys.forEach(key => {
    if (key in settings) filtered[key] = settings[key];
  });
  if (Object.keys(filtered).length) updateSettings(filtered);
}


// -----------------------------------------------------------------------------
// Subtitle simplification: runs here (not in the page-injected agent) so the API key is never
// exposed to netflix.com page scripts.

const kOpenAiEndpoint = 'https://api.openai.com/v1/chat/completions';
const kOpenAiModel = 'gpt-4o-mini';

const kVocabularyPrompts = {
  '100': 'a basic vocabulary of 100 words or less',
  '300': 'a basic vocabulary of 300 words or less',
  '1k': 'a vocabulary of 1000 words or less',
  'fluency': 'a full vocabulary for fluency, making only light clarity edits',
};

// Once a key is confirmed bad (401), stop spending one failing request per subtitle cue until
// the user changes it.
let gApiKeyIsInvalid = false;

async function simplifyText(text, level) {
  if (!gOpenAiApiKey) throw new Error('No OpenAI API key configured');
  if (gApiKeyIsInvalid) throw new Error('OpenAI API key was rejected, not retrying until it changes');

  const vocabularyDescription = kVocabularyPrompts[level] || kVocabularyPrompts['300'];
  const response = await fetch(kOpenAiEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gOpenAiApiKey}`,
    },
    body: JSON.stringify({
      model: kOpenAiModel,
      messages: [
        {
          role: 'system',
          content: 'You simplify subtitle text for language learners. Rewrite the given text ' +
            `using only ${vocabularyDescription}, in the same language as the input, preserving ` +
            'the original meaning and line breaks. Reply with ONLY the rewritten text -- no ' +
            'preamble, no explanation, no quotes.',
        },
        { role: 'user', content: text },
      ],
      temperature: 0.3,
    }),
  });

  if (response.status === 401) gApiKeyIsInvalid = true;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI request failed: ${response.status} ${body}`.trim());
  }

  const data = await response.json();
  const simplified = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!simplified) throw new Error('OpenAI response had no content');
  return simplified.trim();
}

// A subtitle cue is a line or two; this also keeps any netflix.com page script that can reach
// this port (see updateSettingsFromAgent, above) from using it as an open-ended LLM proxy.
const kMaxSimplifyTextLength = 500;

// requestId lets the agent match the (out-of-order, async) reply to the right subtitle cue.
// `level` is NOT taken from the agent's message -- only the user's own stored setting is used,
// so the page can't redirect the request to a different prompt.
async function handleSimplifyRequest(port, { requestId, text }) {
  if (!gSettings.simplifySubtitlesWithAI) return;
  if (typeof text !== 'string' || !text || text.length > kMaxSimplifyTextLength) return;

  try {
    const simplified = await simplifyText(text, gSettings.simplifyVocabularyLevel);
    port.postMessage({ simplifyResult: { requestId, text: simplified } });
  }
  catch (err) {
    // the detailed error (e.g. OpenAI's invalid-key message, which echoes part of the key back)
    // stays in our own console -- the page only learns that the request failed
    console.error('Error: subtitle simplification failed,', err);
    port.postMessage({ simplifyResult: { requestId, error: 'Simplification failed' } });
  }
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
      updateSettingsFromAgent(msg.settings);
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
    else if (msg.simplify) {
      handleSimplifyRequest(port, msg.simplify);
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
    port.postMessage({ hasOpenAiApiKey: !!gOpenAiApiKey });
  });

  port.onMessage.addListener(msg => gStorageLoaded.then(() => {
    if ('openaiApiKey' in msg) {
      gOpenAiApiKey = msg.openaiApiKey || '';
      gApiKeyIsInvalid = false; // give a newly-entered key a fresh chance
      saveOpenAiApiKey();
      port.postMessage({ hasOpenAiApiKey: !!gOpenAiApiKey });
    }
    else if (msg.resetSettings) {
      gSettings = Object.assign({}, kDefaultSettings);
      saveSettings();
      dispatchSettings();
      port.postMessage({ settings: gSettings });
    }
    else if (msg.settings) {
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
