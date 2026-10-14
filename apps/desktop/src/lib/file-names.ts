/** Validate a single name inside an existing workspace directory. */
export function workspaceNameError(name: string): string | undefined {
	const value = name.trim();
	if (!value || value === "." || value === "..") return "请输入有效的名称";
	if (/[\\/]/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32) || /^[a-zA-Z]:/.test(value))
		return "名称不能包含路径分隔符或控制字符";
	return undefined;
}
