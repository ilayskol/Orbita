const {test}=require('node:test');
const assert=require('node:assert/strict');
const {APP_URL,isAppDocument,isLocalBlob,isAllowedResource,allowedPermission,safeExportName}=require('./policy.cjs');
test('only the packaged document and local blobs can load',()=>{
  assert(isAppDocument(APP_URL));assert(isLocalBlob('blob:orbita://app/abc-123'));
  for(const value of ['https://example.com/','http://localhost/','file:///C:/secret.txt','orbita://app/../secret','orbita://app/?path=secret','orbita://app.evil/','blob:https://evil/abc','javascript:alert(1)','ws://example.com/'])assert.equal(isAllowedResource(value),false,value);
});
test('clipboard writes are limited to the trusted app; reading and device access are denied',()=>{
  assert(allowedPermission('clipboard-sanitized-write',APP_URL));
  for(const permission of ['clipboard-read','media','geolocation','notifications','fileSystem','display-capture'])assert.equal(allowedPermission(permission,APP_URL),false);
  assert.equal(allowedPermission('clipboard-sanitized-write','https://example.com/'),false);
});
test('export filenames cannot escape the chosen folder or launch executables',()=>{
  assert.equal(safeExportName('../../Суммы_2026-09.txt'),'Суммы_2026-09.txt');
  assert.equal(safeExportName('Статистика.xlsx'),'Статистика.xlsx');
  for(const name of ['payload.exe','settings.json.exe','CON.txt','LPT1.xlsx','bad',''])assert.equal(safeExportName(name),null);
});
