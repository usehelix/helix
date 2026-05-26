import { describe, it, expect } from 'vitest';
import {
  smartParamRepair,
  applyParamRepair,
  type CircleParamError,
  type ParamRepairAction,
} from '../../../src/strategies/circle-v2/smart-param-repair.js';

// ──────────────────────────────────────────────────────────────────
// Helpers — build representative Circle param errors
// ──────────────────────────────────────────────────────────────────

function buildErr(entries: Array<Record<string, unknown>>): CircleParamError {
  return { response: { data: { code: 2, message: 'API parameter invalid', errors: entries as any } } };
}

// ──────────────────────────────────────────────────────────────────
// Routing — smartParamRepair
// ──────────────────────────────────────────────────────────────────

describe('smartParamRepair — routing', () => {
  it('no errors[] → hold_and_notify with generic diagnostic', () => {
    const action = smartParamRepair({});
    expect(action.type).toBe('hold_and_notify');
    if (action.type === 'hold_and_notify') {
      expect(action.diagnostic).toMatch(/no structured/i);
    }
  });

  it('empty errors[] array → hold_and_notify with generic diagnostic', () => {
    const action = smartParamRepair(buildErr([]));
    expect(action.type).toBe('hold_and_notify');
  });

  it('idempotencyKey rejection (PR #2 probe shape) → strip_field', () => {
    const action = smartParamRepair(buildErr([{
      error: 'uuid_format',
      invalidValue: 'deliberate-probe-bad-key',
      location: 'idempotencyKey',
      message: "'idempotencyKey' field is not in the correct UUID format (was deliberate-probe-bad-key)",
    }]));
    expect(action).toEqual({ type: 'strip_field', field: 'idempotencyKey' });
  });

  it('UUID format error on walletId (NOT idempotencyKey) → hold_and_notify', () => {
    const action = smartParamRepair(buildErr([{
      error: 'uuid_format',
      location: 'walletId',
      message: "'walletId' is not in correct UUID format",
    }]));
    expect(action.type).toBe('hold_and_notify');
    if (action.type === 'hold_and_notify') {
      expect(action.diagnostic).toMatch(/uuid/i);
      expect(action.diagnostic).toMatch(/walletId/);
    }
  });

  it('amount must be string → coerce_type/string', () => {
    const action = smartParamRepair(buildErr([{
      location: 'amount',
      message: 'amount must be a string',
    }]));
    expect(action).toEqual({ type: 'coerce_type', field: 'amount', toType: 'string' });
  });

  it('amount must be array → coerce_type/array', () => {
    const action = smartParamRepair(buildErr([{
      location: 'amount',
      message: 'amount expected array, got string',
    }]));
    expect(action).toEqual({ type: 'coerce_type', field: 'amount', toType: 'array' });
  });

  it('amount must be number → coerce_type/number', () => {
    const action = smartParamRepair(buildErr([{
      location: 'amount',
      message: 'amount must be a number',
    }]));
    expect(action).toEqual({ type: 'coerce_type', field: 'amount', toType: 'number' });
  });

  it('destinationAddress hex error → normalize_address', () => {
    const action = smartParamRepair(buildErr([{
      location: 'destinationAddress',
      message: "destinationAddress is not a valid hex string",
    }]));
    expect(action.type).toBe('normalize_address');
    if (action.type === 'normalize_address') {
      expect(action.field).toBe('destinationAddress');
    }
  });

  it('missing fee → inject_default with MEDIUM fee level', () => {
    const action = smartParamRepair(buildErr([{
      location: 'fee',
      message: 'fee is required',
    }]));
    expect(action.type).toBe('inject_default');
    if (action.type === 'inject_default') {
      expect(action.field).toBe('fee');
      expect(action.value).toEqual({ type: 'level', config: { feeLevel: 'MEDIUM' } });
    }
  });

  it('unknown tokenId → refresh_metadata/tokenId', () => {
    const action = smartParamRepair(buildErr([{
      location: 'tokenId',
      message: 'unknown token id',
    }]));
    expect(action).toEqual({ type: 'refresh_metadata', resource: 'tokenId' });
  });

  it('unknown walletId → refresh_metadata/walletId', () => {
    const action = smartParamRepair(buildErr([{
      location: 'walletId',
      message: 'wallet id not found',
    }]));
    expect(action).toEqual({ type: 'refresh_metadata', resource: 'walletId' });
  });

  it('unknown error shape → hold_and_notify with location-prefixed diagnostic', () => {
    const action = smartParamRepair(buildErr([{
      location: 'someNewField',
      message: 'some constraint we have not seen',
    }]));
    expect(action.type).toBe('hold_and_notify');
    if (action.type === 'hold_and_notify') {
      expect(action.diagnostic).toContain('someNewField');
      expect(action.diagnostic).toContain('some constraint we have not seen');
    }
  });

  it('accepts legacy "constraint" field name AS WELL AS "error"', () => {
    // Spec used `constraint`; live SDK uses `error`. Both should work.
    const action = smartParamRepair(buildErr([{
      constraint: 'uuid_format', // ← legacy spec field name
      location: 'walletId',
      message: 'walletId field is malformed',
    }]));
    expect(action.type).toBe('hold_and_notify');
    if (action.type === 'hold_and_notify') {
      expect(action.diagnostic).toMatch(/uuid/i);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Application — applyParamRepair
// ──────────────────────────────────────────────────────────────────

describe('applyParamRepair — argument mutation', () => {
  it('strip_field — removes the field, original args unchanged', () => {
    const args = { walletId: 'w1', idempotencyKey: 'not-a-uuid', amount: ['1.0'] };
    const action: ParamRepairAction = { type: 'strip_field', field: 'idempotencyKey' };
    const r = applyParamRepair(args, action);
    expect(r.args).toEqual({ walletId: 'w1', amount: ['1.0'] });
    expect(r.canRetry).toBe(true);
    // Original args MUST be untouched (deep clone contract).
    expect(args.idempotencyKey).toBe('not-a-uuid');
  });

  it('coerce_type/string — wraps the value', () => {
    const args = { amount: 123 };
    const r = applyParamRepair(args, { type: 'coerce_type', field: 'amount', toType: 'string' });
    expect(r.args.amount).toBe('123');
    expect(r.canRetry).toBe(true);
  });

  it('coerce_type/array — wraps scalar; idempotent on existing array', () => {
    const r1 = applyParamRepair({ amount: '1.0' }, { type: 'coerce_type', field: 'amount', toType: 'array' });
    expect(r1.args.amount).toEqual(['1.0']);
    const r2 = applyParamRepair({ amount: ['1.0'] }, { type: 'coerce_type', field: 'amount', toType: 'array' });
    expect(r2.args.amount).toEqual(['1.0']); // no double-wrap
  });

  it('coerce_type/number — parses string to number', () => {
    const r = applyParamRepair({ amount: '0.5' }, { type: 'coerce_type', field: 'amount', toType: 'number' });
    expect(r.args.amount).toBe(0.5);
  });

  it('normalize_address — adds 0x prefix and lowercases', () => {
    const r = applyParamRepair(
      { destinationAddress: 'ABC123def' },
      { type: 'normalize_address', field: 'destinationAddress' },
    );
    expect(r.args.destinationAddress).toBe('0xabc123def');
  });

  it('normalize_address — preserves existing 0x, only lowercases', () => {
    const r = applyParamRepair(
      { destinationAddress: '0xABC123' },
      { type: 'normalize_address', field: 'destinationAddress' },
    );
    expect(r.args.destinationAddress).toBe('0xabc123');
  });

  it('inject_default — adds the missing field', () => {
    const args = { walletId: 'w1' };
    const r = applyParamRepair(args, {
      type: 'inject_default',
      field: 'fee',
      value: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    expect(r.args).toMatchObject({
      walletId: 'w1',
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    expect(r.canRetry).toBe(true);
  });

  it('refresh_metadata — canRetry=false (caller must re-fetch)', () => {
    const r = applyParamRepair({ tokenId: 'stale' }, { type: 'refresh_metadata', resource: 'tokenId' });
    expect(r.canRetry).toBe(false);
    expect(r.description).toMatch(/refresh/i);
    // Args untouched in this case.
    expect(r.args).toEqual({ tokenId: 'stale' });
  });

  it('hold_and_notify — canRetry=false, description == diagnostic', () => {
    const r = applyParamRepair(
      { walletId: 'w1' },
      { type: 'hold_and_notify', diagnostic: 'Manual review needed for walletId UUID' },
    );
    expect(r.canRetry).toBe(false);
    expect(r.description).toBe('Manual review needed for walletId UUID');
  });

  it('deep clone — nested objects in args are not aliased', () => {
    const args = { fee: { type: 'level', config: { feeLevel: 'MEDIUM' } } };
    const r = applyParamRepair(args, { type: 'strip_field', field: 'nonexistent' });
    // Mutate the returned copy's nested field — original should not change.
    (r.args.fee as any).config.feeLevel = 'HIGH';
    expect(args.fee.config.feeLevel).toBe('MEDIUM');
  });
});

// ──────────────────────────────────────────────────────────────────
// End-to-end: chain smartParamRepair + applyParamRepair on the PR #2 probe
// ──────────────────────────────────────────────────────────────────

describe('end-to-end — PR #2 probe → router → applied args', () => {
  it('reproduces PR #2 idempotencyKey rejection scenario', () => {
    const error: CircleParamError = {
      response: {
        data: {
          code: 2,
          message: 'API parameter invalid',
          errors: [{
            error: 'uuid_format',
            invalidValue: 'deliberate-probe-bad-key',
            location: 'idempotencyKey',
            message: "'idempotencyKey' field is not in the correct UUID format",
          }],
        },
      },
    };

    const args = {
      walletId: '7e0d2079-c1ba-51c8-9162-0b8b9536a0b4',
      destinationAddress: '0xd49a5e28...',
      tokenId: '15dc2b5d-0994-58b0-bf8c-3a0501148ee8',
      amount: ['0.001'],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      idempotencyKey: 'deliberate-probe-bad-key',
    };

    const action = smartParamRepair(error);
    expect(action).toEqual({ type: 'strip_field', field: 'idempotencyKey' });

    const repaired = applyParamRepair(args, action);
    expect(repaired.canRetry).toBe(true);
    expect('idempotencyKey' in repaired.args).toBe(false);
    expect(repaired.args.walletId).toBe(args.walletId); // other fields preserved
  });
});
