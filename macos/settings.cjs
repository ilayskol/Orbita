'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const MAX_BYTES=1024*1024;
function check(ok,message='Некорректные настройки приложения.'){if(!ok)throw new Error(message);}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=150&&!/[\u0000-\u001f]/.test(value);
const id=value=>Number.isSafeInteger(value)&&value>0;
function sanitizeConfig(value){
  check(plain(value)&&value.version===1);
  check(Array.isArray(value.offers)&&value.offers.length<=5000&&Array.isArray(value.template)&&value.template.length<=5000);
  check(Array.isArray(value.ownWebs)&&value.ownWebs.length<=5000&&value.ownWebs.every(id));
  check(Array.isArray(value.statuses)&&value.statuses.length>0&&value.statuses.length<=100&&value.statuses.every(text));
  check(value.offers.every(o=>plain(o)&&id(o.id)&&text(o.name)&&text(o.company)&&['RU','KZ'].includes(o.country)));
  check(new Set(value.offers.map(o=>o.id)).size===value.offers.length);
  check(value.template.every(r=>plain(r)&&text(r.offer)&&text(r.company)&&id(r.web)&&['RU','KZ'].includes(r.country)));
  check(new Set(value.template.map(r=>`${r.country}\0${r.company.trim()}\0${r.offer.trim()}\0${r.web===8888?33:r.web}`)).size===value.template.length);
  check(['grossup','markup'].includes(value.commissionMode)&&[',','.'].includes(value.decimal)&&['source','moscow'].includes(value.timeMode)&&typeof value.filterMonth==='boolean');
  check(typeof value.commissionRate==='string'&&(value.commissionRate===''||(/^\d{1,2}([.,]\d{1,3})?$/.test(value.commissionRate)&&Number(value.commissionRate.replace(',','.'))<100)));
  return {version:1,offers:value.offers.map(o=>({id:o.id,name:o.name.trim(),company:o.company.trim(),country:o.country})),
    template:value.template.map(r=>({offer:r.offer.trim(),company:r.company.trim(),web:r.web===8888?33:r.web,country:r.country})),
    ownWebs:[...value.ownWebs],statuses:value.statuses.map(s=>s.trim()),commissionRate:value.commissionRate,
    commissionMode:value.commissionMode,decimal:value.decimal,filterMonth:value.filterMonth,timeMode:value.timeMode};
}
function createSettingsStore(directory,{legacy=false,io=fs}={}){
  const root=path.resolve(directory),filename=path.join(root,'settings.json');let queue=Promise.resolve();
  const serial=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result;};
  async function ensureRoot(){
    await io.mkdir(root,{recursive:true});const stat=await io.lstat(root);
    check(stat.isDirectory()&&!stat.isSymbolicLink(),'Папка настроек не должна быть ссылкой.');
    const actual=await io.realpath(root);
    check(path.relative(actual,root)==='','Папка настроек перенаправлена за пределы профиля.');
  }
  async function existing(){
    try{const stat=await io.lstat(filename);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=MAX_BYTES,'Файл настроек повреждён или слишком большой.');return true;}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
  }
  return {
    flush:()=>queue,
    load:()=>serial(async()=>{
      await ensureRoot();if(!await existing())return {config:null,legacy};
      let doc;try{const bytes=await io.readFile(filename);check(bytes.byteLength<=MAX_BYTES);doc=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Не удалось прочитать настройки. Файл settings.json повреждён.');}
      return {config:sanitizeConfig(doc),legacy};
    }),
    save:config=>serial(async()=>{
      const clean=sanitizeConfig(config),data=JSON.stringify(clean,null,2)+'\n';
      check(Buffer.byteLength(data)<=MAX_BYTES,'Настройки превышают 1 МБ.');
      await ensureRoot();await existing();const temporary=path.join(root,`.settings-${randomUUID()}.tmp`);
      try{await io.writeFile(temporary,data,{flag:'wx',mode:0o600});await existing();await io.rename(temporary,filename);}
      finally{await io.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    }),
  };
}
module.exports={createSettingsStore,sanitizeConfig,MAX_BYTES};
