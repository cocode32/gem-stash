/**
 * Format a byte count as a human-readable size (e.g. "3.4 MB").
 * Whole numbers for bytes and >=10 of a unit, one decimal otherwise.
 */
export function humanSize(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let n = bytes;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function parseErrorMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
