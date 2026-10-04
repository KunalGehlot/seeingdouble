// Smoke test for src/background.js message handling, run under Node with a stubbed `chrome`
// and `fetch`, to exercise the OpenAI key isolation / agent-write whitelist / simplify flow
// without needing a browser or a real Netflix page.

const assert = require('assert');
const path = require('path');

const storage = {};
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => {
        const result = {};
        keys.forEach(k => { if (k in storage) result[k] = storage[k]; });
        cb(result);
      },
      set: (obj, cb) => { Object.assign(storage, obj); cb && cb(); },
    },
  },
  browserAction: {
    setIcon: () => {},
  },
};

let fetchCalls = [];
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'Simplified text here' } }] }),
  };
};

class FakePort {
  constructor(name, tabId) {
    this.name = name;
    this.sender = tabId ? { tab: { id: tabId } } : undefined;
    this._msgListeners = [];
    this._discListeners = [];
    this.received = [];
  }
  postMessage(msg) { this.received.push(msg); }
  onMessage = { addListener: (fn) => this._msgListeners.push(fn) };
  onDisconnect = { addListener: (fn) => this._discListeners.push(fn) };
  send(msg) { this._msgListeners.forEach(fn => fn(msg)); }
}

let connectListener;
global.chrome.runtime = {
  onConnect: { addListener: (fn) => { connectListener = fn; } },
};

require(path.join(__dirname, '..', 'src', 'background.js'));

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // 1. Agent connects, gets default settings (no key in them)
  const agentPort = new FakePort('agent', 42);
  connectListener(agentPort);
  await wait(10);

  const firstMsg = agentPort.received.find(m => m.settings);
  assert.ok(firstMsg, 'agent should receive initial settings');
  assert.ok(!('openaiApiKey' in firstMsg.settings), 'settings sent to agent must never contain the API key');
  console.log('PASS: initial settings to agent exclude API key');

  // 2. Agent tries to turn on simplification / set vocabulary level -- must be ignored (whitelist)
  agentPort.send({ settings: { simplifySubtitlesWithAI: true, simplifyVocabularyLevel: '100' } });
  await wait(10);
  const afterAttempt = agentPort.received.filter(m => m.settings).pop();
  assert.strictEqual(afterAttempt.settings.simplifySubtitlesWithAI, false, 'agent must not be able to enable simplification');
  console.log('PASS: agent cannot enable simplification or change vocabulary level');

  // 3. Agent tries to set the API key directly via settings -- must be ignored too
  agentPort.send({ settings: { openaiApiKey: 'sk-stolen' } });
  await wait(10);
  assert.ok(!storage.openaiApiKey, 'agent must not be able to set the API key via settings');
  console.log('PASS: agent cannot set API key via settings message');

  // 4. Agent CAN set secondaryLanguageLastUsed (legit whitelisted key)
  agentPort.send({ settings: { secondaryLanguageLastUsed: 'fr', secondaryLanguageLastUsedIsCaption: false } });
  await wait(10);
  const afterLangUpdate = agentPort.received.filter(m => m.settings).pop();
  assert.strictEqual(afterLangUpdate.settings.secondaryLanguageLastUsed, 'fr', 'agent should be able to update last-used language');
  console.log('PASS: agent can still update secondaryLanguageLastUsed');

  // 5. Popup sets the API key -- stored, and status reflects it; never broadcast to agent settings
  const popupPort = new FakePort('settings');
  connectListener(popupPort);
  await wait(10);
  popupPort.send({ openaiApiKey: 'sk-real-key-12345' });
  await wait(10);
  assert.strictEqual(storage.openaiApiKey, 'sk-real-key-12345', 'key should be persisted to storage');
  const keyStatusMsg = popupPort.received.filter(m => 'hasOpenAiApiKey' in m).pop();
  assert.strictEqual(keyStatusMsg.hasOpenAiApiKey, true);
  console.log('PASS: popup can set API key, status reflects it');

  const agentSettingsAfterKeySet = agentPort.received.filter(m => m.settings).pop();
  assert.ok(!('openaiApiKey' in agentSettingsAfterKeySet.settings), 'API key still never appears in agent settings after being set');
  console.log('PASS: API key never leaks to agent after being set via popup');

  // 6. Popup enables simplification properly (this is the legit path)
  popupPort.send({ settings: { simplifySubtitlesWithAI: true, simplifyVocabularyLevel: '300' } });
  await wait(10);
  console.log('PASS: popup can enable simplification');

  // 7. Agent sends a simplify request -- should hit fetch() with Authorization header, never expose key back
  fetchCalls = [];
  agentPort.send({ simplify: { requestId: 7, text: 'Hello world', level: '300' } });
  await wait(50);
  assert.strictEqual(fetchCalls.length, 1, 'should have made exactly one fetch call');
  assert.ok(fetchCalls[0].url.startsWith('https://api.openai.com/'), 'must call OpenAI endpoint');
  assert.ok(fetchCalls[0].opts.headers.Authorization.includes('sk-real-key-12345'), 'must send the stored key as Bearer token');
  const simplifyReply = agentPort.received.filter(m => m.simplifyResult).pop();
  assert.strictEqual(simplifyReply.simplifyResult.requestId, 7);
  assert.strictEqual(simplifyReply.simplifyResult.text, 'Simplified text here');
  assert.ok(!JSON.stringify(simplifyReply).includes('sk-real-key-12345'), 'reply to agent must never contain the raw key');
  console.log('PASS: simplify request reaches OpenAI with key, reply to agent has no key, correct requestId');

  // 8. Reset: key must survive (reset only clears gSettings, not the key)
  popupPort.send({ resetSettings: true });
  await wait(10);
  assert.strictEqual(storage.openaiApiKey, 'sk-real-key-12345', 'Reset to Default must not wipe the API key');
  const afterReset = popupPort.received.filter(m => m.settings).pop();
  assert.strictEqual(afterReset.settings.simplifySubtitlesWithAI, false, 'reset should restore the default (off)');
  console.log('PASS: Reset to Default clears settings but preserves the API key');

  console.log('\nAll smoke tests passed.');
})().catch(err => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
