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

// The generated NSIS uninstaller (__uninstaller.exe) must NOT be edited after
// makensis writes it. NSIS computes the executable's CRC at build time and
// verifies it on every start; re-stamping the manifest with rcedit changes
// the resource section, so the uninstaller fails with "Installer integrity
// check has failed" (exit code 2). Releases 6.3.1-6.3.3 shipped such an
// uninstaller: Add/Remove could not uninstall them, and the next installer's
// "uninstall old version" step stopped at "Failed to uninstall old
// application files ... : 2". The uninstaller does not need the manifest:
// electron-builder builds it `RequestExecutionLevel user` on purpose and it
// elevates itself through UAC when it runs per-machine. Guard against the
// mistake coming back: refuse to let anything under afterPack touch it.
function guardUninstaller(packager) {
  if (!packager || typeof packager.signIf !== 'function' || packager.signIf.__1132_guard) return;
  const orig = packager.signIf.bind(packager);
  packager.signIf = async function signUntouched(file) {
    const name = path.basename(String(file || ''));
    if (name.endsWith('__uninstaller.exe')) {
      const before = fs.statSync(file);
      const result = await orig(file);
      const after = fs.statSync(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        // Signing appends a signature block and is the only edit NSIS tolerates.
        console.log(`[afterPack] uninstaller signed (${before.size} -> ${after.size} bytes)`);
      } else {
        console.log(`[afterPack] uninstaller left untouched (${after.size} bytes) so its NSIS integrity check stays valid`);
      }
      return result;
    }
    return orig(file);
  };
  packager.signIf.__1132_guard = true;
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
  guardUninstaller(packager);
};
