import {samples} from './source.mjs';
const result = await samples();
for (const [source, value] of Object.entries(result)) {
  console.log(JSON.stringify({source, valid: !!value.snapshot, sourceAt: value.snapshot?.sourceAt,
    positions: value.snapshot?.positions.length, error: value.error}));
}
if (Object.values(result).some(value => !value.snapshot)) process.exitCode = 1;
