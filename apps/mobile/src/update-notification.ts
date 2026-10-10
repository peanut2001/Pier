import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

type NotificationState = "downloading" | "ready" | "installing" | "error";

interface NativeUpdateNotification {
	show(version: string, state: NotificationState, downloaded: number, total: number): void;
	dismiss(): void;
}

const native =
	Platform.OS === "android" ? requireOptionalNativeModule<NativeUpdateNotification>("PierUpdateNotification") : null;
const PROGRESS_INTERVAL_MS = 1_000;
let lastProgress = 0;
let lastState: NotificationState | undefined;

/** Ask only after the user starts a download; denied permissions never prevent updating. */
export async function prepareUpdateNotification(): Promise<void> {
	if (!native || Number(Platform.Version) < 33) return;
	try {
		const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
		if (!(await PermissionsAndroid.check(permission))) {
			await PermissionsAndroid.request(permission);
		}
	} catch {
		// Notifications are optional, including on devices without a permission prompt.
	}
}

export function showUpdateNotification(version: string, state: NotificationState, downloaded = 0, total = 0): void {
	if (!native) return;
	const now = Date.now();
	if (state === "downloading" && lastState === state && now - lastProgress < PROGRESS_INTERVAL_MS) return;
	lastState = state;
	lastProgress = now;
	try {
		native.show(version, state, downloaded, total);
	} catch {
		// Notification errors must not interrupt downloading, verification or installation.
	}
}

/** Also removes stale progress from an interrupted download when the app starts again. */
export function dismissUpdateNotification(): void {
	lastState = undefined;
	lastProgress = 0;
	try {
		native?.dismiss();
	} catch {
		// Best effort: the notification may already be gone.
	}
}
