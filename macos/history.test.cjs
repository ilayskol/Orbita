'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createHistoryStore,LIMITS}=require('./history.cjs');
const bytes=()=>Uint8Array.from([0,255,128,1,40]).buffer;
const payload=()=>({files:[{name:'клики.xlsx',data:bytes()}],config:{ownIds:['1001'],rules:[{offer:'demo_offer_10',web:'33'}]},period:'2026-09',recordCount:5064,months:['2026-08','2026-09']});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'orbita-history-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return {dir,store:createHistoryStore(path.join(dir,'history')),root:path.join(dir,'history')};}
test('raw binary and settings survive a fresh store instance; duplicate import is one archive',async t=>{
  const {store,root}=await fixture(t);const input=payload();const saved=await store.save(input);
  assert.equal(saved.recordCount,5064);assert.deepEqual(saved.files,['клики.xlsx']);assert.equal('config' in saved,false);
  const fresh=createHistoryStore(root);assert.deepEqual(await fresh.list(),[saved]);
  const loaded=await fresh.load(saved.id);assert.ok(loaded.files[0].data instanceof ArrayBuffer);assert.deepEqual(new Uint8Array(loaded.files[0].data),new Uint8Array(bytes()));assert.deepEqual(loaded.config,input.config);
  assert.deepEqual(await fresh.save(payload()),saved);assert.equal((await fresh.list()).length,1);
  assert.equal(await fresh.remove(saved.id),true);assert.deepEqual(await store.list(),[]);
});
test('different periods and settings create distinct history entries; parallel saves serialize',async t=>{
  const {store}=await fixture(t);const second=payload();second.period='2026-10';const third=payload();third.config.ownIds=['9000'];
  const all=await Promise.all([store.save(payload()),store.save(payload()),store.save(second),store.save(third)]);
  assert.equal(all[0].id,all[1].id);assert.equal(new Set(all.map(x=>x.id)).size,3);assert.equal((await store.list()).length,3);
});
test('flush waits for pending disk saves so a fresh store can reopen the archive',async t=>{
  const {store,root}=await fixture(t);let complete=false;
  const saving=store.save(payload()).then(value=>{complete=true;return value;});
  await store.flush();assert.equal(complete,true);
  const saved=await saving;assert.deepEqual(await createHistoryStore(root).list(),[saved]);
  const deleting=store.remove(saved.id);await store.flush();await deleting;assert.deepEqual(await createHistoryStore(root).list(),[]);
});
test('reject invalid IDs, filenames, dates, metadata and settings before creating an archive',async t=>{
  const {store}=await fixture(t);
  for(const id of ['../escape','a'.repeat(63),'A'.repeat(64),null]){await assert.rejects(store.load(id));await assert.rejects(store.remove(id));await assert.rejects(store.folder(id));}
  for(const name of ['../secret','a/b.csv','C:\\secret','','..','a\0b']){const p=payload();p.files[0].name=name;await assert.rejects(store.save(p));}
  for(const patch of [{period:'2026-13'},{recordCount:-1},{recordCount:0.5},{months:['2026-09','2026-09']},{months:['2026-1']},{files:[]},{config:{x:NaN}}])await assert.rejects(store.save({...payload(),...patch}));
  await assert.rejects(store.save({...payload(),config:JSON.parse('{"__proto__":{}}')}));
  const cyclic={};cyclic.x=cyclic;await assert.rejects(store.save({...payload(),config:cyclic}));
  await assert.rejects(store.save({...payload(),config:{x:'x'.repeat(LIMITS.config)}}));
  const p=payload();p.files[0].data=new Uint8Array([1]);await assert.rejects(store.save(p));assert.deepEqual(await store.list(),[]);
});
test('reject oversized files and file counts',async t=>{
  const {store}=await fixture(t);const p=payload();p.files[0].data=new ArrayBuffer(LIMITS.file+1);await assert.rejects(store.save(p),/100 МБ/);
  await assert.rejects(store.save({...payload(),files:Array.from({length:101},()=>({name:'a',data:bytes()}))}));
});
test('interrupted staging folder is not listed; malformed committed entry reports an error',async t=>{
  const {store,root}=await fixture(t);await store.list();await fs.mkdir(path.join(root,'.stage-interrupted'));await fs.writeFile(path.join(root,'.stage-interrupted','0.bin'),'unfinished');assert.deepEqual(await store.list(),[]);
  const saved=await store.save(payload());const other=await store.save({...payload(),period:'2026-10'});
  const manifest=path.join(await store.folder(saved.id),'manifest.json');await fs.writeFile(manifest,'{bad');
  const listed=await store.list();assert.equal(listed.length,2);assert.deepEqual(listed.find(entry=>entry.id===other.id),other);assert.match(listed.find(entry=>entry.id===saved.id).error,/Повреждён/);await assert.rejects(store.load(saved.id),/Повреждён/);
  // A damaged entry can still be explicitly deleted without trusting its manifest.
  await store.remove(saved.id);assert.deepEqual(await store.list(),[other]);
});
test('load catches same-size binary corruption; list catches missing source files and tampered metadata',async t=>{
  const {store}=await fixture(t);const saved=await store.save(payload());const folder=await store.folder(saved.id);const file=path.join(folder,'001 - клики.xlsx');await fs.writeFile(file,Buffer.from([0,255,128,1,41]));await assert.rejects(store.load(saved.id),/повреждён/);await assert.rejects(store.save(payload()),/повреждена/);
  await fs.unlink(file);assert.equal(typeof (await store.list())[0].error,'string');await fs.writeFile(file,Buffer.from(bytes()));
  const filename=path.join(folder,'manifest.json');const doc=JSON.parse(await fs.readFile(filename,'utf8'));doc.recordCount=7;await fs.writeFile(filename,JSON.stringify(doc));assert.match((await store.list())[0].error,/изменено или повреждено/);
});
test('directory junctions cannot redirect archive access or deletion',async t=>{
  const {store,root,dir}=await fixture(t);await store.list();const outside=path.join(dir,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'keep.txt'),'keep');const id='a'.repeat(64);
  try{await fs.symlink(outside,path.join(root,id),'junction');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Local symlink privileges unavailable');return;}throw error;}
  await assert.rejects(store.list());await assert.rejects(store.load(id));await assert.rejects(store.remove(id));await assert.rejects(store.folder(id));assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'keep');
});
test('readable period folders preserve original filenames with safe Windows names and unique prefixes',async t=>{
  const {store,root}=await fixture(t);assert.equal(await store.folder(),root);
  const names=['Клики за сентябрь.csv','Клики за сентябрь.csv','CON.xlsx','Сумма:<1>?*.csv','длинное'.repeat(30)+'.xlsx','итог. '];
  const input={...payload(),files:names.map(name=>({name,data:bytes()}))};const saved=await store.save(input);
  const folder=await store.folder(saved.id);assert.equal(path.basename(folder),`2026-09--${saved.id}`);
  const files=await fs.readdir(folder);assert.ok(files.includes('001 - Клики за сентябрь.csv'));assert.ok(files.includes('002 - Клики за сентябрь.csv'));assert.ok(files.includes('003 - CON.xlsx'));assert.ok(files.includes('004 - Сумма__1___.csv'));assert.ok(files.some(name=>name.startsWith('005 - ')&&name.endsWith('.xlsx')&&name.length<100));assert.ok(files.includes('006 - итог'));
  assert.deepEqual((await store.load(saved.id)).files.map(file=>file.name),names);assert.deepEqual(await store.save(input),saved);
  await assert.rejects(store.folder('a'.repeat(64)),/не найдена/);await store.remove(saved.id);assert.deepEqual(await store.list(),[]);
});
test('legacy hash folders and numbered binary files still load, deduplicate, open and remove',async t=>{
  const {store,root}=await fixture(t);const saved=await store.save(payload());const current=await store.folder(saved.id);
  const doc=JSON.parse(await fs.readFile(path.join(current,'manifest.json'),'utf8'));doc.version=1;doc.files[0].stored='0.bin';
  await fs.rename(path.join(current,'001 - клики.xlsx'),path.join(current,'0.bin'));await fs.writeFile(path.join(current,'manifest.json'),JSON.stringify(doc));
  const legacy=path.join(root,saved.id);await fs.rename(current,legacy);
  const fresh=createHistoryStore(root);assert.equal(await fresh.folder(saved.id),legacy);assert.deepEqual(await fresh.list(),[saved]);assert.deepEqual(new Uint8Array((await fresh.load(saved.id)).files[0].data),new Uint8Array(bytes()));
  assert.deepEqual(await fresh.save(payload()),saved);assert.equal((await fs.readdir(root)).length,1);await fresh.remove(saved.id);assert.deepEqual(await fresh.list(),[]);
});
test('tampered stored filename and mismatched period folders cannot redirect source reads',async t=>{
  const {store,root}=await fixture(t);const saved=await store.save(payload());const folder=await store.folder(saved.id);const filename=path.join(folder,'manifest.json');const doc=JSON.parse(await fs.readFile(filename,'utf8'));
  doc.files[0].stored='../escape.csv';await fs.writeFile(filename,JSON.stringify(doc));await assert.rejects(store.load(saved.id),/описание исходного файла/);
  doc.files[0].stored='001 - клики.xlsx';await fs.writeFile(filename,JSON.stringify(doc));await fs.rename(folder,path.join(root,`2026-10--${saved.id}`));await assert.rejects(store.load(saved.id),/периодом/);
});
