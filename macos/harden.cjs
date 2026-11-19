const path=require('node:path');
module.exports=async function(context) {
  const {flipFuses,FuseVersion,FuseV1Options}=await import('@electron/fuses');
  const platform=context.electronPlatformName;
  if(!['win32','linux','darwin'].includes(platform))throw new Error(`Unsupported package platform: ${platform}`);
  const executable=platform==='darwin'?`${context.packager.appInfo.productFilename}.app`:platform==='win32'?'PIMOrbit.exe':'PIMOrbit';
  await flipFuses(path.join(context.appOutDir,executable),{
    version:FuseVersion.V1,
    [FuseV1Options.RunAsNode]:false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
    [FuseV1Options.EnableNodeCliInspectArguments]:false,
    [FuseV1Options.OnlyLoadAppFromAsar]:true,
    // Electron currently supports embedded ASAR validation on Windows/macOS only.
    ...(['win32','darwin'].includes(platform)?{[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true}:{})
  });
};

