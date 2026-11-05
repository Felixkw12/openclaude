import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { clearManagedProfileEnv } from '../../utils/providerProfile.js'
import opper, { mapOpperModel } from './opper.js'

describe('opper gateway live model mapping', () => {
  test('uses hybrid discovery against the simplified models list', () => {
    expect(opper.catalog?.source).toBe('hybrid')
    expect(opper.catalog?.discovery).toEqual(
      expect.objectContaining({
        kind: 'openai-compatible',
        path: 'models?view=simplified',
      }),
    )
    expect(opper.catalog?.discovery?.requiresAuth).not.toBe(false)
    expect(opper.catalog?.discovery?.mapModel).toBe(mapOpperModel)
  })

  test('maps Opper model fields into catalog entries', () => {
    expect(
      mapOpperModel({
        id: 'claude-sonnet-4-6',
        object: 'model',
        owned_by: 'opper',
        context_length: 1000000,
        architecture: {
          modality: 'text+image->text',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        pricing: { prompt: '0.000003', completion: '0.000015' },
        opper: {
          kind: 'pool',
          type: 'llm',
          capabilities: ['text', 'vision', 'tools', 'reasoning'],
          max_output_tokens: 128000,
        },
      }),
    ).toEqual({
      id: 'claude-sonnet-4-6',
      apiName: 'claude-sonnet-4-6',
      label: 'claude-sonnet-4-6',
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
    })

    expect(
      mapOpperModel({
        id: 'mistral/mistral-small',
        context_length: 128000,
        opper: { type: 'llm', capabilities: ['text'], max_output_tokens: 0 },
      }),
    ).toEqual({
      id: 'mistral/mistral-small',
      apiName: 'mistral/mistral-small',
      label: 'mistral/mistral-small',
      contextWindow: 128000,
    })
  })

  test('filters non-chat and non-coding models', () => {
    expect(
      mapOpperModel({
        id: 'openai/text-embedding-3-small',
        opper: { type: 'embedding' },
      }),
    ).toBeNull()

    expect(
      mapOpperModel({
        id: 'vendor/some-model',
        architecture: { output_modalities: ['image'] },
      }),
    ).toBeNull()

    expect(
      mapOpperModel({ id: 'vendor/voice-model', opper: { type: 'tts' } }),
    ).toBeNull()
    expect(mapOpperModel({ id: 'openai/text-embedding-3-large' })).toBeNull()
    expect(mapOpperModel({})).toBeNull()
    expect(mapOpperModel({ id: '   ' })).toBeNull()
    expect(mapOpperModel(null)).toBeNull()
    expect(mapOpperModel('claude-sonnet-4-6')).toBeNull()
  })

  test('drops model ids carrying control or ANSI escape characters', () => {
    expect(mapOpperModel({ id: 'claude-sonnet-4-6\u001b[31m' })).toBeNull()
    expect(mapOpperModel({ id: 'claude\u0007-sonnet-4-6' })).toBeNull()
    expect(mapOpperModel({ id: 'claude-sonnet-4-6\u009b' })).toBeNull()
  })
})

// Run the shim in a fresh process with a clean provider env: inherited
// provider flags, Azure mode or auth settings cannot reach the request, and
// the test never mutates this process's env. 30s covers the child's startup.
test('sends OPPER_API_KEY only to the canonical Opper URL', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'opper-gate-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  delete env.OPPER_API_KEY
  env.CLAUDE_CONFIG_DIR = configDir
  env.OPENCLAUDE_CONFIG_DIR = configDir
  const source = `
    import { enableConfigs } from './src/utils/config.ts';
    import { createOpenAIShimClient } from './src/services/api/openaiShim.ts';
    enableConfigs();
    let authorization = null;
    globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({
        id: 'chatcmpl-opper', model: 'claude-sonnet-4-6',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const results = {};
    for (const baseUrl of ${JSON.stringify([
      'https://api.opper.ai/v3/compat',
      'http://api.opper.ai/v3/compat',
      'https://api.opper.ai:8443/v3/compat',
      'https://proxy.example/v1',
    ])}) {
      for (const openAIKey of [undefined, 'openai-key']) {
        process.env.CLAUDE_CODE_USE_OPENAI = '1';
        process.env.OPENAI_BASE_URL = baseUrl;
        process.env.OPENAI_MODEL = 'claude-sonnet-4-6';
        process.env.OPPER_API_KEY = 'opper-key';
        if (openAIKey) process.env.OPENAI_API_KEY = openAIKey;
        else delete process.env.OPENAI_API_KEY;
        authorization = null;
        await createOpenAIShimClient({}).beta.messages.create({
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 32,
          stream: false,
        });
        results[baseUrl + (openAIKey ? ' +openai' : '')] = authorization;
      }
    }
    process.stdout.write(JSON.stringify(results));
  `
  try {
    const child = Bun.spawn([process.execPath, '--eval', source], {
      cwd: join(import.meta.dir, '../../..'),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    const opperKey = 'Bearer opper-key'
    const openai = 'Bearer openai-key'
    expect(JSON.parse(stdout)).toEqual({
      'https://api.opper.ai/v3/compat': opperKey,
      'https://api.opper.ai/v3/compat +openai': opperKey,
      'http://api.opper.ai/v3/compat': null,
      'http://api.opper.ai/v3/compat +openai': openai,
      'https://api.opper.ai:8443/v3/compat': null,
      'https://api.opper.ai:8443/v3/compat +openai': openai,
      'https://proxy.example/v1': null,
      'https://proxy.example/v1 +openai': openai,
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 30_000)
