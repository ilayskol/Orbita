'use strict';
const APP_URL='orbita://app/';
const isAppDocument=value=>value===APP_URL;
const isLocalBlob=value=>typeof value==='string'&&value.startsWith('blob:'+APP_URL);
const isAllowedResource=value=>isAppDocument(value)||isLocalBlob(value)||typeof value==='string'&&value.startsWith('data:image/');
const allowedPermission=(permission,url)=>permission==='clipboard-sanitized-write'&&isAppDocument(url);
function safeExportName(input) {
  const name=String(input).replace(/^.*[\\/]/,'').replace(/[<>:"|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'');
  if(!name||name.length>180||!/\.(txt|xlsx|json)$/i.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))return null;
  return name;
}
module.exports={APP_URL,isAppDocument,isLocalBlob,isAllowedResource,allowedPermission,safeExportName};
