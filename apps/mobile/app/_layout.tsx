import Ionicons from "@expo/vector-icons/Ionicons";
import * as Font from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ToastHost } from "../src/components/ui.tsx";
import { MobileStore, StoreContext } from "../src/store.ts";
import { usePalette } from "../src/theme.ts";
import { updater } from "../src/updater.ts";

const store = new MobileStore();

export default function RootLayout() {
	const p = usePalette();
	useEffect(() => {
		void store.init();
		void updater.init();
		// Icons render once their font is in; load it right away instead of on first use.
		void Font.loadAsync(Ionicons.font).catch(() => {});
		// iOS suspends sockets in the background; resume (with seq replay) right away on return.
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				store.onBackground();
				return;
			}
			store.onForeground();
			updater.onForeground();
		});
		return () => subscription.remove();
	}, []);
	return (
		<SafeAreaProvider>
			<StoreContext.Provider value={store}>
				<StatusBar style="auto" />
				<Stack
					screenOptions={{
						headerStyle: { backgroundColor: p.bg },
						headerShadowVisible: false,
						headerTintColor: p.text,
						headerTitleStyle: { color: p.text, fontWeight: "700", fontSize: 17 },
						headerBackButtonDisplayMode: "minimal",
						contentStyle: { backgroundColor: p.bg },
						animation: "slide_from_right",
					}}
				>
					<Stack.Screen name="index" options={{ title: "" }} />
					<Stack.Screen
						name="pair"
						options={{ title: "添加电脑", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen name="settings" options={{ title: "设置" }} />
					<Stack.Screen name="host/[hostId]/index" options={{ title: "" }} />
					<Stack.Screen
						name="host/[hostId]/addresses"
						options={{ title: "连接地址", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen
						name="host/[hostId]/add-workspace"
						options={{ title: "添加工作区", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen
						name="host/[hostId]/workspace/[workspaceId]"
						options={{ title: "工作区设置", presentation: "modal", animation: "slide_from_bottom" }}
					/>
					<Stack.Screen name="host/[hostId]/session/[sessionId]" options={{ title: "" }} />
					<Stack.Screen name="host/[hostId]/files" options={{ title: "文件" }} />
					<Stack.Screen name="host/[hostId]/file" options={{ title: "" }} />
					<Stack.Screen
						name="host/[hostId]/terminal"
						options={{
							title: "终端",
							headerStyle: { backgroundColor: "#0d1014" },
							headerTintColor: "#eef0f3",
							headerTitleStyle: { color: "#eef0f3", fontWeight: "700", fontSize: 17 },
							contentStyle: { backgroundColor: "#0d1014" },
						}}
					/>
					<Stack.Screen name="host/[hostId]/extensions" options={{ title: "pi 扩展" }} />
				</Stack>
				<ToastHost />
			</StoreContext.Provider>
		</SafeAreaProvider>
	);
}
