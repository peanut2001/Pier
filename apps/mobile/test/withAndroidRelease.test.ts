import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { applyReleaseSigning, versionCodeOf } = require("../plugins/withAndroidRelease.js") as {
	applyReleaseSigning: (gradle: string) => string;
	versionCodeOf: (version: string | undefined) => number;
};

// The signing section of the Expo SDK template's android/app/build.gradle.
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

describe("withAndroidRelease", () => {
	it("derives an increasing versionCode from the app version", () => {
		expect(versionCodeOf("0.2.1")).toBe(2001);
		expect(versionCodeOf("0.2.2-rc.1")).toBe(2002);
		expect(versionCodeOf("1.0.0")).toBe(1_000_000);
		expect(versionCodeOf("0.10.0")).toBeGreaterThan(versionCodeOf("0.9.999"));
		expect(() => versionCodeOf("1.2")).toThrow();
		expect(() => versionCodeOf("0.1000.0")).toThrow();
	});

	it("signs release builds with the Pier key only when it is configured", () => {
		const gradle = applyReleaseSigning(TEMPLATE);
		expect(gradle).toContain("storeFile file(findProperty('pierUploadStoreFile'))");
		expect(gradle).toContain(
			"signingConfig findProperty('pierUploadStoreFile') ? signingConfigs.release : signingConfigs.debug",
		);
		// Debug builds keep the debug key.
		expect(gradle).toMatch(/debug \{\n\s*signingConfig signingConfigs\.debug\n/);
		expect(applyReleaseSigning(gradle)).toBe(gradle);
	});

	it("fails loudly when the template changes", () => {
		expect(() => applyReleaseSigning("android {}\n")).toThrow(/no longer matches/);
	});
});
