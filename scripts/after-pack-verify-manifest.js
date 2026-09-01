'use strict';

const fs = require('fs');
const path = require('path');
const { assertRequireAdministrator } = require('./verify-exe-manifest');
const { stampRequireAdministrator } = require('./stamp-exe-manifest');

async function stampRequireAdmin(file, extra = {}) {
  let how = 'app-builder-lib';
  try {
    const { editWindowsResources } = require('app-builder-lib/out/util/resEdit');
    await editWindowsResources(Object.assign({
      file,
      requestedExecutionLevel: 'requireAdministrator'
    }, extra));
  } catch (err) {
    how = await stampRequireAdministrator(file);
    if (!how) throw err;
  }
  const info = assertRequireAdministrator(file);
  return { how, info };
}

function removeElevateHelper(appOutDir) {
  const p = path.join(appOutDir, 'resources', 'elevate.exe');
  try {
    fs.unlinkSync(p);
    console.log(`[afterPack] removed unsigned ${p}`);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }
}

// electron-builder copies elevate.exe AFTER afterPack when perMachine is true
// (packElevateHelper false is ignored). Patch the copier so the 7z payload
// never includes it. First-party code does not call that helper.
function installElevateStrip() {
  let CopyElevateHelper;
  try {
    ({ CopyElevateHelper } = require('app-builder-lib/out/targets/nsis/nsisUtil'));
  } catch (_) {
    return false;
  }
  if (!CopyElevateHelper || CopyElevateHelper.prototype.copy.__1132_stripped) return true;
  const orig = CopyElevateHelper.prototype.copy;
  CopyElevateHelper.prototype.copy = function copyAndStrip(appOutDir, target) {
    return Promise.resolve(orig.call(this, appOutDir, target)).then(() => {
      removeElevateHelper(appOutDir);
    });
  };
  CopyElevateHelper.prototype.copy.__1132_stripped = true;
  return true;
}

// Custom installer.nsi makes electron-builder skip uninstaller generation
// (UNINSTALLER_OUT_FILE unset → makensis File usage error). Keep the stock
// template so the uninstaller is produced, then stamp it requireAdministrator
// before it is embedded. Do not RequestExecutionLevel admin on BUILD_UNINSTALLER:
// that stub must run asInvoker during the pack.
function installUninstallerStamp(packager) {
  if (!packager || typeof packager.signIf !== 'function' || packager.signIf.__1132_stamp) return;
  const orig = packager.signIf.bind(packager);
  packager.signIf = async function stampThenSign(file) {
    const name = path.basename(String(file || ''));
    if (name.endsWith('__uninstaller.exe')) {
      const { how, info } = await stampRequireAdmin(file);
      console.log(`[afterPack] stamped uninstaller via ${how}; requestedExecutionLevel=${info.requestedExecutionLevel} size=${info.size}`);
    }
    return orig(file);
  };
  packager.signIf.__1132_stamp = true;
}

exports.default = async function afterPack(context) {
  const packager = context.packager;
  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exe = path.join(context.appOutDir, exeName);
  const appInfo = packager.appInfo;

  // afterPack runs BEFORE electron-builder's signAndEditResources, so the
  // unpacked exe is still Electron's default asInvoker. Stamp here so the
  // portable/NSIS payload cannot ship without requireAdministrator, even
  // when there is no signing certificate.
  const { how, info } = await stampRequireAdmin(exe, {
    versionStrings: {
      FileDescription: appInfo.productName,
      ProductName: appInfo.productName,
      LegalCopyright: appInfo.copyright || ''
    },
    fileVersion: appInfo.shortVersion || appInfo.version,
    productVersion: appInfo.shortVersionWindows || appInfo.version
  });
  console.log(`[afterPack] stamped ${exeName} via ${how}; requestedExecutionLevel=${info.requestedExecutionLevel} size=${info.size}`);

  removeElevateHelper(context.appOutDir);
  installElevateStrip();
  installUninstallerStamp(packager);
};
