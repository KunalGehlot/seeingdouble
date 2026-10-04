<img src="docs/icon.png?raw=true" height="48"> SeeingDouble
============================================================

A Chrome/Firefox/Safari extension for bilingual subtitles on Netflix, forked from
[NflxMultiSubs](https://github.com/jennimao/seeingdouble) (itself forked from
[gmertes/NflxMultiSubs](https://github.com/gmertes/NflxMultiSubs), originally by
[Dan Chen](https://github.com/dannvix)).

This fork is **not published to any extension store** -- build it yourself (see below).

Features
--------
- Enable secondary subtitles in all languages (incl. image-based subtitles like Japanese, Chinese, Russian, …)
- Smart selection on secondary subtitles. Choose between 3 subtitle activation modes: disabled; automatically match subtitle language to audio language; or remember the last selected language.
- Seamless integration with native Netflix player UI -- switch languages in place
- Adjust playback speed (pressing key `[` and `]`)
- Click a word in the secondary subtitle (or press 1-9) to look up its definition and save it to a word bank
- Optional: rewrite secondary subtitles to a simpler vocabulary level using OpenAI (off by default,
  requires your own OpenAI API key -- see **AI Subtitle Simplification** below)
- Open source!!

Build
-----
Requires Node.js. Build directories are `build/chrome` and `build/firefox`.
```
git clone https://github.com/KunalGehlot/seeingdouble.git
cd seeingdouble
npm install
npm run build
```
Then load `build/chrome` or `build/firefox` as an unpacked/temporary extension in your browser.

For Safari, see [INSTALL.md](INSTALL.md).

Run `npm test` to run the background script's smoke tests.

AI Subtitle Simplification
---------------------------
This fork adds an optional feature (off by default) that rewrites secondary subtitles to a
simpler vocabulary level, aimed at language learners, using OpenAI's API.

- **Enable it in the extension's settings popup**, where you also enter your own OpenAI API key
  and pick a vocabulary level.
- **When enabled, subtitle text is sent to OpenAI's API** (`api.openai.com`) to be rewritten.
  Don't enable it if you don't want subtitle text leaving your machine.
- **Your API key is stored locally** by the extension (`chrome.storage.local`) and is only ever
  sent to `api.openai.com`, from the extension's background script -- never to any other
  destination, and never to the Netflix page itself.
- You will be billed by OpenAI for usage under your own API key.

Known Issues
-------------------------
- Wait for the Netflix home page to finish loading completely before starting a show/movie.
- Refresh the page if the secondary sub list is empty.
- This extension could conflict with other Netflix-related extensions. If you encounter any problem, try to disable some of them.
- RTL (right-to-left) text-based subtitles are not ready yet.
- Chrome's current Manifest V2 support may reject this extension's manifest; Firefox and Safari are the tested targets for this fork.
- This extension and its developers are not affiliated with Netflix, Inc. or OpenAI; all rights belong to their respective owners.

Problems?
---------
### The secondary subtitles list is empty or subs aren't showing up
- Subs will show up after a Refresh (F5).

### Large gap between main subtitle and secondary subtitle
- This happens only when the controls bar is active -- just wait until the controls hide

### Only available in Chrome/Firefox for desktop?
- Yup -- mobile devices, smart TVs, Apple TV, Chromecast, … are not supported

### Could I load subtitles from other country?
- This extension respects Netflix rules, hence we only support all official subtitles available in your country

License
--------
MIT. Original by [Dan Chen](https://github.com/dannvix), forked and maintained by
[Gert Mertes](https://github.com/gmertes), further forked by [jennimao](https://github.com/jennimao),
this fork maintained by [Kunal Gehlot](https://github.com/KunalGehlot).
