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

import * as shimmer from 'shimmer'
import { getElementXPath } from '@opentelemetry/sdk-trace-web'
import { limitLen } from './utils'
import { Span } from '@opentelemetry/api'
import { InstrumentationBase, InstrumentationConfig } from '@opentelemetry/instrumentation'

// FIXME take timestamps from events?

// Default caps for the `error.message` and `error.stack` span attributes. These
// are applied client-side, before export, and are the binding limit on how much
// of an error the backend receives (the collector/backend add no cap of their
// own). They can be overridden per-site via SplunkErrorInstrumentationConfig.
const DEFAULT_MESSAGE_LIMIT = 8192
const DEFAULT_STACK_LIMIT = 16384

export const STACK_TRACE_URL_PATTER = /([\w]+:\/\/[^\s/]+\/[^\s?:#]+)/g

function useful(s: string) {
	return s && s.trim() !== '' && !s.startsWith('[object') && s !== 'error'
}

function stringifyValue(value: unknown) {
	if (value === undefined) {
		return '(undefined)'
	}

	if (value === null) {
		return '(null)'
	}

	// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object#null-prototype_objects
	// Check for null-prototype objects
	if (value.toString) {
		return value.toString()
	}

	try {
		return Object.prototype.toString.call(value)
	} catch {
		return '(unknown)'
	}
}

function parseErrorStack(stack: string): string {
	//get list of files in stack , find corresponding sourcemap id and add it to the source map id object
	const sourceMapIds: Record<string, string> = {}
	const urls = stack.match(STACK_TRACE_URL_PATTER)
	if (urls) {
		urls.forEach((url) => {
			// Strip off any line/column numbers at the end after the last colon
			const cleanedUrl = url.split(/:(?=\d+$)/)[0]
			const globalSourceMapIds = (window as any).sourceMapIds
			if (globalSourceMapIds && globalSourceMapIds[cleanedUrl] && !sourceMapIds[cleanedUrl]) {
				sourceMapIds[cleanedUrl] = globalSourceMapIds[cleanedUrl]
			}
		})
	}

	return JSON.stringify(sourceMapIds)
}

function addStackToSpan(span: Span, stack: string, stackLimit: number) {
	if (stack && useful(stack)) {
		//get sourcemap ids and add to span as error.source_map_ids
		span.setAttribute('error.stack', limitLen(stack, stackLimit))
		const sourcemapIds = parseErrorStack(stack)
		if (sourcemapIds) {
			span.setAttribute('error.source_map_ids', sourcemapIds)
		}
	}
}

function addStackIfUseful(span: Span, err: Error, stackLimit: number) {
	if (err && err.stack) {
		addStackToSpan(span, err.stack.toString(), stackLimit)
	}
}

// URL of the script this SDK is bundled into. Used to strip the SDK's own frames
// from synthesized stacks so they begin at the caller's code. Computed lazily
// (and cached) from the top frame of an Error created inside this module.
let selfScriptUrl: string | undefined
let selfScriptUrlComputed = false

function getSelfScriptUrl(): string | undefined {
	if (!selfScriptUrlComputed) {
		selfScriptUrlComputed = true
		const stack = new Error().stack
		const match = stack ? stack.match(STACK_TRACE_URL_PATTER) : null
		selfScriptUrl = match ? match[0] : undefined
	}

	return selfScriptUrl
}

/**
 * Strip the leading frames that belong to this SDK (identified by `selfUrl`)
 * from a raw stack string, so the synthesized stack begins at the caller's code.
 * A new `name` header line is prepended, mirroring a native `Error.stack`.
 *
 * Returns undefined when no usable (URL-bearing) caller frame remains, so callers
 * never attach a stack that only points back into the instrumentation.
 *
 * Exported for testing.
 */
export function trimInternalStackFrames(
	rawStack: string,
	selfUrl: string | undefined,
	name: string,
): string | undefined {
	const lines = rawStack.split('\n')

	// Skip the header line(s) and any leading frames that live in this SDK's own
	// bundle; stop at the first frame that points at other (caller) code.
	let start = 0
	while (start < lines.length) {
		const line = lines[start]
		const hasUrl = line.indexOf('://') !== -1
		const isInternalFrame = !!selfUrl && line.indexOf(selfUrl) !== -1
		if (hasUrl && !isInternalFrame) {
			break
		}

		start += 1
	}

	const frames = lines.slice(start)
	// Only useful if at least one real (URL-bearing) caller frame remains.
	if (!frames.some((line) => line.indexOf('://') !== -1)) {
		return undefined
	}

	return [name, ...frames].join('\n')
}

/**
 * Synthesize a stack trace for errors that don't carry one of their own — e.g.
 * `console.error('...')`, thrown strings, or other non-Error values. Captures
 * `new Error().stack` and strips the leading frames that belong to this SDK so
 * the result begins at the code that reported the error.
 */
function generateStack(name: string): string | undefined {
	const rawStack = new Error().stack
	if (!rawStack) {
		return undefined
	}

	return trimInternalStackFrames(rawStack, getSelfScriptUrl(), name)
}

export const ERROR_INSTRUMENTATION_NAME = 'errors'
export const ERROR_INSTRUMENTATION_VERSION = '1'

export interface SplunkErrorInstrumentationConfig extends InstrumentationConfig {
	/**
	 * Maximum length of the `error.message` span attribute. Longer messages are
	 * truncated before export. Defaults to 8192.
	 */
	messageLengthLimit?: number

	/**
	 * Maximum length of the `error.stack` span attribute. Longer stacks are
	 * truncated before export. Defaults to 16384.
	 */
	stackLengthLimit?: number
}

export class SplunkErrorInstrumentation extends InstrumentationBase {
	private readonly messageLimit: number

	private readonly stackLimit: number

	constructor(config: SplunkErrorInstrumentationConfig = {}) {
		super(ERROR_INSTRUMENTATION_NAME, ERROR_INSTRUMENTATION_VERSION, config)
		this.messageLimit = config.messageLengthLimit ?? DEFAULT_MESSAGE_LIMIT
		this.stackLimit = config.stackLengthLimit ?? DEFAULT_STACK_LIMIT
	}

	disable(): void {
		shimmer.unwrap(console, 'error')
		window.removeEventListener('unhandledrejection', this._unhandledRejectionListener)
		window.removeEventListener('error', this._errorListener)
		document.documentElement.removeEventListener('error', this._documentErrorListener, { capture: true })
	}

	enable(): void {
		shimmer.wrap(console, 'error', this._consoleErrorHandler)
		window.addEventListener('unhandledrejection', this._unhandledRejectionListener)
		window.addEventListener('error', this._errorListener)
		document.documentElement.addEventListener('error', this._documentErrorListener, { capture: true })
	}

	init(): void {}

	public report(source: string, arg: string | Event | ErrorEvent | Array<any>): void {
		if (Array.isArray(arg) && arg.length === 0) {
			return
		}

		if (arg instanceof Array && arg.length === 1) {
			arg = arg[0]
		}

		if (arg instanceof Error) {
			this.reportError(source, arg)
		} else if (arg instanceof ErrorEvent) {
			this.reportErrorEvent(source, arg)
		} else if (arg instanceof Event) {
			this.reportEvent(source, arg)
		} else if (typeof arg === 'string') {
			this.reportString(source, arg)
		} else if (arg instanceof Array) {
			// if any arguments are Errors then add the stack trace even though the message is handled differently
			const firstError = arg.find((x) => x instanceof Error)
			this.reportString(source, arg.map((x) => stringifyValue(x)).join(' '), firstError)
		} else {
			this.reportString(source, stringifyValue(arg)) // FIXME or JSON.stringify?
		}
	}

	protected reportError(source: string, err: Error): void {
		const msg = err.message || err.toString()
		if (!useful(msg) && !err.stack) {
			return
		}

		const now = Date.now()
		const span = this.tracer.startSpan(source, { startTime: now })
		span.setAttribute('component', 'error')
		span.setAttribute('error', true)
		span.setAttribute(
			'error.object',
			useful(err.name) ? err.name : err.constructor && err.constructor.name ? err.constructor.name : 'Error',
		)
		span.setAttribute('error.message', limitLen(msg, this.messageLimit))
		addStackIfUseful(span, err, this.stackLimit)
		span.end(now)
	}

	protected reportErrorEvent(source: string, ev: ErrorEvent): void {
		if (ev.error) {
			this.report(source, ev.error)
		} else if (ev.message) {
			this.report(source, ev.message)
		}
	}

	protected reportEvent(source: string, ev: Event): void {
		// FIXME consider other sources of global 'error' DOM callback - what else can be captured here?
		if (!ev.target && !useful(ev.type)) {
			return
		}

		const now = Date.now()
		const span = this.tracer.startSpan(source, { startTime: now })
		span.setAttribute('component', 'error')
		span.setAttribute('error.type', ev.type)
		if (ev.target) {
			// TODO: find types to match this
			span.setAttribute('target_element', (ev.target as any).tagName)
			span.setAttribute('target_xpath', getElementXPath(ev.target, true))
			span.setAttribute('target_src', (ev.target as any).src)
		}

		span.end(now)
	}

	protected reportString(source: string, message: string, firstError?: Error): void {
		if (!useful(message)) {
			return
		}

		const now = Date.now()
		const span = this.tracer.startSpan(source, { startTime: now })
		span.setAttribute('component', 'error')
		span.setAttribute('error', true)
		span.setAttribute('error.object', 'String')
		span.setAttribute('error.message', limitLen(message, this.messageLimit))
		if (firstError) {
			addStackIfUseful(span, firstError, this.stackLimit)
		} else {
			// Strings and other non-Error values carry no stack of their own.
			// Synthesize one so these errors are still traceable to their source.
			const syntheticStack = generateStack('Error')
			if (syntheticStack) {
				addStackToSpan(span, syntheticStack, this.stackLimit)
			}
		}

		span.end(now)
	}

	private readonly _consoleErrorHandler =
		(original: Console['error']) =>
		(...args: any[]) => {
			this.report('console.error', args)
			return original.apply(this, args)
		}

	private readonly _documentErrorListener = (event: ErrorEvent) => {
		this.report('eventListener.error', event)
	}

	private readonly _errorListener = (event: ErrorEvent) => {
		this.report('onerror', event)
	}

	private readonly _unhandledRejectionListener = (event: PromiseRejectionEvent) => {
		this.report('unhandledrejection', event.reason)
	}
}
