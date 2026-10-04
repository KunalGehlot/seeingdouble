let settings = {};
let wordBank = [];
let hasOpenAiApiKey = false;
let primaryPicker, secondaryPicker;

if (BROWSER === 'firefox') {
  const Picker = require('vanilla-picker');

  primaryPicker = new Picker({
    popup: 'bottom',
    color: '#ffffff',
    alpha: false,
    editor: false
  });

  secondaryPicker = new Picker({
    popup: 'top',
    color: '#ffffff',
    alpha: false,
    editor: false
  });
}

const port = chrome.runtime.connect({ name: 'settings' });
port.onMessage.addListener((msg) => {
  settings = msg.settings || settings;
  renderActiveSettings();

  wordBank = msg.wordBank || wordBank;
  renderWordBank();

  primaryPicker?.setColor(settings.primaryTextColor || "#ffffff", true);
  secondaryPicker?.setColor(settings.secondaryTextColor || "#ffffff", true);

  if ('hasOpenAiApiKey' in msg) hasOpenAiApiKey = msg.hasOpenAiApiKey;
  renderOpenAiKeyStatus(hasOpenAiApiKey);
});

// -----------------------------------------------------------------------------

const minimumFontScale = 0.3;
const maximumFontScale = 2.5;

const layoutPresets = [
  { // compact
    upperBaselinePos: 0.20,
    lowerBaselinePos: 0.80,
  },
  { // moderate (default)
    upperBaselinePos: 0.15,
    lowerBaselinePos: 0.85,
  },
  { // ease
    upperBaselinePos: 0.10,
    lowerBaselinePos: 0.90,
  },
];

const secondaryLanguagePresets = [
  {
    secondaryLanguageMode: 'disabled',
  },
  {
    secondaryLanguageMode: 'audio',
  },
  {
    secondaryLanguageMode: 'last',
  }
];


function uploadSettings() {
  port.postMessage({ settings: settings });
}

function resetSettings() {
  port.postMessage({ resetSettings: true });
}

function updateOpenAiApiKey(key) {
  port.postMessage({ openaiApiKey: key });
}

function renderOpenAiKeyStatus(hasKey) {
  const statusElem = document.getElementById('openai-key-status');
  if (statusElem) statusElem.textContent = hasKey ? '✓ saved' : '';

  const removeLink = document.getElementById('btnRemoveKey');
  if (removeLink) removeLink.style.display = hasKey ? '' : 'none';
}



function renderWordBank() {
  console.log('renderingWordBank');
  if (document.readyState !== 'complete') return;

  // Assuming WordBank is an array containing the word bank data
  const wordBankContainer = document.getElementById('wordBankContainer');
  wordBankContainer.innerHTML = ''; // Clear previous content

  // Iterate through the word bank data and create UI elements for each word and definition
  wordBank.forEach((wordDefinition, index) => { // <-- Using forEach with index
    const wordElement = document.createElement('div');

    // Number each word
    const wordNumber = document.createElement('span');
    wordNumber.textContent = `${index + 1}`;
    wordNumber.style.fontWeight = 'bold'; 

    // Add the word and definition
    const wordDefinitionText = `${wordNumber.textContent}. ${wordDefinition.word}: ${wordDefinition.definition}`;
    wordElement.textContent = wordDefinitionText;

    // Add additional styling or event listeners if needed
    wordBankContainer.appendChild(wordElement);

    // Add a line break after each definition
    wordBankContainer.appendChild(document.createElement('br'));
  });
}



function renderActiveSettings() {
  console.log('renderingActiveSettings');

  if (document.readyState !== 'complete') return;

  // clear all
  [].forEach.call(document.querySelectorAll('.active'), elem => {
    elem.classList.remove('active');
  });

  let elem;

  // layout
  const layoutId = layoutPresets.findIndex(k => (k.lowerBaselinePos === settings.lowerBaselinePos));
  if (layoutId !== -1) {
    elem = document.querySelector(`.settings-layout > div[data-id="${layoutId}"]`);
    elem && elem.classList.add('active');
  }
  // primary font size
  document.getElementById('primary-font-indicator').style.scale = settings.primaryTextScale * 0.8;
  
  // primary font color
  document.getElementById('primary-color').value = settings.primaryTextColor || "#ffffff";

  // secondary font size
  document.getElementById('secondary-font-indicator').style.scale = settings.secondaryTextScale * 0.8;

  // secondary font color
  document.getElementById('secondary-color').value = settings.secondaryTextColor || "#ffffff";

  // secondary language
  const secondaryLanguageId = secondaryLanguagePresets.findIndex(k => (k.secondaryLanguageMode === settings.secondaryLanguageMode));
  if (secondaryLanguageId !== -1) {
    elem = document.querySelector(`.settings-secondary-lang > div[data-id="${secondaryLanguageId}"]`);
    elem && elem.classList.add('active');

    if(settings.secondaryLanguageLastUsed)
      document.getElementById('langcode').innerHTML = settings.secondaryLanguageLastUsed.split('-')[0] // only display language code, not script tag (eg: zh not zh-Hans)
  }

  // AI simplification
  document.getElementById('simplify-enabled').checked = !!settings.simplifySubtitlesWithAI;
  document.getElementById('simplify-level').value = settings.simplifyVocabularyLevel || '300';

  renderWordBank();
}

function updateLayout(layoutId) {
  if (layoutId < 0 || layoutId >= layoutPresets.length) return;

  settings = Object.assign(settings, layoutPresets[layoutId]);
  uploadSettings();
  renderActiveSettings();
}

function updatePrimaryFontSize(action) {
  if (action === "+") {
    settings.primaryTextScale = Math.min(maximumFontScale, settings.primaryTextScale + 0.1);
  } else if (action === "-"){
    settings.primaryTextScale = Math.max(minimumFontScale, settings.primaryTextScale - 0.1);
  } else return;

  settings.primaryImageScale = 0.6 * settings.primaryTextScale;
  uploadSettings();
  renderActiveSettings();
}

function updateSecondaryFontSize(action) {
  if (action === "+") {
    settings.secondaryTextScale = Math.min(maximumFontScale, settings.secondaryTextScale + 0.1);
  } else if (action === "-"){
    settings.secondaryTextScale = Math.max(minimumFontScale, settings.secondaryTextScale - 0.1);
  } else return;

  settings.secondaryImageScale = 0.6 * settings.secondaryTextScale;

  uploadSettings();
  renderActiveSettings();
}

function updatePrimaryColor(color) {
  settings = Object.assign(settings, {primaryTextColor: color});
  uploadSettings();
  renderActiveSettings();
}

function updateSecondaryColor(color) {
  settings = Object.assign(settings, {secondaryTextColor: color});
  uploadSettings();
  renderActiveSettings();
}

function updateSecondaryLanguage(secondaryLanguage){
  if (secondaryLanguage < 0 || secondaryLanguage >= secondaryLanguagePresets.length) return;

  settings = Object.assign(settings, secondaryLanguagePresets[secondaryLanguage]);
  uploadSettings();
  renderActiveSettings();
}


function renderVersion() {
  let elem = document.querySelector('#version');
  if (elem) {
    elem.textContent = VERSION;
  }
}


window.addEventListener('load', evt => {
  renderVersion();
  renderActiveSettings();
  renderWordBank();
  renderOpenAiKeyStatus(hasOpenAiApiKey);

  // handle click events
  // ---------------------------------------------------------------------------
  const layouts = document.querySelectorAll('.settings-layout > div');
  [].forEach.call(layouts, div => {
    const layoutId = parseInt(div.getAttribute('data-id'));
    div.addEventListener('click', evt => updateLayout(layoutId), false);
  });

  document.getElementById("primary-plus").addEventListener('click', () => updatePrimaryFontSize("+"));
  document.getElementById("primary-minus").addEventListener('click', () => updatePrimaryFontSize("-"));

  document.getElementById("secondary-plus").addEventListener('click', () => updateSecondaryFontSize("+"));
  document.getElementById("secondary-minus").addEventListener('click', () => updateSecondaryFontSize("-"));

  const primaryColorField = document.getElementById('primary-color');
  primaryColorField.onchange = evt => {
    updatePrimaryColor(evt.target.value);
  }

  primaryPicker?.setOptions({
    parent: document.getElementById('primary-color-ff'),
    onChange: color => {
      updatePrimaryColor(color.hex.slice(0, 7));
    }
  });

  const secondaryColorField = document.getElementById('secondary-color');
  secondaryColorField.onchange = evt => {
    updateSecondaryColor(evt.target.value);
  }

  secondaryPicker?.setOptions({
    parent: document.getElementById('secondary-color-ff'),
    onChange: color => {
      updateSecondaryColor(color.hex.slice(0, 7));
    }
  });

  const secondaryLanguage = document.querySelectorAll('.settings-secondary-lang > div');
  [].forEach.call(secondaryLanguage, div => {
    const languageId = parseInt(div.getAttribute('data-id'));
    div.addEventListener('click', evt => updateSecondaryLanguage(languageId), false);
  });

  document.getElementById('simplify-enabled').addEventListener('change', evt => {
    settings = Object.assign(settings, { simplifySubtitlesWithAI: evt.target.checked });
    uploadSettings();
  });

  document.getElementById('simplify-level').addEventListener('change', evt => {
    settings = Object.assign(settings, { simplifyVocabularyLevel: evt.target.value });
    uploadSettings();
  });

  const openaiKeyField = document.getElementById('openai-key');
  openaiKeyField.addEventListener('change', evt => {
    if (!evt.target.value) return; // blurring an empty field isn't "remove the key" -- use the link below
    updateOpenAiApiKey(evt.target.value);
    evt.target.value = ''; // never keep the key visible/in the DOM after saving it
  });

  document.getElementById('btnRemoveKey').addEventListener('click', evt => {
    updateOpenAiApiKey('');
  }, false);

  const btnReset = document.getElementById('btnReset');
  btnReset.addEventListener('click', evt => {
    resetSettings();
  }, false);
});

