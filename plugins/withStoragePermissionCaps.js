const { withAndroidManifest } = require("expo/config-plugins");

// expo-image-picker (and friends) inject the legacy storage permissions
// uncapped. From API 33 those are superseded by the granular READ_MEDIA_*
// grants, so leaving them open requests storage access the app never uses and
// draws a Play Console review flag. The hand-maintained manifest used to cap
// them at 32; this reproduces that so a prebuild cannot silently drop it.
//
// Must stay LAST in app.json's plugins array — it edits permissions that
// earlier plugins add, so running before them is a no-op.
const CAPPED_PERMISSIONS = new Set([
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
]);

module.exports = function withStoragePermissionCaps(config) {
  return withAndroidManifest(config, (mod) => {
    const permissions = mod.modResults.manifest["uses-permission"] ?? [];

    for (const permission of permissions) {
      if (CAPPED_PERMISSIONS.has(permission.$?.["android:name"])) {
        permission.$["android:maxSdkVersion"] = "32";
      }
    }

    return mod;
  });
};
