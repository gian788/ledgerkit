import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { Resource } from '@opentelemetry/resources';
import { trace, metrics, context, propagation } from '@opentelemetry/api';
import type { Context, TextMapGetter } from '@opentelemetry/api';
import { config } from './config';

type KafkaHeaders = Record<string, string | Buffer | undefined>;

let sdk: NodeSDK | undefined;

export function initOtel(serviceName: string): void {
  if (!config.otel.enabled) return;

  const resource = new Resource({ 'service.name': serviceName });

  const traceExporter = new OTLPTraceExporter({
    url: `${config.otel.otlpEndpoint}/v1/traces`,
  });

  const metricReader = new PrometheusExporter({
    port: config.otel.metricsPort,
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation is extremely noisy (fires on every require)
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
}

export function shutdownOtel(): Promise<void> {
  return sdk?.shutdown() ?? Promise.resolve();
}

export function getTracer(name: string) {
  return trace.getTracer(name);
}

export function getMeter(name: string) {
  return metrics.getMeter(name);
}

// ── Kafka W3C trace-context propagation ───────────────────────────────────────

const kafkaGetter: TextMapGetter<KafkaHeaders> = {
  get(carrier, key) {
    const val = carrier[key];
    if (val === undefined) return undefined;
    return Buffer.isBuffer(val) ? val.toString() : val;
  },
  keys(carrier) {
    return Object.keys(carrier);
  },
};

/**
 * Returns headers to attach to a Kafka ProducerRecord so the current active
 * trace context travels with the message.
 */
export function injectKafkaHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return headers;
}

/**
 * Extracts a trace context from incoming Kafka message headers and returns
 * an OTel Context that can be used as a parent for new spans.
 */
export function extractKafkaContext(headers: KafkaHeaders | undefined): Context {
  if (!headers) return context.active();
  return propagation.extract(context.active(), headers, kafkaGetter);
}
