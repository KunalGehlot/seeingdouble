# Installation instructions

This fork is **not published on the Chrome or Firefox stores**. Build it yourself, or use a zip
from your own [Releases](https://github.com/KunalGehlot/seeingdouble/releases) page if you've
cut one.

```
git clone https://github.com/KunalGehlot/seeingdouble.git
cd seeingdouble
npm install
npm run build
```

This produces `build/chrome` and `build/firefox`.

Chrome
----
1) In a new Chrome tab, type `chrome://extensions` in the address bar and press enter
2) In the top right corner, click the box next to **Developer mode** to turn it on
3) Click **Load Unpacked**, then select the `build/chrome` folder
4) Re-run step 3 after each `npm run build` to pick up changes

Firefox
----

**NOTE:** Due to the way Firefox handles unpacked extensions, this is only a temporary
installation -- the extension is removed on browser restart.

1) In a new Firefox tab, type `about:debugging` in the address bar and press enter
2) Click **This Firefox** on the left side of the page
3) Under Temporary Extensions, click **Load Temporary Add-on**
4) Browse to `build/firefox`, select `manifest.json`, and click **Open**

Safari
----
See the Safari build notes in the repository (requires Xcode and
`xcrun safari-web-extension-converter`).
