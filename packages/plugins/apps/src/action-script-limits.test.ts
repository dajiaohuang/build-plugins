// Unless explicitly stated otherwise all files in this repository are licensed under the MIT License.
// This product includes software developed at Datadog (https://www.datadoghq.com/).
// Copyright 2019-Present Datadog, Inc.

/* global globalThis */

import {
    DATATRANSFORMATION_MANIFEST_PATH,
    MAX_SCRIPT_LIMIT_READS,
    SCRIPT_INPUTS_DEF_NAME,
    SCRIPT_LIMIT_WARNING,
    scriptLimitRetryDelayMs,
    resetScriptLimitCache,
    resolveScriptMaxLength,
    SCRIPT_LIMIT_CACHE_KEY,
    SCRIPT_LIMIT_TIMEOUT_MS,
} from '@dd/apps-plugin/action-script-limits';
import { getAuthenticatedRequest } from '@dd/apps-plugin/auth';
import type { DoAuthenticatedRequest } from '@dd/apps-plugin/auth';
import { FAILED_LOOKUP_RETRY_MS, MAX_LOGGED_REASON_LENGTH } from '@dd/apps-plugin/backend-runtime';
import type { Logger } from '@dd/core/types';
import { clearDatadogEnv } from '@dd/tests/_jest/helpers/datadogEnv';
import { getMockLogger, mockLogFn } from '@dd/tests/_jest/helpers/mocks';
import nock from 'nock';

const SITE = 'datad0g.com';
const API_ORIGIN = `https://api.${SITE}`;
const API_KEY = 'test-api-key';
const APP_KEY = 'test-app-key';
const ACCESS_TOKEN = 'test-oauth-token';
const LIMIT = 1_048_576;

const scriptInputs = (maxLength: unknown) => ({
    type: 'object',
    properties: { script: { type: 'string', maxLength } },
});

const manifestWith = (defs: Record<string, unknown>) => ({
    data: { id: 'com.datadoghq.datatransformation', attributes: { types: { $defs: defs } } },
});

const FULL_MANIFEST = manifestWith({ [SCRIPT_INPUTS_DEF_NAME]: scriptInputs(LIMIT) });

describe('Apps Plugin - resolveScriptMaxLength', () => {
    let restoreEnv: () => void;
    let log: Logger;
    let doAuthenticatedRequest: DoAuthenticatedRequest;

    beforeEach(() => {
        log = getMockLogger();
        restoreEnv = clearDatadogEnv();
        process.env.DD_API_KEY = API_KEY;
        process.env.DD_APP_KEY = APP_KEY;
        doAuthenticatedRequest = getAuthenticatedRequest();
        resetScriptLimitCache();
        jest.clearAllMocks();
    });

    afterEach(() => {
        restoreEnv();
        nock.cleanAll();
        jest.restoreAllMocks();
    });

    test('should name the input schema as the manifest does', () => {
        expect(SCRIPT_INPUTS_DEF_NAME).toBe('JsFunctionWithActionsInputs');
    });

    test.each([
        {
            description: 'API-key auth',
            setAuth: () => {},
            headers: { 'DD-API-KEY': API_KEY, 'DD-APPLICATION-KEY': APP_KEY },
        },
        {
            description: 'the OAuth access token',
            setAuth: () => {
                delete process.env.DD_API_KEY;
                delete process.env.DD_APP_KEY;
                process.env.DD_OAUTH_ACCESS_TOKEN = ACCESS_TOKEN;
            },
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
        },
    ])('should read the script limit using $description', async ({ setAuth, headers }) => {
        setAuth();
        let interceptor = nock(API_ORIGIN);
        for (const [name, value] of Object.entries(headers)) {
            interceptor = interceptor.matchHeader(name, value);
        }
        const scope = interceptor.get(DATATRANSFORMATION_MANIFEST_PATH).reply(200, FULL_MANIFEST);

        const request = getAuthenticatedRequest();

        const limit = await resolveScriptMaxLength(SITE, request, log);
        const isDone = scope.isDone();
        expect(limit).toBe(LIMIT);
        expect(isDone).toBe(true);
    });

    test('should stop reading after its last attempt, waiting longer before each retry', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        let now = 1_000_000;
        nowSpy.mockImplementation(() => now);
        let requests = 0;
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .times(MAX_SCRIPT_LIMIT_READS + 1)
            .reply(() => {
                requests += 1;
                return [503, ''];
            });

        for (let failedReads = 1; failedReads <= MAX_SCRIPT_LIMIT_READS; failedReads++) {
            // eslint-disable-next-line no-await-in-loop
            await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
            expect(requests).toBe(failedReads);
            now += scriptLimitRetryDelayMs(failedReads) - 1;
            // eslint-disable-next-line no-await-in-loop
            await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
            expect(requests).toBe(failedReads);
            now += 2;
        }
        now += FAILED_LOOKUP_RETRY_MS * 100;
        const limit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        const warnings = mockLogFn.mock.calls.filter(([, level]) => level === 'warn');
        const expectedWarnings = Array.from({ length: MAX_SCRIPT_LIMIT_READS }, () => [
            SCRIPT_LIMIT_WARNING,
            'warn',
        ]);
        expect(requests).toBe(MAX_SCRIPT_LIMIT_READS);
        expect(limit).toBeUndefined();
        expect(warnings).toEqual(expectedWarnings);
    });

    test('should back off by doubling the retry window', () => {
        const firstDelay = scriptLimitRetryDelayMs(1);
        const secondDelay = scriptLimitRetryDelayMs(2);
        expect(firstDelay).toBe(FAILED_LOOKUP_RETRY_MS);
        expect(secondDelay).toBe(FAILED_LOOKUP_RETRY_MS * 2);
    });

    test('should warn once per failed read, not per call', async () => {
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(500, {});

        await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        const warnings = mockLogFn.mock.calls.filter(([, level]) => level === 'warn');
        expect(warnings).toEqual([[SCRIPT_LIMIT_WARNING, 'warn']]);
    });

    test.each([
        { description: 'the request is unauthorized', status: 401, body: { errors: ['nope'] } },
        { description: 'the bundle is not found', status: 404, body: { errors: ['missing'] } },
        { description: 'the server errors', status: 500, body: { errors: ['boom'] } },
        { description: 'the body is not JSON', status: 200, body: 'not json' },
        { description: 'the body is JSON null', status: 200, body: 'null' },
        { description: 'the body has no $defs', status: 200, body: { data: { attributes: {} } } },
        {
            description: "only another action's schema has a script limit",
            status: 200,
            body: manifestWith({ OtherActionInputs: scriptInputs(LIMIT) }),
        },
        {
            description: 'maxLength is not a number',
            status: 200,
            body: manifestWith({
                [SCRIPT_INPUTS_DEF_NAME]: scriptInputs('1048576'),
            }),
        },
        {
            description: 'maxLength is not a positive integer',
            status: 200,
            body: manifestWith({
                [SCRIPT_INPUTS_DEF_NAME]: scriptInputs(-1),
            }),
        },
        {
            description: 'the input schema has no script property',
            status: 200,
            body: manifestWith({
                [SCRIPT_INPUTS_DEF_NAME]: { type: 'object', properties: {} },
            }),
        },
    ])('should resolve no limit when $description', async ({ status, body }) => {
        const scope = nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(status, body);

        const limit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        const isDone = scope.isDone();
        expect(limit).toBeUndefined();
        expect(isDone).toBe(true);
    });

    test('should resolve no limit when the network request fails', async () => {
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).replyWithError('socket hang up');

        const limit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        expect(limit).toBeUndefined();
        expect(mockLogFn).toHaveBeenCalledWith(SCRIPT_LIMIT_WARNING, 'warn');
        expect(mockLogFn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'), 'debug');
    });

    test('should resolve no limit when the request fails with a value String() cannot convert', async () => {
        const unprintable: unknown = Object.create(null);
        const failingRequest: DoAuthenticatedRequest = async () => {
            throw unprintable;
        };

        const limit = await resolveScriptMaxLength(SITE, failingRequest, log);
        expect(limit).toBeUndefined();
        expect(mockLogFn).toHaveBeenCalledWith(SCRIPT_LIMIT_WARNING, 'warn');
    });

    test('should resolve no limit when the request outlives its timeout', async () => {
        const realTimeout = AbortSignal.timeout.bind(AbortSignal);
        const timeoutSpy = jest
            .spyOn(AbortSignal, 'timeout')
            .mockImplementation(() => realTimeout(10));
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).delay(100).reply(200, FULL_MANIFEST);

        const limit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        expect(limit).toBeUndefined();
        expect(timeoutSpy).toHaveBeenCalledWith(SCRIPT_LIMIT_TIMEOUT_MS);
    });

    test('should not retry a failed request', async () => {
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(503)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(200, FULL_MANIFEST);

        const limit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        const pendingMocks = scope.pendingMocks();
        expect(limit).toBeUndefined();
        expect(pendingMocks).toHaveLength(1);
    });

    test('should make a single request for concurrent and later calls', async () => {
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);

        const first = resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        const concurrent = resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        const concurrentLimits = await Promise.all([first, concurrent]);
        const laterLimit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        const isDone = scope.isDone();

        expect(concurrentLimits).toEqual([LIMIT, LIMIT]);
        expect(laterLimit).toBe(LIMIT);
        expect(isDone).toBe(true);
    });

    test.each([
        { description: 'a failed lookup', status: 500, body: {} },
        { description: 'a lookup that read no limit', status: 200, body: { data: {} } },
    ])('should retry $description once the retry window passes', async ({ status, body }) => {
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).once().reply(status, body);
        const failedLimit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        nowSpy.mockReturnValue(startedAt + scriptLimitRetryDelayMs(1) - 1);
        const cachedLimit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        const retry = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);
        nowSpy.mockReturnValue(startedAt + scriptLimitRetryDelayMs(1) + 1);
        const retriedLimit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        const retryDone = retry.isDone();

        expect(failedLimit).toBeUndefined();
        expect(cachedLimit).toBeUndefined();
        expect(retriedLimit).toBe(LIMIT);
        expect(retryDone).toBe(true);
    });

    test('should keep a successful lookup past the retry window', async () => {
        const nowSpy = jest.spyOn(Date, 'now');
        const startedAt = 1_000_000;
        nowSpy.mockReturnValue(startedAt);
        const scope = nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .once()
            .reply(200, FULL_MANIFEST);
        const firstLimit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        nowSpy.mockReturnValue(startedAt + FAILED_LOOKUP_RETRY_MS * 10);
        const laterLimit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        const isDone = scope.isDone();

        expect(firstLimit).toBe(LIMIT);
        expect(laterLimit).toBe(LIMIT);
        expect(isDone).toBe(true);
    });

    test('should wait out the retry window after a foreign entry with a non-numeric failure count', async () => {
        const foreignEntry = {
            limit: Promise.resolve(undefined),
            expiresAt: 0,
            failedReads: 'many',
        };
        const foreignCache = new Map([[SITE, foreignEntry]]);
        Reflect.set(globalThis, SCRIPT_LIMIT_CACHE_KEY, foreignCache);
        jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const scope = nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).twice().reply(500, {});

        await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        const pendingMocks = scope.pendingMocks();
        expect(pendingMocks).toHaveLength(1);
    });

    test.each([
        {
            description: 'a rejected limit',
            limit: () => {
                const rejected = Promise.reject(new Error('foreign'));
                rejected.catch(() => {});
                return rejected;
            },
        },
        { description: 'a limit that is not a number', limit: async () => 'lots' },
    ])('should resolve no limit for a foreign entry holding $description', async ({ limit }) => {
        const foreignLimit = limit();
        const foreignCache = new Map([[SITE, { limit: foreignLimit, expiresAt: Infinity }]]);
        Reflect.set(globalThis, SCRIPT_LIMIT_CACHE_KEY, foreignCache);

        const resolved = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        expect(resolved).toBeUndefined();
    });

    test('should look the limit up again when the cached entry has an unexpected shape', async () => {
        const foreignCache = new Map([[SITE, { limit: LIMIT, expiresAt: Infinity }]]);
        Reflect.set(globalThis, SCRIPT_LIMIT_CACHE_KEY, foreignCache);
        nock(API_ORIGIN).get(DATATRANSFORMATION_MANIFEST_PATH).reply(200, FULL_MANIFEST);

        const limit = await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);
        expect(limit).toBe(LIMIT);
    });

    test('should cap a non-JSON error body in the log', async () => {
        const filler = 'x'.repeat(MAX_LOGGED_REASON_LENGTH);
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(502, `<!DOCTYPE html>\n${filler}`);

        await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(logged).toContain('<!DOCTYPE html>');
        expect(logged).not.toContain(filler);
        expect(logged).not.toContain('HTTP 502');
    });

    test('should never log the credentials', async () => {
        nock(API_ORIGIN)
            .get(DATATRANSFORMATION_MANIFEST_PATH)
            .reply(401, { errors: ['Unauthorized'] });

        await resolveScriptMaxLength(SITE, doAuthenticatedRequest, log);

        const logged = mockLogFn.mock.calls.map(([text]) => String(text)).join('\n');
        expect(mockLogFn).toHaveBeenCalled();
        expect(logged).not.toContain(API_KEY);
        expect(logged).not.toContain(APP_KEY);
    });
});
