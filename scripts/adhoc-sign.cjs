// electron-builder afterPack hook: ad-hoc sign the packed .app.
//
// With no Developer ID certificate in the keychain, electron-builder skips
// signing entirely, leaving only the Electron binary's linker signature — an
// invalid seal for the bundle as a whole ("Sealed Resources=none"). Gatekeeper
// reports a quarantined app with an invalid signature as "damaged and can't be
// opened", with no way for the user to bypass it. A valid ad-hoc signature
// (codesign -s -) downgrades that to the "unverified developer" block, which
// users can clear via System Settings → Privacy & Security → Open Anyway.
const { execFileSync } = require('child_process')
const path = require('path')

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  // Refuse to ship a bundle whose seal still doesn't verify — that's exactly
  // the state that produces the "damaged" dialog.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed   ${appPath}`)
}
