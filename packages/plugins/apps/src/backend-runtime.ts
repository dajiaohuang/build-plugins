// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import type { AuthOptionsWithDefaults, Logger } from '@dd/core/types';
import { createHash } from 'crypto';

import type { AuthCredentials } from './auth';
import { createAuthenticatedRequest, getAuthCredentials } from './auth';
import { describeRuntime, type BackendRuntime } from './runtime-names';

export { describeRuntime, type BackendRuntime };

// With it on for an org, Action Platform runs jsFunctionWithActions on Terrapin.
export const TERRAPIN_CUTOVER_FLAG = 'ap-js-high-code-terrapin-cutover';
export const ACTIVE_FEATURE_FLAGS_PATH = '/api/ui/feature-flags/get-active-feature-flags';
export const BACKEND_RUNTIME_TIMEOUT_MS = 3_000;

export const NO_CREDENTIALS_MESSAGE = `No Datadog credentials, so the default ${describeRuntime('v1')} applies.`;

export const NO_FAILURE_DETAILS = 'no details came back';

export const FAILED_LOOKUP_WARNING = `Could not determine the org's backend runtime, so the stricter checks of the ${describeRuntime('v1')} apply.`;

export const DATATRANSFORMATION_BUNDLE_ID = 'com.datadoghq.datatransformation';

// Uploaded backend functions run as this action, on whichever runtime the cutover flag gives the org.
export const SCRIPT_ACTION_NAME = 'jsFunctionWithActions';
export const SCRIPT_ACTION_FQN = `${DATATRANSFORMATION_BUNDLE_ID}.${SCRIPT_ACTION_NAME}`;

// The endpoint can rate-limit, so a successful lookup is reused for the life of the process; kept on
// globalThis because a dev server restart can load a fresh copy of this module.
export const RUNTIME_CACHE_KEY = Symbol.for('@datadog/vite-plugin/apps/backend-runtime');

// A failed lookup falls back to v1, which rejects valid v2 code, so it's retried after this long.
export const FAILED_LOOKUP_RETRY_MS = 60_000;

// doRequest appends the error body after the status line, which for a non-JSON reply can be a whole HTML page.
export const MAX_LOGGED_REASON_LENGTH = 200;

// doRequest's status line describes the internal endpoint rather than anything the developer can act on.
const HTTP_STATUS_LINE = /^HTTP \d{3}\b[^\n]*\n?/;

// String() throws on some values, such as an object without a prototype.
export function summarizeRequestError(error: unknown): string {
    try {
        const message: unknown = error instanceof Error ? error.message : error;
        const details = String(message).replace(HTTP_STATUS_LINE, '');
        const reason = details.split('\n').join('; ').slice(0, MAX_LOGGED_REASON_LENGTH);
        return reason || NO_FAILURE_DETAILS;
    } catch {
        return NO_FAILURE_DETAILS;
    }
}

type CacheEntry = { runtime: Promise<BackendRuntime>; expiresAt: number };

// Another copy of the plugin in the process may have stored a different shape under the same key.
function isCacheEntry(value: unknown): value is CacheEntry {
    return (
        typeof value === 'object' &&
        value !== null &&
        'runtime' in value &&
        value.runtime instanceof Promise &&
        'expiresAt' in value &&
        typeof value.expiresAt === 'number'
    );
}

function getRuntimeCache(): Map<string, unknown> {
    const existing: unknown = Reflect.get(globalThis, RUNTIME_CACHE_KEY);
    if (existing instanceof Map) {
        return existing;
    }
    const cache = new Map<string, unknown>();
    Reflect.set(globalThis, RUNTIME_CACHE_KEY, cache);
    return cache;
}

// Test-only escape hatch: forgets every memoized lookup.
export function resetBackendRuntimeCache(): void {
    getRuntimeCache().clear();
}

function runtimeFromResponse(body: unknown): BackendRuntime {
    if (typeof body !== 'object' || body === null || !('user_status' in body)) {
        throw new Error('Unexpected response shape.');
    }
    if (body.user_status !== 'logged-in') {
        throw new Error('The credentials were not recognized as a logged-in user.');
    }
    if (!('active_feature_flags' in body) || !Array.isArray(body.active_feature_flags)) {
        throw new Error('Unexpected response shape.');
    }
    return body.active_feature_flags.includes(TERRAPIN_CUTOVER_FLAG) ? 'v2' : 'v1';
}

type LookupResult = { runtime: BackendRuntime; failed: boolean };

async function lookUpBackendRuntime(
    site: string,
    credentials: AuthCredentials | undefined,
    log: Logger,
): Promise<LookupResult> {
    if (!credentials) {
        log.info(NO_CREDENTIALS_MESSAGE);
        return { runtime: 'v1', failed: false };
    }

    try {
        const doAuthenticatedRequest = createAuthenticatedRequest(credentials);
        const signal = AbortSignal.timeout(BACKEND_RUNTIME_TIMEOUT_MS);
        const body = await doAuthenticatedRequest<unknown>({
            url: `https://api.${site}${ACTIVE_FEATURE_FLAGS_PATH}`,
            type: 'json',
            retries: 0,
            signal,
        });
        const runtime = runtimeFromResponse(body);
        const runtimeName = describeRuntime(runtime);
        log.info(`Following the org's ${runtimeName}.`);
        return { runtime, failed: false };
    } catch (error) {
        log.warn(FAILED_LOOKUP_WARNING);
        const reason = summarizeRequestError(error);
        log.debug(`Backend runtime lookup failed: ${reason}`);
        return { runtime: 'v1', failed: true };
    }
}

// One entry per set of credentials, since the flag is per org. Hashed so the cache never holds
// the secrets themselves.
export function getCacheKey(site: string, credentials: AuthCredentials | undefined): string {
    if (!credentials) {
        return `${site}:none`;
    }
    const serialized = JSON.stringify(credentials);
    const credentialsHash = createHash('sha256').update(serialized).digest('hex');
    return `${site}:${credentialsHash}`;
}

export type BackendRuntimeStatus = { runtime: BackendRuntime; isFallback: boolean };

// The entry's shape is shared with other copies of the plugin, so a fallback is told apart by its
// expiry: only a failed lookup's entry expires.
async function statusOf(entry: CacheEntry): Promise<BackendRuntimeStatus> {
    const runtime = await entry.runtime;
    return { runtime, isFallback: Number.isFinite(entry.expiresAt) };
}

/**
 * v2 only while the org's backend-runtime flag is on. Any failure, including missing credentials
 * or another plugin copy's broken cache, resolves to 'v1', and isFallback says whether v1 applies
 * only because the lookup failed.
 */
export async function resolveBackendRuntime(
    auth: AuthOptionsWithDefaults,
    log: Logger,
): Promise<BackendRuntimeStatus> {
    try {
        return await resolveCachedBackendRuntime(auth, log);
    } catch {
        log.warn(FAILED_LOOKUP_WARNING);
        return { runtime: 'v1', isFallback: true };
    }
}

function resolveCachedBackendRuntime(
    auth: AuthOptionsWithDefaults,
    log: Logger,
): Promise<BackendRuntimeStatus> {
    const { site } = auth;
    const cache = getRuntimeCache();
    // The keys the build's other uploads, such as sourcemaps, send: env, else the auth option.
    const credentials = getAuthCredentials(auth);
    const cacheKey = getCacheKey(site, credentials);
    const cached = cache.get(cacheKey);
    if (isCacheEntry(cached) && cached.expiresAt > Date.now()) {
        return statusOf(cached);
    }

    const failedLookup: LookupResult = { runtime: 'v1', failed: true };
    const lookup = lookUpBackendRuntime(site, credentials, log).catch(() => failedLookup);
    const entry: CacheEntry = {
        runtime: lookup.then(({ runtime, failed }) => {
            if (failed) {
                entry.expiresAt = Date.now() + FAILED_LOOKUP_RETRY_MS;
            }
            return runtime;
        }),
        expiresAt: Number.POSITIVE_INFINITY,
    };
    cache.set(cacheKey, entry);
    return statusOf(entry);
}
