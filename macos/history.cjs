'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const LIMITS=Object.freeze({file:100*1024*1024,total:300*1024*1024,files:100,config:1024*1024,manifest:2*1024*1024,entries:1000});
const month=/^\d{4}-(0[1-9]|1[0-2])$/;
const idPattern=/^[a-f0-9]{64}$/;
const directoryPattern=/^(?:(\d{4}-(?:0[1-9]|1[0-2]))--)?([a-f0-9]{64})$/;
function assert(condition,message){if(!condition)throw new Error(message);}
function validId(id){assert(typeof id==='string'&&idPattern.test(id),'Некорректный идентификатор записи истории.');return id;}
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
function configJSON(value){
  assert(plain(value),'Настройки истории должны быть объектом.');
  const seen=new Set();let nodes=0;
  function visit(item,depth){
    assert(++nodes<=100000&&depth<=30,'Настройки истории слишком сложные.');
    if(item===null||typeof item==='boolean')return;
    if(typeof item==='string'){assert(item.length<=LIMITS.config,'Слишком длинное значение настройки.');return;}
    if(typeof item==='number'){assert(Number.isFinite(item),'Некорректное число в настройках.');return;}
    assert(Array.isArray(item)||plain(item),'Недопустимое значение настройки.');
    assert(!seen.has(item),'Циклические настройки недопустимы.');seen.add(item);
    for(const key of Object.keys(item)){assert(!['__proto__','constructor','prototype'].includes(key),'Недопустимый ключ настройки.');visit(item[key],depth+1);}
    seen.delete(item);
  }
  visit(value,0);const json=JSON.stringify(value);
  assert(Buffer.byteLength(json)<=LIMITS.config,'Настройки истории превышают 1 МБ.');return json;
}
function validName(name){assert(typeof name==='string'&&name.trim().length>0&&name.length<=240&&!/[\\/\x00-\x1f\x7f]/.test(name)&&!['.','..'].includes(name),'Некорректное имя исходного файла.');return name;}
function storedName(name,index){
  // The numeric prefix prevents reserved Windows device names and duplicate filenames.
  const clean=name.replace(/[<>:"|?*]/g,'_').replace(/[. ]+$/g,'').trim()||'Файл';
  const extension=path.extname(clean).slice(0,12);
  const stem=clean.slice(0,clean.length-path.extname(clean).length)||'Файл';
  return `${String(index+1).padStart(3,'0')} - ${Array.from(stem).slice(0,70).join('')}${extension}`;
}
function readableStoredName(name){return /^(?:00[1-9]|0[1-9]\d|100) - .+$/u.test(name)&&!/[<>:"|?*\\/\x00-\x1f\x7f]/.test(name)&&!/[. ]$/.test(name);}
function metadata(value){
  assert(plain(value),'Некорректная запись истории.');
  assert(typeof value.period==='string'&&month.test(value.period),'Некорректный месяц истории.');
  assert(Number.isSafeInteger(value.recordCount)&&value.recordCount>=0,'Некорректное число записей.');
  assert(Array.isArray(value.months)&&value.months.length<=1200&&value.months.every(v=>typeof v==='string'&&month.test(v))&&new Set(value.months).size===value.months.length,'Некорректные месяцы истории.');
  return {period:value.period,recordCount:value.recordCount,months:[...value.months],config:JSON.parse(configJSON(value.config))};
}
function hash(data){return createHash('sha256').update(data).digest('hex');}
function archiveId(meta,files){return hash(JSON.stringify({...meta,files:files.map(({name,size,sha256})=>({name,size,sha256}))}));}
function summary(manifest){return {id:manifest.id,createdAt:manifest.createdAt,period:manifest.period,months:manifest.months,recordCount:manifest.recordCount,files:manifest.files.map(file=>file.name)};}
function readableError(error){
  if(error?.code==='ENOENT')return 'Отсутствует файл выгрузки или её описание.';
  if(error?.code==='EACCES'||error?.code==='EPERM')return 'Нет доступа к файлам этой выгрузки.';
  if(error?.code)return 'Не удалось прочитать файлы этой выгрузки.';
  return error.message;
}
async function regular(file,max){const stat=await fs.lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=max,'Повреждён или недоступен файл истории.');return stat;}
function createHistoryStore(root){
  root=path.resolve(root);let queue=Promise.resolve();
  const serial=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result;};
  async function ensureRoot(){await fs.mkdir(root,{recursive:true});const stat=await fs.lstat(root);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Папка истории не должна быть ссылкой.');}
  async function directories(){
    await ensureRoot();const entries=await fs.readdir(root,{withFileTypes:true});
    assert(entries.length<=LIMITS.entries*2,'В папке истории слишком много файлов.');
    const result=[];
    for(const entry of entries){
      if(entry.name.startsWith('.stage-'))continue;
      const match=entry.name.match(directoryPattern);
      assert(match&&entry.isDirectory()&&!entry.isSymbolicLink(),'В папке истории обнаружена повреждённая или посторонняя запись.');
      assert(!result.some(item=>item.id===match[2]),'В папке истории обнаружены две копии одной записи.');
      result.push({id:match[2],name:entry.name,period:match[1]});
    }
    assert(result.length<=LIMITS.entries,'История содержит слишком много выгрузок.');return result;
  }
  async function resolveEntry(id){
    validId(id);const entry=(await directories()).find(item=>item.id===id);
    assert(entry,'Выгрузка не найдена в локальной истории.');return entry;
  }
  async function entryFolder(entry){
    const folder=path.join(root,entry.name);const stat=await fs.lstat(folder);
    assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Запись истории не должна быть ссылкой.');
    return folder;
  }
  async function readManifest(id,entry){
    validId(id);entry??=await resolveEntry(id);const folder=await entryFolder(entry);
    const filename=path.join(folder,'manifest.json');await regular(filename,LIMITS.manifest);
    let doc;try{doc=JSON.parse(await fs.readFile(filename,'utf8'));}catch{throw new Error('Повреждён файл описания истории.');}
    assert(plain(doc)&&[1,2].includes(doc.version)&&doc.id===id,'Неизвестный или повреждённый формат истории.');
    assert(typeof doc.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(doc.createdAt)&&Number.isFinite(Date.parse(doc.createdAt))&&new Date(doc.createdAt).toISOString()===doc.createdAt,'Повреждена дата истории.');
    const meta=metadata(doc);
    assert(doc.version===1?!entry.period:entry.period===meta.period,'Название папки не совпадает с периодом выгрузки.');
    assert(Array.isArray(doc.files)&&doc.files.length>0&&doc.files.length<=LIMITS.files,'Некорректный список файлов истории.');
    let total=0;
    for(let i=0;i<doc.files.length;i++){
      const file=doc.files[i];assert(plain(file),'Некорректный файл истории.');validName(file.name);
      assert(file.stored===(doc.version===1?`${i}.bin`:storedName(file.name,i))&&Number.isSafeInteger(file.size)&&file.size>=0&&file.size<=LIMITS.file&&typeof file.sha256==='string'&&idPattern.test(file.sha256),'Повреждено описание исходного файла.');
      total+=file.size;assert(total<=LIMITS.total,'История превышает допустимый размер.');
      assert((await regular(path.join(folder,file.stored),LIMITS.file)).size===file.size,'Размер исходного файла истории изменился.');
    }
    assert(archiveId(meta,doc.files)===id,'Описание истории было изменено или повреждено.');return doc;
  }
  return {
    flush:()=>queue,
    folder:id=>serial(async()=>{
      if(id===undefined){await ensureRoot();return root;}
      return entryFolder(await resolveEntry(id));
    }),
    list:()=>serial(async()=>{
      const entries=await directories();const result=[];
      for(const entry of entries){
        try{result.push(summary(await readManifest(entry.id,entry)));}
        catch(error){result.push({id:entry.id,createdAt:'',period:'',months:[],recordCount:0,files:[],error:`Запись повреждена или недоступна: ${readableError(error)}`});}
      }
      return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    }),
    save:payload=>serial(async()=>{
      const meta=metadata(payload);
      assert(Array.isArray(payload.files)&&payload.files.length>0&&payload.files.length<=LIMITS.files,'Выберите от 1 до 100 исходных файлов.');
      let total=0;
      const files=payload.files.map((file,i)=>{
        assert(plain(file),'Некорректный исходный файл.');validName(file.name);
        assert(file.data instanceof ArrayBuffer,'Данные исходного файла должны быть двоичными.');
        const size=file.data.byteLength;total+=size;
        assert(size<=LIMITS.file&&total<=LIMITS.total,'Слишком большая выгрузка: максимум 100 МБ на файл и 300 МБ суммарно.');
        const bytes=Buffer.from(new Uint8Array(file.data));return {name:file.name,stored:storedName(file.name,i),size,sha256:hash(bytes),bytes};
      });
      const id=archiveId(meta,files);const entries=await directories();
      const duplicate=entries.find(entry=>entry.id===id);
      if(duplicate){
        const existing=await readManifest(id,duplicate);const folder=await entryFolder(duplicate);
        for(const file of existing.files)assert(hash(await fs.readFile(path.join(folder,file.stored)))===file.sha256,'Существующая запись истории повреждена. Удалите её перед повторным сохранением.');
        return summary(existing);
      }
      assert(entries.length<LIMITS.entries,'В истории уже 1000 выгрузок. Удалите ненужные записи.');
      const manifest={version:2,id,createdAt:new Date().toISOString(),...meta,files:files.map(({bytes,...file})=>file)};
      const stage=path.join(root,`.stage-${randomUUID()}`);await fs.mkdir(stage);
      try{
        for(const file of files)await fs.writeFile(path.join(stage,file.stored),file.bytes,{flag:'wx',mode:0o600});
        await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
        await fs.rename(stage,path.join(root,`${meta.period}--${id}`));return summary(manifest);
      }finally{await fs.rm(stage,{recursive:true,force:true});}
    }),
    load:id=>serial(async()=>{
      const entry=await resolveEntry(id);const folder=await entryFolder(entry);const doc=await readManifest(id,entry);const files=[];
      for(const file of doc.files){const bytes=await fs.readFile(path.join(folder,file.stored));assert(hash(bytes)===file.sha256,'Исходный файл истории повреждён.');files.push({name:file.name,data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});}
      return {id,files,config:doc.config,period:doc.period,recordCount:doc.recordCount,months:doc.months};
    }),
    remove:id=>serial(async()=>{
      const entry=await resolveEntry(id);const folder=await entryFolder(entry);
      const entries=await fs.readdir(folder,{withFileTypes:true});
      assert(entries.length<=LIMITS.files+1&&entries.every(file=>file.isFile()&&!file.isSymbolicLink()&&(file.name==='manifest.json'||(!entry.period?/^(0|[1-9]\d?)\.bin$/.test(file.name):readableStoredName(file.name)))),'В записи истории обнаружены посторонние файлы.');
      // Detach atomically before deleting, so an interrupted removal cannot leave a half-readable entry.
      const detached=path.join(root,`.stage-delete-${randomUUID()}`);await fs.rename(folder,detached);
      for(const entry of entries)await fs.unlink(path.join(detached,entry.name));
      await fs.rmdir(detached);return true;
    })
  };
}
module.exports={createHistoryStore,LIMITS,validId};
