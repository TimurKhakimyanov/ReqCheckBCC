import { describe, expect, it } from 'vitest'
import { RAW_400, RAW_401 } from '@/mocks/data'
import { describeProviderError, extractProviderMessage } from './providerError'

describe('describeProviderError', () => {
  it('classifies the raw SDK errors users currently see', () => {
    expect(describeProviderError(RAW_400)).toMatchObject({ kind: 'bad_request', status: 400 })
    expect(describeProviderError(RAW_400).providerMessage).toMatch(/^Unsupported parameter: 'max_tokens'/)
    expect(describeProviderError(RAW_401)).toMatchObject({ kind: 'auth', status: 401 })
  })

  it.each([
    ["RateLimitError: Error code: 429 - {'error': {'message': 'Rate limit reached'}}", 'rate_limit'],
    ['google.genai.errors.ClientError: 429 RESOURCE_EXHAUSTED. Quota exceeded for metric per day', 'quota'],
    ['APITimeoutError: Request timed out.', 'timeout'],
    ['APIConnectionError: Connection error.', 'connection'],
    ['InternalServerError: Error code: 503 - overloaded', 'unavailable'],
    ["NotFoundError: Error code: 404 - {'error': {'message': 'The model `gpt-9` does not exist'}}", 'not_found'],
    ["BadRequestError: Error code: 400 - {'error': {'message': \"This model's maximum context length is 8192 tokens\"}}", 'context'],
    ['ValidationError: 1 validation error for RequirementCheck: Invalid JSON', 'invalid_output'],
    ['NotImplementedError', 'not_implemented'],
    ['Провайдер отклонил ключ (401). Проверьте API-ключ в кабинете.', 'auth'],
    ['что-то странное', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (raw, kind) => {
    expect(describeProviderError(raw).kind).toBe(kind)
  })

  it('extracts the provider message from Python dicts and JSON', () => {
    expect(extractProviderMessage(`{"error": {"message": "Bad \\"thing\\"", "code": 1}}`)).toBe('Bad "thing"')
    expect(extractProviderMessage(`{'error': {'message': 'It\\'s wrong'}}`)).toBe("It's wrong")
    expect(extractProviderMessage('no message here')).toBeUndefined()
  })
})
