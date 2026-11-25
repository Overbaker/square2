// v0.1.2: an OpenAI-compatible gateway as the provider base URL, and retry/stream settings for
// throttled deployments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LLM_RETRIES, RunError, codexArgs, llmBaseUrl, llmRetries } from '../src/review/run.mjs';

const BASE = { model: 'm', endpoint: 'https://res.example.invalid/', tree: '/t', outFile: '/o' };
/** @param {string[]} args @returns {string} the provider table override */
const provider = (args) => /** @type {string} */ (args.find((a) => a.startsWith('model_providers.sq2azure=')));

test('default: the Azure endpoint, 20 request and stream retries, a 10 minute stream idle timeout', () => {
  const p = provider(codexArgs(BASE));
  assert.equal(p, 'model_providers.sq2azure={ name = "sq2azure", base_url = "https://res.example.invalid/openai/v1", env_key = "SQ2_AZURE_OPENAI_API_KEY", wire_api = "responses", request_max_retries = 20, stream_max_retries = 20, stream_idle_timeout_ms = 600000 }');
  assert.equal(DEFAULT_LLM_RETRIES, 20);
  assert.equal(llmRetries({}), 20);
  assert.equal(llmRetries({ SQ2_LLM_RETRIES: '' }), 20, 'an unset repository variable arrives as an empty string');
  assert.equal(llmBaseUrl({ SQ2_LLM_BASE_URL: '' }, 'https://e.invalid///'), 'https://e.invalid/openai/v1');
});

test('SQ2_LLM_BASE_URL is used verbatim', () => {
  for (const url of ['http://127.0.0.1:3425/v1', 'http://localhost:8080/openai/v1/', 'http://[::1]:3425/v1', 'https://gateway.example.invalid/v1', 'HTTP://LOCALHOST:1/v1']) {
    assert.match(provider(codexArgs({ ...BASE, env: { SQ2_LLM_BASE_URL: url } })), new RegExp(`base_url = ${JSON.stringify(url).replace(/[[\]/.]/g, '\\$&')}, env_key = "SQ2_AZURE_OPENAI_API_KEY"`), url);
  }
});

test('SQ2_LLM_BASE_URL rejects non-loopback http, other schemes, credentials and garbage', () => {
  for (const url of ['http://gateway.example.invalid/v1', 'http://10.0.0.5:3425/v1', 'http://127.0.0.2/v1', 'http://localhost.example.invalid/v1', 'ftp://127.0.0.1/v1', 'file:///tmp/x', 'ws://127.0.0.1/v1', 'https://user:pass@gateway.example.invalid/v1', 'not a url', '127.0.0.1:3425/v1']) {
    assert.throws(() => codexArgs({ ...BASE, env: { SQ2_LLM_BASE_URL: url } }), RunError, url);
  }
});

test('SQ2_LLM_RETRIES: integers 0..100 only', () => {
  for (const [v, n] of /** @type {[string, number][]} */ ([['0', 0], ['1', 1], ['100', 100], [' 7 ', 7]])) {
    assert.equal(llmRetries({ SQ2_LLM_RETRIES: v }), n, v);
    assert.match(provider(codexArgs({ ...BASE, env: { SQ2_LLM_RETRIES: v } })), new RegExp(`request_max_retries = ${n}, stream_max_retries = ${n},`));
  }
  for (const v of ['101', '-1', '1.5', '1e2', 'twenty', '0x10', '1000']) assert.throws(() => llmRetries({ SQ2_LLM_RETRIES: v }), RunError, v);
});
