import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { s } from '@stark-ballot/validation/schema';
import { VoteRequestSchema, FinalizationCancelRequestSchema } from '@stark-ballot/api-contract/schemas';
import { gatewayContract } from '../gateway-contract';
import { buildGatewayContract, projectGatewaySchema } from './gateway-projection';

describe('Gateway request contract', () => {
  it('keeps the checked-in deployment artifact fresh', async () => {
    await gatewayContract('check');
  });

  it('rejects schema kinds and effects that have not been reviewed', () => {
    for (const schema of [
      s.number(),
      s.string().nullable(),
      s.string().transform((value) => value.trim()),
      s.string().refine(() => true),
    ]) {
      expect(() => projectGatewaySchema(schema, 'request', [])).toThrow(/unsupported|unreviewed/);
    }
  });

  it('derives strict objects, required fields, enums and the declared hex constraint', () => {
    const { models } = buildGatewayContract();
    expect(models['VoteRequest']).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['commitment', 'rand', 'vote'],
      properties: { commitment: { pattern: '^(?:0x)?[0-9A-Fa-f]{64}$' }, vote: { enum: ['A', 'B', 'C', 'D', 'E'] } },
    });
    expect(models['VerificationRunRequest']).toMatchObject({ properties: {}, additionalProperties: false });
    expect(models['VerificationObservationRequest']).toMatchObject({
      properties: {
        castChecks: {
          additionalProperties: false,
          required: ['cast_choice_range', 'cast_commitment_match', 'cast_random_format', 'cast_receipt_present'],
        },
      },
    });
    for (const hex of ['a'.repeat(64), `0x${'A'.repeat(64)}`]) {
      expect(VoteRequestSchema.safeParse({ commitment: hex, rand: hex, vote: 'A' }).success).toBe(true);
    }
  });

  it('leaves UTF-16 boundaries to Hono instead of narrowing valid Unicode input', () => {
    const { models, honoConstraints } = buildGatewayContract();
    expect(FinalizationCancelRequestSchema.safeParse({ reason: '😀'.repeat(128) }).success).toBe(true);
    expect(FinalizationCancelRequestSchema.safeParse({ reason: '😀'.repeat(129) }).success).toBe(false);
    expect(JSON.stringify(models)).not.toContain('maxLength');
    expect(honoConstraints).toContain('FinalizationCancelRequest.reason: maxLength 256 UTF-16 code units (Hono only)');
  });

  it('keeps optional session body, validates shadowed parameter POSTs, and gives all resources a method fallback', async () => {
    const { methods, resources } = buildGatewayContract();
    expect(methods['POST /api/sessions']?.model).toBeNull();
    expect(methods['POST /api/sessions/{sessionId}/finalizations/current/verification']?.model).toBe(
      'VerificationRunRequest',
    );
    for (const path of Object.keys(resources)) {
      expect(methods[`ANY ${path}`]?.model).toBeNull();
      expect(
        Object.values(resources).filter((child) => child.parent === path && child.part.startsWith('{')).length,
      ).toBeLessThanOrEqual(1);
    }
    expect(methods['ANY /api/sessions/{sessionId}/finalizations/current/{proxy+}']).toBeDefined();
    const source = await readFile('infra/terraform/app/api_gateway.tf', 'utf8');
    expect(source).toContain('"$default"');
    expect(source).toContain('"application/json"');
    expect(source).toContain(
      'request_validator_id = each.value.model == null ? null : aws_api_gateway_request_validator.body.id',
    );
  });
});
