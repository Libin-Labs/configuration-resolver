import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createResolver, changes } from '../dist/esm/index.js';
const number = (value) => typeof value === 'number';
test('later layers replace whole top-level values and provenance identifies the winner', () => {
  const resolver = createResolver({
    port: { validate: number, default: 80 },
    object: { validate: (v) => typeof v === 'object' && v !== null },
  });
  const result = resolver.resolve([
    { name: 'file', values: { port: 8080, object: { a: 1, b: 2 } } },
    { name: 'runtime', values: { object: { c: 3 } } },
  ]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.values, { port: 8080, object: { c: 3 } });
  assert.deepEqual(result.provenance, { port: 'file', object: 'runtime' });
});
test('defaults, required fields and unknown-key policy remain explicit', () => {
  const definition = {
    port: { validate: number, default: 80 },
    required: { validate: number, required: true },
  };
  const resolver = createResolver(definition),
    result = resolver.resolve([{ name: 'file', values: { extra: 1 } }]);
  assert.equal(result.valid, false);
  assert.equal(result.values.port, 80);
  assert.equal(result.provenance.port, '$default');
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['unknown', 'missing'],
  );
  const ignored = createResolver({ port: definition.port }, { unknown: 'ignore' }).resolve([
    { name: 'file', values: { extra: 1 } },
  ]);
  assert.equal(ignored.valid, true);
});
test('invalid winning values are errors without fallback; shadowed values are not field-validated', () => {
  const resolver = createResolver({ port: { validate: number, default: 80 } });
  const invalid = resolver.resolve([{ name: 'runtime', values: { port: 'bad' } }]);
  assert.equal(invalid.valid, false);
  assert.equal(Object.hasOwn(invalid.values, 'port'), false);
  assert.equal(invalid.issues[0].layer, 'runtime');
  const valid = resolver.resolve([
    { name: 'file', values: { port: 'bad' } },
    { name: 'override', values: { port: 3 } },
  ]);
  assert.equal(valid.valid, true);
  assert.equal(valid.values.port, 3);
});
test('sensitive diagnostics and issues do not leak values', () => {
  const resolver = createResolver({
    token: { validate: (value) => typeof value === 'string', sensitive: true },
  });
  const result = resolver.resolve([{ name: 'secrets', values: { token: 'private' } }]);
  assert.equal(result.values.token, 'private');
  assert.equal(result.diagnostics.token, '[REDACTED]');
  assert.equal(JSON.stringify(result.issues).includes('private'), false);
});
test('validators receive detached copies and exceptions propagate', () => {
  const resolver = createResolver({
    value: {
      validate(input) {
        input.x = 999;
        return true;
      },
    },
  });
  const input = { x: 1 },
    result = resolver.resolve([{ name: 'a', values: { value: input } }]);
  assert.equal(result.values.value.x, 1);
  assert.equal(input.x, 1);
  assert.throws(
    () =>
      createResolver({
        x: {
          validate() {
            throw new Error('validator');
          },
        },
      }).resolve([{ name: 'a', values: { x: 1 } }]),
    /validator/,
  );
  assert.throws(
    () => createResolver({ x: { validate: () => 1 } }).resolve([{ name: 'a', values: { x: 1 } }]),
    TypeError,
  );
});
test('defaults, input and diagnostics cannot mutate subsequent resolutions', () => {
  const value = { x: [1] },
    resolver = createResolver({ value: { validate: () => true, default: value } });
  value.x.push(2);
  const first = resolver.resolve([]);
  first.values.value.x.push(999);
  first.diagnostics.value.x.push(88);
  assert.deepEqual(resolver.resolve([]).values.value, { x: [1] });
});
test('changes compare nested JSON by structure not object key insertion order and never expose values', () => {
  const resolver = createResolver({ a: { validate: () => true }, b: { validate: () => true } });
  const before = resolver.resolve([{ name: 'a', values: { a: { x: 1, y: [2] } } }]);
  const same = resolver.resolve([{ name: 'b', values: { a: { y: [2], x: 1 } } }]);
  assert.deepEqual(changes(before, same), []);
  const after = resolver.resolve([{ name: 'c', values: { a: null, b: 'private' } }]);
  assert.deepEqual(changes(before, after), [
    { key: 'a', kind: 'changed' },
    { key: 'b', kind: 'added' },
  ]);
  assert.deepEqual(changes(after, resolver.resolve([])), [
    { key: 'a', kind: 'removed' },
    { key: 'b', kind: 'removed' },
  ]);
});
test('invalid JSON, cycles and property accessors are rejected without invoking getters', () => {
  const resolver = createResolver({ x: { validate: () => true } });
  const cycle = {};
  cycle.self = cycle;
  for (const x of [undefined, NaN, Infinity, new Date(), new Array(1), cycle, () => {}, 1n])
    assert.throws(() => resolver.resolve([{ name: 'a', values: { x } }]));
  let called = false;
  const values = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      called = true;
      return 1;
    },
  });
  assert.throws(() => resolver.resolve([{ name: 'a', values }]), TypeError);
  assert.equal(called, false);
});
test('own-key handling and quotas are deterministic and errors do not return partial successes', () => {
  const definition = Object.fromEntries([['__proto__', { validate: number }]]);
  const result = createResolver(definition).resolve([
    { name: 'a', values: JSON.parse('{"__proto__":1}') },
  ]);
  assert.equal(result.values.__proto__, 1);
  assert.equal({}.polluted, undefined);
  assert.throws(
    () =>
      createResolver({ x: { validate: () => true } }, { maxNodes: 1 }).resolve([
        { name: 'a', values: { x: [1] } },
      ]),
    RangeError,
  );
  assert.throws(
    () =>
      createResolver({}).resolve([
        { name: 'a', values: {} },
        { name: 'a', values: {} },
      ]),
    TypeError,
  );
  assert.throws(() => createResolver({ x: { validate: number, default: 'bad' } }), TypeError);
  assert.throws(() => createResolver({ x: { validate: number, typo: true } }), TypeError);
  assert.throws(() => changes({ valid: false }, { valid: true }), TypeError);
});
test('CommonJS resolves independent consumer configuration layers', () => {
  const api = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.equal(api.createResolver({ x: { validate: number, default: 1 } }).resolve([]).values.x, 1);
});
