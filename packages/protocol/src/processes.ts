/** Processes visible to the Host's OS account and PID namespace (1.42). No command-line arguments. */
export interface HostProcess {
	pid: number;
	parentPid?: number;
	name: string;
	/** User name, or numeric UID when a name is unavailable. */
	user?: string;
	memoryBytes?: number;
	/** Opaque process start identity; clients must echo it when terminating a process. */
	startToken?: string;
	canTerminate: boolean;
}

export interface HostProcesses {
	processes: HostProcess[];
	truncated: boolean;
}
