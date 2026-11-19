'use strict';
const {app,BrowserWindow,Menu,dialog,nativeTheme,protocol,session,screen,ipcMain,shell}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {APP_URL,isAppDocument,isLocalBlob,isAllowedResource,allowedPermission,safeExportName}=require('./policy.cjs');
const {createHistoryStore,validId}=require('./history.cjs');
const {createSettingsStore}=require('./settings.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'orbita',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setName('Орбита');
app.setPath('userData',path.join(app.getPath('appData'),'PIMOrbit'));
// Capture this before history initialization creates a directory for a new profile.
const legacyProfile=fs.existsSync(path.join(app.getPath('userData'),'Preferences'))||fs.existsSync(path.join(app.getPath('userData'),'history'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-http-cache');
if(process.platform==='win32')app.setAppUserModelId('io.pim.orbit');
let mainWindow;
let historyStore;
let settingsStore;
let historyFlushedForQuit=false;
let awaitingHistoryForQuit=false;
app.on('before-quit',event=>{
  if(historyFlushedForQuit||!historyStore)return;
  event.preventDefault();
  if(awaitingHistoryForQuit)return;
  awaitingHistoryForQuit=true;
  Promise.all([historyStore.flush(),settingsStore?.flush()]).finally(()=>{
    historyFlushedForQuit=true;
    app.quit();
  });
});
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
else {
  app.on('second-instance',()=>{
    if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}
  });
  app.whenReady().then(createWindow).catch(error=>{
    dialog.showErrorBox('Орбита','Не удалось открыть приложение.\n\n'+error.message);app.quit();
  });
}
app.on('window-all-closed',()=>app.quit());

async function createWindow() {
  Menu.setApplicationMenu(process.platform==='darwin'?Menu.buildFromTemplate([
    {label:'Орбита',submenu:[{role:'about',label:'Об Орбите'},{type:'separator'},{role:'hide',label:'Скрыть Орбиту'},{role:'hideOthers',label:'Скрыть остальные'},{role:'unhide',label:'Показать все'},{type:'separator'},{role:'quit',label:'Завершить Орбиту'}]},
    {label:'Правка',submenu:[{role:'undo',label:'Отменить'},{role:'redo',label:'Повторить'},{type:'separator'},{role:'cut',label:'Вырезать'},{role:'copy',label:'Копировать'},{role:'paste',label:'Вставить'},{role:'selectAll',label:'Выбрать всё'}]},
    {label:'Окно',submenu:[{role:'minimize',label:'Свернуть'},{role:'zoom',label:'Масштаб'},{role:'close',label:'Закрыть'}]}
  ]):null);
  nativeTheme.themeSource='dark';
  const html=fs.readFileSync(path.join(__dirname,'assets/index.html'));
  const csp=html.toString('utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  if(!csp?.includes("connect-src 'none'"))throw new Error('Повреждена политика локальной сборки. Переустановите приложение.');
  const privateSession=session.fromPartition('orbita-memory',{cache:false});
  privateSession.protocol.handle('orbita',request=>{
    if(!isAppDocument(request.url)||request.method!=='GET')return new Response('Not found',{status:404});
    return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  });
  privateSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!isAllowedResource(details.url)}));
  privateSession.setPermissionCheckHandler((contents,permission)=>allowedPermission(permission,contents?.getURL()));
  privateSession.setPermissionRequestHandler((contents,permission,callback)=>callback(allowedPermission(permission,contents?.getURL())));
  privateSession.setDevicePermissionHandler(()=>false);
  privateSession.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
  const work=screen.getPrimaryDisplay().workAreaSize;
  const shellIcon=path.join(__dirname.endsWith('.asar')?path.dirname(__dirname):path.join(__dirname,'assets'),'PIMOrbit-OrbitalKnot.ico');
  mainWindow=new BrowserWindow({
    title:'Орбита — локальная статистика',icon:process.platform==='win32'?shellIcon:path.join(__dirname,'assets/PIMOrbit-OrbitalKnot.png'),
    width:Math.min(1440,Math.floor(work.width*.94)),height:Math.min(960,Math.floor(work.height*.92)),
    minWidth:Math.min(880,work.width),minHeight:Math.min(640,work.height),
    backgroundColor:'#101617',show:false,autoHideMenuBar:true,
    webPreferences:{session:privateSession,preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,
      allowRunningInsecureContent:false,webviewTag:false,devTools:false,spellcheck:false,navigateOnDragDrop:false}
  });
  const window=mainWindow;
  window.webContents.on('will-prevent-unload',()=>{
    // The renderer can defer closing while it is still preparing an import before IPC.
    historyFlushedForQuit=false;
    awaitingHistoryForQuit=false;
  });
  const history=createHistoryStore(path.join(app.getPath('userData'),'history'));
  historyStore=history;
  const settings=createSettingsStore(app.getPath('userData'),{legacy:legacyProfile});
  settingsStore=settings;
  const authorize=event=>{
    if(awaitingHistoryForQuit||window.isDestroyed()||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==APP_URL)throw new Error('Доступ к локальной истории запрещён.');
  };
  ipcMain.handle('orbita-settings:load',async event=>{authorize(event);return settings.load();});
  ipcMain.handle('orbita-settings:save',async(event,config)=>{authorize(event);return settings.save(config);});
  for(const method of ['list','save','load'])ipcMain.handle(`orbita-history:${method}`,async(event,value)=>{
    authorize(event);return history[method](value);
  });
  ipcMain.handle('orbita-history:openFolder',async(event,id)=>{
    authorize(event);const folder=await history.folder(id);authorize(event);
    const error=await shell.openPath(folder);
    if(error)throw new Error('Не удалось открыть папку библиотеки в Проводнике.');
  });
  ipcMain.handle('orbita-history:remove',async(event,id)=>{
    authorize(event);validId(id);
    const answer=await dialog.showMessageBox(window,{type:'question',title:'Удалить из истории?',message:'Удалить эту выгрузку из локальной истории?',detail:'Исходные файлы вне программы останутся на компьютере.',buttons:['Отмена','Удалить'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response!==1)return false;
    authorize(event);return history.remove(id);
  });
  if(process.platform==='win32')window.setAppDetails({appId:'io.pim.orbit',appIconPath:shellIcon,appIconIndex:0,
    relaunchCommand:'"'+process.execPath+'"',relaunchDisplayName:'Орбита'});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  for(const event of ['will-navigate','will-redirect','will-frame-navigate'])window.webContents.on(event,e=>{if(!isAppDocument(e.url))e.preventDefault();});
  window.webContents.on('will-attach-webview',e=>e.preventDefault());
  window.webContents.on('before-input-event',(e,input)=>{
    if(input.key==='F5'||input.key==='F12'||(input.control||input.meta)&&['r','R'].includes(input.key))e.preventDefault();
  });
  privateSession.on('will-download',(event,item,contents)=>{
    const filename=safeExportName(item.getFilename());
    if(contents!==window.webContents||!isAppDocument(contents.getURL())||!isLocalBlob(item.getURL())||!filename){event.preventDefault();return;}
    item.setSaveDialogOptions({title:'Сохранить отчёт',defaultPath:path.join(app.getPath('documents'),filename),buttonLabel:'Сохранить',properties:['showOverwriteConfirmation','createDirectory']});
    item.on('done',(_e,state)=>{
      if(state==='interrupted'&&!window.isDestroyed())dialog.showMessageBox(window,{type:'error',title:'Орбита',message:'Не удалось сохранить отчёт.',detail:'Проверьте выбранную папку и свободное место на диске.'});
    });
  });
  window.once('ready-to-show',()=>window.show());
  window.on('closed',()=>{mainWindow=null;});
  await window.loadURL(APP_URL);
}


