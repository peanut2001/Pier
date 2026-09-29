/**
 * Names of files that usually hold private keys or credentials. Previewing them is allowed,
 * but only after an explicit confirmation, so a stray click does not put a secret on screen.
 */
const SENSITIVE_PATTERNS = [
	/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
	/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg)$/i,
	/^\.env(\.(?!example$|sample$|template$|dist$)[^.]+)*$/i,
	/^\.(netrc|pgpass|npmrc|pypirc|git-credentials)$/i,
	/^(credentials|secrets?)(\.[\w-]+)?$/i,
	/^auth\.json$/i,
];

export function isSensitiveFile(path: string): boolean {
	const name = path.split("/").pop() ?? path;
	return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name));
}
