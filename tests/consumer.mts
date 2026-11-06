import {
  createResolver,
  changes,
  type ResolvedConfig,
  type Json,
} from '@lp-labs/configuration-resolver';
const resolver = createResolver({
  port: { validate: (value: Json) => typeof value === 'number', default: 80 },
});
const report: ResolvedConfig = resolver.resolve([]);
const diff = changes(report, report);
// @ts-expect-error layers accept JSON not functions.
resolver.resolve([{ name: 'x', values: { port: () => 1 } }]);
void diff;
