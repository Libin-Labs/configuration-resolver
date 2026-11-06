# @lp-labs/configuration-resolver

Resolve named JSON configuration layers with explicit precedence, validation, provenance,
redacted diagnostics and structural reload comparisons. Independently authored; no runtime
or peer dependencies.

## Install

```bash
npm install @lp-labs/configuration-resolver
```

ES2022 ESM/CommonJS and TypeScript declarations. CommonJS:
`const { createResolver, changes } = require('@lp-labs/configuration-resolver')`.

## Quickstart

```js
import { createResolver, changes } from '@lp-labs/configuration-resolver';

const resolver = createResolver({
  port: { validate: (value) => Number.isSafeInteger(value) && value > 0, default: 8080 },
  token: { validate: (value) => typeof value === 'string', sensitive: true },
});
const before = resolver.resolve([]);
const after = resolver.resolve([
  { name: 'application', values: { port: 9000, token: 'example-only' } },
]);
if (!after.valid || after.provenance.port !== 'application')
  throw new Error('Invalid configuration');
if (after.diagnostics.token !== '[REDACTED]') throw new Error('Missing redaction');
if (changes(before, after).length !== 2) throw new Error('Reload differences missing');
```

## Definitions and options

`createResolver(definition: Record<string, ConfigField>, options?: ResolveOptions): ConfigResolver`

Each field has:

- `validate(value: Json): boolean`: required trusted synchronous validator.
- `default?: Json`: validated and copied at construction.
- `required?: boolean`: absent-without-default produces a missing issue.
- `sensitive?: boolean`: redacts the field's complete diagnostic value.

`Json` supports null, booleans, finite numbers, strings, dense arrays and plain data records.
Functions, undefined, bigint, dates, accessors, symbols, cycles, sparse arrays, extra array
properties and nonenumerable properties are rejected. Shared noncyclic references are allowed
and copied independently. Object keys such as `__proto__` are treated as own data keys.

Options:

| Option      | Default    | Contract                                                                                           |
| ----------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `unknown`   | `'reject'` | `'reject'` adds issues for unknown keys; `'ignore'` omits them.                                    |
| `maxLayers` | `100`      | Positive safe integer layer cap.                                                                   |
| `maxNodes`  | `100000`   | Positive safe integer JSON node budget per resolution; also bounds definition/default preparation. |

Fixed limits: nesting depth 64, strings 65536 UTF-16 units, keys 1024 units,
layer names 256 units. Definition objects permit only documented field options.

## Layering and output

`resolver.resolve(layers: readonly ConfigLayer[]): ResolvedConfig`

Each layer is `{ name, values }`; names must be nonempty and unique.
`'$default'` is reserved for default provenance.
Later layers win by **top-level replacement**, not recursive merge.
Defaults apply only if no layer supplied the field. An invalid winning value produces an issue,
not fallback to an earlier layer/default.

All supplied values, including unknown/overridden ones, must be valid bounded JSON.
Only the winning value is field-validated: an earlier type-invalid but valid-JSON value can be
overridden. Unknown-key issues in reject mode remain even when later layers also contain that key.

The result contains:

- `valid`: true only when no issues exist.
- `values`: detached successfully validated values; invalid/missing fields omitted.
- `provenance`: winning layer name or `'$default'` for each successful value.
- `diagnostics`: separately cloned values with sensitive fields replaced by `'[REDACTED]'`.
- `issues`: `{ key, code: 'missing' | 'unknown' | 'invalid', layer: string | null }`.

**Values include real secrets.** Log diagnostics/issues rather than values. Keys and layer names
are not redacted, so do not encode secrets in names.
Validators receive independent clones; their mutation cannot change returned configuration.
Thrown validator errors propagate; nonboolean results throw `TypeError`.

## Customization and reload comparisons

Implement domain validation in callbacks and provide already-parsed layers from files, environment
or remote sources. Parsing/I/O and string conversion remain explicit application responsibilities.

```js
import { createResolver, changes } from '@lp-labs/configuration-resolver';

const resolver = createResolver(
  {
    theme: { validate: (value) => value === 'light' || value === 'dark', default: 'light' },
  },
  { unknown: 'ignore' },
);
const previous = resolver.resolve([]);
const next = resolver.resolve([{ name: 'user', values: { theme: 'dark', unrelated: true } }]);
if (!next.valid) throw new Error('Reject reload');
const diff = changes(previous, next);
if (diff[0].key !== 'theme' || diff[0].kind !== 'changed') throw new Error('Wrong reload report');
```

`changes(before, after): ConfigChange[]` requires valid reports returned by this package.
It returns lexically sorted `{ key, kind: 'added' | 'removed' | 'changed' }` entries without
values. Structural equality ignores object key order, preserves array ordering, and treats
equal values from different provenance layers as unchanged.
Do not pass forged/cyclic reports. This helper does not apply or roll back configuration;
validate the result before updating application state.

## Performance, errors and scope

Resolution is linear in visited/copied JSON nodes plus validator work and definition/layer scans.
Structural comparison visits compared JSON values and sorts top-level keys.
Memory is proportional to prepared defaults and supplied/output data.
Cloning budgets do not bound arbitrary validator work or prevent reflection from allocating
temporary key arrays; this is not a hardened memory or execution sandbox.

Invalid JSON/definitions/names/policies throw `TypeError`; exceeded capacities/depth/string limits
throw `RangeError`. Expected validation problems are explicit `issues`; callers must check `valid`.
No file loader, dotenv/YAML parser, recursive merge, asynchronous validators, schema inference,
subscriptions, remote synchronization or secret vault is included.

Exported types: `Json`, `ConfigField`, `ConfigLayer`, `ResolveOptions`, `ConfigIssue`,
`ResolvedConfig`, `ConfigChange`, `ConfigResolver`.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
