'use strict';

const path = require('path');
const { assertRequireAdministrator } = require('./verify-exe-manifest');
const { stampRequireAdministrator } = require('./stamp-exe-manifest');

exports.default = async function afterPack(context) {
  const packager = context.packager;
  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exe = path.join(context.appOutDir, exeName);
  const appInfo = packager.appInfo;

  // afterPack runs BEFORE electron-builder's signAndEditResources, so the
  // unpacked exe is still Electron's default asInvoker. Stamp here so the
  // portable/NSIS payload cannot ship without requireAdministrator, even
  // when there is no signing certificate.
  let how = 'app-builder-lib';
  try {
    const { editWindowsResources } = require('app-builder-lib/out/util/resEdit');
    await editWindowsResources({
      file: exe,
      versionStrings: {
        FileDescription: appInfo.productName,
        ProductName: appInfo.productName,
        LegalCopyright: appInfo.copyright || ''
      },
      fileVersion: appInfo.shortVersion || appInfo.version,
      productVersion: appInfo.shortVersionWindows || appInfo.version,
      requestedExecutionLevel: 'requireAdministrator'
    });
  } catch (err) {
    how = await stampRequireAdministrator(exe);
    if (!how) throw err;
  }

  const info = assertRequireAdministrator(exe);
  console.log(`[afterPack] stamped ${exeName} via ${how}; requestedExecutionLevel=${info.requestedExecutionLevel} size=${info.size}`);
};
