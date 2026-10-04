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
Requires Xcode and a free or paid Apple Developer account.

1) Convert the Chrome build into a Safari app project (run once; `--macos-only --swift` skips
   iOS, `--project-location` is where the generated Xcode project goes):
   ```
   xcrun safari-web-extension-converter build/chrome --macos-only --swift \
     --project-location build/safari --app-name SeeingDouble \
     --bundle-identifier com.yourname.SeeingDouble
   ```
2) After each `npm run build`, rebuild the Safari app (replace `YOUR_TEAM_ID` with your Apple
   Developer Team ID, found at https://developer.apple.com/account under Membership):
   ```
   xcodebuild -project build/safari/SeeingDouble/SeeingDouble.xcodeproj -scheme SeeingDouble \
     -derivedDataPath ~/Library/Developer/Xcode/DerivedData/SeeingDouble-safari \
     DEVELOPMENT_TEAM=YOUR_TEAM_ID -allowProvisioningUpdates build
   ```
3) Toggle the extension off/on in Safari's Settings > Extensions to pick up the rebuild.

**If your project directory is inside iCloud Drive** (e.g. under `~/Documents` with iCloud sync
on), point `-derivedDataPath` somewhere outside it, as above. iCloud-synced files pick up
extended attributes that make codesigning fail with "resource fork, Finder information, or
similar detritus not allowed".
