'use strict';

const path = require('path');
const { assertRequireAdministrator } = require('./verify-exe-manifest');

exports.default = async function afterPack(context) {
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exe = path.join(context.appOutDir, exeName);
  const info = assertRequireAdministrator(exe);
  console.log(`[afterPack] ${exeName} requestedExecutionLevel=${info.requestedExecutionLevel} size=${info.size}`);
};
