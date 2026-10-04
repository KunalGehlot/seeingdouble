const kDefaultSettings = {
  upperBaselinePos: 0.15,
  lowerBaselinePos: 0.85,
  primaryImageScale: 0.75,
  primaryImageOpacity: 1,
  primaryTextScale: 0.95,
  primaryTextOpacity: 1,
  primaryTextColor: "#ffffff",
  secondaryImageScale: 0.5,
  secondaryImageOpacity: 1,
  secondaryTextScale: 1.0,
  secondaryTextStroke: 2.0,
  secondaryTextOpacity: 1,
  secondaryTextColor: "#ffffff",
  secondaryLanguageMode: 'last', // disabled, audio, last (last used language; matches the audio language until one is picked)
  secondaryLanguageLastUsed: undefined, // bcp47 code of the last used language; null if the user picked "Off"
  secondaryLanguageLastUsedIsCaption: undefined,

  // Rewrite secondary subtitles to a simpler vocabulary with OpenAI. The API key is NOT part of
  // this settings object (see background.js) so it's never sent to the page agent.
  simplifySubtitlesWithAI: false,
  simplifyVocabularyLevel: '300', // '100', '300', '1k', or 'fluency' (full vocabulary, light cleanup only)
};

module.exports = kDefaultSettings;
