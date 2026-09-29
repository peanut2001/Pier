import { describe, expect, it } from "vitest";
import { isSensitiveFile } from "../src/lib/sensitive-files.ts";

describe("isSensitiveFile", () => {
	it("flags private keys and credential files", () => {
		for (const path of [
			"id_ed25519",
			".ssh/id_rsa",
			"certs/server.key",
			"tls.pem",
			".env",
			"app/.env.local",
			".env.production.local",
			".netrc",
			".git-credentials",
			"credentials.json",
			"secrets.yaml",
			"auth.json",
		]) {
			expect(isSensitiveFile(path), path).toBe(true);
		}
	});

	it("does not flag public keys, examples and ordinary files", () => {
		for (const path of [
			"id_ed25519.pub",
			".env.example",
			".env.sample",
			"src/keyboard.ts",
			"README.md",
			"docs/secrets-management.md",
			"environment.ts",
		]) {
			expect(isSensitiveFile(path), path).toBe(false);
		}
	});
});
