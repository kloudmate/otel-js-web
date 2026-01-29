/**
 *
 * Copyright 2020-2025 Splunk Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { InternalEventTarget } from '../src/EventTarget'
import { SessionBasedSampler } from '../src/SessionBasedSampler'
import { initSessionTracking, updateSessionStatus } from '../src/session'
import { context, SamplingDecision } from '@opentelemetry/api'
import { SESSION_INACTIVITY_TIMEOUT_MS, SESSION_STORAGE_KEY } from '../src/session/constants'
import { describe, it, expect } from 'vitest'

describe('Session based sampler', () => {
	it('decide sampling based on session id and ratio', () => {
		// Session id < target ratio
		const lowSessionId = '0'.repeat(32)
		const lowCookieValue = encodeURIComponent(
			JSON.stringify({
				id: lowSessionId,
				startTime: new Date().getTime(),
				expiresAt: new Date().getTime() + SESSION_INACTIVITY_TIMEOUT_MS,
			}),
		)
		document.cookie = SESSION_STORAGE_KEY + '=' + lowCookieValue + '; path=/; max-age=' + 10
		const trackingHandle = initSessionTracking('cookie', new InternalEventTarget())

		const sampler = new SessionBasedSampler({ ratio: 0.5 })
		expect(
			sampler.shouldSample(context.active(), '0000000000000000', 'test', 0, {}, []).decision,
			'low session id should be recorded',
		).toBe(SamplingDecision.RECORD_AND_SAMPLED)

		// Session id > target ratio
		const highSessionId = '1234567890abcdeffedcba0987654321'
		const highCookieValue = encodeURIComponent(
			JSON.stringify({
				id: highSessionId,
				startTime: new Date().getTime(),
				expiresAt: new Date().getTime() + SESSION_INACTIVITY_TIMEOUT_MS,
			}),
		)
		document.cookie = SESSION_STORAGE_KEY + '=' + highCookieValue + '; path=/; max-age=' + 10
		updateSessionStatus({ forceStore: true })

		expect(
			sampler.shouldSample(context.active(), '0000000000000000', 'test', 0, {}, []).decision,
			'high session id should not be recorded',
		).toBe(SamplingDecision.NOT_RECORD)

		trackingHandle.deinit()
		trackingHandle.clearSession()
	})

	it('isSessionSampled returns correct sampling decision based on session ID and ratio', () => {
		const sampler = new SessionBasedSampler({ ratio: 0.5 })

		// Low session id (all zeros) should always be sampled
		const lowSessionId = '0'.repeat(32)
		expect(sampler.isSessionSampled(lowSessionId), 'low session id should be sampled').toBe(true)

		// High session id (high value) should not be sampled at 50% ratio
		const highSessionId = 'ffffffffffffffffffffffffffffffff'
		expect(sampler.isSessionSampled(highSessionId), 'high session id should not be sampled').toBe(false)
	})

	it('isSessionSampled handles edge cases', () => {
		// 100% sampling rate - all sessions should be sampled
		const samplerAll = new SessionBasedSampler({ ratio: 1 })
		expect(samplerAll.isSessionSampled('ffffffffffffffffffffffffffffffff')).toBe(true)

		// 0% sampling rate - no sessions should be sampled
		const samplerNone = new SessionBasedSampler({ ratio: 0 })
		expect(samplerNone.isSessionSampled('00000000000000000000000000000000')).toBe(false)
	})
})
