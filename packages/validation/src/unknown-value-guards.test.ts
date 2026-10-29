import { describe, expect, it } from 'vitest';
import {
  hasExactOwnKeys,
  hasOnlyAllowedKeys,
  isNonNegativeInteger,
  isNonNegativeSafeInteger,
  getArrayProperty,
  getBooleanArrayProperty,
  getNumberArrayProperty,
  getNumberProperty,
  getObjectProperty,
  getStringArrayProperty,
  getStringProperty,
  isNumberArray,
  isNonNullObject,
  requireNonNullObject,
} from './unknown-value-guards';

describe('unknown-value guards', () => {
  it('distinguishes optional allowed fields from exact own enumerable fields', () => {
    const allowed = new Set(['required', 'optional']);
    const value = { required: 1 };
    Object.setPrototypeOf(value, { optional: 2 });
    expect(hasOnlyAllowedKeys(value, allowed)).toBe(true);
    expect(hasExactOwnKeys(value, allowed)).toBe(false);
    expect(hasExactOwnKeys(value, ['required', 'optional'])).toBe(false);
    expect(hasExactOwnKeys({ required: 1, optional: 2 }, ['optional', 'required'])).toBe(true);
    expect(hasExactOwnKeys({ required: 1, optional: 2 }, ['required', 'required'])).toBe(false);
    expect(hasOnlyAllowedKeys({ required: 1, unexpected: 2 }, allowed)).toBe(false);
  });

  it('preserves integer contracts that admit values beyond the safe-integer bound', () => {
    const value = Number.MAX_SAFE_INTEGER + 1;
    expect(isNonNegativeInteger(value)).toBe(true);
    expect(isNonNegativeSafeInteger(value)).toBe(false);
    for (const invalid of [-1, 0.5, Number.NaN, Infinity, '1', null]) {
      expect(isNonNegativeInteger(invalid)).toBe(false);
    }
  });

  it('accepts non-null objects, including arrays', () => {
    expect(isNonNullObject({})).toBe(true);
    expect(isNonNullObject([])).toBe(true);
    expect(isNonNullObject(['entry'])).toBe(true);

    expect(isNonNullObject(null)).toBe(false);
    expect(isNonNullObject(undefined)).toBe(false);
    expect(isNonNullObject('record')).toBe(false);
    expect(isNonNullObject(1)).toBe(false);
    expect(isNonNullObject(true)).toBe(false);
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
    expect(getObjectProperty(value, 'recordValue')).toEqual({ nested: true });
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

  it('accepts arrays as object-valued properties', () => {
    const arrayValue = ['entry'];

    expect(getObjectProperty({ arrayValue }, 'arrayValue')).toBe(arrayValue);
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
      expect(getObjectProperty(value, 'recordValue')).toBeUndefined();
      expect(getArrayProperty(value, 'arrayValue')).toBeUndefined();
      expect(getStringArrayProperty(value, 'stringArrayValue')).toBeUndefined();
      expect(getNumberArrayProperty(value, 'numberArrayValue')).toBeUndefined();
      expect(getBooleanArrayProperty(value, 'booleanArrayValue')).toBeUndefined();
    }
  });

  it('returns undefined properties when the containing value is not a non-null object', () => {
    expect(getStringProperty(null, 'value')).toBeUndefined();
    expect(getNumberProperty(undefined, 'value')).toBeUndefined();
    expect(getObjectProperty('value', 'value')).toBeUndefined();
    expect(getArrayProperty(1, 'value')).toBeUndefined();
    expect(getStringArrayProperty(false, 'value')).toBeUndefined();
    expect(getNumberArrayProperty(null, 'value')).toBeUndefined();
    expect(getBooleanArrayProperty(undefined, 'value')).toBeUndefined();
  });

  it('requires non-null objects with the exact existing error messages', () => {
    const record = { value: true };
    const arrayRecord = ['value'];

    expect(requireNonNullObject(record)).toBe(record);
    expect(requireNonNullObject(arrayRecord, 'array')).toBe(arrayRecord);
    expect(() => requireNonNullObject(null)).toThrow('Expected value to be a record');
    expect(() => requireNonNullObject(undefined, 'response payload')).toThrow(
      'Expected response payload to be a record',
    );
  });
});
