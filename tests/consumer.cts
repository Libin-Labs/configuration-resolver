import { createResolver } from '@lp-labs/configuration-resolver';
const valid: boolean = createResolver({}).resolve([]).valid;
void valid;
