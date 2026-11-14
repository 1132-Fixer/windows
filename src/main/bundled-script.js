'use strict';

// Builds the PowerShell text that runs a bundled script through stdin.
//
// Why: a PowerShell process that is started with a script file on its command
// line ("-File <path>") can be held by endpoint protection before the first
// line runs. On one affected computer the hold was 27 seconds each time
// (issue #266), which is most of this step's time limit. The same script text
// that arrives through stdin started in 0.3 seconds on that computer. Every
// other script in the app already travels through stdin.
//
// The script keeps its own param() block. The text is wrapped in one script
// block and called with named arguments, so parameter binding is the same as
// with -File. Values are single-quoted literals: PowerShell expands nothing
// inside them.

// Code points are written as numbers so that this file stays plain ASCII.
// PowerShell accepts four typographic quotation marks as a single-quote
// delimiter, in addition to the apostrophe.
const PS_SINGLE_QUOTE_CODES = new Set([0x27, 0x2018, 0x2019, 0x201A, 0x201B]);
const BYTE_ORDER_MARK = 0xFEFF;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// A line break or another control character can never be part of a valid
// argument here, and would let a value leave its line.
function isControlCode(code) {
  return code <= 0x1F || code === 0x7F || code === 0x85 || code === 0x2028 || code === 0x2029;
}

function psLiteral(value) {
  if (typeof value !== 'string') throw new TypeError('Script argument must be a string.');
  let out = "'";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (isControlCode(code)) throw new RangeError('Script argument contains a control character.');
    out += PS_SINGLE_QUOTE_CODES.has(code) ? value[i] + value[i] : value[i];
  }
  return out + "'";
}

function buildBundledScriptInvocation(source, parameters = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('Script source is empty.');
  const text = source.charCodeAt(0) === BYTE_ORDER_MARK ? source.slice(1) : source;
  const args = Object.keys(parameters).map((name) => {
    if (!PARAMETER_NAME.test(name)) throw new RangeError('Script parameter name is not valid.');
    return `-${name} ${psLiteral(parameters[name])}`;
  });
  // The script block starts and ends on its own line, so a comment on the
  // first or last line of the script cannot swallow a brace.
  return [
    'try {',
    '& {',
    text,
    `} ${args.join(' ')}`.trimEnd(),
    '} catch {',
    '  [Console]::Error.WriteLine([string]$_.Exception.Message)',
    '  exit 1',
    '}',
    ''
  ].join('\r\n');
}

module.exports = { buildBundledScriptInvocation, psLiteral };
