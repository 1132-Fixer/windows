'use strict';

const path = require('path');

// Recognition is deliberately narrower than PowerShell's command parser.
// Only this app's generated argument form proves ownership. Ambiguous or
// hand-edited shortcuts remain untouched.
function shortcutMatchesCurrentApp(info, expectedScript, expectedPowerShell) {
  if (!info || ![info.target, info.arguments, expectedScript, expectedPowerShell]
    .every(value => typeof value === 'string' && value.length > 0)) return false;
  const samePath = (left, right) => path.win32.isAbsolute(left) && path.win32.isAbsolute(right) &&
    path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
  if (!samePath(info.target, expectedPowerShell)) return false;
  const match = /^-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "([^"\r\n]+)"$/i.exec(info.arguments);
  return !!match && samePath(match[1], expectedScript);
}

module.exports = { shortcutMatchesCurrentApp };
