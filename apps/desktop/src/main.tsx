import "@fontsource-variable/inter/wght.css";
import "highlight.js/styles/github-dark.css";
import "./styles.css";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { customTitleBar } from "./components/TitleBar.tsx";
import { bridge } from "./lib/bridge.ts";
import { PierStore, StoreContext } from "./lib/store.tsx";

if (/Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) {
	document.documentElement.classList.add("linux");
}

if (customTitleBar) document.documentElement.classList.add("custom-titlebar");

const store = new PierStore(bridge);

function Root() {
	useEffect(() => store.start(), []);
	return (
		<StoreContext.Provider value={store}>
			<App />
		</StoreContext.Provider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
	<StrictMode>
		<Root />
	</StrictMode>,
);
