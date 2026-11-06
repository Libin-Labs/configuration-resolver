export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ConfigField {
  validate: (value: Json) => boolean;
  default?: Json;
  required?: boolean;
  sensitive?: boolean;
}
export interface ConfigLayer {
  name: string;
  values: Readonly<Record<string, Json>>;
}
export interface ResolveOptions {
  unknown?: 'reject' | 'ignore';
  maxLayers?: number;
  maxNodes?: number;
}
export interface ConfigIssue {
  key: string;
  code: 'missing' | 'unknown' | 'invalid';
  layer: string | null;
}
export interface ResolvedConfig {
  valid: boolean;
  values: Record<string, Json>;
  provenance: Record<string, string>;
  diagnostics: Record<string, Json>;
  issues: ConfigIssue[];
}
export interface ConfigChange {
  key: string;
  kind: 'added' | 'removed' | 'changed';
}
export interface ConfigResolver {
  resolve(layers: readonly ConfigLayer[]): ResolvedConfig;
}
function entries(input: unknown): [string, unknown][] {
  if (
    !input ||
    typeof input !== 'object' ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    throw new TypeError('Expected a plain object.');
  return Reflect.ownKeys(input).map((key) => {
    if (typeof key !== 'string' || key.length > 1024)
      throw new TypeError('Expected bounded string keys.');
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!descriptor.enumerable || !('value' in descriptor))
      throw new TypeError('Expected enumerable data properties.');
    return [key, descriptor.value];
  });
}
function clone(
  input: unknown,
  budget: { left: number },
  ancestors = new Set<object>(),
  depth = 0,
): Json {
  if (budget.left-- === 0 || depth > 64)
    throw new RangeError('Configuration exceeds node/depth limit.');
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    if (input.length > 65_536) throw new RangeError('String too long.');
    return input;
  }
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'object' || input === null)
    throw new TypeError('Expected finite JSON data.');
  if (ancestors.has(input)) throw new TypeError('Cyclic configuration.');
  ancestors.add(input);
  let result: Json;
  if (Array.isArray(input)) {
    if (input.length > budget.left) throw new RangeError('Configuration exceeds node limit.');
    if (Reflect.ownKeys(input).length !== input.length + 1)
      throw new TypeError('Arrays must be dense without extra properties.');
    result = Array.from({ length: input.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor))
        throw new TypeError('Array items must be data properties.');
      return clone(descriptor.value, budget, ancestors, depth + 1);
    });
  } else
    result = Object.fromEntries(
      entries(input).map(([key, value]) => [key, clone(value, budget, ancestors, depth + 1)]),
    );
  ancestors.delete(input);
  return result;
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('Limits must be positive safe integers.');
  return value;
}
export function createResolver(
  definition: Readonly<Record<string, ConfigField>>,
  options: ResolveOptions = {},
): ConfigResolver {
  const maxNodes = positive(options.maxNodes ?? 100_000),
    maxLayers = positive(options.maxLayers ?? 100);
  const unknown = options.unknown ?? 'reject';
  if (unknown !== 'reject' && unknown !== 'ignore') throw new TypeError('Unknown key policy.');
  const budget = { left: maxNodes };
  const fields = new Map(
    entries(definition).map(([key, raw]) => {
      if (budget.left-- === 0) throw new RangeError('Definition exceeds maxNodes.');
      const field = Object.fromEntries(entries(raw));
      if (
        Object.keys(field).some(
          (key) => !['validate', 'default', 'required', 'sensitive'].includes(key),
        )
      )
        throw new TypeError('Unknown field definition option.');
      if (typeof field.validate !== 'function')
        throw new TypeError('Each field needs a validator.');
      for (const flag of [field.required, field.sensitive])
        if (flag !== undefined && typeof flag !== 'boolean')
          throw new TypeError('Flags must be booleans.');
      const validator = field.validate as (value: Json) => boolean;
      const saved: ConfigField = {
        validate: validator,
        required: field.required === true,
        sensitive: field.sensitive === true,
      };
      if (Object.hasOwn(field, 'default')) {
        const value = clone(field.default, budget);
        const valid = validator(clone(value, { left: maxNodes }));
        if (typeof valid !== 'boolean')
          throw new TypeError('Validators must return booleans synchronously.');
        if (!valid) throw new TypeError(`Invalid default: ${key}`);
        saved.default = value;
      }
      return [key, saved];
    }),
  );
  return {
    resolve(layers) {
      if (!Array.isArray(layers) || layers.length > maxLayers)
        throw new RangeError('Layer capacity exceeded.');
      const remaining = { left: maxNodes },
        names = new Set<string>();
      const chosen = new Map<string, { value: Json; layer: string }>(),
        issues: ConfigIssue[] = [];
      for (const layer of layers) {
        if (
          typeof layer.name !== 'string' ||
          !layer.name ||
          layer.name === '$default' ||
          layer.name.length > 256 ||
          names.has(layer.name)
        )
          throw new TypeError('Layer names must be nonempty, unique and not $default.');
        names.add(layer.name);
        for (const [key, raw] of entries(layer.values)) {
          const value = clone(raw, remaining);
          if (!fields.has(key)) {
            if (unknown === 'reject') issues.push({ key, code: 'unknown', layer: layer.name });
          } else chosen.set(key, { value, layer: layer.name });
        }
      }
      const values: [string, Json][] = [],
        provenance: [string, string][] = [],
        diagnostics: [string, Json][] = [];
      for (const [key, field] of fields) {
        let selection = chosen.get(key);
        if (!selection && Object.hasOwn(field, 'default'))
          selection = { value: clone(field.default, remaining), layer: '$default' };
        if (!selection) {
          if (field.required) issues.push({ key, code: 'missing', layer: null });
          continue;
        }
        const valid = field.validate(clone(selection.value, { left: maxNodes }));
        if (typeof valid !== 'boolean')
          throw new TypeError('Validators must return booleans synchronously.');
        if (!valid) {
          issues.push({ key, code: 'invalid', layer: selection.layer });
          continue;
        }
        values.push([key, selection.value]);
        provenance.push([key, selection.layer]);
        diagnostics.push([
          key,
          field.sensitive ? '[REDACTED]' : clone(selection.value, { left: maxNodes }),
        ]);
      }
      return {
        valid: issues.length === 0,
        values: Object.fromEntries(values),
        provenance: Object.fromEntries(provenance),
        diagnostics: Object.fromEntries(diagnostics),
        issues,
      };
    },
  };
}
function equal(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left),
    b = Object.keys(right);
  if (a.length !== b.length) return false;
  return a.every(
    (key) =>
      Object.hasOwn(right, key) &&
      equal(
        Array.isArray(left) ? left[Number(key)]! : left[key]!,
        Array.isArray(right) ? right[Number(key)]! : right[key]!,
      ),
  );
}
export function changes(before: ResolvedConfig, after: ResolvedConfig): ConfigChange[] {
  if (!before.valid || !after.valid)
    throw new TypeError('Reload comparisons require valid resolved configurations.');
  return [...new Set([...Object.keys(before.values), ...Object.keys(after.values)])]
    .sort()
    .flatMap((key): ConfigChange[] => {
      if (!Object.hasOwn(before.values, key)) return [{ key, kind: 'added' }];
      if (!Object.hasOwn(after.values, key)) return [{ key, kind: 'removed' }];
      return equal(before.values[key]!, after.values[key]!) ? [] : [{ key, kind: 'changed' }];
    });
}
