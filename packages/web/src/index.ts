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

import './polyfill-safari10'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import {
	ConsoleSpanExporter,
	SimpleSpanProcessor,
	BatchSpanProcessor,
	SpanExporter,
	SpanProcessor,
	BufferConfig,
	AlwaysOffSampler,
	AlwaysOnSampler,
	ParentBasedSampler,
} from '@opentelemetry/sdk-trace-base'
import { Attributes, diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'
import { SplunkDocumentLoadInstrumentation } from './SplunkDocumentLoadInstrumentation'
import { SplunkXhrPlugin } from './SplunkXhrPlugin'
import { SplunkFetchInstrumentation } from './SplunkFetchInstrumentation'
import {
	SplunkUserInteractionInstrumentation,
	DEFAULT_AUTO_INSTRUMENTED_EVENTS,
	DEFAULT_AUTO_INSTRUMENTED_EVENT_NAMES,
	UserInteractionEventsConfig,
} from './SplunkUserInteractionInstrumentation'
import { type SplunkExporterConfig } from './exporters/common'
import { SplunkZipkinExporter } from './exporters/zipkin'
import { ERROR_INSTRUMENTATION_NAME, SplunkErrorInstrumentation } from './SplunkErrorInstrumentation'
import { generateId, getPluginConfig } from './utils'
import {
	checkSessionRecorderType,
	getIsNewSession,
	getRumSessionId,
	initSessionTracking,
	RecorderType,
	updateSessionStatus,
} from './session'
import { SplunkWebSocketInstrumentation } from './SplunkWebSocketInstrumentation'
import { initWebVitals } from './webvitals'
import { SplunkLongTaskInstrumentation } from './SplunkLongTaskInstrumentation'
import { SplunkPageVisibilityInstrumentation } from './SplunkPageVisibilityInstrumentation'
import { SplunkConnectivityInstrumentation } from './SplunkConnectivityInstrumentation'
import { SplunkPostDocLoadResourceInstrumentation } from './SplunkPostDocLoadResourceInstrumentation'
import { SplunkWebTracerProvider } from './SplunkWebTracerProvider'
import { InternalEventTarget, SplunkOtelWebEventTarget } from './EventTarget'
import { SplunkContextManager } from './SplunkContextManager'
import { Resource, ResourceAttributes } from '@opentelemetry/resources'
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'
import { SDK_INFO, _globalThis } from '@opentelemetry/core'
import { VERSION } from './version'
import { getSyntheticsRunId, SYNTHETICS_RUN_ID_ATTRIBUTE } from './synthetics'
import { SplunkSpanAttributesProcessor } from './SplunkSpanAttributesProcessor'
import { SessionBasedSampler } from './SessionBasedSampler'
import { SplunkSocketIoClientInstrumentation } from './SplunkSocketIoClientInstrumentation'
import { SplunkOTLPTraceExporter } from './exporters/otlp'
import { registerGlobal, unregisterGlobal } from './global-utils'
import { BrowserInstanceService } from './services/BrowserInstanceService'
import { SessionId } from './session'
import { forgetAnonymousId, getOrCreateAnonymousId } from './user-tracking'
import {
	isPersistenceType,
	SplunkOtelWebConfig,
	SplunkOtelWebExporterOptions,
	SplunkOtelWebOptionsInstrumentations,
	UserTrackingMode,
} from './types'
import { isBot } from './utils/is-bot'
import { SplunkSamplerWrapper } from './SplunkSamplerWrapper'

export { type SplunkExporterConfig } from './exporters/common'
export { SplunkZipkinExporter } from './exporters/zipkin'
export * from './SplunkWebTracerProvider'
export * from './SessionBasedSampler'

export type { SplunkOtelWebConfig, SplunkOtelWebExporterOptions }

interface SplunkOtelWebConfigInternal extends SplunkOtelWebConfig {
  bufferSize?: number;
  bufferTimeout?: number;

  exporter: SplunkOtelWebExporterOptions & {
    factory: (config: SplunkExporterConfig & { otlp?: boolean }) => SpanExporter;
  };

  instrumentations: SplunkOtelWebOptionsInstrumentations;

  spanProcessor: {
    factory: <T extends BufferConfig>(exporter: SpanExporter, config: T) => SpanProcessor;
  };
}

const OPTIONS_DEFAULTS: Partial<SplunkOtelWebConfigInternal> = {
  applicationName: 'unknown-browser-app',
  bufferTimeout: 4000, //millis, tradeoff between batching and loss of spans by not sending before page close
  bufferSize: 50, // spans, tradeoff between batching and hitting sendBeacon invididual limits
  instrumentations: {},
  exporter: {
    factory: (options) => {
      if (options.otlp) {
        return new SplunkOTLPTraceExporter(options);
      }
      return new SplunkZipkinExporter(options);
    },
  },
  spanProcessor: {
    factory: (exporter, config) => new BatchSpanProcessor(exporter, config),
  },
  persistence: 'cookie',
  disableBots: false,
  disableAutomationFrameworks: false,
};

function migrateConfigOption(
  config: SplunkOtelWebConfig,
  from: keyof SplunkOtelWebConfig,
  to: keyof SplunkOtelWebConfig,
) {
  if (from in config && !(to in config && config[to] !== (OPTIONS_DEFAULTS as SplunkOtelWebConfig)[to])) {
    // @ts-expect-error There's no way to type this right
    config[to] = config[from];
  }
}

/**
 * Update configuration based on configuration option renames
 */
function migrateConfig(config: SplunkOtelWebConfig): SplunkOtelWebConfig {
    migrateConfigOption(config, 'app', 'applicationName');
    migrateConfigOption(config, 'beaconUrl', 'beaconEndpoint');
    migrateConfigOption(config, 'environment', 'deploymentEnvironment');
    migrateConfigOption(config, 'rumAuth', 'rumAccessToken');
    return config;
}

const INSTRUMENTATIONS = [
  { Instrument: SplunkDocumentLoadInstrumentation, confKey: 'document', disable: false },
  { Instrument: SplunkXhrPlugin, confKey: 'xhr', disable: false },
  { Instrument: SplunkUserInteractionInstrumentation, confKey: 'interactions', disable: false },
  { Instrument: SplunkPostDocLoadResourceInstrumentation, confKey: 'postload', disable: false },
  { Instrument: SplunkFetchInstrumentation, confKey: 'fetch', disable: false },
  { Instrument: SplunkWebSocketInstrumentation, confKey: 'websocket', disable: true },
  { Instrument: SplunkLongTaskInstrumentation, confKey: 'longtask', disable: false },
  { Instrument: SplunkErrorInstrumentation, confKey: ERROR_INSTRUMENTATION_NAME, disable: false },
  { Instrument: SplunkPageVisibilityInstrumentation, confKey: 'visibility', disable: true },
  { Instrument: SplunkConnectivityInstrumentation, confKey: 'connectivity', disable: true },
  { Instrument: SplunkSocketIoClientInstrumentation, confKey: 'socketio', disable: true },
] as const;

export const INSTRUMENTATIONS_ALL_DISABLED: SplunkOtelWebOptionsInstrumentations = INSTRUMENTATIONS.map(
  (instrumentation) => instrumentation.confKey,
).reduce(
  (acc, key) => {
    acc[key] = false;
    return acc;
  },
  { webvitals: false } as Record<string, false>,
);

function buildExporter(options: SplunkOtelWebConfigInternal): SpanExporter {
  const url = `${options.endpoint}/v1/traces`;
  const authHeaderKey = 'Authorization';
  return options.exporter.factory({
    url,
    otlp: true,
    onAttributesSerializing: options.exporter.onAttributesSerializing,
    headers: { [authHeaderKey]: options.rumAccessToken } as Record<string, string>,
  });
}

class SessionSpanProcessor implements SpanProcessor {
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  onEnd(): void {}

  onStart(): void {
    updateSessionStatus({
      forceStore: false,
      hadActivity: true,
    });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface SplunkOtelWebType extends SplunkOtelWebEventTarget {
  AlwaysOffSampler: typeof AlwaysOffSampler;
  AlwaysOnSampler: typeof AlwaysOnSampler;

  DEFAULT_AUTO_INSTRUMENTED_EVENTS: UserInteractionEventsConfig;
  DEFAULT_AUTO_INSTRUMENTED_EVENT_NAMES: (keyof HTMLElementEventMap)[];

  ParentBasedSampler: typeof ParentBasedSampler;
  SessionBasedSampler: typeof SessionBasedSampler;

  /**
   * @deprecated Use {@link getGlobalAttributes()}
   */
  _experimental_getGlobalAttributes: () => Attributes;

  /**
   * @deprecated Use {@link getSessionId()}
   */
  _experimental_getSessionId: () => SessionId | undefined;

  /**
   * Used internally by the SplunkSessionRecorder - checks if the current session is assigned to a correct recorder type.
   */
  _internalCheckSessionRecorderType: (recorderType: RecorderType) => void;

  /**
   * Allows experimental options to be passed. No versioning guarantees are given for this method.
   */
  _internalInit: (options: Partial<SplunkOtelWebConfigInternal>) => void;

  /* Used internally by the SplunkSessionRecorder - span from session can extend the session */
  _internalOnExternalSpanCreated: () => void;

  _processedOptions: SplunkOtelWebConfigInternal | null;

  _processor?: SpanProcessor;

  attributesProcessor?: SplunkSpanAttributesProcessor;

  deinit: (force?: boolean) => void;

  /**
   * True if library detected an automation framework and was disabled based on 'disableAutomationFrameworks' setting.
   */
  disabledByAutomationFrameworkDetection?: boolean;

  /**
   * True if library detected a bot and was disabled based on 'disableBots' setting.
   */
  disabledByBotDetection?: boolean;

  error: (...args: Array<any>) => void;

  getAnonymousId: () => string | undefined;

  /**
   * This method provides access to computed, final value of global attributes, which are applied to all created spans.
   */
  getGlobalAttributes: () => Attributes;

  /**
   * This method returns current session ID
   */
  getSessionId: () => SessionId | undefined;

  init: (options: SplunkOtelWebConfig) => void;

  readonly inited: boolean;

  isNewSessionId: () => boolean;

  provider?: SplunkWebTracerProvider;

  resource?: Resource;

  setGlobalAttributes: (attributes: Attributes) => void;

  setUserTrackingMode: (mode: UserTrackingMode) => void;
}

let inited = false;
let userTrackingMode: UserTrackingMode = 'noTracking';
let _deregisterInstrumentations: undefined | (() => void);
let _deinitSessionTracking: undefined | (() => void);
let _errorInstrumentation: SplunkErrorInstrumentation | undefined;
let _postDocLoadInstrumentation: SplunkPostDocLoadResourceInstrumentation | undefined;
let eventTarget: InternalEventTarget | undefined;

export const KloudMateRum: SplunkOtelWebType = {
  DEFAULT_AUTO_INSTRUMENTED_EVENTS,
  DEFAULT_AUTO_INSTRUMENTED_EVENT_NAMES,

  // Re-export samplers as properties for easier use in CDN build
  AlwaysOnSampler,
  AlwaysOffSampler,
  ParentBasedSampler,
  SessionBasedSampler,

  _processedOptions: null,

  get inited(): boolean {
    return inited;
  },

  _internalInit: function (options: Partial<SplunkOtelWebConfigInternal>) {
    KloudMateRum.init({
      ...OPTIONS_DEFAULTS,
      ...options,
    });
  },

  init: function (options) {
    userTrackingMode = options.user?.trackingMode ?? 'noTracking';

    if (typeof window !== 'object') {
      throw Error(
        'KloudMateRum Error: This library is intended to run in a browser environment. Please ensure the code is evaluated within a browser context.',
      );
    }

    // "env" based config still a bad idea for web
    if (!('OTEL_TRACES_EXPORTER' in _globalThis)) {
      // @ts-expect-error OTEL_TRACES_EXPORTER is not defined in the global scope
      _globalThis.OTEL_TRACES_EXPORTER = 'none';
    }

    if (inited) {
      console.warn('KloudMateRum already initialized.');
      return;
    }

    diag.setLogger(new DiagConsoleLogger(), options?.debug ? DiagLogLevel.DEBUG : DiagLogLevel.WARN);
    
    const registered = registerGlobal(this);
    if (!registered) {
      return;
    }

    if (typeof Symbol !== 'function') {
      diag.error('KloudMateRum: browser not supported, disabling instrumentation.');
      return;
    }
    
    if (options.disableBots && isBot(navigator.userAgent)) {
      this.disabledByBotDetection = true;
      diag.error('KloudMateRum will not be initialized, bots are not allowed.');
      return;
    }

    if (options.disableAutomationFrameworks && navigator.webdriver) {
      this.disabledByAutomationFrameworkDetection = true;
      diag.error('KloudMateRum will not be initialized, automation frameworks are not allowed.');
      return;
    }

    eventTarget = new InternalEventTarget();

    const processedOptions: SplunkOtelWebConfigInternal = Object.assign(
      {},
      OPTIONS_DEFAULTS,
      migrateConfig(options),
      {
        exporter: Object.assign({}, OPTIONS_DEFAULTS.exporter, options.exporter),
		instrumentations: Object.assign({}, OPTIONS_DEFAULTS.instrumentations, options.instrumentations),
        spanProcessor: Object.assign({}, OPTIONS_DEFAULTS.spanProcessor, options.spanProcessors),
      },
    );

    this._processedOptions = processedOptions;

    if (!processedOptions.debug) {
      if (!processedOptions.endpoint) {
        throw new Error('KloudMateRum.init( {endpoint: \'https://something\'} ) is required.');
      } else if (!processedOptions.endpoint.startsWith('https') && !processedOptions.allowInsecureBeacon) {
        throw new Error('Not using https is unsafe, if you want to force it use allowInsecureBeacon option.');
      }
      if (!processedOptions.rumAccessToken) {
        diag.warn('rumAccessToken will be required in the future');
      }
    }
    
    if (
        !processedOptions.persistence ||
        (processedOptions.persistence && !isPersistenceType(processedOptions.persistence))
    ) {
        diag.error(
            `Invalid persistence flag: The value for "persistence" must be either "cookie", "localStorage", or omitted entirely, but was: ${processedOptions.persistence}`,
        );
        return;
    }

    const instanceId = generateId(64);

    const { ignoreUrls, applicationName, deploymentEnvironment, version } = processedOptions;
    const pluginDefaults = { ignoreUrls, enabled: false };
    
    const resourceAttrs: ResourceAttributes = {
      ...SDK_INFO,
      [SemanticResourceAttributes.TELEMETRY_SDK_NAME]: '@kloudmate/otel-web',
      [SemanticResourceAttributes.TELEMETRY_SDK_VERSION]: VERSION,
      'kloudmate.rumVersion': VERSION,
      'kloudmate.scriptInstance': instanceId,
      'app': applicationName,
      'userAgent': navigator.userAgent,
    };

    if (BrowserInstanceService.id) {
        resourceAttrs['browser.instance.id'] = BrowserInstanceService.id;
    }

    const syntheticsRunId = getSyntheticsRunId();
    if (syntheticsRunId) {
        resourceAttrs[SYNTHETICS_RUN_ID_ATTRIBUTE] = syntheticsRunId;
    }
    
    this.resource = new Resource(resourceAttrs);

    this.attributesProcessor = new SplunkSpanAttributesProcessor(
      {
        ...(deploymentEnvironment ? { 'environment': deploymentEnvironment, 'deployment.environment': deploymentEnvironment } : {}),
        ...(version ? { 'app.version': version } : {}),
        ...(processedOptions.globalAttributes || {}),
      },
      this._processedOptions.persistence === 'localStorage',
      () => userTrackingMode,
      processedOptions.cookieDomain,
    );

    const spanProcessors: SpanProcessor[] = [this.attributesProcessor];
    
    if (processedOptions.endpoint) {
      const exporter = buildExporter(processedOptions);
      const spanProcessor = processedOptions.spanProcessor.factory(exporter, {
        scheduledDelayMillis: processedOptions.bufferTimeout,
        maxExportBatchSize: processedOptions.bufferSize,
      });
      spanProcessors.push(spanProcessor);
      this._processor = spanProcessor;
    }
    
    if (processedOptions.debug) {
      spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
    }

    if (options._experimental_allSpansExtendSession) {
        spanProcessors.push(new SessionSpanProcessor());
    }

    if (options.spanProcessors) {
        spanProcessors.push(...options.spanProcessors);
    }
    
    const provider = new SplunkWebTracerProvider({
        ...processedOptions.tracer,
        resource: this.resource,
        sampler: new SplunkSamplerWrapper({
            decider: processedOptions.tracer?.sampler ?? new AlwaysOnSampler(),
            allSpansAreActivity: Boolean(this._processedOptions._experimental_allSpansExtendSession),
        }),
        spanProcessors,
    });
    
    fetch(`https://cdn.kloudmate.com/rum/js/v${VERSION}/otel-web.js`, {
      method: 'HEAD'
    }).then(resp => {
      provider.resource.attributes['country'] = resp.headers.get("Cloudfront-Viewer-Country") || undefined;
      provider.resource.attributes['city'] = resp.headers.get("CloudFront-Viewer-City") || undefined;
      provider.resource.attributes['viewer.address'] = resp.headers.get("CloudFront-Viewer-Address") || undefined;
    });

    _deinitSessionTracking = initSessionTracking(
        processedOptions.persistence,
        eventTarget,
        processedOptions.cookieDomain,
    ).deinit;

    const instrumentations = INSTRUMENTATIONS.map(({ Instrument, confKey, disable }) => {
      const pluginConf = getPluginConfig(processedOptions.instrumentations[confKey], pluginDefaults, disable);
      if (pluginConf) {
        const instrumentation =
            Instrument === SplunkLongTaskInstrumentation
                ? new Instrument(pluginConf, options)
                : // @ts-expect-error Can't mark in any way that processedOptions.instrumentations[confKey] is of specifc config type
                  new Instrument(pluginConf);

        if (confKey === ERROR_INSTRUMENTATION_NAME && instrumentation instanceof SplunkErrorInstrumentation) {
          _errorInstrumentation = instrumentation;
        }
        if (confKey === 'postload' && instrumentation instanceof SplunkPostDocLoadResourceInstrumentation) {
          _postDocLoadInstrumentation = instrumentation;
        }
        return instrumentation;
      }
      return null;
    }).filter((a): a is Exclude<typeof a, null> => Boolean(a));
    
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            void this._processor?.forceFlush();
        }
    });
    
    provider.register({
        contextManager: new SplunkContextManager({
            ...processedOptions.context,
            onBeforeContextStart: () => _postDocLoadInstrumentation?.onBeforeContextChange(),
            onBeforeContextEnd: () => _postDocLoadInstrumentation?.onBeforeContextChange(),
        }),
    });
    
    _deregisterInstrumentations = registerInstrumentations({
        tracerProvider: provider,
        instrumentations,
    });
    
    this.provider = provider;
    
    const vitalsConf = getPluginConfig(processedOptions.instrumentations.webvitals);
    if (vitalsConf !== false) {
        initWebVitals(provider, vitalsConf);
    }
    
    if (options.sessionRecorder?.enabled) {
      import('@kloudmate/otel-web-session-recorder').then(module => {
        module.default.init({
          endpoint: options.endpoint,
          rumAccessToken: options.rumAccessToken,
          debug: options.debug,
          ...options.sessionRecorder?.options
        });
      });
    }

    inited = true;
    diag.info('KloudMateRum.init() complete');

  },

  deinit(force = false) {
    if (!inited && !force) {
      return;
    }

    _deregisterInstrumentations?.();
    _deregisterInstrumentations = undefined;

    _deinitSessionTracking?.();
    _deinitSessionTracking = undefined;

    void this.provider?.shutdown();
    delete this.provider;

    eventTarget = undefined;

    diag.disable();
    unregisterGlobal();

    forgetAnonymousId();
    inited = false;
  },

  setGlobalAttributes(this: SplunkOtelWebType, attributes?: Attributes) {
    this.attributesProcessor?.setGlobalAttributes(attributes);
    eventTarget?.emit('global-attributes-changed', {
      attributes: this.attributesProcessor?.getGlobalAttributes() || {},
    });
  },

  getGlobalAttributes(this: SplunkOtelWebType) {
    return this.attributesProcessor?.getGlobalAttributes() || {};
  },

  _experimental_getGlobalAttributes() {
    return this.getGlobalAttributes();
  },

  error(...args) {
    if (!inited) {
      diag.debug('KloudMateRum not inited');
      return;
    }

    if (!_errorInstrumentation) {
      diag.error('Error was reported, but error instrumentation is disabled.');
      return;
    }

    _errorInstrumentation.report('KloudMate.error', args);
  },

  addEventListener(name, callback): void {
    eventTarget?.addEventListener(name, callback);
  },

  removeEventListener(name, callback): void {
    eventTarget?.removeEventListener(name, callback);
  },

  _experimental_addEventListener(name, callback): void {
    return this.addEventListener(name, callback);
  },

  _experimental_removeEventListener(name, callback): void {
    return this.removeEventListener(name, callback);
  },

  setUserTrackingMode(mode: UserTrackingMode) {
    userTrackingMode = mode;
  },

  getAnonymousId() {
    if (!this._processedOptions) {
      return;
    }

    if (userTrackingMode === 'anonymousTracking') {
      return getOrCreateAnonymousId({
        useLocalStorage: this._processedOptions.persistence === 'localStorage',
        domain: this._processedOptions.cookieDomain,
      });
    }
  },

  getSessionId() {
    if (!inited) {
      return undefined;
    }
    return getRumSessionId();
  },

  isNewSessionId() {
    return getIsNewSession();
  },

  _experimental_getSessionId() {
    return this.getSessionId();
  },

  _internalOnExternalSpanCreated() {
    if (!this._processedOptions) {
      return;
    }

    updateSessionStatus({
      forceStore: false,
      hadActivity: !!this._processedOptions._experimental_allSpansExtendSession,
    });
  },

  _internalCheckSessionRecorderType(recorderType: RecorderType) {
    checkSessionRecorderType(recorderType);
  },
};

export default KloudMateRum;