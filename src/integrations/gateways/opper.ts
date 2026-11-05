import { defineGateway } from '../define.js'
import type { ModelCatalogEntry } from '../descriptors.js'
import {
  firstPositiveNumber,
  getTrimmedString,
  isKnownNonCodingModelId,
  isRecord,
} from '../modelMapping.js'

// Model ids are rendered in the model picker. Drop anything carrying control
// characters (including ESC for ANSI sequences) instead of trying to clean it.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/

function stringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Map a row of Opper's authenticated GET /v3/compat/models?view=simplified
 * payload into a catalog entry. Rows use OpenRouter's `context_length` and
 * `architecture` fields, plus an `opper` block with the model `type`, its
 * `capabilities` and `max_output_tokens`.
 */
export function mapOpperModel(raw: unknown): ModelCatalogEntry | null {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (
    !id ||
    CONTROL_CHARACTER_PATTERN.test(id) ||
    isKnownNonCodingModelId(id)
  ) {
    return null
  }

  const opper = isRecord(raw.opper) ? raw.opper : undefined
  const type = opper ? getTrimmedString(opper, 'type') : undefined
  if (type && type !== 'llm') {
    return null
  }

  const architecture = isRecord(raw.architecture) ? raw.architecture : undefined
  const outputs = stringEntries(architecture?.output_modalities)
  if (outputs.length > 0 && !outputs.includes('text')) {
    return null
  }

  const capabilities = stringEntries(opper?.capabilities)
  const toolCall = capabilities.includes('tools')
  const reasoning = capabilities.includes('reasoning')
  const contextWindow = firstPositiveNumber(raw.context_length)
  const maxOutputTokens = firstPositiveNumber(opper?.max_output_tokens)

  return {
    id,
    apiName: id,
    label: id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(toolCall || reasoning
      ? {
          capabilities: {
            ...(toolCall ? { supportsFunctionCalling: true } : {}),
            ...(reasoning ? { supportsReasoning: true } : {}),
          },
        }
      : {}),
  }
}

export default defineGateway({
  id: 'opper',
  label: 'Opper',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.opper.ai/v3/compat',
  defaultModel: 'claude-sonnet-4-6',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['OPPER_API_KEY'],
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsAuthHeaders: true,
    },
  },
  preset: {
    id: 'opper',
    description: 'Opper OpenAI-compatible gateway',
    apiKeyEnvVars: ['OPPER_API_KEY'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.opper.ai'],
    },
    credentialEnvVars: ['OPPER_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'Set OPPER_API_KEY or OPENAI_API_KEYS / OPENAI_API_KEY for the Opper gateway.',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      // The simplified view lists each model once, by its bare name when
      // several providers serve it, instead of every provider route.
      path: 'models?view=simplified',
      mapModel: mapOpperModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [
      { id: 'opper-claude-sonnet-4-6', apiName: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (via Opper)', modelDescriptorId: 'claude-sonnet-4-6' },
      { id: 'opper-gpt-5.5', apiName: 'gpt-5.5', label: 'GPT-5.5 (via Opper)', modelDescriptorId: 'gpt-5.5' },
      { id: 'opper-gemini-3.5-flash', apiName: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (via Opper)', modelDescriptorId: 'gemini-3.5-flash' },
    ],
  },
  usage: { supported: false },
})
