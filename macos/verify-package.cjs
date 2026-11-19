const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync,spawn}=require('node:child_process');
const asar=require('@electron/asar');
const root=path.resolve(process.argv[2]);const app=fs.readdirSync(root).find(n=>n.endsWith('.app'));assert(app,'Missing application bundle');
let bundle=path.join(root,app);let packed=path.join(bundle,'Contents/Resources/app.asar');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
(async()=>{
 const os=require('node:os');const work=fs.mkdtempSync(path.join(os.tmpdir(),'orbita-install-'));const mount=path.join(work,'volume');fs.mkdirSync(mount);
 const dmg=fs.readdirSync('dist').find(n=>n.endsWith(`mac-${process.arch}.dmg`));assert(dmg,'Missing native DMG');
 const sourceHash=sha(fs.readFileSync(packed));
 execFileSync('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,path.resolve('dist',dmg)],{stdio:'inherit'});
 try{assert.equal(fs.readlinkSync(path.join(mount,'Applications')),'/Applications');execFileSync('ditto',[path.join(mount,app),path.join(work,app)]);}finally{execFileSync('hdiutil',['detach',mount],{stdio:'inherit'});}
 bundle=path.join(work,app);packed=path.join(bundle,'Contents/Resources/app.asar');assert.equal(sha(fs.readFileSync(packed)),sourceHash,'DMG contains different application');
 execFileSync('codesign',['--verify','--deep','--strict','--verbose=2',bundle],{stdio:'inherit'});
 const info=execFileSync('plutil',['-convert','json','-o','-',path.join(bundle,'Contents/Info.plist')],{encoding:'utf8'});const plist=JSON.parse(info);assert.equal(plist.CFBundleIdentifier,'io.pim.orbit');assert.equal(plist.CFBundleShortVersionString,'1.8.8');assert(plist.ElectronAsarIntegrity,'Missing ASAR integrity');
 assert.equal(plist.CFBundleDisplayName,'Орбита');const exe=path.join(bundle,'Contents/MacOS',plist.CFBundleExecutable);
 assert.equal(execFileSync('lipo',['-archs',exe],{encoding:'utf8'}).trim(),process.arch==='arm64'?'arm64':'x86_64');
 const entries=asar.listPackage(packed).map(n=>n.replace(/^\//,'')).filter(n=>!asar.statFile(packed,n).files).sort();
 assert.deepEqual(entries,['assets/PIMOrbit-OrbitalKnot.ico','assets/PIMOrbit-OrbitalKnot.png','assets/index.html','assets/Инструкция-mac.txt','assets/Инструкция.txt','assets/Лицензии.txt','history.cjs','main.cjs','package.json','policy.cjs','preload.cjs','settings.cjs'].sort());
 assert.equal(sha(asar.extractFile(packed,'assets/index.html')),fs.readFileSync('ui.sha256','utf8').trim());
 const {getCurrentFuseWire,FuseV1Options:O,FuseState:S}=await import('@electron/fuses');const fuses=await getCurrentFuseWire(bundle);
 for(const name of ['RunAsNode','EnableNodeOptionsEnvironmentVariable','EnableNodeCliInspectArguments'])assert.equal(fuses[O[name]],S.DISABLE,name);
 for(const name of ['OnlyLoadAppFromAsar','EnableEmbeddedAsarIntegrityValidation'])assert.equal(fuses[O[name]],S.ENABLE,name);
 const log=fs.openSync('native-boot.log','w');const child=spawn(exe,[],{env:{...process.env,HOME:path.resolve('qa-native-home')},stdio:['ignore',log,log]});let failure;child.on('error',e=>failure=e);await new Promise(r=>setTimeout(r,12000));assert(!failure,String(failure));assert.equal(child.exitCode,null,'Packaged application exited early');
 // Inspect the actual native window; a living error dialog is not a successful boot.
 const swift=`import CoreGraphics\nlet pid = ${child.pid}\nlet ws = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as! [[String:Any]]\nlet ok = ws.contains { ($0[kCGWindowOwnerPID as String] as? Int) == pid && (($0[kCGWindowBounds as String] as? [String:Any])?["Width"] as? Double ?? 0) >= 800 }\nif !ok { fatalError("No main application window") }\n`;
 fs.writeFileSync('native-window.swift',swift);try{execFileSync('swift',['native-window.swift'],{stdio:'inherit'});}finally{child.kill('SIGTERM');}
 fs.writeFileSync('package-check.json',JSON.stringify({passed:true,arch:process.arch,os:os.release(),minimumMacOS:plist.LSMinimumSystemVersion,uiSHA256:fs.readFileSync('ui.sha256','utf8').trim(),signature:'ad-hoc; not notarized',dmgInstall:true,nativeMainWindow:true,asarWhitelist:true,fuses:true},null,2));
 console.log('PASS native package, architecture, signing, fuses and main window');
})().catch(e=>{console.error(e);process.exitCode=1;});
