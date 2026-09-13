import { describe, expect, it } from 'vitest';
import {
  getArrayProperty,
  getBooleanArrayProperty,
  getNumberArrayProperty,
  getNumberProperty,
  getRecordProperty,
  getStringArrayProperty,
  getStringProperty,
  isNumberArray,
  isRecord,
  requireRecord,
} from './unknown-value-guards';

describe('unknown-value guards', () => {
  it('treats non-null objects, including arrays, as records', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    expect(isRecord(['entry'])).toBe(true);

    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('record')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });

  it('reads inherited properties without requiring an own property', () => {
    const value: Record<string, unknown> = {};
    Object.setPrototypeOf(value, {
      stringValue: 'inherited',
      numberValue: 42,
      recordValue: { nested: true },
      arrayValue: ['mixed', 1],
      stringArrayValue: ['A', 'B'],
      numberArrayValue: [1, 2],
      booleanArrayValue: [true, false],
    });

    expect(getStringProperty(value, 'stringValue')).toBe('inherited');
    expect(getNumberProperty(value, 'numberValue')).toBe(42);
    expect(getRecordProperty(value, 'recordValue')).toEqual({ nested: true });
    expect(getArrayProperty(value, 'arrayValue')).toEqual(['mixed', 1]);
    expect(getStringArrayProperty(value, 'stringArrayValue')).toEqual(['A', 'B']);
    expect(getNumberArrayProperty(value, 'numberArrayValue')).toEqual([1, 2]);
    expect(getBooleanArrayProperty(value, 'booleanArrayValue')).toEqual([true, false]);
  });

  it('accepts only arrays of finite numbers', () => {
    expect(isNumberArray([])).toBe(true);
    expect(isNumberArray([0, -1, Number.MAX_VALUE])).toBe(true);

    expect(isNumberArray([Number.NaN])).toBe(false);
    expect(isNumberArray([Number.POSITIVE_INFINITY])).toBe(false);
    expect(isNumberArray([Number.NEGATIVE_INFINITY])).toBe(false);
    expect(isNumberArray([1, '2'])).toBe(false);
    expect(isNumberArray('1,2')).toBe(false);
  });

  it('preserves exact string, number, boolean, and unknown array property behavior', () => {
    const value = {
      strings: ['A', 'B'],
      numbers: [1, 2],
      booleans: [true, false],
      unknowns: ['A', 1, false, null],
      mixedStrings: ['A', 2],
      nonFiniteNumbers: [1, Number.NaN],
      mixedBooleans: [true, 0],
    };

    expect(getStringArrayProperty(value, 'strings')).toBe(value.strings);
    expect(getNumberArrayProperty(value, 'numbers')).toBe(value.numbers);
    expect(getBooleanArrayProperty(value, 'booleans')).toBe(value.booleans);
    expect(getArrayProperty(value, 'unknowns')).toBe(value.unknowns);

    expect(getStringArrayProperty(value, 'mixedStrings')).toBeUndefined();
    expect(getNumberArrayProperty(value, 'nonFiniteNumbers')).toBeUndefined();
    expect(getBooleanArrayProperty(value, 'mixedBooleans')).toBeUndefined();
    expect(getArrayProperty(value, 'strings')).toBe(value.strings);
  });

  it('accepts empty arrays for every array property guard', () => {
    const empty: unknown[] = [];
    const value = { empty };

    expect(getArrayProperty(value, 'empty')).toBe(empty);
    expect(getStringArrayProperty(value, 'empty')).toBe(empty);
    expect(getNumberArrayProperty(value, 'empty')).toBe(empty);
    expect(getBooleanArrayProperty(value, 'empty')).toBe(empty);
  });

  it('treats arrays as record-valued properties', () => {
    const arrayValue = ['entry'];

    expect(getRecordProperty({ arrayValue }, 'arrayValue')).toBe(arrayValue);
  });

  it('returns undefined for missing, explicitly undefined, and wrong-type properties', () => {
    const missing = {};
    const undefinedProperties = {
      stringValue: undefined,
      numberValue: undefined,
      recordValue: undefined,
      arrayValue: undefined,
      stringArrayValue: undefined,
      numberArrayValue: undefined,
      booleanArrayValue: undefined,
    };
    const wrongTypes = {
      stringValue: 1,
      numberValue: '1',
      recordValue: null,
      arrayValue: {},
      stringArrayValue: 'A',
      numberArrayValue: 1,
      booleanArrayValue: true,
    };

    for (const value of [missing, undefinedProperties, wrongTypes]) {
      expect(getStringProperty(value, 'stringValue')).toBeUndefined();
      expect(getNumberProperty(value, 'numberValue')).toBeUndefined();
      expect(getRecordProperty(value, 'recordValue')).toBeUndefined();
      expect(getArrayProperty(value, 'arrayValue')).toBeUndefined();
      expect(getStringArrayProperty(value, 'stringArrayValue')).toBeUndefined();
      expect(getNumberArrayProperty(value, 'numberArrayValue')).toBeUndefined();
      expect(getBooleanArrayProperty(value, 'booleanArrayValue')).toBeUndefined();
    }
  });

  it('returns undefined properties when the containing value is not a record', () => {
    expect(getStringProperty(null, 'value')).toBeUndefined();
    expect(getNumberProperty(undefined, 'value')).toBeUndefined();
    expect(getRecordProperty('value', 'value')).toBeUndefined();
    expect(getArrayProperty(1, 'value')).toBeUndefined();
    expect(getStringArrayProperty(false, 'value')).toBeUndefined();
    expect(getNumberArrayProperty(null, 'value')).toBeUndefined();
    expect(getBooleanArrayProperty(undefined, 'value')).toBeUndefined();
  });

  it('requires records with the exact existing error messages', () => {
    const record = { value: true };
    const arrayRecord = ['value'];

    expect(requireRecord(record)).toBe(record);
    expect(requireRecord(arrayRecord, 'array')).toBe(arrayRecord);
    expect(() => requireRecord(null)).toThrow('Expected value to be a record');
    expect(() => requireRecord(undefined, 'response payload')).toThrow('Expected response payload to be a record');
  });
});
