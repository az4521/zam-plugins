/**
 * Pure logic for parsing and validating plugin manifests. Validates that a
 * third-party plugin's manifest.json is well-formed (required fields present,
 * valid semver version, valid id pattern) and returns a typed Manifest object.
 * Imports only from within src/lib/plugins — no SDK, DOM, or localStorage.
 */
import type { SettingsSchema } from "./settingsSchema";
export declare const KNOWN_CAPABILITIES: readonly ["commands", "composer", "ui", "messages:read", "messages:send", "rooms:read", "storage", "network", "unsafe", "audio", "native", "frames"];
export type Capability = (typeof KNOWN_CAPABILITIES)[number];
/** A file the plugin ships beside its bundle, fetched from the same pinned
 *  commit and checked against its SHA-256 before use. */
export interface ManifestFile {
    /** Relative to the plugin's directory. */
    path: string;
    /** Lowercase hex SHA-256 of the file. */
    sha256: string;
    /** Bytes. */
    size: number;
}
/** One platform's native code (zam.native). */
export interface ManifestNativePlatform {
    /** Desktop ("win32-x64", ...): a CommonJS script Electron starts in a
     *  utility process. Android ("android-arm64", ...): a .dex or .jar Zam
     *  loads in its own process. Must be one of `files`. */
    host: string;
    /** Android only: the host's class (implements
     *  moe.crafty.matrix.PluginNativeHost). */
    entry?: string;
    /** Every file the host needs, laid out as in the plugin directory. On
     *  Android, `.so` files go under a `lib/` directory next to the host. */
    files: ManifestFile[];
}
/** Native code, per platform: desktop keys are
 *  `${process.platform}-${process.arch}` (e.g. "win32-x64"), Android keys
 *  "android-" + arm64 / arm / x64 / ia32. */
export interface ManifestNative {
    platforms: Record<string, ManifestNativePlatform>;
}
export interface Manifest {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    entry: string;
    minAppVersion?: string;
    capabilities?: string[];
    settings?: SettingsSchema;
    assets?: ManifestFile[];
    native?: ManifestNative;
}
/** Largest single file a plugin may ship (GitHub's own limit is 100 MB). */
export declare const MAX_PLUGIN_FILE_BYTES: number;
/** Validate `native` (from untrusted input). */
export declare function parseNative(raw: unknown): ManifestNative;
/**
 * Parse and validate a plugin manifest from untrusted input. Throws Error
 * naming the offending field if validation fails. Returns a fresh Manifest
 * object with only known fields.
 */
export declare function parseManifest(input: unknown): Manifest;
