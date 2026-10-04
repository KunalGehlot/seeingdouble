const console = require('./console');
const JSZip = require('jszip');
const kDefaultSettings = require('./default-settings');
const PlaybackRateController = require('./playback-rate-controller');

////////////////////////////////////////////////////////////////////////////////

// Hook JSON.parse() and attempt to intercept the manifest
// For cadmium-playercore-6.0022.710.042.js and later
const hookJsonParseAndAddCallback = function(_window) {
  const _parse = JSON.parse;
  _window.JSON.parse = (...args) => {
      const result = _parse.call(JSON, ...args);
      if (result && result.result && result.result.movieId) {
          const movieId = result.result.movieId
          //console.log(`Intercepted manifest ${movieId}`);
          window.__NflxMultiSubs.updateManifest(result.result);
      }
      return result;
  };
};
hookJsonParseAndAddCallback(window);


// hook `history.pushState()` as there is not "pushstate" event in DOM API
// Because Netflix preload manifests when the user hovers mouse over movies on index page,
// our .updateManifest() won't be trigger after user clicks a movie to start watching (they must reload the player page)
(() => {
  function processStateChange() {
    const movieIdInUrl = extractMovieIdFromUrl();
    if (!movieIdInUrl) return;
    console.log(`Movie changed, movieId: ${movieIdInUrl}`);
    nflxMultiSubsManager.activateManifest(movieIdInUrl);
  }

  history.pushState = ( f => function pushState(state, ...args){
    f.call(history, state, ...args);
    //console.log(`pushState: ${state.url}`);

    processStateChange()
  })(history.pushState);

  // Sometimes the URL captured by pushState does not contain the correct movieId, causing the manifest activation to fail.
  // This happens when there is a server-side redirect after starting playback, which doesn't trigger the pushState hook.
  // For example, a redirect happens after you click on a show thumbnail to start it instead of the play icon.
  // So we also hook history.replaceState to capture this redirect.
  history.replaceState = ( f => function replaceState(state, ...args){
    f.call(history, state, ...args);
    //console.log(`replaceState: ${state.url}`);

    processStateChange()
  })(history.replaceState);
})();

////////////////////////////////////////////////////////////////////////////////

// global states
let gSubtitles = [],
  gSubtitleMenu;
let gRendererLoop;
let gVideoRatio = 1080 / 1920;
let gRenderOptions = Object.assign({}, kDefaultSettings);
let gSecondaryOffset = 0; // used to move secondary subs if primary subs overflow the screen edge
let gSubtitleWords = []; // words of the secondary subtitle on screen, for the 1-9 keyboard shortcuts

// This injected agent cannot use the extension APIs, so messages to/from the background
// script are relayed by our content script through window.postMessage() (see content.js).
const kMsgNamespace = 'nflxmultisubs';
const sendToBackground = msg => {
  window.postMessage({ namespace: kMsgNamespace, direction: 'to-background', msg }, '*');
};

// Resolves once the background has sent the stored settings, so the secondary language is chosen
// with the user's settings. Times out in case the background can't be reached.
let gSettingsReceived = false;
let resolveSettingsReady;
const gSettingsReady = new Promise(resolve => {
  resolveSettingsReady = resolve;
  setTimeout(() => {
    resolve();
    if (!gSettingsReceived) console.warn('Error: no settings from background, using defaults');
  }, 1500);
});

// pending simplify() calls, keyed by requestId, so replies (which arrive async and out of order)
// can be routed back to the right caller
let gNextSimplifyRequestId = 1;
const gPendingSimplifyRequests = {};

window.addEventListener('message', evt => {
  if (evt.origin !== window.location.origin || !evt.data || evt.data.namespace !== kMsgNamespace) return;
  if (evt.data.direction !== 'to-agent' || !evt.data.msg) return;

  const msg = evt.data.msg;
  if (msg.settings) {
    gRenderOptions = Object.assign({}, kDefaultSettings, msg.settings);
    gSettingsReceived = true;
    resolveSettingsReady();
    gRendererLoop && gRendererLoop.setRenderDirty();
  }
  else if (msg.simplifyResult) {
    const { requestId, text, error } = msg.simplifyResult;
    const pending = gPendingSimplifyRequests[requestId];
    if (!pending) return;
    delete gPendingSimplifyRequests[requestId];
    if (error) pending.reject(new Error(error));
    else pending.resolve(text);
  }
}, false);

// connect immediately so we get the settings before playback starts (used for language mode)
window.postMessage({ namespace: kMsgNamespace, direction: 'to-background' }, '*');

// Ask the background script (which holds the API key) to simplify this text. The background
// only honors this while the setting is on, and the agent can never read or set the API key.
function simplifyViaBackground(text, level) {
  return new Promise((resolve, reject) => {
    const requestId = gNextSimplifyRequestId++;
    gPendingSimplifyRequests[requestId] = { resolve, reject };
    sendToBackground({ simplify: { requestId, text, level } });
    setTimeout(() => {
      if (!gPendingSimplifyRequests[requestId]) return;
      delete gPendingSimplifyRequests[requestId];
      reject(new Error('Timed out waiting for simplified text'));
    }, 10000);
  });
}

////////////////////////////////////////////////////////////////////////////////

class SubtitleBase {
  constructor(lang, bcp47, urls, isCaption) {
    this.state = 'GENESIS';
    this.active = false;
    this.lang = lang;
    this.bcp47 = bcp47;
    this.isCaption = isCaption;
    this.urls = urls;
    this.extentWidth = undefined;
    this.extentHeight = undefined;
    this.lines = undefined;
    this.lastRenderedIds = undefined;
  }

  activate(options) {
    return new Promise((resolve, reject) => {
      this.active = true;
      if (this.state === 'GENESIS') {
        this.state = 'LOADING';
        console.log(`Subtitle "${this.lang}" downloading`);
        this._download().then(() => {
          this.state = 'READY';
          console.log(`Subtitle "${this.lang}" loaded`);
          resolve(this);
        });
      }
    });
  }

  deactivate() {
    this.active = false;
  }

  async render(seconds, options, forced) {
    if (!this.active || this.state !== 'READY' || !this.lines) return [];

    // find the correct line to render 
    const lines = this.lines.filter(
      line => line.begin <= seconds && seconds <= line.end
    );
    const ids = lines
      .map(line => line.id)
      .sort()
      .toString();

    if (this.lastRenderedIds === ids && !forced) return null;
    this.lastRenderedIds = ids;
    // Wait for _renderText to complete before proceeding
    const renderedElements = await this._renderText(lines, options);
    return renderedElements;

  }

  getExtent() {
    return [this.extentWidth, this.extentHeight];
  }

  setExtent(width, height) {
    [this.extentWidth, this.extentHeight] = [width, height];
  }

  _download() {
    if (!this.urls) return Promise.resolve();

    console.debug('Selecting fastest server, candidates: ',
      this.urls.map(u => u.substr(0, 24)));

    return Promise.any(
      this.urls.map(url => fetch(new Request(url), {method: 'HEAD'}))
    ).then(r => {
      const url = r.url;
      console.debug(`Fastest: ${url.substr(0, 24)}`);
      return this._extract(fetch(url));
    });
  }

  _render(lines, options) {
    // implemented in derived class
  }

  _renderText(lines, options) {
    // implemented in derived class
  }

  _extract(fetchPromise) {
    // extract contents downloaded from fetch()
    // implemented in derived class
  }
}

class DummySubtitle extends SubtitleBase {
  constructor() {
    super('Off');
  }

  activate() {
    this.active = true;
    return Promise.resolve();
  }
}

// subtitle with no download urls
class DehydratedSubtitle extends SubtitleBase {
  constructor(...args) {
    super(...args);
  }

  activate() {
    this.active = true;
    return Promise.resolve();
  }
}


const DICTIONARY_API_BASE_URL = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

// Look up a word from the subtitles (clicked, or picked with the 1-9 keys) and add it to the word bank
const lookUpWord = rawWord => {
  // strip punctuation but keep letters of any script (e.g. "für", "déjà")
  const trimmedWord = rawWord.replace(/[^\p{L}\p{N}'-]/gu, '').replace(/^['-]+|['-]+$/g, '');
  if (!trimmedWord) return;
  const word = trimmedWord.charAt(0).toUpperCase() + trimmedWord.slice(1);
  console.log('Looking up word:', word);

  fetch(DICTIONARY_API_BASE_URL + encodeURIComponent(word))
      .then(response => {
          if (!response.ok) {
              throw new Error(`No definition found for "${word}"`);
          }
          return response.json();
      })
      .then(data => {
          const definition = data[0]?.meanings.flatMap(m => m.definitions).flatMap(d => d.definition)[0];
          if (!definition) {
              console.log(`No definition found for "${word}"`);
              return;
          }
          // the background script keeps the word bank (and ignores duplicates)
          sendToBackground({ addWord: { word, definition } });
      })
      .catch(error => {
          console.warn('Error fetching definition:', error.message);
      });
};



// Cache of in-flight/settled simplify promises, keyed by `${level}\n${originalText}`, so
// re-rendering the same cue (e.g. on resize or a settings change, which force a re-render
// regardless of lastRenderedIds) doesn't fire a duplicate request while one is already pending.
// Also used to ignore late replies for a cue that's no longer on screen.
const gSimplifiedTextCache = {};

// Kicks off a simplify request in the background (never awaited by the render loop -- a slow or
// failed request must not stall requestAnimationFrame) and calls onReady with the result if/when
// it arrives while `isStillCurrent` holds.
function simplifySubtitleText(text, level, isStillCurrent, onReady) {
  const cacheKey = `${level}\n${text}`;
  if (!(cacheKey in gSimplifiedTextCache)) {
    gSimplifiedTextCache[cacheKey] = simplifyViaBackground(text, level);
  }
  gSimplifiedTextCache[cacheKey]
    .then(simplified => {
      if (isStillCurrent()) onReady(simplified);
    })
    .catch(err => {
      delete gSimplifiedTextCache[cacheKey]; // allow retrying a failed request later
      console.warn('Error simplifying subtitles, showing original text:', err.message);
    });
}


class TextSubtitle extends SubtitleBase {
  constructor(...args) {
    super(...args);
  }

  _extract(fetchPromise) {
    return new Promise((resolve, reject) => {
      fetchPromise
        .then(r => r.text())
        .then(xmlText => {
          const xml = new DOMParser().parseFromString(xmlText, 'text/xml');

          const LINE_SELECTOR = 'tt > body > div > p';
          const lines = [].map.call(
            xml.querySelectorAll(LINE_SELECTOR),
            (line, id) => {
              let text = '';
              let extractTextRecur = parentNode => {
                [].forEach.call(parentNode.childNodes, node => {
                  if (node.nodeType === Node.ELEMENT_NODE)
                    if (node.nodeName.toLowerCase() === 'br') text += '\n';
                    else extractTextRecur(node);
                  else if (node.nodeType === Node.TEXT_NODE)
                    text += node.nodeValue + ' ';
                });
              };
              extractTextRecur(line);

              // convert microseconds to seconds
              const begin = parseInt(line.getAttribute('begin')) / 10000000;
              const end = parseInt(line.getAttribute('end')) / 10000000;
              return { id, begin, end, text };
            }
          );

          this.lines = lines;
          resolve();
        });
    });
  }

  // one <span> per word (clicking it, or pressing 1-9, looks it up and adds it to the word bank),
  // laid out to hang just below the primary subtitles, which sit on the lower baseline
  _buildTextContainer(text, options) {
    const textLines = text.split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line);

    gSubtitleWords = [];
    const container = document.createElement('div');
    if (!textLines.length) return container;

    // `em` as font size was not so good -- some other extensions change the em (?)
    const fontSize = Math.ceil(this.extentHeight / 30) * options.secondaryTextScale;
    const stroke = options.secondaryTextStroke;
    const outline = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
      .map(([x, y]) => `${x * stroke}px ${y * stroke}px 0 #000`)
      .join(', ');

    container.style.cssText = `position:absolute; left:5%; right:5%;
      top:${(options.lowerBaselinePos + 0.01) * 100}%;
      text-align:center; font-family:Arial, Helvetica, sans-serif; font-size:${fontSize}px; line-height:1.25;
      color:${options.secondaryTextColor}; opacity:${options.secondaryTextOpacity};
      text-shadow:${stroke > 0 ? outline : 'none'};`;

    textLines.forEach(line => {
      const lineElem = document.createElement('div');
      line.split(' ').forEach((word, i) => {
        if (i > 0) lineElem.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.classList.add('nflxmultisubs-word');
        span.textContent = word;
        span.addEventListener('click', () => lookUpWord(word));
        lineElem.appendChild(span);
        gSubtitleWords.push(word);
      });
      container.appendChild(lineElem);
    });

    return container;
  }

  // Renders the original text immediately (never blocks the render loop on a network call). If
  // simplification is on, a background request is kicked off and -- once it resolves, assuming
  // this cue (identified by `lastRenderedIds`) is still the one on screen -- its container's
  // content is replaced in place with the simplified version.
  _renderText(lines, options) {
    // .join('\n').split('\n') because speaker-based captions come as separate lines without a \n,
    // while regular captions come as a single line containing \n
    const text = lines.map(line => line.text).join('\n');
    const container = this._buildTextContainer(text, options);

    if (options.simplifySubtitlesWithAI && text.trim()) {
      const renderedForIds = this.lastRenderedIds;
      const isStillCurrent = () => this.lastRenderedIds === renderedForIds && container.parentNode;
      simplifySubtitleText(text, options.simplifyVocabularyLevel, isStillCurrent, simplified => {
        const simplifiedContainer = this._buildTextContainer(simplified, options);
        container.replaceChildren(...simplifiedContainer.childNodes);
      });
    }

    return [container];
  }
}


class ImageSubtitle extends SubtitleBase {
  constructor(...args) {
    super(...args);
    this.zip = undefined;
  }

  _extract(fetchPromise) {
    return new Promise((resolve, reject) => {
      const unzipP = fetchPromise.then(r => r.blob()).then(zipBlob => new JSZip().loadAsync(zipBlob));
      unzipP.then(zip => {
        zip
          .file('manifest_ttml2.xml')
          .async('string')
          .then(xmlText => {
            const xml = new DOMParser().parseFromString(xmlText, 'text/xml');

            // dealing with `ns2:extent`, `ns3:extent`, ...
            const _getAttributeAnyNS = (domNode, attrName) => {
              const name = domNode.getAttributeNames().find(
                n =>
                  n
                    .split(':')
                    .pop()
                    .toLowerCase() === attrName
              );
              return domNode.getAttribute(name);
            };

            const extent = _getAttributeAnyNS(
              xml.querySelector('tt'),
              'extent'
            );
            [this.extentWidth, this.extentHeight] = extent
              .split(' ')
              .map(n => parseInt(n));

            const _ttmlTimeToSeconds = timestamp => {
              // e.g., _ttmlTimeToSeconds('00:00:06.005') -> 6.005
              const regex = /(\d+):(\d+):(\d+(?:\.\d+)?)/;
              const [hh, mm, sssss] = regex
                .exec(timestamp)
                .slice(1)
                .map(parseFloat);
              return hh * 3600 + mm * 60 + sssss;
            };

            const LINE_SELECTOR = 'tt > body > div';
            const lines = [].map.call(
              xml.querySelectorAll(LINE_SELECTOR),
              (line, id) => {
                const extentAttrName = line.getAttributeNames().find(
                  n =>
                    n
                      .split(':')
                      .pop()
                      .toLowerCase() === 'extent'
                );

                const [width, height] = _getAttributeAnyNS(line, 'extent')
                  .split(' ')
                  .map(n => parseInt(n));
                const [left, top] = _getAttributeAnyNS(line, 'origin')
                  .split(' ')
                  .map(n => parseInt(n));
                const imageName = line
                  .querySelector('image')
                  .getAttribute('src');
                const begin = _ttmlTimeToSeconds(line.getAttribute('begin'));
                const end = _ttmlTimeToSeconds(line.getAttribute('end'));
                return { id, width, height, top, left, imageName, begin, end };
              }
            );

            this.lines = lines;
            this.zip = zip;
            resolve();
          });
      });
    });
  }

  _render(lines, options) {
    const scale = options.secondaryImageScale;
    const centerLine = this.extentHeight * 0.5;
    const upperBaseline = this.extentHeight * options.upperBaselinePos;
    const lowerBaseline = this.extentHeight * options.lowerBaselinePos;
    return lines.map(line => {
      const img = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'image'
      );
      this.zip
        .file(line.imageName)
        .async('blob')
        .then(blob => {
          const { left, top, width, height } = line;
          const [newWidth, newHeight] = [width * scale, height * scale];
          const newLeft = left + 0.5 * (width - newWidth);
          const newTop = top <= centerLine ? upperBaseline + gSecondaryOffset : lowerBaseline;

          const src = URL.createObjectURL(blob);
          img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', src);
          img.setAttributeNS(null, 'width', newWidth);
          img.setAttributeNS(null, 'height', newHeight);
          img.setAttributeNS(null, 'x', newLeft);
          img.setAttributeNS(null, 'y', newTop);
          img.setAttributeNS(null, 'opacity', options.secondaryImageOpacity);
          img.addEventListener('load', () => {
            URL.revokeObjectURL(src);
          });
        });
      return img;
    });
  }
}

// -----------------------------------------------------------------------------

class SubtitleFactory {
  // Netflix renamed "ttDownloadables" to "downloadables" (same shape: { [profile]: { urls, isImage, ... } })
  static downloadables(track) {
    return track.downloadables || track.ttDownloadables || {};
  }

  // track: manifest.textTracks[...]
  static build(track) {
    const isImageBased = Object.values(this.downloadables(track)).some(d => d.isImage);
    const isCaption = track.rawTrackType === 'closedcaptions';
    const lang = track.languageDescription + (isCaption ? ' [CC]' : '');
    const bcp47 = track.language;

    if (!track.hydrated) {
      return new DehydratedSubtitle(lang, bcp47);
    }
    if (isImageBased) {
      return this._buildImageBased(track, lang, bcp47, isCaption);
    }
    return this._buildTextBased(track, lang, bcp47, isCaption);
  }

  static isNoneTrack(track) {
    // Sometimes Netflix places "fake" text tracks into manifests.
    // Such tracks have "isNoneTrack: false" and even have downloadable URLs,
    // while their display name is "Off" (localized in UI language, e.g., "關閉").
    // Here we use a huristic rule concluded by observation to filter those "fake" tracks out.
    if (track.isNoneTrack) {
      return true;
    }

    // "new_track_id" example "T:1:0;1;zh-Hant;1;1;" (now "id", e.g. "T:2:0;1;pl;1;1;0;0;")
    // the bit at index 4 is 1 for NoneTrack text tracks
    try {
      const isNoneTrackBit = (track.id || track.new_track_id).split(';')[4];
      if (isNoneTrackBit === '1') {
        return true;
      }
    }
    catch (err) {
    }

    // "rank" === -1
    if (track.rank !== undefined && track.rank < 0) {
      return true;
    }
    return false;
  }

  static _buildImageBased(track, lang, bcp47, isCaption) {
    const downloadables = Object.values(this.downloadables(track));
    const maxHeight = Math.max(...downloadables.map(d => {
      if(d.height)
        return d.height;
      else
        return -1;
    }));
    const d = downloadables.find(d => d.height === maxHeight);
    let urls;
    if (d.downloadUrls) {
      urls = Object.values(d.downloadUrls);
    } else {
      urls = d.urls.map(t => t.url);
    }
    return new ImageSubtitle(lang, bcp47, urls, isCaption);
  }

  static _buildTextBased(track, lang, bcp47, isCaption) {
    const targetProfile = 'dfxp-ls-sdh';
    const d = this.downloadables(track)[targetProfile];
    if (!d) {
      console.debug(`Cannot find "${targetProfile}" for ${lang}`);
      return null;
    }
    let urls;
    if (d.downloadUrls) {
      urls = Object.values(d.downloadUrls);
    } else {
      urls = d.urls.map(t => t.url);
    }
    return new TextSubtitle(lang, bcp47, urls, isCaption);
  }
}

// textTracks: manifest.textTracks
const buildSubtitleList = textTracks => {
  const dummy = new DummySubtitle();
  dummy.activate();

  // sorted by language in alphabetical order (to align with official UI)
  const subs = textTracks
    .filter(t => !SubtitleFactory.isNoneTrack(t))
    .map(t => SubtitleFactory.build(t))
    .filter(t => t !== null);
  return subs.concat(dummy);
};

// textTracks: manifest.textTracks
const updateSubtitleList = (textTracks, textTrackId) => {
  const track = textTracks.find(t => (t.id || t.new_track_id) == textTrackId),
    sub = SubtitleFactory.build(track),
    index = gSubtitles.findIndex(s => s.lang == sub.lang);
  if (gSubtitles[index] instanceof DehydratedSubtitle && sub !== null) {
    gSubtitles[index] = sub;
    gSubtitleMenu && gSubtitleMenu.render();
  }
};

////////////////////////////////////////////////////////////////////////////////

const SUBTITLE_LIST_CLASSNAME = 'nflxmultisubs-subtitle-list';
const SUB_MENU_SELECTOR = 'selector-audio-subtitle';
class SubtitleMenu {
  constructor(node) {
    this.style = this.extractStyle(node)
    this.elem = document.createElement('div');
    this.elem.classList.add(this.style.maindiv, 'structural', 'track-list-subtitles');
    this.elem.classList.add(SUBTITLE_LIST_CLASSNAME);
  }

  extractStyle(node){
    // get class names of all the sub menu elements
    // so we can apply them to our menu and copy their style
    let style = { maindiv: null, subdiv: null, h3: null, ul: null, li: null, selected: null }
    const mainNode = node.querySelector(`div[data-uia=${SUB_MENU_SELECTOR}]`)

    //some ugly try blocks because we don't want to crash if only one extraction fails
    try { style.maindiv = mainNode.firstChild.className } catch {}
    try { style.subdiv = mainNode.querySelector('li div div').className } catch {}
    try { style.h3 = mainNode.querySelector('h3').className } catch {}
    try { style.ul = mainNode.querySelector('ul').className } catch {}
    try { style.li = mainNode.querySelector('li').className } catch {}
    try { style.selected = mainNode.querySelector('li[data-uia*="selected"] svg').className.baseVal } catch {} // Netflix fuckery

    return style
  }

  render() {
    const checkIcon = `<svg viewBox="0 0 24 24" class="${this.style.selected}"><path fill="currentColor" d="M3.707 12.293l-1.414 1.414L8 19.414 21.707 5.707l-1.414-1.414L8 16.586z"></path></svg>`;

    const loadingIcon = `<svg class="${this.style.selected}" focusable="false" viewBox="0 -5 50 55">
          <path d="M 6 25 C6 21, 0 21, 0 25 C0 57, 49 59, 50 25 C50 50, 8 55, 6 25" stroke="transparent" fill="red">
            <animateTransform attributeType="xml" attributeName="transform" type="rotate" from="0 25 25" to="360 25 25" dur="0.9s" repeatCount="indefinite"/>
          </path>
      </svg>`;

    this.elem.innerHTML = `<h3 class="${this.style.h3}">Secondary Subtitles</h3>`;

    const listElem = document.createElement('ul');
    gSubtitles.forEach((sub, id) => {
      if (sub instanceof DehydratedSubtitle) return;
      let item = document.createElement('li');
      item.classList.add(this.style.li);
      if (sub.active) {
        const icon = sub.state === 'LOADING' ? loadingIcon : checkIcon;
        item.classList.add('selected');
        item.innerHTML = `<div>${icon}<div class="${this.style.subdiv}">${sub.lang}</div></div>`;
      } else {
        item.innerHTML = `<div><div class="${this.style.subdiv}">${sub.lang}</div></div>`;
        item.addEventListener('click', () => {
          activateSubtitle(id, { remember: true });
        });
      }
      listElem.classList.add(this.style.ul);
      listElem.appendChild(item);
    });
    const listWrapper = document.createElement('div');
    listWrapper.style.overflowY = 'auto';
    listWrapper.style.overflowX = 'hidden';
    listWrapper.appendChild(listElem);
    this.elem.appendChild(listWrapper);
  }
}

// -----------------------------------------------------------------------------

const isPopupMenuElement = node => {
  return (
    node.nodeName.toLowerCase() === 'div' &&
    node.querySelector(`div[data-uia=${SUB_MENU_SELECTOR}]`)
  );
};

// FIXME: can we disconnect this observer once our menu is injected ?
// we still don't know whether Netflix would re-build the pop-up menu after
// switching to next episodes
const bodyObserver = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (isPopupMenuElement(node)) {
        // popup menu attached
        if (!node.getElementsByClassName(SUBTITLE_LIST_CLASSNAME).length) {
          if (!gSubtitleMenu) {
            gSubtitleMenu = new SubtitleMenu(node);
            gSubtitleMenu.render();
          }
          node.style.left = "auto";
          node.style.right = "10px";
          node.querySelector(`div[data-uia=${SUB_MENU_SELECTOR}]`).appendChild(gSubtitleMenu.elem);
        }
      }
    });
    mutation.removedNodes.forEach(node => {
      if (isPopupMenuElement(node)) {
        // popup menu detached
      }
    });
  });
});
const observerOptions = {
  attributes: true,
  subtree: true,
  childList: true,
  characterData: true
};
bodyObserver.observe(document.body, observerOptions);

////////////////////////////////////////////////////////////////////////////////

// `remember`: the user picked this subtitle, save it as the last used language
const activateSubtitle = (id, { remember = false } = {}) => {
  const sub = gSubtitles[id];
  if (sub) {
    gSubtitles.forEach(sub => sub.deactivate());
    sub.activate().then(() => {gSubtitleMenu && gSubtitleMenu.render();});

    if (remember) {
      // only send the changed keys, so other stored settings aren't overwritten
      const lastUsed = {
        secondaryLanguageLastUsed: sub.bcp47 || null, // null: "Off"
        secondaryLanguageLastUsedIsCaption: !!sub.isCaption,
      };
      Object.assign(gRenderOptions, lastUsed);
      sendToBackground({ settings: lastUsed });
    }
  }
  gSubtitleMenu && gSubtitleMenu.render();
};

const buildSecondarySubtitleTextElement = options => {
  // covers the video area (same aspect ratio as the video), subtitles are positioned inside it in %
  const paragraph = document.createElement('p');
  paragraph.classList.add('nflxmultisubs-subtitle-text');
  paragraph.style = 'position:absolute; top:0; bottom:0; left:0; right:0; margin:0;';

  const padding = document.createElement('div');
  padding.classList.add('nflxmultisubs-subtitle-padding');
  padding.style = `display:block; content:' '; width:100%; padding-top:${gVideoRatio *
    100}%;`;

  const container = document.createElement('div');
  container.classList.add('nflxmultisubs-subtitle-container');
  container.style = 'position:relative; width:100%; max-height:100%;';
  container.appendChild(paragraph);
  container.appendChild(padding);

  // the wrapper covers the player, so let clicks through to it except on the words
  const style = document.createElement('style');
  style.textContent = `
    .nflxmultisubs-word { pointer-events: auto; cursor: pointer; border-radius: 0.15em; }
    .nflxmultisubs-word:hover { background-color: rgba(255, 255, 255, 0.25); }`;

  const wrapper = document.createElement('div');
  wrapper.classList.add('nflxmultisubs-subtitle-wrapper');
  wrapper.style =
    'position:absolute; top:0; left:0; width:100%; height:100%; z-index:2; display:flex; align-items:center; pointer-events:none;';
  wrapper.appendChild(style);
  wrapper.appendChild(container);
  return wrapper;
};

// -----------------------------------------------------------------------------

class PrimaryImageTransformer {
  constructor() {}

  transform(svgElem, controlsActive, forced) {
    const selector = forced ? 'image' : 'image:not(.nflxmultisubs-scaled)';
    const images = svgElem.querySelectorAll(selector);
    if (images.length > 0) {
      const viewBox = svgElem.getAttributeNS(null, 'viewBox');
      const [extentWidth, extentHeight] = viewBox
        .split(' ')
        .slice(-2)
        .map(n => parseInt(n));

      // TODO: if there's no secondary subtitle, center the primary on baseline
      const options = gRenderOptions;
      const centerLine = extentHeight * 0.5;
      const upperBaseline = extentHeight * options.upperBaselinePos;
      const lowerBaseline = extentHeight * options.lowerBaselinePos;
      const scale = options.primaryImageScale;
      const opacity = options.primaryImageOpacity;
      const color = options.primaryTextColor;

      [].forEach.call(images, img => {
        img.classList.add('nflxmultisubs-scaled');
        const left = parseInt(
          img.getAttributeNS(null, 'data-orig-x') ||
            img.getAttributeNS(null, 'x')
        );
        const top = parseInt(
          img.getAttributeNS(null, 'data-orig-y') ||
            img.getAttributeNS(null, 'y')
        );
        const width = parseInt(
          img.getAttributeNS(null, 'data-orig-width') ||
            img.getAttributeNS(null, 'width')
        );
        const height = parseInt(
          img.getAttributeNS(null, 'data-orig-height') ||
            img.getAttributeNS(null, 'height')
        );

        const attribs = [
          ['x', left],
          ['y', top],
          ['width', width],
          ['height', height]
        ];
        attribs.forEach(p => {
          const attrName = `data-orig-${p[0]}`,
            attrValue = p[1];
          if (!img.getAttributeNS(null, attrName)) {
            img.setAttributeNS(null, attrName, attrValue);
          }
        });

        const [newWidth, newHeight] = [width * scale, height * scale];
        const newLeft = left + 0.5 * (width - newWidth);

        // large scale multi-line subs sometimes fall outside of the screen when they are placed at the top,
        // caused by newTop becoming negative (because newHeight is based on the subs scale)
        // subtracting newHeight/2 prevents this and makes it so that multiline subs are displayed at roughly
        // the same location as the single line subs when this happens.
        // gSecondaryOffset moves the secondary subtitles with it
        let newTop;

        if(top <= centerLine){
          if(upperBaseline - newHeight <= 0){
            newTop = upperBaseline - newHeight/2
            gSecondaryOffset = newHeight/2
          }else{
            newTop = upperBaseline - newHeight
            gSecondaryOffset = 0
          }
        }else{
          newTop = lowerBaseline - newHeight
          gSecondaryOffset = 0
        }

        // if it somehow still ends up negative just hard-constrain it
        // (we arbitrarily choose 10 to give it some space from the screen edge)
        newTop = (newTop <= 0) ? 10 : newTop;

        img.setAttributeNS(null, 'width', newWidth);
        img.setAttributeNS(null, 'height', newHeight);
        img.setAttributeNS(null, 'x', newLeft);
        img.setAttributeNS(null, 'y', newTop);
        img.setAttributeNS(null, 'opacity', opacity);
        img.setAttributeNS(null, 'color', color);
      });
    }
  }
}

class PrimaryTextTransformer {
  constructor() {
    this.lastScaledPrimaryTextContent = undefined;
  }

  transform(divElem, controlsActive, forced) {
    let parentNode = divElem.parentNode;
    if (!parentNode.classList.contains('nflxmultisubs-primary-wrapper')) {
      // let's use `<style>` + `!imporant` to outrun the offical player...
      const wrapper = document.createElement('div');
      wrapper.classList.add('nflxmultisubs-primary-wrapper');
      wrapper.style =
        'position:absolute; width:100%; height:100%; top:0; left:0;';

      const styleElem = document.createElement('style');
      wrapper.appendChild(styleElem);

      // wrap the offical text-based subtitle container, hehe!
      parentNode.insertBefore(wrapper, divElem);
      wrapper.appendChild(divElem);
      parentNode = wrapper;
    }

    const containers = divElem.querySelectorAll('.player-timedtext-text-container');
    // select all elements to check if there are more than one later
    // but for now we only need the first one to attach our style
    const container = containers.item(0);
    if (!container) return;

    const textContent = container.textContent;
    if (this.lastScaledPrimaryTextContent === textContent && !forced) return;
    this.lastScaledPrimaryTextContent = textContent;

    const style = parentNode.querySelector('style');
    if (!style) return;

    const textSpan = Array.from(container.querySelectorAll('span'));
    if (!textSpan) return;

    const fontSize = parseInt(textSpan.find(t => t.style.fontSize).style.fontSize);
    if (!fontSize) return;

    const options = gRenderOptions;
    const opacity = options.primaryTextOpacity;
    const color = options.primaryTextColor;
    const scale = options.primaryTextScale;
    const newFontSize = fontSize * scale;
    const styleText = `.player-timedtext-text-container span {
        font-size: ${newFontSize}px !important;
        opacity: ${opacity};
        color: ${color} !important;
      }`;
    style.textContent = styleText;

    const rect = divElem.getBoundingClientRect();
    const [extentWidth, extentHeight] = [rect.width, rect.height];

    const lowerBaseline = extentHeight * options.lowerBaselinePos;
    const { left, top, width, height } = container.getBoundingClientRect();
    const newLeft = extentWidth * 0.5 - width * 0.5;
    let newTop = lowerBaseline - height;

    // FIXME: dirty transform & magic offets
    // we out run the official player, so the primary text-based subtitles
    // does not move automatically when the navs are active
    newTop += controlsActive ? -100 : 0;

    if (containers.length == 1){
      style.textContent +=
          styleText +
          '\n' +
          `
      .player-timedtext-text-container {
        top: ${newTop}px !important;
        left: ${newLeft}px !important;
      }`;
    }else{
      // Don't change position when there are multiple subtitle boxes.
      // Changing 'left:' will cause overlap.
      // This can happen for subs that have speaker-placed captioning enabled (subs that are positioned over the speaker)
    }
  }
}

class RendererLoop {
  constructor(video) {
    this.isRunning = false;
    this.isRenderDirty = undefined; // windows resize or config change, force re-render
    this.videoElem = video;
    this.subtitleWrapperElem = undefined; // secondary subtitles wrapper (outer)
    this.subText = undefined; // secondary subtitles text container
    this.primaryImageTransformer = new PrimaryImageTransformer();
    this.primaryTextTransformer = new PrimaryTextTransformer();
  }

  setRenderDirty() {
    this.isRenderDirty = true;
  }

  start() {
    this.isRunning = true;
    window.requestAnimationFrame(this.loop.bind(this));
    sendToBackground({ startPlayback: 1 }); // colors our toolbar icon
  }

  stop() {
    this.isRunning = false;
    this._clearSecondarySubtitlesText();
    sendToBackground({ stopPlayback: 1 }); // grays out our toolbar icon
  }

  async loop() {
    try {
      await this._loop();
      this.isRunning && window.requestAnimationFrame(this.loop.bind(this));
    }
    catch (err) {
      console.error('Fatal: ', err);
    }
  }

  async _loop() {
    const currentVideoElem = document.querySelector('#appMountPoint video');

    // stop the render loop if there is no videoplayer (e.g.: user is on the homepage)
    if (!currentVideoElem && !/netflix\..*\/watch/i.test(window.location.href)) {
      this.stop();
      window.__NflxMultiSubs.lastMovieId = undefined // clear this in case the same show is started again later
      return;
    }

    if (currentVideoElem && this.videoElem.src !== currentVideoElem.src) {
      // TODO: do we still need to check for this?
      // some video change episodes by update video src
      // force terminate renderer loop if src changed
      this.stop();
      window.__NflxMultiSubs.rendererLoopDestroy();
      return;
    }

    const controlsActive = this._getControlsActive();
    // NOTE: don't do this, the render rate is too high to shown the
    // image in SVG for secondary subtitles.... O_Q
    // if (controlsActive) {
    //   this.setRenderDirty(); // to move up subttles
    // }
    if (!this._appendSubtitleWrapper()) {
      return;
    }

    this._adjustPrimarySubtitles(controlsActive, !!this.isRenderDirty);
    await this._renderSecondarySubtitlesText();

    // PrimaryTextTransformer moves the primary subtitles up by 100px while the controls are shown,
    // move the secondary ones along so they stay together
    this.subtitleWrapperElem.style.transform = controlsActive ? 'translateY(-100px)' : '';

    // everything rendered, clear the dirty bit with ease
    this.isRenderDirty = false;
  }

  _getControlsActive() {
    // FIXME: better solution to handle different versions of Netflix web player UI
    // "Neo Style" refers to the newer version as in 2018/07
    let controlsElem = document.querySelector('.controls, div[data-uia="controls-standard"], .watch-video--bottom-controls-container'),
      neoStyle = false;
    if (!controlsElem) {
      controlsElem = document.querySelector('.PlayerControlsNeo__layout');
      if (!controlsElem) {
        return false;
      }
      neoStyle = true;
    }
    // elevate the navs' z-index (to be on top of our subtitles)
    if (!controlsElem.style.zIndex) {
      controlsElem.style.zIndex = 3;
    }

    if (neoStyle) {
      return !controlsElem.classList.contains(
        'PlayerControlsNeo__layout--inactive'
      );
    }
    return controlsElem !== null;
  }

  // @returns {boolean} Successed?
  _appendSubtitleWrapper() {
    if (!this.subtitleWrapperElem || !this.subtitleWrapperElem.parentNode) {
      const playerContainerElem = document.querySelector('div[data-uia="video-canvas"]');
      if (!playerContainerElem) return false;
      this.subtitleWrapperElem = buildSecondarySubtitleTextElement(gRenderOptions);
      playerContainerElem.appendChild(this.subtitleWrapperElem);
    }
    return true;
  }

  // transform & scale primary subtitles
  _adjustPrimarySubtitles(active, dirty) {
    // NOTE: we cannot put `primaryImageSubSvg` into instance state,
    // because there are multiple instance of the SVG and they're switched
    // when the langauge of primary subtitles is switched.
    const force = this.lastControlsActive !== active;
    const primaryImageSubSvg = document.querySelector(
      '.image-based-subtitles svg'
    );
    if (primaryImageSubSvg) {
      this.primaryImageTransformer.transform(primaryImageSubSvg, active, dirty || force);
    }

    const primaryTextSubDiv = document.querySelector('.player-timedtext');
    if (primaryTextSubDiv) {
      this.primaryTextTransformer.transform(primaryTextSubDiv, active, dirty || force);
    }

    this.lastControlsActive = active;
  }

  _clearSecondarySubtitlesText() {
    if (!this.subText || !this.subText.parentNode) return;
    while (this.subText.firstChild) {
      this.subText.removeChild(this.subText.firstChild); // remove the children to clear subtitle text 
    }
  }

  async _renderSecondarySubtitlesText() {
    if (!this.subText || !this.subText.parentNode) {
      this.subText = this.subtitleWrapperElem.querySelector('p');
      // find paragraph
    }
    const seconds = this.videoElem.currentTime;
    const sub = gSubtitles.find(sub => sub.active);
    if (!sub) {
      return;
    }

    if (sub instanceof TextSubtitle) {
      const rect = this.videoElem.getBoundingClientRect();
      sub.setExtent(rect.width, rect.height);
    }

    const renderedElems = await sub.render(
      seconds,
      gRenderOptions,
      !!this.isRenderDirty
    );

    if (renderedElems) {
      // const [extentWidth, extentHeight] = sub.getExtent();
      this._clearSecondarySubtitlesText();
      renderedElems.forEach(elem => this.subText.appendChild(elem));
    }
  }
}

window.addEventListener('resize', evt => {
  gRendererLoop && gRendererLoop.setRenderDirty();
  console.log(
    'Resize:',
    `${window.innerWidth}x${window.innerHeight} (${evt.timeStamp})`
  );
});


// -----------------------------------------------------------------------------

class ManifestManagerBase {
  enumManifest() {}
  getManifest(movieId) {}
  saveManifest(manifest) {}
}


class ManifestManagerInMemory extends ManifestManagerBase {
  constructor(...args) {
    super(...args);
    this.manifests = {};
  }

  enumManifest() {
    return this.manifests;
  }

  getManifest(movieId) {
    return this.manifests[movieId];
  }

  saveManifest(manifest) {
    this.manifests[manifest.movieId] = manifest;
  }
}

class ManifestManagerLocalStorage extends ManifestManagerBase {
  enumManifests() {
    return Object.entries(window.localStorage).filter((key, val) => {
      return key.indexOf('manifest=') == 0;
    });
  }

  getManifest(movieId) {
    const key = `manifest=${movieId}`;
    const item = window.localStorage.getItem(key);
    if (!item) {
      console.log(`Manifet ${movieId} not found in localStorage`);
      return null;
    }

    // console.log(`Manifest ${movieId} found in localStorage`);
    const manifest = JSON.parse(item).manifest;
    return manifest;
  }

  saveManifest(manifest) {
    const key = `manifest=${manifest.movieId}`;
    window.localStorage.setItem(key, JSON.stringify({
      manifest: manifest,
      timestamp: new Date(),
    }));
  }
}



const extractMovieIdFromUrl = () => {
  const isInPlayerPage = /netflix\.com\/watch/i.test(window.location.href);
  if (!isInPlayerPage) {
    // console.log('Not in player page');
    return null;
  }

  try {
    const movieIdInUrl = /^\/watch\/(\d+)/.exec(window.location.pathname)[1];
    const movieId = parseInt(movieIdInUrl);
    //console.log(`Movie in URL: ${movieId}`)
    return movieId;
  }
  catch (err) {
    console.error(err);
  }
  return null;
};

class NflxMultiSubsManager {
  constructor() {
    this.version = VERSION;
    this.lastMovieId = undefined;
    this.playerUrl = undefined;
    this.playerVersion = undefined;
    this.busyWaitTimeout = 100000; // ms
    this.manifestManager = new ManifestManagerInMemory();
    console.log(`Version: ${this.version}`)
  }

  busyWaitVideoElement() {
    // Never reject
    return new Promise((resolve, _) => {
      let timer = 0;
      const intervalId = setInterval(() => {
        const video = document.querySelector('#appMountPoint video');
        if (video) {
          clearInterval(intervalId);
          resolve(video);
        }
        if (timer * 200 === this.busyWaitTimeout) {
          // Notify user can F5 or just keep wait...
          clearInterval(intervalId);
        }
        timer += 1;
      }, 200);
    });
  }

  activateManifest(movieId) {
    const manifest = this.manifestManager.getManifest(movieId);
    if (!manifest) {
      console.log(`Cannot find manifest: ${movieId}`);
      return;
    }

    const movieIdInUrl = extractMovieIdFromUrl();
    if (!movieIdInUrl) return;

    if (movieIdInUrl != manifest.movieId) {
      console.log(`Different manifest, movieIdInUrl=${movieIdInUrl}, manifest.movieId=${manifest.movieId}`);
      return;
    }

    // Sometime the movieId in URL may be different to the actually playing manifest
    // Thus we also need to check the player DOM tree...
    // (also wait for the stored settings, which decide the secondary language)
    Promise.all([this.busyWaitVideoElement(), gSettingsReady])
      .then(([video]) => {
        try {
          const movieIdInUrl = extractMovieIdFromUrl();
          let playingManifest = (manifest.movieId === movieId);

          if (!playingManifest) {
            // magic! ... div.VideoContainer > div#12345678 > video[src=blob:...]
            const movieIdInPlayerNode = video.parentNode.id;
            console.log(`Note: movieIdInPlayerNode=${movieIdInPlayerNode}`);
            playingManifest = movieIdInPlayerNode.includes(manifest.movieId.toString());
          }

          if (!playingManifest) {
            console.log(`Ignored: manifest ${manifest.movieId} not playing`);
            // Ignore but store it.
            // this.manifestList.push(manifest);
            return;
          }

          // Netflix renamed manifest fields (timedtexttracks -> textTracks, audio_tracks -> audioTracks, ...)
          const textTracks = manifest.textTracks || manifest.timedtexttracks;
          const audioTracks = manifest.audioTracks || manifest.audio_tracks;
          const videoTracks = manifest.videoTracks || manifest.video_tracks;

          const movieChanged = manifest.movieId !== this.lastMovieId;
          if (!movieChanged) {
            updateSubtitleList(textTracks, manifest.recommendedMedia.textTrackId || manifest.recommendedMedia.timedTextTrackId);
            console.log(`Manifest ${manifest.movieId} updated`);
            return;
          }

          console.log(`Activating manifest ${manifest.movieId} (last=${this.lastMovieId})`);
          this.lastMovieId = manifest.movieId;

          // For cadmium-playercore-6.0012.183.041.js and later
          gSubtitles = buildSubtitleList(textTracks);
          // the menu may have been built before the list existed
          gSubtitleMenu && gSubtitleMenu.render();

          // select subtitle based on language settings
          this.selectSecondarySubtitle(audioTracks);

          // retrieve video ratio
          try {
            let { maxWidth, maxHeight } = videoTracks[0];
            gVideoRatio = maxHeight / maxWidth;
          }
          catch (err) {
            console.error('Video ratio not available, ', err);
          }
        }
        catch (err) {
          console.error('Fatal: ', err);
        }

        if (gRendererLoop) {
          gRendererLoop.stop();
          gRendererLoop = null;
          console.log('Terminated: old renderer loop');
        }

        if (!gRendererLoop) {
          gRendererLoop = new RendererLoop(video);
          gRendererLoop.start();
          console.log('Started: renderer loop');
        }

        // detect for newer version of Netflix web player UI
        const hasNeoStyleControls = !!document.querySelector('[class*=PlayerControlsNeo]');
        console.log(`hasNeoStyleControls: ${hasNeoStyleControls}`);
      })
      .catch(err => {
        console.error('Fatal: ', err);
      });
  }

  // pick the secondary subtitle according to the language mode in the settings
  selectSecondarySubtitle(audioTracks) {
    const mode = String(gRenderOptions.secondaryLanguageMode);
    console.log('Language mode: ', mode);
    if (mode === 'disabled') return;

    const findSubtitle = (bcp47, isCaption) => gSubtitles.findIndex(t =>
      !(t instanceof DehydratedSubtitle) && t.bcp47 == bcp47 && (isCaption === undefined || t.isCaption == isCaption));

    if (mode === 'last') {
      const lastUsed = gRenderOptions.secondaryLanguageLastUsed;
      if (lastUsed === null) {
        console.log('Last used language is "Off", subs disabled.');
        return;
      }
      if (lastUsed) {
        // if can't match CC type, fall back to language only
        let lastSubtitleId = findSubtitle(lastUsed, gRenderOptions.secondaryLanguageLastUsedIsCaption);
        if (lastSubtitleId == -1)
          lastSubtitleId = findSubtitle(lastUsed);
        if (lastSubtitleId >= 0) {
          console.log(`Subtitle #${lastSubtitleId} enabled (last used)`);
          activateSubtitle(lastSubtitleId);
          return;
        }
        console.log(`${lastUsed} subs not available, matching audio language instead.`);
      }
      // nothing picked yet (or not available for this title): match the audio language
    }

    try {
      /* Note 2021/11/04 :
          manifest.defaultTrackOrderList doesn't exist anymore. We can use the audio track's isNative flag instead.
          There is also manifest.recommendedMedia.audioTrackId , but it just points to the track with isNative == true. */
      const defaultAudioTrack = audioTracks.find(t => t.isNative == true) || audioTracks[0]; // fall back to first track if isNative fails
      const defaultAudioLanguage = defaultAudioTrack.language;
      console.log(`Default audio track language: ${defaultAudioLanguage}`);
      const autoSubtitleId = findSubtitle(defaultAudioLanguage);
      if (autoSubtitleId >= 0) {
        console.log(`Subtitle #${autoSubtitleId} auto-enabled to match audio`);
        activateSubtitle(autoSubtitleId);
      } else {
        console.log(defaultAudioLanguage + ' subs not available.');
      }
    }
    catch (err) {
      console.error('Default audio track not found, ', err);
    }
  }

  updateManifest(manifest) {
    try {
      console.log(`Intecerpted manifest: ${manifest.movieId}`);
    }
    catch (err) {
      console.warn('Error:', err);
    }

    this.manifestManager.saveManifest(manifest);
    this.activateManifest(manifest.movieId);
  }

  rendererLoopDestroy() {
    const movieIdInUrl = extractMovieIdFromUrl();
    if (!movieIdInUrl) return;

    console.log(`rendererLoop destroyed, trying to activate: ${movieIdInUrl}`);
    this.lastMovieId = undefined;
    this.activateManifest(movieIdInUrl);
  }
}

const nflxMultiSubsManager = new NflxMultiSubsManager();
window.__NflxMultiSubs = nflxMultiSubsManager;  // interface between us and the the manifest hook

// =============================================================================


// =============================================================================

// control video playback rate
const playbackRateController = new PlaybackRateController();
playbackRateController.activate();

window.addEventListener('keydown', (event) => {
  // toggle subtitles visibility with 'v'
  if (event.key.toLowerCase() === 'v') {
    const wrappers = Array.from(document.querySelectorAll('.nflxmultisubs-primary-wrapper, .nflxmultisubs-subtitle-wrapper'));
    if (!wrappers.length)
      return;

    const visible = wrappers.some(w => window.getComputedStyle(w).visibility === 'visible');
    wrappers.forEach(w => w.style.visibility = (visible) ? 'hidden' : 'visible');
  }
}, true);



// press 1-9 to look up the n-th word of the secondary subtitle on screen and add it to the word bank
document.addEventListener('keydown', (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (!/^[1-9]$/.test(event.key)) return;

  const word = gSubtitleWords[parseInt(event.key) - 1];
  if (word) lookUpWord(word);
});