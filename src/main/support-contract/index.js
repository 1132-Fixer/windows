/**
 * The support contract that this app sends to the support service.
 *
 * `feedback.v1.schema.json` and `validate.js` are exact copies from
 * 1132-Fixer/support-reporting (`contract/`). Never edit them here: change
 * them in that repository, copy them again, and update `pin.json`.
 * `tools/support-contract-smoke.js` fails when a copy differs from its pin.
 */
'use strict';

const schema = require('./feedback.v1.schema.json');
const pin = require('./pin.json');
const { validate } = require('./validate');

module.exports = {
  PRODUCT: 'windows',
  pin,
  schema,
  validate: (value) => validate(schema, value),
};
