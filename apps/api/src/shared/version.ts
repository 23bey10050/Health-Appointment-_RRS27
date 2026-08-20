/**
 * Reported by `/health` so a deploy can be identified without opening a shell.
 *
 * Kept as a plain constant rather than read out of package.json: the file sits at a different
 * relative path when running from source than it does from the compiled build, and a version
 * string is not worth a runtime file read that can fail in one of those two places.
 */
export const APP_VERSION = '0.1.0';
