import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { failure } from './common.mjs';

// One contract owned by the Gateway. Never maintain a permissive parallel schema.
const schema = JSON.parse(readFileSync(new URL('../../WeAgent-Backend/contracts/protocol.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: false });
formats(ajv);
ajv.addSchema(schema);
const validators = new Map();
export function validate(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }));
  const check = validators.get(name);
  if (!check(value)) throw failure('PROTOCOL_UNSUPPORTED', `${name}: ${check.errors[0].instancePath} ${check.errors[0].keyword}`);
  return value;
}
export const frame = (type, data) => ({ version: 'weagent/1', type, data });
