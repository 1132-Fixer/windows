'use strict';

/**
 * Small JSON Schema checker for the support contract. No dependencies.
 *
 * It supports only the keywords that the contract schema uses. A schema that
 * contains any other keyword is refused, so a rule can never be skipped
 * silently. Products copy this file together with the schema.
 */

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const KEYWORDS = new Set(['type', 'required', 'properties', 'additionalProperties', 'enum', 'const',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'allOf', 'if', 'then', 'else', 'not',
  // Not standard JSON Schema: the largest size of a string as UTF-8 bytes.
  // Other schema tools ignore it; this checker applies it.
  'x-maxUtf8Bytes']);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

// JSON Schema counts Unicode code points. A string never has more code points
// than UTF-16 units, so the common cases need no full count.
function hasAtLeast(text, count) {
  if (text.length < count) return false;
  let seen = 0;
  for (const _ of text) { seen += 1; if (seen >= count) return true; }
  return seen >= count;
}

function hasMoreThan(text, limit) {
  return text.length > limit && hasAtLeast(text, limit + 1);
}

const TYPES = new Set(['object', 'string', 'integer', 'number', 'boolean']);
const isPrimitive = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

// Walks the whole schema once, before any value is checked. Every subschema is
// visited, also one that the value under test would never reach, and every
// keyword must have a form that this checker implements.
function assertSchema(schema, where) {
  const refuse = (reason) => { throw new Error(`unsupported schema: ${reason} at ${where || '#'}`); };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) refuse('a schema must be an object');
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !KEYWORDS.has(key)) throw new Error(`unsupported schema keyword "${key}" at ${where || '#'}`);
  }
  if (schema.type !== undefined && !TYPES.has(schema.type)) refuse('type must be one supported type name');
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((name) => typeof name === 'string'))) refuse('required must be a list of names');
  if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.length && schema.enum.every(isPrimitive))) refuse('enum must be a list of simple values');
  if (schema.const !== undefined && !isPrimitive(schema.const)) refuse('const must be a simple value');
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) refuse('additionalProperties must be false');
  for (const key of ['minLength', 'maxLength', 'x-maxUtf8Bytes']) if (schema[key] !== undefined && !isCount(schema[key])) refuse(`${key} must be a whole number`);
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && !Number.isFinite(schema[key])) refuse(`${key} must be a number`);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') refuse('pattern must be text');
    try { new RegExp(schema.pattern, 'u'); } catch (_) { refuse('pattern is not a valid expression'); }
  }
  if (schema.properties !== undefined) {
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) refuse('properties must be an object');
    for (const name of Object.keys(schema.properties)) assertSchema(schema.properties[name], `${where}/properties/${name}`);
  }
  if (schema.allOf !== undefined) {
    if (!Array.isArray(schema.allOf) || !schema.allOf.length) refuse('allOf must be a list');
    schema.allOf.forEach((part, index) => assertSchema(part, `${where}/allOf/${index}`));
  }
  for (const key of ['if', 'then', 'else', 'not']) if (schema[key] !== undefined) assertSchema(schema[key], `${where}/${key}`);
  if ((schema.then !== undefined || schema.else !== undefined) && schema.if === undefined) refuse('then and else need if');
}

function check(schema, value, path, errors) {
  const fail = (message) => { errors.push({ path, message }); };
  const actual = typeOf(value);

  if (schema.type !== undefined) {
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!ok) { fail(`must be ${schema.type}`); return; }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) fail('must be one of the listed values');
  if (schema.const !== undefined && value !== schema.const) fail('must be the fixed value');

  if (actual === 'string') {
    if (schema.minLength !== undefined && !hasAtLeast(value, schema.minLength)) fail('is too short');
    if (schema.maxLength !== undefined && hasMoreThan(value, schema.maxLength)) fail('is too long');
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail('does not match the required form');
    // One UTF-16 unit is at most three UTF-8 bytes, so short strings need no encoding.
    if (schema['x-maxUtf8Bytes'] !== undefined && value.length * 3 > schema['x-maxUtf8Bytes'] &&
        new TextEncoder().encode(value).length > schema['x-maxUtf8Bytes']) fail('is too large');
  }
  if (actual === 'integer' || actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('is too small');
    if (schema.maximum !== undefined && value > schema.maximum) fail('is too large');
  }
  if (actual === 'object') {
    const properties = schema.properties || {};
    for (const name of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) errors.push({ path: `${path}/${name}`, message: 'is required' });
    }
    for (const name of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) check(properties[name], value[name], `${path}/${name}`, errors);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}/${name}`, message: 'is not part of the contract' });
    }
  }

  for (const part of schema.allOf || []) check(part, value, path, errors);
  if (schema.not !== undefined && passes(schema.not, value, path)) fail('is not permitted here');
  if (schema.if !== undefined) {
    const branch = passes(schema.if, value, path) ? schema.then : schema.else;
    if (branch !== undefined) check(branch, value, path, errors);
  }
}

function passes(schema, value, path) {
  const errors = [];
  check(schema, value, path, errors);
  return errors.length === 0;
}

/** Returns { valid, errors: [{ path, message }] }. Throws only for a schema it cannot check. */
function validate(schema, value) {
  assertSchema(schema, '');
  const errors = [];
  check(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}

module.exports = { validate };
