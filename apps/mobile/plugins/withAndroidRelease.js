// Expo config plugin for Pier's Android release builds (`expo prebuild` regenerates android/, so
// every change to the native project has to go through here):
//
// - versionCode is derived from the app version, so each release upgrades the previous one in place.
// - The release build type is signed with the Pier release key when the `pierUploadStoreFile`,
//   `pierUploadStorePassword`, `pierUploadKeyAlias` and `pierUploadKeyPassword` Gradle properties are
//   set (CI passes them as ORG_GRADLE_PROJECT_* environment variables; locally they can live in
//   ~/.gradle/gradle.properties). Without them it falls back to the debug key, like the Expo template.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "// pier: release signing";

/** "1.2.3" or "1.2.3-rc.1" → 1002003. Pre-releases share the code of their final version. */
function versionCodeOf(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(version ?? "");
	if (!match) throw new Error(`withAndroidRelease: unsupported app version "${version}"`);
	const [major, minor, patch] = match.slice(1).map(Number);
	if (minor > 999 || patch > 999) throw new Error(`withAndroidRelease: version ${version} is out of range`);
	return major * 1_000_000 + minor * 1_000 + patch;
}

const RELEASE_SIGNING_CONFIG = `
        release {
            ${MARKER}
            if (findProperty('pierUploadStoreFile')) {
                storeFile file(findProperty('pierUploadStoreFile'))
                storePassword findProperty('pierUploadStorePassword')
                keyAlias findProperty('pierUploadKeyAlias')
                keyPassword findProperty('pierUploadKeyPassword')
            }
        }`;

/** Adds the Pier release signing config to the template's app/build.gradle. */
function applyReleaseSigning(gradle) {
	if (gradle.includes(MARKER)) return gradle;
	const signingConfigs = /(signingConfigs \{\n(\s*)debug \{[^}]*\}\n)/;
	const releaseBuildType = /(buildTypes \{[\s\S]*?\n\s*release \{[\s\S]*?)signingConfig signingConfigs\.debug/;
	if (!signingConfigs.test(gradle) || !releaseBuildType.test(gradle)) {
		throw new Error("withAndroidRelease: app/build.gradle no longer matches the Expo template; update the plugin");
	}
	return gradle
		.replace(signingConfigs, `$1${RELEASE_SIGNING_CONFIG.slice(1)}\n`)
		.replace(
			releaseBuildType,
			"$1signingConfig findProperty('pierUploadStoreFile') ? signingConfigs.release : signingConfigs.debug",
		);
}

function withAndroidRelease(config) {
	config.android = { ...config.android, versionCode: config.android?.versionCode ?? versionCodeOf(config.version) };
	return withAppBuildGradle(config, (mod) => {
		if (mod.modResults.language !== "groovy") {
			throw new Error("withAndroidRelease: only the Groovy app/build.gradle is supported");
		}
		mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
		return mod;
	});
}

module.exports = withAndroidRelease;
module.exports.versionCodeOf = versionCodeOf;
module.exports.applyReleaseSigning = applyReleaseSigning;
